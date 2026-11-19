/**
 * One-time codes that sites send by email: recognising a page that says "we emailed you a code",
 * and picking the code out of recent messages. Pure text work; fetching the messages is elsewhere.
 */

export interface MailMessage {
  id: string;
  from: string;
  subject: string;
  /** The message body as plain text. */
  text: string;
  /** When the mailbox received it (ms). */
  at: number;
}

export interface MailCode {
  /** The message it came from. */
  id: string;
  code: string;
  from: string;
  subject: string;
  at: number;
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();

/** Whether a page's text says a code was sent by email (as opposed to an authenticator app or SMS). */
export function saysEmailCode(pageText: string): boolean {
  const t = fold(pageText).replace(/\s+/g, ' ');
  const mail = '(e-?mail|inbox|hop thu|thu dien tu|mailbox)';
  const code = '(code|otp|passcode|ma xac|ma bao mat|ma dang nhap|ma gom|verification|xac minh|xac thuc)';
  return (
    new RegExp(`(sent|send|emailed|gui|vua gui|da gui).{0,80}${mail}`).test(t) ||
    new RegExp(`(check|kiem tra|xem|mo|open).{0,30}${mail}`).test(t) ||
    new RegExp(`${mail}.{0,60}${code}`).test(t) ||
    new RegExp(`${code}.{0,80}${mail}`).test(t) ||
    /emailed (you|a|the)/.test(t)
  );
}

/** Email addresses written out in a page's text. */
export function emailsIn(text: string): string[] {
  return [...new Set((text.match(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) ?? []).map((e) => e.toLowerCase()))].slice(0, 10);
}

/** Whether two addresses are the same mailbox (Gmail ignores dots and "+tags"). */
export function sameMailbox(a: string, b: string): boolean {
  const norm = (e: string) => {
    const [local = '', domain = ''] = e.trim().toLowerCase().split('@');
    const d = domain === 'googlemail.com' ? 'gmail.com' : domain;
    return d === 'gmail.com' ? `${local.replace(/\+.*$/, '').replace(/\./g, '')}@${d}` : `${local}@${d}`;
  };
  return !!a && !!b && a.includes('@') && norm(a) === norm(b);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|td|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

const KEYWORD = /code|otp|\bma\b|passcode|password|\bpin\b|verif|xac (minh|thuc|nhan)|one[- ]time|security|dang nhap|sign[- ]?in|log[- ]?in|authenticat|confirm/;
const NOT_A_CODE = /order|invoice|ref|don hang|hoa don|ticket|case|\$|usd|vnd|₫|phone|tel|so dien thoai|zip|postal/;

/**
 * The one-time code in a message, with a confidence score, or null. A code is 4 to 8 digits
 * (possibly written "123 456" or "123-456", or with a letter prefix like "G-123456"), standing on
 * its own, near words like "code" or "mã xác minh"; years, amounts, order numbers and anything
 * inside a link are passed over.
 */
export function findCode(subject: string, body: string): { code: string; score: number } | null {
  let best: { code: string; score: number; at: number } | null = null;
  const scan = (raw: string, inSubject: boolean) => {
    const text = raw.replace(/https?:\/\/\S+/g, ' ');
    const folded = fold(text);
    const re = /(?<![\w.@#/=+-])(?:[A-Z]{1,3}-)?(\d{3}[ -]\d{3}|\d{4,8})(?![\w@/=+]|[.,-]\d)/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const digits = m[1].replace(/[ -]/g, '');
      const before = folded.slice(Math.max(0, m.index - 70), m.index);
      const after = folded.slice(m.index + m[0].length, m.index + m[0].length + 50);
      let score = inSubject ? 4 : 0;
      if (KEYWORD.test(before)) score += 6;
      if (KEYWORD.test(after)) score += 3;
      if (digits.length === 6) score += 2;
      if (/^(19|20)\d\d$/.test(digits) && !KEYWORD.test(before.slice(-25))) score -= 8;
      if (NOT_A_CODE.test(before.slice(-30))) score -= 6;
      if (score >= 6 && (!best || score > best.score)) best = { code: digits, score, at: m.index };
    }
  };
  scan(subject, true);
  scan(body.slice(0, 4000), false);
  return best ? { code: (best as { code: string }).code, score: (best as { score: number }).score } : null;
}

/**
 * The code to use from recent messages: only those that arrived after `since`, preferring a
 * message that mentions the site being signed in to, then the newest.
 */
export function pickCode(messages: MailMessage[], opts: { since: number; site?: string; used?: string[] }): MailCode | null {
  const site = opts.site ? fold(opts.site) : '';
  const scored = messages
    .filter((m) => m.at >= opts.since && !opts.used?.includes(m.id))
    .map((m) => {
      const found = findCode(m.subject, m.text);
      if (!found) return null;
      const mentions = !!site && site.length >= 3 && fold(`${m.from} ${m.subject} ${m.text.slice(0, 600)}`).includes(site);
      return { m, code: found.code, score: found.score + (mentions ? 5 : 0) };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.score - a.score || b.m.at - a.m.at);
  const top = scored[0];
  return top ? { id: top.m.id, code: top.code, from: top.m.from, subject: top.m.subject, at: top.m.at } : null;
}
