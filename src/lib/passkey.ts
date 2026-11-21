/**
 * Passkeys: KaiPass acting as the authenticator for WebAuthn sign-ins. A passkey is a P-256 key
 * pair made for one site; the private key lives on the login item in the vault (in the fields
 * KeePassXC uses for passkeys), so it syncs with the vault and nothing else holds a copy.
 *
 * This module only does the cryptography and the WebAuthn byte formats. Whether a site may use a
 * passkey, and asking the user, is up to the callers (the extension and the Android app).
 */
import { getDomain } from 'tldts';

export interface Passkey {
  /** base64url */
  credentialId: string;
  /** PKCS#8, PEM */
  privateKeyPem: string;
  /** The site the passkey belongs to, e.g. "github.com". */
  rpId: string;
  username: string;
  /** The site's id for the user, base64url. */
  userHandle: string;
}

/** Field names on the vault entry (the ones KeePassXC reads and writes). */
export const PASSKEY_FIELDS = {
  credentialId: 'KPEX_PASSKEY_CREDENTIAL_ID',
  privateKeyPem: 'KPEX_PASSKEY_PRIVATE_KEY_PEM',
  rpId: 'KPEX_PASSKEY_RELYING_PARTY',
  username: 'KPEX_PASSKEY_USERNAME',
  userHandle: 'KPEX_PASSKEY_USER_HANDLE',
} as const;

export const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const unb64url = (s: string): Uint8Array => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(t + '='.repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

const utf8 = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const sha256 = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));

// ---- the little CBOR this needs: unsigned and negative integers, byte and text strings, maps ----

function head(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 0x100) return Uint8Array.of((major << 5) | 24, n);
  if (n < 0x10000) return Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff);
  return Uint8Array.of((major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;

export function cbor(v: Cbor): Uint8Array {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return concat(head(3, utf8(v).length), utf8(v));
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  const parts: Uint8Array[] = [head(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return concat(...parts);
}

// ---- keys ----

const pem = (der: ArrayBuffer) => {
  const b = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN PRIVATE KEY-----\n${b.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`;
};

async function importKey(privateKeyPem: string): Promise<CryptoKey> {
  const der = Uint8Array.from(atob(privateKeyPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** WebCrypto signs as r||s; WebAuthn wants the ASN.1 DER form. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    const body = v[0] & 0x80 ? concat(Uint8Array.of(0), v) : v;
    return concat(Uint8Array.of(0x02, body.length), body);
  };
  const r = int(raw.subarray(0, 32));
  const s = int(raw.subarray(32));
  return concat(Uint8Array.of(0x30, r.length + s.length), r, s);
}

/** Identifies KaiPass as the authenticator model ("kaipass-passkeys" in bytes). */
const AAGUID = utf8('kaipass-passkeys');

// Flags: user present, user verified (the vault was unlocked), backup eligible and backed up (the
// passkey syncs with the vault), and, when creating, "attested credential data follows".
const FLAGS_GET = 0x01 | 0x04 | 0x08 | 0x10;
const FLAGS_CREATE = FLAGS_GET | 0x40;

const clientData = (type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string, crossOrigin: boolean) =>
  utf8(JSON.stringify({ type, challenge, origin, crossOrigin }));

/**
 * Whether a page at `host` may use passkeys for `rpId`: the id must be the page's own host or a
 * parent of it, and a real site (not a bare suffix like "com" or "co.uk").
 */
export function rpIdAllowed(rpId: string, host: string): boolean {
  const id = rpId.toLowerCase();
  const h = host.toLowerCase();
  if (id === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(id)) return id === h;
  return (h === id || h.endsWith(`.${id}`)) && getDomain(id, { allowPrivateDomains: true }) !== null;
}

export interface CreatedPasskey {
  passkey: Passkey;
  /** All base64url. */
  response: {
    clientDataJSON: string;
    attestationObject: string;
    authenticatorData: string;
    /** The public key as SubjectPublicKeyInfo (what `getPublicKey()` returns). */
    publicKey: string;
  };
}

/** Makes a new passkey and the registration answer the site expects. */
export async function createPasskey(opts: {
  rpId: string;
  origin: string;
  /** base64url, as the site sent it */
  challenge: string;
  user: { id: string; name: string };
  crossOrigin?: boolean;
}): Promise<CreatedPasskey> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const credentialId = crypto.getRandomValues(new Uint8Array(32));
  const cose = cbor(
    new Map<number, Cbor>([
      [1, 2], // key type: EC2
      [3, -7], // algorithm: ES256
      [-1, 1], // curve: P-256
      [-2, unb64url(jwk.x!)],
      [-3, unb64url(jwk.y!)],
    ]),
  );
  const authData = concat(
    await sha256(utf8(opts.rpId)),
    Uint8Array.of(FLAGS_CREATE),
    new Uint8Array(4), // signature counter: 0, as synced passkeys use
    AAGUID,
    Uint8Array.of(credentialId.length >> 8, credentialId.length & 0xff),
    credentialId,
    cose,
  );
  const attestation = cbor(new Map<string, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
  return {
    passkey: {
      credentialId: b64url(credentialId),
      privateKeyPem: pem(await crypto.subtle.exportKey('pkcs8', keys.privateKey)),
      rpId: opts.rpId,
      username: opts.user.name,
      userHandle: opts.user.id,
    },
    response: {
      clientDataJSON: b64url(clientData('webauthn.create', opts.challenge, opts.origin, !!opts.crossOrigin)),
      attestationObject: b64url(attestation),
      authenticatorData: b64url(authData),
      publicKey: b64url(await crypto.subtle.exportKey('spki', keys.publicKey)),
    },
  };
}

export interface PasskeyAssertion {
  /** All base64url. */
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle: string;
}

/** Signs a site's sign-in challenge with a passkey. */
export async function signWithPasskey(
  passkey: Passkey,
  opts: { origin: string; challenge: string; crossOrigin?: boolean },
): Promise<PasskeyAssertion> {
  const authData = concat(await sha256(utf8(passkey.rpId)), Uint8Array.of(FLAGS_GET), new Uint8Array(4));
  const client = clientData('webauthn.get', opts.challenge, opts.origin, !!opts.crossOrigin);
  const signed = concat(authData, await sha256(client));
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await importKey(passkey.privateKeyPem), signed as BufferSource));
  return {
    clientDataJSON: b64url(client),
    authenticatorData: b64url(authData),
    signature: b64url(derSignature(raw)),
    userHandle: passkey.userHandle,
  };
}
