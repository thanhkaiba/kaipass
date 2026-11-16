/**
 * Share links. An item is encrypted with a fresh random key (AES-256-GCM); the key travels only
 * in the link's #fragment, which browsers never send to any server.
 *
 * Two kinds of link:
 * - "drive": the encrypted item is a file on the sender's Google Drive that anyone with its id can
 *   read. Deleting the file (revoking, or expiry clean-up) kills the link for good.
 * - "inline": the encrypted item is inside the link itself. Works with no setup, but cannot be
 *   revoked; the expiry date is only honoured by KaiPass's own viewer.
 * An optional passphrase, sent separately, is mixed into the key so the link alone is not enough.
 */
import { GOOGLE_API_KEY, SHARE_BASE_URL } from '../config';
import { Drive } from './drive';
import { kv } from './store';
import type { ItemDraft, ItemField, ItemType } from './vault';

export interface SharedItem {
  type: ItemType;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  otp: string;
  fields: ItemField[];
}

export interface Envelope {
  v: 1;
  /** epoch ms */
  expires: number;
  /** base64url PBKDF2 salt, present when a passphrase is needed */
  salt?: string;
  iv: string;
  data: string;
}

export interface ShareRecord {
  id: string;
  kind: 'drive' | 'inline';
  itemId: string;
  title: string;
  created: number;
  expires: number;
  passphrase: boolean;
  /** Drive file id, for revoking */
  fileId?: string;
}

const PBKDF2_ROUNDS = 310_000;
const REGISTRY = 'shares';

// ---- encoding ----

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---- crypto ----

async function aesKey(secret: Uint8Array, passphrase: string, salt?: Uint8Array): Promise<CryptoKey> {
  let material = secret;
  if (salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PBKDF2_ROUNDS }, base, 256),
    );
    material = new Uint8Array([...secret, ...bits]);
  }
  const digest = await crypto.subtle.digest('SHA-256', material as BufferSource);
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(item: SharedItem, expires: number, passphrase = ''): Promise<{ envelope: Envelope; secret: Uint8Array }> {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const salt = passphrase ? crypto.getRandomValues(new Uint8Array(16)) : undefined;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(secret, passphrase, salt);
  // The expiry is bound into the ciphertext, so it cannot be edited without breaking decryption.
  const aad = new TextEncoder().encode(`kaipass-share-v1:${expires}`);
  const plain = new TextEncoder().encode(JSON.stringify(item));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain));
  return {
    envelope: { v: 1, expires, salt: salt && b64url(salt), iv: b64url(iv), data: b64url(data) },
    secret,
  };
}

export class SharePassphraseError extends Error {
  constructor() {
    super('Sai mật khẩu chia sẻ');
  }
}

export async function open(envelope: Envelope, secret: Uint8Array, passphrase = ''): Promise<SharedItem> {
  const key = await aesKey(secret, passphrase, envelope.salt ? fromB64url(envelope.salt) : undefined);
  const aad = new TextEncoder().encode(`kaipass-share-v1:${envelope.expires}`);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64url(envelope.iv) as BufferSource, additionalData: aad },
      key,
      fromB64url(envelope.data) as BufferSource,
    );
    return JSON.parse(new TextDecoder().decode(plain)) as SharedItem;
  } catch {
    if (envelope.salt) throw new SharePassphraseError();
    throw new Error('Link chia sẻ bị hỏng hoặc không đầy đủ');
  }
}

// ---- links ----

export interface ParsedLink {
  kind: 'drive' | 'inline';
  /** Drive file id, or the encoded envelope */
  ref: string;
  secret: Uint8Array;
}

/** Recognises "…#share=d.<fileId>.<key>" and "…#share=l.<envelope>.<key>". */
export function parseLink(text: string): ParsedLink | undefined {
  const m = /#share=([dl])\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})\s*$/.exec(text.trim());
  if (!m) return undefined;
  try {
    return { kind: m[1] === 'd' ? 'drive' : 'inline', ref: m[2], secret: fromB64url(m[3]) };
  } catch {
    return undefined;
  }
}

/** Base address for links: this page when it is the hosted web app, else the configured one. */
export function linkBase(): string {
  return /^https?:$/.test(location.protocol) ? location.origin + location.pathname : SHARE_BASE_URL;
}

