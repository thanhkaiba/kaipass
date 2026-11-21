/**
 * Putting a new passkey in the vault: on the login already saved for that site and username when
 * there is one without a passkey, otherwise on a new login. Shared by the browser extension and
 * the Android app.
 */
import { hostOf, matchScore } from '../ext/match';
import type { Passkey } from './passkey';
import type { Item, ItemDraft, Vault } from './vault';

export interface PasskeyToKeep {
  /** The page it was made on, e.g. "https://github.com". */
  origin: string;
  /** The site's name for itself; the new login's title. */
  rpName: string;
  passkey: Passkey;
}

const addresses = (i: Item) => [i.url, ...i.fields.filter((f) => /^KP2A_URL/.test(f.name)).map((f) => f.value)];

/** Returns false when the vault already holds this very passkey (delivered twice). */
export function keepPasskey(vault: Vault, p: PasskeyToKeep): boolean {
  const items = vault.items().filter((i) => !i.trashed && i.type === 'login');
  if (items.some((i) => i.passkey?.credentialId === p.passkey.credentialId)) return false;
  const host = hostOf(p.origin) || p.passkey.rpId;
  const name = p.passkey.username.toLowerCase();
  const existing = items.find(
    (i) => !i.passkey && addresses(i).some((u) => matchScore(hostOf(u), host) > 0) && (!i.username || i.username.toLowerCase() === name),
  );
  const draft: ItemDraft = existing
    ? { ...existing, username: existing.username || p.passkey.username, passkey: p.passkey }
    : {
        type: 'login',
        title: p.rpName.trim() || host,
        username: p.passkey.username,
        password: '',
        url: p.origin,
        notes: '',
        otp: '',
        fields: [],
        tags: [],
        favorite: false,
        folderId: '',
        passkey: p.passkey,
      };
  vault.upsert(draft);
  return true;
}
