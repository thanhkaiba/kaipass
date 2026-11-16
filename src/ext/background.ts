/**
 * Background service worker. Answers the content script on web pages: which saved logins fit the
 * frame it runs in, and the credentials for one of them when the user picks it.
 *
 * It never trusts what the page or content script says about where it is: the frame's address
 * comes from Chrome (`sender.url`), and credentials are only handed to a frame whose host matches
 * the login's saved address.
 */
import { parseOtp, totp } from '../lib/totp';
import {
  defaultInlinePrefs,
  FILL_INDEX_KEY,
  hostMatches,
  hostOf,
  INLINE_PREFS_KEY,
  UNLOCK_KEY,
  type FillEntry,
  type FillReply,
  type InlinePrefs,
  type Request,
  type StateReply,
  type UnlockRecord,
} from './match';

// Keep session storage (master password, fill index) out of reach of content scripts.
void chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

async function unlocked(): Promise<UnlockRecord | undefined> {
  const record = (await chrome.storage.session.get(UNLOCK_KEY))[UNLOCK_KEY] as UnlockRecord | undefined;
  if (!record) return undefined;
  if (record.until !== null && record.until < Date.now()) {
    await chrome.storage.session.remove([UNLOCK_KEY, FILL_INDEX_KEY]);
    return undefined;
  }
  return record;
}

async function entriesFor(host: string): Promise<FillEntry[]> {
  const all = ((await chrome.storage.session.get(FILL_INDEX_KEY))[FILL_INDEX_KEY] ?? []) as FillEntry[];
  return all
    .filter((e) => e.hosts.some((h) => hostMatches(h, host)))
    .sort((a, b) => a.title.localeCompare(b.title));
}

async function prefs(): Promise<InlinePrefs> {
  const saved = (await chrome.storage.local.get(INLINE_PREFS_KEY))[INLINE_PREFS_KEY] as Partial<InlinePrefs> | undefined;
  return { ...defaultInlinePrefs, ...saved };
}

async function handle(req: Request, sender: chrome.runtime.MessageSender): Promise<unknown> {
  // Only our own content script, running in a normal web page, may ask.
  if (sender.id !== chrome.runtime.id || !sender.tab?.id) return undefined;
  const host = hostOf(sender.url ?? '');

  if (req.type === 'state') {
    const record = await unlocked();
    const items = record && host ? await entriesFor(host) : [];
    const reply: StateReply = {
      locked: !record,
      host,
      prefs: await prefs(),
      items: items.map((e) => ({ id: e.id, title: e.title, username: e.username, hasOtp: !!e.otp })),
    };
    return reply;
  }

  if (req.type === 'fill') {
    const record = await unlocked();
    const entry = record && host ? (await entriesFor(host)).find((e) => e.id === req.id) : undefined;
    if (!record || !entry) return { ok: false } satisfies FillReply;
    let otp = '';
    if (entry.otp) {
      try {
        otp = await totp(parseOtp(entry.otp));
      } catch {
        /* a broken OTP secret should not block the password */
      }
    }
    // Using autofill counts as activity for the auto-lock timer.
    if (record.until !== null) {
      await chrome.storage.session.set({ [UNLOCK_KEY]: { ...record, until: Date.now() + record.minutes * 60_000 } });
    }
    return { ok: true, username: entry.username, password: entry.password, otp } satisfies FillReply;
  }

  if (req.type === 'open') {
    // Opens KaiPass in a small window bound to the tab the user was on, so they can unlock and
    // pick a login there.
    await chrome.windows.create({
      url: chrome.runtime.getURL(`index.html?popup&tab=${sender.tab.id}`),
      type: 'popup',
      width: 420,
      height: 640,
      focused: true,
    });
    return { ok: true };
  }
  return undefined;
}

chrome.runtime.onMessage.addListener((req: Request, sender, reply) => {
  handle(req, sender).then(reply, () => reply(undefined));
  return true; // answer asynchronously
});
