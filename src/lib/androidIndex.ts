/**
 * What the Android autofill service gets while the vault is unlocked: the logins, with their sites
 * worked out here (Public Suffix List via tldts) so the native side can match without a list of
 * its own. Kept only in the app's memory and dropped when the vault locks.
 */
import { getDomain, getDomainWithoutSuffix } from 'tldts';
import { hostOf } from '../ext/match';
import type { Item, Vault } from './vault';

export interface AndroidEntry {
  id: string;
  title: string;
  username: string;
  password: string;
  otp: string;
  hosts: string[];
  sites: string[];
  labels: string[];
  apps: string[];
}

const uniq = (a: (string | null | undefined)[]) => [...new Set(a.filter((x): x is string => !!x))];

export function addressesOf(i: Item): string[] {
  return [i.url, ...i.fields.filter((f) => /^KP2A_URL/.test(f.name)).map((f) => f.value)].filter(Boolean);
}

export function appOf(url: string): string {
  const m = /^androidapp:\/\/([a-z0-9_.]+)/i.exec(url.trim());
  return m ? m[1].toLowerCase() : '';
}

export function androidEntries(vault: Vault): AndroidEntry[] {
  const out: AndroidEntry[] = [];
  for (const i of vault.items()) {
    if (i.trashed || i.type !== 'login') continue;
    if (!i.username && !i.password && !i.otp) continue;
    const urls = addressesOf(i);
    const hosts = uniq(urls.map(hostOf));
    out.push({
      id: i.id,
      title: i.title,
      username: i.username,
      password: i.password,
      otp: i.otp,
      hosts,
      sites: uniq(hosts.map((h) => getDomain(h, { allowPrivateDomains: true }))),
      labels: uniq(hosts.map((h) => getDomainWithoutSuffix(h, { allowPrivateDomains: true }))),
      apps: uniq(urls.map(appOf)),
    });
  }
  return out;
}
