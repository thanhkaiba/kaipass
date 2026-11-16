/**
 * Logos for items of well-known sites, picked from the item's web address (or, failing that, its
 * title), and optional website icons for everything else. Both are per-device choices
 * (Settings → Appearance). The logo data is a separate chunk, loaded once at start-up.
 */
import { useSyncExternalStore } from 'react';
import { brandFor, resolveOverride, type BrandData, type FaviconSource, type LogoOverride } from '../lib/brandMatch';

export { faviconUrls, inkOn, type Brand, type FaviconSource } from '../lib/brandMatch';

type Data = BrandData;

const BRANDS_KEY = 'kaipass.brands';
const FAVICON_KEY = 'kaipass.favicons';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: the choice lasts until the page closes */
  }
}

type State = { data: Data | null; logos: boolean; favicons: FaviconSource; overrides: Record<string, LogoOverride> };
let state: State = {
  data: null,
  overrides: {},
  logos: read(BRANDS_KEY) !== 'off',
  favicons: (['site', 'ddg'] as const).find((v) => v === read(FAVICON_KEY)) ?? 'off',
};
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

/** Logos the user accepted per item, from the open vault. */
export function setLogoOverrides(overrides: Record<string, LogoOverride>): void {
  if (JSON.stringify(overrides) !== JSON.stringify(state.overrides)) set({ overrides });
}

export function setLogos(on: boolean): void {
  write(BRANDS_KEY, on ? 'on' : 'off');
  set({ logos: on });
}

export function setFavicons(source: FaviconSource): void {
  write(FAVICON_KEY, source);
  set({ favicons: source });
}

export function useBrandPrefs(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export const loadBrands = (): Promise<Data> =>
  state.data
    ? Promise.resolve(state.data)
    : import('../icons/brands').then((data) => {
        set({ data });
        return data;
      });

void loadBrands().catch(() => {});

/** The logo for an item, or null when logos are off, still loading, or the site is not known. */
export function useBrand(title: string, url: string, itemId?: string): ReturnType<typeof brandFor> {
  const { data, logos, overrides } = useBrandPrefs();
  if (!data || !logos) return null;
  return (itemId && resolveOverride(data, overrides[itemId])) || brandFor(data, title, url);
}

/** Icon addresses that failed this session, so a list of items does not retry them on every render. */
export const failedIcons = new Set<string>();