/** Deletes expired share files from Drive (links stop working even if KaiPass's viewer is bypassed). */
export async function cleanupExpiredShares(drive: Drive): Promise<void> {
  if (!GOOGLE_API_KEY) return;
  await drive.deleteExpiredShares();
  await kv.set(REGISTRY, await listShares());
}

const INCOMING = 'kaipass.incoming';

/** Hands a shared item from the link viewer to the vault screen (same tab, memory only). */
export function stashIncoming(item: SharedItem): void {
  sessionStorage.setItem(INCOMING, JSON.stringify(item));
}

export function takeIncoming(): SharedItem | undefined {
  const raw = sessionStorage.getItem(INCOMING);
  sessionStorage.removeItem(INCOMING);
  return raw ? (JSON.parse(raw) as SharedItem) : undefined;
}

export class ShareGone extends Error {
  constructor() {
    super('Link này đã bị thu hồi hoặc đã hết hạn');
  }
}

export async function fetchEnvelope(link: ParsedLink): Promise<Envelope> {
  let raw: string;
  if (link.kind === 'inline') {
    raw = new TextDecoder().decode(fromB64url(link.ref));
  } else {
    if (!GOOGLE_API_KEY) throw new Error('Bản KaiPass này chưa được cấu hình để mở link chia sẻ qua Google Drive');
    const bytes = await Drive.fetchShare(link.ref, GOOGLE_API_KEY);
    if (!bytes) throw new ShareGone();
    raw = new TextDecoder().decode(bytes);
  }
  const env = JSON.parse(raw) as Envelope;
  if (env.v !== 1 || !env.iv || !env.data) throw new Error('Link chia sẻ không hợp lệ');
  if (env.expires < Date.now()) throw new ShareGone();
  return env;
}

// ---- creating and tracking shares ----

export function toShared(d: ItemDraft, includeOtp: boolean): SharedItem {
  return {
    type: d.type,
    title: d.title,
    username: d.username,
    password: d.password,
    url: d.url,
    notes: d.notes,
    otp: includeOtp ? d.otp : '',
    fields: d.fields.filter((f) => f.value),
  };
}

export function canShareOnDrive(drive?: Drive): boolean {
  return !!drive && !!GOOGLE_API_KEY;
}

export async function createShare(opts: {
  item: SharedItem;
  itemId: string;
  expires: number;
  passphrase: string;
  drive?: Drive;
  preferInline?: boolean;
}): Promise<{ url: string; record: ShareRecord }> {
  const { envelope, secret } = await seal(opts.item, opts.expires, opts.passphrase);
  const json = new TextEncoder().encode(JSON.stringify(envelope));
  const key = b64url(secret);
  const record: ShareRecord = {
    id: crypto.randomUUID(),
    kind: 'inline',
    itemId: opts.itemId,
    title: opts.item.title,
    created: Date.now(),
    expires: opts.expires,
    passphrase: !!opts.passphrase,
  };
  let url: string;
  if (!opts.preferInline && canShareOnDrive(opts.drive)) {
    const fileId = await opts.drive!.createShare(json.buffer as ArrayBuffer, opts.expires);
    record.kind = 'drive';
    record.fileId = fileId;
    url = `${linkBase()}#share=d.${fileId}.${key}`;
  } else {
    url = `${linkBase()}#share=l.${b64url(json)}.${key}`;
  }
  await kv.set(REGISTRY, [...(await listShares()), record]);
  return { url, record };
}

export async function listShares(): Promise<ShareRecord[]> {
  return ((await kv.get<ShareRecord[]>(REGISTRY)) ?? []).filter((r) => r.expires > Date.now() - 7 * 86_400_000);
}

export async function revokeShare(record: ShareRecord, drive?: Drive): Promise<void> {
  if (record.kind === 'drive') {
    if (!drive) throw new Error('Cần kết nối Google Drive để thu hồi link');
    await drive.deleteFile(record.fileId!);
  }
  await kv.set(REGISTRY, (await listShares()).filter((r) => r.id !== record.id));
}

/** A shared item as a new draft for the recipient's own vault. */
export function sharedToDraft(s: SharedItem): ItemDraft {
  return {
    type: s.type,
    title: s.title,
    username: s.username,
    password: s.password,
    url: s.url,
    notes: s.notes,
    otp: s.otp,
    fields: s.fields,
    tags: [],
    favorite: false,
    folderId: '',
  };
}
