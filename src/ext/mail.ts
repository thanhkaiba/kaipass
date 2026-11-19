/**
 * A linked Gmail account, used for one thing: reading the one-time code a site has just emailed.
 *
 * Linking asks Google for read-only access to that mailbox (Gmail has no narrower permission for
 * reading a message). KaiPass then looks only at mail from the last few minutes, only when a page
 * says it emailed a code to the address being signed in with, and keeps nothing: the access token
 * lives in the browser's memory-only session storage, and message text is dropped once a code has
 * been picked out of it.
 */
import { GOOGLE_CLIENT_ID } from '../config';
import { htmlToText, sameMailbox, type MailMessage } from '../lib/mailOtp';

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const LINKED_KEY = 'kaipass.mail';
const TOKENS_KEY = 'kaipass.mailTokens';

export interface LinkedMail {
  email: string;
  linkedAt: number;
}

export class MailAuthNeeded extends Error {}

export async function linkedMail(): Promise<LinkedMail[]> {
  return ((await chrome.storage.local.get(LINKED_KEY))[LINKED_KEY] ?? []) as LinkedMail[];
}

type Tokens = Record<string, { token: string; exp: number }>;
const tokens = async () => ((await chrome.storage.session.get(TOKENS_KEY))[TOKENS_KEY] ?? {}) as Tokens;

/** Runs Google's consent (or, silently, its renewal) and returns an access token. */
async function authorize(opts: { email?: string; interactive: boolean }): Promise<{ token: string; expiresIn: number }> {
  if (!GOOGLE_CLIENT_ID) throw new Error('Bản build này chưa có Google OAuth Client ID');
  const state = crypto.randomUUID();
  const query = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    response_type: 'token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: SCOPE,
    state,
  });
  if (opts.email) query.set('login_hint', opts.email);
  if (!opts.interactive) query.set('prompt', 'none');
  else if (!opts.email) query.set('prompt', 'select_account');
  let back: string | undefined;
  try {
    back = await chrome.identity.launchWebAuthFlow({ url: `${AUTH_URL}?${query}`, interactive: opts.interactive });
  } catch (e) {
    if (!opts.interactive) throw new MailAuthNeeded();
    throw new Error(`Chưa liên kết được Gmail${e instanceof Error && e.message ? `: ${e.message}` : ''}`);
  }
  const reply = new URLSearchParams(new URL(back ?? 'https://invalid/').hash.slice(1));
  const token = reply.get('access_token');
  if (reply.get('state') !== state || !token) {
    if (!opts.interactive) throw new MailAuthNeeded();
    throw new Error(reply.get('error') === 'access_denied' ? 'Bạn chưa cho phép KaiPass đọc Gmail' : reply.get('error') || 'Google không trả về quyền truy cập');
  }
  return { token, expiresIn: Number(reply.get('expires_in') || 3600) };
}

async function call(token: string, path: string): Promise<Response> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new MailAuthNeeded();
  if (res.status === 403) {
    const detail = ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? '';
    throw new Error(/has not been used|is disabled|not enabled/i.test(detail) ? 'Gmail API chưa được bật trong Google Cloud (APIs & Services → Library → Gmail API → Enable)' : `Gmail từ chối: ${detail || '403'}`);
  }
  if (!res.ok) throw new Error(`Gmail báo lỗi ${res.status}`);
  return res;
}

async function keep(email: string, token: string, expiresIn: number): Promise<void> {
  await chrome.storage.session.set({ [TOKENS_KEY]: { ...(await tokens()), [email]: { token, exp: Date.now() + expiresIn * 1000 } } });
}

/** Asks the user to pick a Google account and allow read-only mail access; remembers the address. */
export async function linkMail(hint?: string): Promise<LinkedMail> {
  const { token, expiresIn } = await authorize({ email: hint, interactive: true });
  const email = String(((await (await call(token, '/profile')).json()) as { emailAddress?: string }).emailAddress ?? '').toLowerCase();
  if (!email) throw new Error('Không đọc được địa chỉ của hộp thư');
  await keep(email, token, expiresIn);
  const list = (await linkedMail()).filter((m) => !sameMailbox(m.email, email));
  const linked = { email, linkedAt: Date.now() };
  await chrome.storage.local.set({ [LINKED_KEY]: [...list, linked] });
  return linked;
}

export async function unlinkMail(email: string): Promise<void> {
  await chrome.storage.local.set({ [LINKED_KEY]: (await linkedMail()).filter((m) => m.email !== email) });
  const t = await tokens();
  delete t[email];
  await chrome.storage.session.set({ [TOKENS_KEY]: t });
}

async function tokenFor(email: string): Promise<string> {
  const saved = (await tokens())[email];
  if (saved && saved.exp > Date.now() + 60_000) return saved.token;
  // Google renews without a window as long as the browser is still signed in to that account.
  const { token, expiresIn } = await authorize({ email, interactive: false });
  await keep(email, token, expiresIn);
  return token;
}

interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
  headers?: { name: string; value: string }[];
}

const decode = (data: string) => {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

function bodyText(payload: Part): string {
  const find = (p: Part, type: string): string | undefined => {
    if (p.mimeType === type && p.body?.data) return decode(p.body.data);
    for (const child of p.parts ?? []) {
      const hit = find(child, type);
      if (hit) return hit;
    }
    return undefined;
  };
  const plain = find(payload, 'text/plain');
  if (plain?.trim()) return plain;
  const html = find(payload, 'text/html');
  return html ? htmlToText(html) : '';
}

/** Mail that reached the linked account after `since` (newest first, a handful at most). */
export async function recentMessages(email: string, since: number): Promise<MailMessage[]> {
  const token = await tokenFor(email);
  const q = encodeURIComponent(`after:${Math.floor(since / 1000) - 1}`);
  const list = (await (await call(token, `/messages?maxResults=6&q=${q}`)).json()) as { messages?: { id: string }[] };
  const out: MailMessage[] = [];
  for (const { id } of list.messages ?? []) {
    const m = (await (await call(token, `/messages/${id}?format=full`)).json()) as { internalDate?: string; snippet?: string; payload?: Part };
    const header = (name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
    out.push({
      id,
      from: header('from'),
      subject: header('subject'),
      text: (m.payload ? bodyText(m.payload) : '') || m.snippet || '',
      at: Number(m.internalDate ?? 0),
    });
  }
  return out;
}
