import { forcedTabId, isExtension, isPopup, memory } from '../lib/platform';
import { parseOtp, totp } from '../lib/totp';
import type { Item, ItemDraft, Vault } from '../lib/vault';
import { LOGO_SETTING, parseOverrides } from '../lib/brandMatch';
import { fillPage, type FillResult } from './fill';
import { FILL_INDEX_KEY, hostMatches, hostOf, matchScore, UNLOCK_KEY, type FillEntry, type UnlockRecord } from './match';

export { hostMatches, hostOf };

export interface PageTab {
  id: number;
  host: string;
}

/** How well an item fits a page (see matchScore); 0 when it should not be offered. */
export function pageScore(item: Item, pageHost: string): number {
  if (item.trashed) return 0;
  const urls = [item.url, ...item.fields.filter((f) => /^KP2A_URL/.test(f.name)).map((f) => f.value)];
  return Math.max(0, ...urls.map((u) => matchScore(hostOf(u), pageHost)));
}

export function matchesPage(item: Item, pageHost: string): boolean {
  return pageScore(item, pageHost) > 0;
}

/** The web page the popup was opened on, if it is one we can fill. */
export async function currentTab(): Promise<PageTab | undefined> {
  if (!isPopup) return undefined;
  const tab =
    forcedTabId !== undefined
      ? await chrome.tabs.get(forcedTabId)
      : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  const host = hostOf(tab?.url ?? '');
  return tab?.id !== undefined && host ? { id: tab.id, host } : undefined;
}

/** Types the item's username, password and current one-time code into the page. */
export async function fillTab(tab: PageTab, item: Item): Promise<FillResult & { code: string }> {
  let code = '';
  if (item.otp) {
    try {
      code = await totp(parseOtp(item.otp));
    } catch {
      /* an unreadable OTP secret should not stop the password from being filled */
    }
  }
  const frames = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: fillPage,
    args: [{ host: tab.host, username: item.username, password: item.password, otp: code }],
  });
  const total = { username: false, password: false, otp: false, code };
  for (const f of frames) {
    const r = f.result as FillResult | undefined;
    if (!r) continue;
    total.username ||= r.username;
    total.password ||= r.password;
    total.otp ||= r.otp;
  }
  return total;
}

/** A screenshot of what the page's tab shows (the toolbar popup itself is not in it). */
export async function captureTab(tab: PageTab): Promise<Blob> {
  const { windowId } = await chrome.tabs.get(tab.id);
  const url = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const bytes = Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}

export function openInTab(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
}

// ---- staying unlocked between popup openings ----

/**
 * The popup is destroyed every time it closes, so the extension keeps the master password in
 * the browser's memory-only session storage until the auto-lock time passes or the browser quits.
 * Session storage is not readable by content scripts or web pages.
 */
/** Set by forget(): a touch() already under way must not put the password back after a lock. */
let lockedHere = false;

export async function remember(password: string, minutes: number): Promise<void> {
  if (!isExtension) return;
  lockedHere = false;
  const record: UnlockRecord = { password, until: minutes ? Date.now() + minutes * 60_000 : null, minutes };
  await memory.set(UNLOCK_KEY, record);
}

/**
 * "Lock after N minutes" means N minutes without anyone using the computer, not N minutes since
 * KaiPass itself was last clicked: someone working in the browser should not find it locked in
 * the middle of a sign-in. So when the time is up, the browser is asked whether the user has been
 * away that long; if not, the clock starts again.
 */
export async function stillInUse(record: UnlockRecord): Promise<boolean> {
  try {
    return (await chrome.idle.queryState(Math.max(15, record.minutes * 60))) === 'active';
  } catch {
    return false; // no idle information: lock, the safe side
  }
}

export async function recall(): Promise<string | undefined> {
  if (!isExtension) return undefined;
  const saved = await memory.get<UnlockRecord>(UNLOCK_KEY);
  if (!saved) return undefined;
  if (saved.until !== null && saved.until < Date.now()) {
    if (lockedHere || !(await stillInUse(saved))) {
      await forget();
      return undefined;
    }
    await memory.set(UNLOCK_KEY, { ...saved, until: Date.now() + saved.minutes * 60_000 } satisfies UnlockRecord);
  }
  return saved.password;
}

export async function forget(): Promise<void> {
  if (!isExtension) return;
  lockedHere = true;
  await memory.remove(UNLOCK_KEY);
  await memory.remove(FILL_INDEX_KEY);
  await memory.remove(VIEW_KEY);
}

// ---- reopening the popup where it was left ----

/**
 * Chrome destroys the toolbar popup whenever it loses focus. What the user was looking at (and
 * anything they were in the middle of typing) is kept next to the unlock record: in the browser's
 * memory-only session storage, and gone as soon as the vault locks.
 */
export interface PopupView {
  at: number;
  /** The tab the popup was opened on. */
  tabId?: number;
  selected: string | null;
  pane: 'nav' | 'list' | 'detail';
  /** The list filter, as Main keeps it. */
  filter: unknown;
  /** An edit not saved yet. */
  draft: ItemDraft | null;
}

const VIEW_KEY = 'kaipass.view';
/** How long a plain view is worth coming back to; after that the popup opens on the list again. */
const VIEW_FOR_MS = 3 * 60_000;
/** Unsaved typing is kept much longer: losing it costs the user real work. */
const DRAFT_FOR_MS = 30 * 60_000;

export async function saveView(view: PopupView): Promise<void> {
  if (isPopup) await memory.set(VIEW_KEY, view);
}

/** The view to reopen, or undefined when there is none worth restoring for this tab. */
export async function loadView(tabId: number | undefined): Promise<PopupView | undefined> {
  if (!isPopup) return undefined;
  const v = await memory.get<PopupView>(VIEW_KEY);
  if (!v) return undefined;
  const age = Date.now() - v.at;
  if (v.draft && age < DRAFT_FOR_MS) return v;
  if (v.tabId === tabId && age < VIEW_FOR_MS) return { ...v, draft: null };
  return undefined;
}

/** Pushes the auto-lock deadline back; call on user activity. */
export async function touch(minutes: number): Promise<void> {
  if (!isExtension || lockedHere) return;
  const password = await recall();
  // The user may have pressed "lock" while this was reading: then leave the vault locked.
  if (!password || lockedHere) return;
  await memory.set(UNLOCK_KEY, { password, until: minutes ? Date.now() + minutes * 60_000 : null, minutes } satisfies UnlockRecord);
  if (lockedHere) await memory.remove(UNLOCK_KEY);
}

/** Publishes the logins the background worker may offer on web pages. */
export async function writeFillIndex(vault: Vault): Promise<void> {
  if (!isExtension) return;
  const logos = parseOverrides(vault.getSetting(LOGO_SETTING));
  const entries: FillEntry[] = [];
  for (const i of vault.items()) {
    if (i.trashed) continue;
    const urls = [i.url, ...i.fields.filter((f) => /^KP2A_URL/.test(f.name)).map((f) => f.value)];
    const hosts = [...new Set(urls.map(hostOf).filter(Boolean))];
    if (!hosts.length) continue;
    entries.push({ id: i.id, title: i.title, username: i.username, password: i.password, otp: i.otp, hosts, modified: i.modified, logo: logos[i.id] });
  }
  await memory.set(FILL_INDEX_KEY, entries);
}
