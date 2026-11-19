/**
 * Which items get used, and when, so suggestions can put the usual ones first. Kept on this device
 * only (never in the vault): ids, a count and a time, no names or secrets.
 */
export type Usage = Record<string, { n: number; t: number }>;

const KEY = 'kaipass.usage';
const KEEP = 500;
const inExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;

export async function readUsage(): Promise<Usage> {
  try {
    if (inExtension) return ((await chrome.storage.local.get(KEY))[KEY] ?? {}) as Usage;
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Usage;
  } catch {
    return {};
  }
}

export async function bumpUsage(id: string): Promise<void> {
  const usage = await readUsage();
  usage[id] = { n: (usage[id]?.n ?? 0) + 1, t: Date.now() };
  // Forget the least recently used once the list gets long (deleted items never come back).
  const kept = Object.entries(usage).sort((a, b) => b[1].t - a[1].t).slice(0, KEEP);
  const next = Object.fromEntries(kept);
  try {
    if (inExtension) await chrome.storage.local.set({ [KEY]: next });
    else localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked: ordering just stays as it was */
  }
}

/** When an item last mattered: used on this device, or added/edited (so new items show up first). */
export const lastTouched = (usage: Usage, id: string, modified = 0): number => Math.max(usage[id]?.t ?? 0, modified);
