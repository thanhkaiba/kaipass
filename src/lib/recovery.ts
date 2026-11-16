/**
 * Recovery key: a way back in after forgetting the master password, set up ahead of time.
 *
 * Setting it up creates a key pair. The private key is encrypted with a random recovery key that
 * is shown to the user once (to write down or print). The master password is encrypted to the
 * public key, so it can be re-encrypted whenever the master password changes, without needing the
 * recovery key. Recovering means: recovery key → private key → master password.
 *
 * The record is stored on this device and, for Drive vaults, as a file next to the vault so a new
 * device can recover too. Anyone who has the recovery key and this record can open the vault, so
 * the recovery key must be kept as safely as the master password.
 */
import type { Drive } from './drive';
import { kv } from './store';

export const RECOVERY_FILE = 'kaipass-recovery.json';
const KEY = 'recovery';
const DIRTY = 'recoveryDirty';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface RecoveryRecord {
  v: 1;
  publicKey: string;
  /** private key (pkcs8) encrypted with the recovery key */
  privateKey: { salt: string; iv: string; data: string };
  /** master password encrypted to the public key */
  sealed: { ephemeral: string; iv: string; data: string };
  created: number;
}

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
const EC = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** 30 characters from a 32-letter alphabet, about 150 bits, shown in groups of five. */
function newRecoveryKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(30));
  const chars = Array.from(bytes, (b) => ALPHABET[b & 31]);
  return chars.join('').replace(/(.{5})(?=.)/g, '$1-');
}

export function normalizeKey(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function keyFromRecovery(recoveryKey: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(normalizeKey(recoveryKey)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: 310_000 },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function sharedKey(priv: CryptoKey, pub: CryptoKey): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('kaipass-recovery-v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(publicKey: string, masterPassword: string): Promise<RecoveryRecord['sealed']> {
  const pub = await crypto.subtle.importKey('spki', unb64(publicKey), EC, false, []);
  const eph = await crypto.subtle.generateKey(EC, true, ['deriveBits']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sharedKey(eph.privateKey, pub), new TextEncoder().encode(masterPassword));
  return { ephemeral: b64(await crypto.subtle.exportKey('spki', eph.publicKey)), iv: b64(iv), data: b64(data) };
}

/** Builds a recovery record without storing it (exported for tests). */
export async function createRecord(masterPassword: string): Promise<{ record: RecoveryRecord; recoveryKey: string }> {
  const recoveryKey = newRecoveryKey();
  const pair = await crypto.subtle.generateKey(EC, true, ['deriveBits']);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFromRecovery(recoveryKey, salt), pkcs8);
  const publicKey = b64(await crypto.subtle.exportKey('spki', pair.publicKey));
  const record: RecoveryRecord = {
    v: 1,
    publicKey,
    privateKey: { salt: b64(salt), iv: b64(iv), data: b64(encrypted) },
    sealed: await seal(publicKey, masterPassword),
    created: Date.now(),
  };
  return { record, recoveryKey };
}

/** The same record with a new master password sealed in (no recovery key needed). */
export async function withNewPassword(record: RecoveryRecord, masterPassword: string): Promise<RecoveryRecord> {
  return { ...record, sealed: await seal(record.publicKey, masterPassword) };
}

/** Creates a recovery key for this vault; returns the key to show the user (once). */
export async function setUpRecovery(masterPassword: string, drive?: Drive): Promise<string> {
  const { record, recoveryKey } = await createRecord(masterPassword);
  await save(record, drive);
  return recoveryKey;
}

/** Re-encrypts the new master password for recovery. Call after every master password change. */
export async function resealRecovery(masterPassword: string, drive?: Drive): Promise<void> {
  const record = await kv.get<RecoveryRecord>(KEY);
  if (!record) return;
  await save(await withNewPassword(record, masterPassword), drive);
}

async function save(record: RecoveryRecord, drive?: Drive): Promise<void> {
  await kv.set(KEY, record);
  await kv.set(DIRTY, true);
  if (drive) await pushRecovery(drive).catch(() => {});
}

/** Uploads the local record to Drive if Drive has not seen the latest one. */
export async function pushRecovery(drive: Drive): Promise<void> {
  if (!(await kv.get<boolean>(DIRTY))) return;
  const record = await kv.get<RecoveryRecord>(KEY);
  const bytes = new TextEncoder().encode(JSON.stringify(record ?? { v: 1, removed: true })).buffer as ArrayBuffer;
  const existing = await drive.find(RECOVERY_FILE);
  if (existing) await drive.update(existing.id, bytes);
  else if (record) await drive.create(RECOVERY_FILE, bytes);
  await kv.del(DIRTY);
}

export async function recoveryEnabled(): Promise<boolean> {
  return !!(await kv.get<RecoveryRecord>(KEY));
}

export async function removeRecovery(drive?: Drive): Promise<void> {
  await kv.del(KEY);
  await kv.set(DIRTY, true);
  if (drive) await pushRecovery(drive).catch(() => {});
}

/** The recovery record on this device, or else the one stored on Drive. */
export async function findRecovery(drive?: Drive): Promise<RecoveryRecord | undefined> {
  const local = await kv.get<RecoveryRecord>(KEY);
  if (local) return local;
  if (!drive) return undefined;
  const file = await drive.find(RECOVERY_FILE);
  if (!file) return undefined;
  const parsed = JSON.parse(new TextDecoder().decode(await drive.download(file.id)));
  return parsed?.v === 1 && parsed.publicKey ? (parsed as RecoveryRecord) : undefined;
}

export class WrongRecoveryKey extends Error {
  constructor() {
    super('Khoá khôi phục không đúng');
  }
}

/** Recovery key → master password. */
export async function recoverPassword(record: RecoveryRecord, recoveryKey: string): Promise<string> {
  let priv: CryptoKey;
  try {
    const pkcs8 = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(record.privateKey.iv) },
      await keyFromRecovery(recoveryKey, unb64(record.privateKey.salt)),
      unb64(record.privateKey.data),
    );
    priv = await crypto.subtle.importKey('pkcs8', pkcs8, EC, false, ['deriveBits']);
  } catch {
    throw new WrongRecoveryKey();
  }
  const eph = await crypto.subtle.importKey('spki', unb64(record.sealed.ephemeral), EC, false, []);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(record.sealed.iv) },
    await sharedKey(priv, eph),
    unb64(record.sealed.data),
  );
  return new TextDecoder().decode(plain);
}
