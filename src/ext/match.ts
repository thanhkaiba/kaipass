/** Address matching shared by the popup and the background worker. No DOM or chrome.* use here. */

/** Host name without "www.", or '' for anything that is not a web address. */
export function hostOf(url: string): string {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
    if (!/^https?:$/.test(u.protocol)) return '';
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * A saved address matches a page when the hosts are equal or one is a subdomain of the other,
 * so a login saved for example.com is offered on login.example.com but never on example.com.evil.net.
 */
export function hostMatches(saved: string, page: string): boolean {
  if (!saved || !page) return false;
  return saved === page || page.endsWith(`.${saved}`) || saved.endsWith(`.${page}`);
}

export const UNLOCK_KEY = 'kaipass.unlock';
export const FILL_INDEX_KEY = 'kaipass.fill';
export const INLINE_PREFS_KEY = 'kaipass.inline';

export interface UnlockRecord {
  password: string;
  /** Epoch ms after which the vault counts as locked; null means never. */
  until: number | null;
  /** Auto-lock length, so the background worker can push `until` back on use. */
  minutes: number;
}

/** What the background worker needs to autofill, kept only in memory-only session storage. */
export interface FillEntry {
  id: string;
  title: string;
  username: string;
  password: string;
  otp: string;
  hosts: string[];
}

export interface InlinePrefs {
  /** KaiPass icon and suggestion list inside login fields. */
  icon: boolean;
  /** Suggestion card in the top corner of login pages. */
  toast: boolean;
}

export const defaultInlinePrefs: InlinePrefs = { icon: true, toast: true };

// ---- messages between the content script and the background worker ----

export interface SuggestItem {
  id: string;
  title: string;
  username: string;
  hasOtp: boolean;
}

export type Request = { type: 'state' } | { type: 'fill'; id: string } | { type: 'open' };

export interface StateReply {
  locked: boolean;
  host: string;
  items: SuggestItem[];
  prefs: InlinePrefs;
}

export interface FillReply {
  ok: boolean;
  username?: string;
  password?: string;
  otp?: string;
}
