/**
 * Picks the logo of a well-known site for an item, from its web address or else its title. Pure,
 * so the extension's background worker can use it too; the data comes from src/icons/brands.ts.
 */
import { getDomain, getDomainWithoutSuffix, getHostname } from 'tldts';

export type BrandData = typeof import('../icons/brands');

export type Brand = { id: string; title: string; hex: string; path: string; letter?: string };

/** Where website icons for items without a built-in logo come from. */
export type FaviconSource = 'off' | 'site' | 'ddg';

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/** The host of an item's web address, or '' when it is not a web address. */
export function hostOfUrl(url: string): string {
  const u = url.trim();
  if (!u || (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^https?:/i.test(u))) return '';
  return getHostname(/^https?:/i.test(u) ? u : `https://${u}`)?.toLowerCase() ?? '';
}

function brandId(data: BrandData, title: string, url: string): string | undefined {
  const host = hostOfUrl(url);
  if (host) {
    // The most specific host first: mail.google.com → Gmail before google.com → Google.
    const parts = host.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      const id = data.hosts[parts.slice(i).join('.')];
      if (id) return id;
    }
    // The site name under any suffix (shopee.vn, google.com.vn). Sites hosted on someone else's
    // domain (me.github.io, app.vercel.app) are the user's own, not the host's.
    const name = getDomainWithoutSuffix(host, { allowPrivateDomains: true });
    if (name && data.names[name]) return data.names[name];
  }
  // Otherwise the title: "GitHub" or "Google - công việc" still gets its logo, even with no web
  // address or one on a company domain (github.mycompany.com).
  const whole = norm(title);
  if (data.titles[whole]) return data.titles[whole];
  // Then each word: the first may be short ("GG", "FB"); later ones need three letters or more, so
  // "Visa VCB" and "Tài khoản Google công ty" match but a stray "MB" in a note does not.
  const words = title.trim().split(/[\s\-–—|:(/)·,.]+/).map(norm).filter(Boolean);
  for (const [i, w] of words.entries()) {
    if ((i === 0 || w.length >= 3) && data.titles[w]) return data.titles[w];
  }
  return undefined;
}

export function brandFor(data: BrandData, title: string, url: string): Brand | null {
  const id = brandId(data, title, url);
  const b = id ? data.brands[id] : undefined;
  return b ? { id: id!, title: b[0], hex: b[1], path: b[2], letter: b[3] } : null;
}

/** Whether white or near-black reads better on a brand colour. */
export function inkOn(hex: string): string {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111' : '#fff';
}

/** Website icon addresses to try in order, or [] when icons are off or the item has no web address. */
export function faviconUrls(url: string, source: FaviconSource): string[] {
  const host = hostOfUrl(url);
  if (source === 'off' || !host || !host.includes('.')) return [];
  if (source === 'ddg') return [`https://icons.duckduckgo.com/ip3/${host}.ico`];
  const site = getDomain(host, { allowPrivateDomains: true }) ?? host;
  const list = [`https://${host}/apple-touch-icon.png`, `https://${host}/favicon.ico`];
  if (site !== host) list.push(`https://${site}/apple-touch-icon.png`, `https://${site}/favicon.ico`);
  return list;
}


/**
 * A logo the user accepted for one item (from "Find logos with Claude"): a bundled logo by id, or
 * a brand name, colour and letter for a site the bundle does not know. Kept in the vault, so it
 * syncs with it.
 */
export type LogoOverride = { b?: string; t?: string; h?: string; l?: string };

/** Vault setting holding { itemId: LogoOverride } as JSON. */
export const LOGO_SETTING = 'logoOverrides';

export function parseOverrides(json: string): Record<string, LogoOverride> {
  try {
    const v: unknown = json ? JSON.parse(json) : {};
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, LogoOverride>) : {};
  } catch {
    return {};
  }
}

export const HEX = /^[0-9a-f]{6}$/i;

export function resolveOverride(data: BrandData, o: LogoOverride | undefined): Brand | null {
  if (!o) return null;
  const b = o.b ? data.brands[o.b] : undefined;
  if (b) return { id: o.b!, title: b[0], hex: b[1], path: b[2], letter: b[3] };
  const letter = o.l?.trim().slice(0, 3);
  if (o.h && HEX.test(o.h) && letter) return { id: 'custom', title: o.t ?? '', hex: o.h.toUpperCase(), path: '', letter };
  return null;
}
