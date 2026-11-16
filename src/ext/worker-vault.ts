/**
 * Vault changes made by the background worker (saving a login from a web page, syncing with
 * Drive while no KaiPass window is open). It opens this device's copy with the master password the
 * user unlocked with, makes the change, saves, syncs, and publishes the new fill index.
 */
import { Session, storedMeta } from '../lib/session';
import type { ItemDraft } from '../lib/vault';
import { cleanupExpiredShares } from '../lib/share';
import { writeFillIndex } from './browser';
import { BUMP_KEY } from './match';

let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs vault work one job at a time: two jobs opening the same copy at once would each save
 * their own version and the later one would undo the earlier.
 */
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

/** `work` returns true when it changed the vault, so open pages and the fill index catch up. */
function withSession(password: string, work: (s: Session) => Promise<boolean>): Promise<boolean> {
  return exclusive(async () => {
    const session = await Session.unlock(password);
    try {
      const changed = await work(session);
      if (changed) {
        await writeFillIndex(session.vault);
        await chrome.storage.session.set({ [BUMP_KEY]: Date.now() });
      }
      return changed;
    } finally {
      session.close();
    }
  });
}

export interface LoginToSave {
  id?: string;
  host: string;
  origin: string;
  username: string;
  password: string;
}

export async function saveLogin(password: string, login: LoginToSave): Promise<void> {
  await withSession(password, async (session) => {
    const existing = login.id ? session.vault.item(login.id) : undefined;
    const draft: ItemDraft = existing
      ? { ...existing, password: login.password, username: existing.username || login.username }
      : {
          type: 'login',
          title: login.host,
          username: login.username,
          password: login.password,
          url: login.origin,
          notes: '',
          otp: '',
          fields: [],
          tags: [],
          favorite: false,
          folderId: '',
        };
    session.vault.upsert(draft);
    await session.commit();
    await session.sync();
    return true;
  });
}

/** Pulls changes from Drive. Returns false when there was nothing to do or no way to reach Drive. */
export async function backgroundSync(password: string): Promise<boolean> {
  // Opening the vault costs about a second of key derivation; skip it for device-only vaults.
  if ((await storedMeta())?.mode !== 'drive') return false;
  return withSession(password, async (session) => {
    const before = session.meta.rev;
    await session.sync();
    if (session.drive) await cleanupExpiredShares(session.drive).catch(() => {});
    return session.meta.rev !== before;
  });
}
