/** Address matching shared by the popup and the background worker. No DOM or chrome.* use here. */
import { getDomain } from 'tldts';

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
 * The registrable domain ("site") of a host, using the Public Suffix List including its private
 * section, so alice.github.io and evil.github.io are different sites while
 * us-east-1.signin.aws.amazon.com and console.aws.amazon.com are both amazon.com.
 * Undefined for IP addresses and names like localhost.
 */
function siteOf(host: string): string | undefined {
  return getDomain(host, { allowPrivateDomains: true }) ?? undefined;
}

function sharedLabels(a: string, b: string): number {
  const x = a.split('.').reverse();
  const y = b.split('.').reverse();
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

/**
 * How well a saved address fits the page, 0 meaning "do not offer it". The same host scores
 * highest; otherwise addresses on the same site rank by how much of the name they share, so on
 * us-east-1.signin.aws.amazon.com a login saved for ap-southeast-2.signin.aws.amazon.com ranks
 * above one saved for console.aws.amazon.com, which ranks above one for amazon.com. A login is
 * never offered on example.com.evil.net or on another github.io site.
 */
export function matchScore(saved: string, page: string): number {
  if (!saved || !page) return 0;
  if (saved === page) return 1000;
  const shared = sharedLabels(saved, page);
  const nested = page.endsWith(`.${saved}`) || saved.endsWith(`.${page}`);
  const site = siteOf(page);
  if (!nested && !(site && site === siteOf(saved))) return 0;
  return shared * 10 + (nested ? 5 : 0);
}

export function hostMatches(saved: string, page: string): boolean {
  return matchScore(saved, page) > 0;
}

export const UNLOCK_KEY = 'kaipass.unlock';
export const FILL_INDEX_KEY = 'kaipass.fill';
export const INLINE_PREFS_KEY = 'kaipass.inline';
/** Hosts the user told us never to offer saving for (storage.local). */
export const NEVER_SAVE_KEY = 'kaipass.neverSave';
/** Logins captured on a page, waiting for the user's answer (storage.session, per tab). */
export const PENDING_KEY = 'kaipass.pending';
/** Bumped by the background worker after it changes this device's copy of the vault. */
export const BUMP_KEY = 'kaipass.bump';

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
  /** When the item was last edited, so new logins can be suggested first. */
  modified?: number;
  /** A logo the user picked for this item (see LogoOverride in lib/brandMatch). */
  logo?: { b?: string; t?: string; h?: string; l?: string };
}

export interface InlinePrefs {
  /** KaiPass icon and suggestion list inside login fields. */
  icon: boolean;
  /** Suggestion card at the top of login pages. */
  toast: boolean;
  /** After filling from a suggestion: press the sign-in button, and carry on through the next steps (password, OTP). */
  autoSubmit: boolean;
}

export const defaultInlinePrefs: InlinePrefs = { icon: true, toast: true, autoSubmit: true };

// ---- messages between the content script and the background worker ----

export interface SuggestItem {
  id: string;
  title: string;
  username: string;
  hasOtp: boolean;
  /** Logo of the site, when it is a well-known one: colours plus an SVG path or a short letter. */
  brand?: { bg: string; ink: string; path: string; letter?: string };
}

export type SavePrompt = 'new' | 'update';

export type Request =
  | { type: 'state' }
  | { type: 'fill'; id: string }
  /** The page shows the next step of the sign-in the user started (a password or OTP box): credentials for it, once. */
  | { type: 'flow'; want: 'password' | 'otp' }
  /** What the user-started fill put on the page, so the same step is not repeated. */
  | { type: 'flowStep'; username: boolean; password: boolean; otp: boolean }
  | { type: 'open' }
  | { type: 'sawUsername'; username: string }
  | { type: 'captured'; username: string; password: string }
  | { type: 'pendingSave' }
  | { type: 'saveAnswer'; action: 'save' | 'dismiss' | 'never' };

export interface PendingSave {
  host: string;
  origin: string;
  username: string;
  password: string;
  prompt: SavePrompt;
  /** id of the login being updated */
  id?: string;
  at: number;
}

export interface SavePromptReply {
  prompt: SavePrompt | null;
  username?: string;
  host?: string;
}

export interface StateReply {
  /** A sign-in the user started from a suggestion is still under way in this tab. */
  flow: boolean;
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
