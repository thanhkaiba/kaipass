/**
 * Background service worker. Answers the content script on web pages: which saved logins fit the
 * frame it runs in, and the credentials for one of them when the user picks it.
 *
 * It never trusts what the page or content script says about where it is: the frame's address
 * comes from Chrome (`sender.url`), and credentials are only handed to a frame whose host matches
 * the login's saved address.
 */
import { parseOtp, totp } from '../lib/totp';
import { backgroundSync, saveLogin } from './worker-vault';
import {
  defaultInlinePrefs,
  FILL_INDEX_KEY,
  hostMatches,
  hostOf,
  INLINE_PREFS_KEY,
  NEVER_SAVE_KEY,
  PENDING_KEY,
  UNLOCK_KEY,
  type PendingSave,
  type SavePromptReply,
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

declare const __KAIPASS_TEST__: boolean;

// ---- background sync ----

const SYNC_EVERY_MIN = 15;
/** Visiting a login page refreshes suggestions when the last sync is older than this. */
const STALE_MS = __KAIPASS_TEST__ ? 0 : 5 * 60_000;
let lastSync = 0;
let syncing: Promise<void> | undefined;

function syncSoon(): Promise<void> {
  syncing ??= (async () => {
    try {
      const record = await unlocked();
      if (record) await backgroundSync(record.password);
      lastSync = Date.now();
    } catch {
      /* offline or signed out: the next attempt will try again */
    } finally {
      syncing = undefined;
    }
  })();
  return syncing;
}

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('sync', { periodInMinutes: SYNC_EVERY_MIN }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('sync', { periodInMinutes: SYNC_EVERY_MIN }));
chrome.alarms.onAlarm.addListener((a) => a.name === 'sync' && void syncSoon());

// ---- saving logins typed into pages ----

const PENDING_FOR_MS = 3 * 60_000;
type PendingMap = Record<string, PendingSave & { lastUsername?: string }>;

async function pendingMap(): Promise<PendingMap> {
  return ((await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY] ?? {}) as PendingMap;
}

async function setPending(tabId: number, value: (PendingSave & { lastUsername?: string }) | undefined): Promise<void> {
  const map = await pendingMap();
  if (value) map[tabId] = value;
  else delete map[tabId];
  for (const [k, v] of Object.entries(map)) if (Date.now() - v.at > PENDING_FOR_MS) delete map[k];
  await chrome.storage.session.set({ [PENDING_KEY]: map });
}

async function neverSave(): Promise<string[]> {
  return ((await chrome.storage.local.get(NEVER_SAVE_KEY))[NEVER_SAVE_KEY] ?? []) as string[];
}

/** Decides whether a login typed into a page is new, a changed password, or already saved. */
async function judge(host: string, username: string, password: string): Promise<{ prompt: PendingSave['prompt'] | null; id?: string }> {
  if (!password || (await neverSave()).includes(host)) return { prompt: null };
  const entries = await entriesFor(host);
  const same = entries.filter((e) => e.username.toLowerCase() === username.toLowerCase());
  if (same.some((e) => e.password === password)) return { prompt: null };
  // A username-less capture matching a saved password is also nothing new.
  if (!username && entries.some((e) => e.password === password)) return { prompt: null };
  if (same.length > 0) return { prompt: 'update', id: same[0].id };
  if (!username && entries.length === 1) return { prompt: 'update', id: entries[0].id };
  return { prompt: 'new' };
}

async function handle(req: Request, sender: chrome.runtime.MessageSender): Promise<unknown> {
  // Only our own content script, running in a normal web page, may ask.
  if (sender.id !== chrome.runtime.id || !sender.tab?.id) return undefined;
  const host = hostOf(sender.url ?? '');

  const tabId = sender.tab.id;

  if (req.type === 'state') {
    const record = await unlocked();
    if (record && Date.now() - lastSync > STALE_MS) void syncSoon();
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

  if (req.type === 'sawUsername') {
    if (!host || !req.username) return undefined;
    const prev = (await pendingMap())[tabId];
    await setPending(tabId, {
      ...(prev && prev.host === host ? prev : { host, origin: '', username: '', password: '', prompt: 'new' }),
      lastUsername: req.username.slice(0, 256),
      at: Date.now(),
    });
    return undefined;
  }

  if (req.type === 'captured') {
    if (!host || !(await unlocked())) return { prompt: null } satisfies SavePromptReply;
    const prev = (await pendingMap())[tabId];
    const username = (req.username || (prev?.host === host ? prev.lastUsername : '') || '').slice(0, 256);
    const password = req.password.slice(0, 1024);
    const verdict = await judge(host, username, password);
    if (!verdict.prompt) {
      await setPending(tabId, undefined);
      return { prompt: null } satisfies SavePromptReply;
    }
    await setPending(tabId, {
      host,
      origin: new URL(sender.url!).origin,
      username,
      password,
      prompt: verdict.prompt,
      id: verdict.id,
      at: Date.now(),
      lastUsername: username,
    });
    return { prompt: verdict.prompt, username, host } satisfies SavePromptReply;
  }

  if (req.type === 'pendingSave') {
    const p = (await pendingMap())[tabId];
    if (!p || !p.password || p.host !== host || Date.now() - p.at > PENDING_FOR_MS || !(await unlocked())) {
      return { prompt: null } satisfies SavePromptReply;
    }
    return { prompt: p.prompt, username: p.username, host: p.host } satisfies SavePromptReply;
  }

  if (req.type === 'saveAnswer') {
    const p = (await pendingMap())[tabId];
    await setPending(tabId, undefined);
    if (!p || !p.password || p.host !== host) return { ok: false };
    if (req.action === 'never') {
      const list = await neverSave();
      if (!list.includes(host)) await chrome.storage.local.set({ [NEVER_SAVE_KEY]: [...list, host] });
      return { ok: true };
    }
    if (req.action !== 'save') return { ok: true };
    const record = await unlocked();
    if (!record) return { ok: false };
    await saveLogin(record.password, p);
    return { ok: true };
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

/**
 * A sign-in form usually navigates away right after it reports what was typed, so the next page
 * can ask for the pending save before that report is processed. Remember reports in flight per tab
 * so the question waits for them.
 */
const inFlight = new Map<number, Promise<unknown>>();

chrome.runtime.onMessage.addListener((req: Request, sender, reply) => {
  const tabId = sender.tab?.id;
  let work: Promise<unknown>;
  if (req.type === 'pendingSave' && tabId !== undefined && inFlight.has(tabId)) {
    work = inFlight.get(tabId)!.then(() => handle(req, sender), () => handle(req, sender));
  } else {
    work = handle(req, sender);
  }
  if ((req.type === 'captured' || req.type === 'sawUsername') && tabId !== undefined) {
    inFlight.set(tabId, work);
    void work.finally(() => inFlight.get(tabId) === work && inFlight.delete(tabId));
  }
  work.then(reply, () => reply(undefined));
  return true; // answer asynchronously
});
