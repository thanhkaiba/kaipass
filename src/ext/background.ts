/**
 * Background service worker. Answers the content script on web pages: which saved logins fit the
 * frame it runs in, and the credentials for one of them when the user picks it.
 *
 * It never trusts what the page or content script says about where it is: the frame's address
 * comes from Chrome (`sender.url`), and credentials are only handed to a frame whose host matches
 * the login's saved address.
 */
import * as brandData from '../icons/brands';
import { brandFor, inkOn, resolveOverride } from '../lib/brandMatch';
import { parseOtp, totp } from '../lib/totp';
import { bumpUsage, lastTouched, readUsage } from '../lib/usage';
import { stillInUse } from './browser';
import { backgroundSync, saveLogin } from './worker-vault';
import {
  defaultInlinePrefs,
  FILL_INDEX_KEY,
  hostOf,
  matchScore,
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
    // Time is up only if the user has actually been away (see stillInUse).
    if (!(await stillInUse(record))) {
      await chrome.storage.session.remove([UNLOCK_KEY, FILL_INDEX_KEY]);
      return undefined;
    }
    const renewed = { ...record, until: Date.now() + record.minutes * 60_000 };
    await chrome.storage.session.set({ [UNLOCK_KEY]: renewed });
    return renewed;
  }
  return record;
}

// The computer's own lock screen locks the vault too, at once.
chrome.idle.onStateChanged.addListener((state) => {
  if (state === 'locked') void chrome.storage.session.remove([UNLOCK_KEY, FILL_INDEX_KEY, 'kaipass.view']);
});

// Pages that showed "KaiPass is locked" are told the moment its logins become available again
// (the list is published right after an unlock), so they can show the accounts without a reload.
chrome.storage.session.onChanged.addListener((changes) => {
  const index = changes[FILL_INDEX_KEY];
  if (!index || index.oldValue !== undefined || index.newValue === undefined) return;
  void chrome.tabs.query({}).then((tabs) => {
    for (const t of tabs) if (t.id !== undefined) chrome.tabs.sendMessage(t.id, { type: 'unlocked' }).catch(() => {});
  });
});

async function entriesFor(host: string): Promise<FillEntry[]> {
  const all = ((await chrome.storage.session.get(FILL_INDEX_KEY))[FILL_INDEX_KEY] ?? []) as FillEntry[];
  const usage = await readUsage();
  const scored = all
    .map((e) => ({ e, score: Math.max(0, ...e.hosts.map((h) => matchScore(h, host))), touched: lastTouched(usage, e.id, e.modified) }))
    .filter((x) => x.score > 0);
  // Closest address first; among those, the login used (or added) most recently; then by name.
  scored.sort((a, b) => b.score - a.score || b.touched - a.touched || a.e.title.localeCompare(b.e.title));
  return scored.map((x) => x.e);
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

// ---- carrying a sign-in through its steps ----

/**
 * After the user picks a login on a page, the same tab may show more steps: a password box after
 * the username, then a code box. For a short while KaiPass fills those too, each kind once.
 */
interface Flow {
  id: string;
  until: number;
  did: { password?: boolean; otp?: boolean };
}
const FLOW_KEY = 'kaipass.flow';
const FLOW_FOR_MS = 2 * 60_000;

async function activeFlow(tabId: number): Promise<Flow | undefined> {
  const map = ((await chrome.storage.session.get(FLOW_KEY))[FLOW_KEY] ?? {}) as Record<string, Flow>;
  const flow = map[tabId];
  return flow && flow.until > Date.now() ? flow : undefined;
}

async function setFlow(tabId: number, flow: Flow): Promise<void> {
  const map = ((await chrome.storage.session.get(FLOW_KEY))[FLOW_KEY] ?? {}) as Record<string, Flow>;
  for (const [k, v] of Object.entries(map)) if (v.until <= Date.now()) delete map[k];
  map[tabId] = flow;
  await chrome.storage.session.set({ [FLOW_KEY]: map });
}

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
  // Saved a moment ago with a generated password, before the username was typed: complete it.
  const nameless = entries.find((e) => !e.username && e.password === password);
  if (username && nameless) return { prompt: 'update', id: nameless.id };
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
      flow: !!record && !!(await activeFlow(tabId)),
      locked: !record,
      host,
      prefs: await prefs(),
      items: items.map((e) => {
        const b = resolveOverride(brandData, e.logo) ?? brandFor(brandData, e.title, `https://${e.hosts[0] ?? host}`);
        return {
          id: e.id,
          title: e.title,
          username: e.username,
          hasOtp: !!e.otp,
          brand: b ? { bg: `#${b.hex}`, ink: inkOn(b.hex), path: b.path, letter: b.letter } : undefined,
        };
      }),
    };
    return reply;
  }

  if (req.type === 'fill' || req.type === 'flow') {
    const record = await unlocked();
    let id: string | undefined;
    if (req.type === 'fill') {
      id = req.id;
    } else {
      // The next step of a sign-in the user started in this tab: each kind of step once, so a
      // rejected password or code is never sent again on its own.
      const flow = await activeFlow(tabId);
      if (!flow || flow.did[req.want]) return { ok: false } satisfies FillReply;
      await setFlow(tabId, { ...flow, did: { ...flow.did, [req.want]: true } });
      id = flow.id;
    }
    // Only ever for a login saved for the site this frame is on.
    const entry = record && host ? (await entriesFor(host)).find((e) => e.id === id) : undefined;
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
    if (req.type === 'fill') {
      void bumpUsage(entry.id);
      // The user picked this login: remember it for the steps that follow (see 'flow').
      if ((await prefs()).autoSubmit) await setFlow(tabId, { id: entry.id, until: Date.now() + FLOW_FOR_MS, did: {} });
    }
    return { ok: true, username: entry.username, password: entry.password, otp } satisfies FillReply;
  }

  if (req.type === 'flowStep') {
    const flow = await activeFlow(tabId);
    if (flow) await setFlow(tabId, { ...flow, did: { password: flow.did.password || req.password, otp: flow.did.otp || req.otp } });
    return undefined;
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
    // Asked from "KaiPass is locked": the window is only there to unlock, and closes itself after.
    const justUnlock = !(await unlocked());
    await chrome.windows.create({
      url: chrome.runtime.getURL(`index.html?popup&tab=${sender.tab.id}${justUnlock ? '&unlock' : ''}`),
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
