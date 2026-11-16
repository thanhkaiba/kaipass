/**
 * Reading two-factor QR codes without a camera: from a screenshot, an image file, the current
 * browser tab, or (when there is one) the camera. Understands the usual otpauth:// codes and the
 * otpauth-migration:// codes Google Authenticator shows when exporting accounts.
 */
import jsQR from 'jsqr';
import { normalizeOtp, parseOtp } from './totp';

export interface OtpAccount {
  /** otpauth://totp/... ready to store */
  uri: string;
  issuer: string;
  account: string;
}

export interface QrResult {
  accounts: OtpAccount[];
  /** Accounts in the code that could not be used (counter-based HOTP). */
  skipped: number;
}

// ---- decoding pixels ----

const MAX_SIDE = 2400;

function scan(data: ImageData): string | null {
  return jsQR(data.data, data.width, data.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}

/** Finds a QR code in an image. Tries the full image, then a downscaled copy (faster on big screenshots). */
export async function readQrImage(source: Blob | HTMLVideoElement): Promise<string | null> {
  let bitmap: ImageBitmap | HTMLVideoElement;
  let w: number;
  let h: number;
  if (source instanceof Blob) {
    bitmap = await createImageBitmap(source);
    w = bitmap.width;
    h = bitmap.height;
  } else {
    bitmap = source;
    w = source.videoWidth;
    h = source.videoHeight;
  }
  if (!w || !h) return null;
  const sizes = [Math.min(1, MAX_SIDE / Math.max(w, h)), Math.min(1, 1000 / Math.max(w, h))];
  for (const scale of [...new Set(sizes)]) {
    const cw = Math.round(w * scale);
    const ch = Math.round(h * scale);
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, cw, ch);
    const text = scan(ctx.getImageData(0, 0, cw, ch));
    if (text) return text;
  }
  return null;
}

// ---- understanding the text ----

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Minimal protobuf reader for Google Authenticator's export format. */
function readProto(buf: Uint8Array): Map<number, (Uint8Array | number)[]> {
  const fields = new Map<number, (Uint8Array | number)[]>();
  let i = 0;
  const varint = () => {
    let shift = 0;
    let result = 0;
    for (;;) {
      if (i >= buf.length) throw new Error('truncated');
      const b = buf[i++];
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return result;
      shift += 7;
    }
  };
  while (i < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    let value: Uint8Array | number;
    if (wire === 0) value = varint();
    else if (wire === 2) {
      const len = varint();
      value = buf.subarray(i, i + len);
      i += len;
    } else if (wire === 5) {
      i += 4;
      continue;
    } else if (wire === 1) {
      i += 8;
      continue;
    } else throw new Error('unsupported wire type');
    fields.set(field, [...(fields.get(field) ?? []), value]);
  }
  return fields;
}

function label(issuer: string, account: string): string {
  return issuer && account ? `${issuer}:${account}` : issuer || account || 'KaiPass';
}

function fromMigration(text: string): QrResult {
  const data = new URL(text).searchParams.get('data');
  if (!data) throw new Error('Mã QR xuất từ Google Authenticator bị thiếu dữ liệu');
  const raw = Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const dec = new TextDecoder();
  const result: QrResult = { accounts: [], skipped: 0 };
  for (const entry of readProto(raw).get(1) ?? []) {
    if (!(entry instanceof Uint8Array)) continue;
    const f = readProto(entry);
    const one = <T,>(n: number) => f.get(n)?.[0] as T | undefined;
    const secret = one<Uint8Array>(1);
    const name = one<Uint8Array>(2);
    const issuerBytes = one<Uint8Array>(3);
    const algo = one<number>(4) ?? 1;
    const digits = one<number>(5) === 2 ? 8 : 6;
    const type = one<number>(6) ?? 2;
    if (!secret || type === 1) {
      result.skipped++;
      continue;
    }
    let account = name ? dec.decode(name) : '';
    const issuer = issuerBytes ? dec.decode(issuerBytes) : account.includes(':') ? account.split(':')[0] : '';
    if (issuer && account.startsWith(`${issuer}:`)) account = account.slice(issuer.length + 1);
    const algorithm = algo === 2 ? 'SHA256' : algo === 3 ? 'SHA512' : 'SHA1';
    const q = new URLSearchParams({ secret: base32(secret), digits: String(digits), period: '30' });
    if (algorithm !== 'SHA1') q.set('algorithm', algorithm);
    if (issuer) q.set('issuer', issuer);
    const uri = `otpauth://totp/${encodeURIComponent(label(issuer, account))}?${q}`;
    parseOtp(uri);
    result.accounts.push({ uri, issuer, account });
  }
  return result;
}

/** Turns the text of a QR code into OTP accounts, or explains why it is not one. */
export function otpFromQrText(text: string): QrResult {
  const t = text.trim();
  if (/^otpauth-migration:\/\//i.test(t)) return fromMigration(t);
  if (/^otpauth:\/\/hotp\//i.test(t)) throw new Error('Mã QR này là OTP theo bộ đếm (HOTP), KaiPass chỉ hỗ trợ OTP theo thời gian');
  if (!/^otpauth:\/\//i.test(t)) throw new Error('Mã QR này không phải mã xác thực hai bước');
  const uri = normalizeOtp(t);
  const u = new URL(uri);
  const path = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  const [maybeIssuer, ...rest] = path.split(':');
  const issuer = u.searchParams.get('issuer') ?? (rest.length ? maybeIssuer : '');
  const account = rest.length ? rest.join(':') : path;
  return { accounts: [{ uri, issuer, account: account.trim() }], skipped: 0 };
}
