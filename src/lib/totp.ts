export interface OtpConfig {
  secret: Uint8Array;
  digits: number;
  period: number;
  algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512';
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('Mã bí mật OTP không hợp lệ');
  const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let idx = 0;
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[idx++] = (value >>> bits) & 0xff;
    }
  }
  return out;
}

/** Accepts an otpauth:// URI or a bare base32 secret. */
export function parseOtp(input: string): OtpConfig {
  const raw = input.trim();
  if (!raw) throw new Error('Thiếu mã bí mật OTP');
  if (!/^otpauth:\/\//i.test(raw)) {
    return { secret: base32Decode(raw), digits: 6, period: 30, algorithm: 'SHA-1' };
  }
  const url = new URL(raw);
  if (url.hostname.toLowerCase() !== 'totp') throw new Error('Chỉ hỗ trợ OTP theo thời gian (TOTP)');
  const p = url.searchParams;
  const algo = (p.get('algorithm') || 'SHA1').toUpperCase().replace('-', '');
  const algorithm = algo === 'SHA256' ? 'SHA-256' : algo === 'SHA512' ? 'SHA-512' : 'SHA-1';
  const digits = Number(p.get('digits') || 6);
  const period = Number(p.get('period') || 30);
  if (!(digits >= 6 && digits <= 8) || !(period > 0)) throw new Error('Tham số OTP không hợp lệ');
  return { secret: base32Decode(p.get('secret') || ''), digits, period, algorithm };
}

/** Turns a bare secret into an otpauth URI (the form KeePass apps expect in the `otp` field). */
export function normalizeOtp(input: string, label = ''): string {
  const raw = input.trim();
  if (!raw) return '';
  if (/^otpauth:\/\//i.test(raw)) {
    parseOtp(raw);
    return raw;
  }
  const secret = raw.toUpperCase().replace(/[\s=-]/g, '');
  base32Decode(secret);
  const name = encodeURIComponent(label || 'KaiPass');
  return `otpauth://totp/${name}?secret=${secret}&period=30&digits=6`;
}

export async function totp(cfg: OtpConfig, nowMs = Date.now()): Promise<string> {
  const counter = Math.floor(nowMs / 1000 / cfg.period);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(4, counter >>> 0);
  new DataView(msg.buffer).setUint32(0, Math.floor(counter / 2 ** 32));
  const key = await crypto.subtle.importKey(
    'raw',
    cfg.secret as BufferSource,
    { name: 'HMAC', hash: cfg.algorithm },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** cfg.digits).padStart(cfg.digits, '0');
}

export function secondsLeft(cfg: OtpConfig, nowMs = Date.now()): number {
  return cfg.period - (Math.floor(nowMs / 1000) % cfg.period);
}
