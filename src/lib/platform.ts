export { isAndroid } from './android';
export { isDesktop } from './desktop';

/** True when running as the browser extension rather than as a web page. */
export const isExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;

const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);

/** True in the extension's toolbar popup (as opposed to the extension opened in a full tab). */
export const isPopup = isExtension && params.has('popup');

/** Lets a test point the popup at a specific tab; normally the popup acts on the active tab. */
export const forcedTabId = params.has('tab') ? Number(params.get('tab')) : undefined;

/**
 * Memory-only storage: cleared when the tab closes (web) or the browser closes (extension).
 * Nothing put here is written to disk.
 */
export const memory = {
  async get<T>(key: string): Promise<T | undefined> {
    if (isExtension) return (await chrome.storage.session.get(key))[key] as T | undefined;
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  },
  async set(key: string, value: unknown): Promise<void> {
    if (isExtension) await chrome.storage.session.set({ [key]: value });
    else sessionStorage.setItem(key, JSON.stringify(value));
  },
  async remove(key: string): Promise<void> {
    if (isExtension) await chrome.storage.session.remove(key);
    else sessionStorage.removeItem(key);
  },
  async clear(): Promise<void> {
    if (isExtension) await chrome.storage.session.clear();
    else sessionStorage.clear();
  },
};
