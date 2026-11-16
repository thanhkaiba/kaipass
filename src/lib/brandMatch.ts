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
  const first = norm(title.trim().split(/[\s\-–—|:(/·,]+/)[0] ?? '');
  return first ? data.titles[first] : undefined;
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

