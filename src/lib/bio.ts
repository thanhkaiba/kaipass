/**
 * Unlocking with the device's own lock: fingerprint, face, or the computer's password / PIN.
 *
 * A passkey is created on this device with the WebAuthn "prf" extension. Each successful
 * fingerprint (or PIN) check makes the authenticator return the same secret, from which we derive
 * a key that encrypts the master password. Only that encrypted copy is stored, on this device.
 * Without passing the device's check, the stored copy cannot be read.
 */
import { kv } from './store';

const KEY = 'bio';

interface BioRecord {
  credentialId: string;
  salt: string;
  iv: string;
  data: string;
  created: number;
}

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class BioUnavailable extends Error {}

export async function bioSupported(): Promise<boolean> {
  try {
    return (
      typeof PublicKeyCredential !== 'undefined' &&
      (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
    );
  } catch {
    return false;
  }
}

export async function bioEnrolled(): Promise<boolean> {
  return !!(await kv.get<BioRecord>(KEY));
}

async function aesFrom(prf: ArrayBuffer): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('kaipass-bio-v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function prfFor(credentialId: Uint8Array, salt: Uint8Array): Promise<ArrayBuffer> {
  let got: PublicKeyCredential | null;
  try {
    got = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: credentialId as BufferSource, transports: ['internal', 'hybrid'] }],
        userVerification: 'required',
        timeout: 60_000,
        extensions: { prf: { eval: { first: salt as BufferSource } } },
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotAllowedError') throw new Error('Đã huỷ hoặc không xác thực được');
    throw e;
  }
  const out = got?.getClientExtensionResults().prf?.results?.first;
  if (!out) throw new BioUnavailable('Thiết bị không trả về khoá cần thiết');
  return out as ArrayBuffer;
}

/** Sets up unlocking on this device. Shows the device's fingerprint / PIN prompt. */
export async function enrollBio(masterPassword: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: 'KaiPass' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'KaiPass', displayName: 'KaiPass (mở khoá trên thiết bị này)' },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
        timeout: 60_000,
        extensions: { prf: { eval: { first: salt } } },
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotAllowedError') throw new Error('Đã huỷ hoặc không xác thực được');
    throw e;
  }
  if (!cred) throw new Error('Không tạo được khoá trên thiết bị');
  const ext = cred.getClientExtensionResults().prf;
  if (!ext?.enabled && !ext?.results) {
    throw new BioUnavailable(
      'Trình duyệt hoặc thiết bị này chưa hỗ trợ mở khoá bằng vân tay cho KaiPass (cần tính năng WebAuthn PRF).',
    );
  }
  const id = new Uint8Array(cred.rawId);
  // Some authenticators only hand out the secret on sign-in, not on creation.
  const prf = (ext.results?.first as ArrayBuffer | undefined) ?? (await prfFor(id, salt));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesFrom(prf), new TextEncoder().encode(masterPassword));
  const record: BioRecord = { credentialId: b64(id), salt: b64(salt), iv: b64(iv), data: b64(data), created: Date.now() };
  await kv.set(KEY, record);
}

/** Shows the device's prompt and returns the master password stored for this device. */
export async function bioPassword(): Promise<string> {
  const r = await kv.get<BioRecord>(KEY);
  if (!r) throw new BioUnavailable('Chưa bật mở khoá bằng vân tay trên thiết bị này');
  const prf = await prfFor(unb64(r.credentialId), unb64(r.salt));
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(r.iv) as BufferSource }, await aesFrom(prf), unb64(r.data) as BufferSource);
    return new TextDecoder().decode(plain);
  } catch {
    throw new BioUnavailable('Không đọc được khoá đã lưu, hãy bật lại mở khoá bằng vân tay');
  }
}

export async function disableBio(): Promise<void> {
  await kv.del(KEY);
}
