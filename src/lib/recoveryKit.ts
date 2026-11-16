/**
 * The recovery kit: a small, self-contained page holding the recovery key as text and as a QR
 * code, downloaded automatically when the key is made. Recovering then means picking that file
 * (or a photo / screenshot of the printed page) instead of typing 30 characters.
 */
import QRCode from 'qrcode';
import { readQrImage } from './qr';

const KEY_RE = /\b([A-Z2-9]{5}-){5}[A-Z2-9]{5}\b/;
const QR_PREFIX = 'kaipass-recovery:';

/** Finds a recovery key in any text: the kit file, a pasted note, the QR code's contents. */
export function extractKey(text: string): string | undefined {
  const upper = text.toUpperCase();
  const dashed = KEY_RE.exec(upper)?.[0];
  if (dashed) return dashed;
  // Typed without dashes, possibly with spaces.
  const compact = upper.replace(/^KAIPASS-RECOVERY:/, '').replace(/[\s-]/g, '');
  if (/^[A-Z2-9]{30}$/.test(compact)) return compact.replace(/(.{5})(?=.)/g, '$1-');
  return undefined;
}

export function kitFileName(created = new Date()): string {
  return `KaiPass-khoi-phuc-${created.toISOString().slice(0, 10)}.html`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export async function buildKit(recoveryKey: string, created = new Date()): Promise<string> {
  const qr = await QRCode.toDataURL(QR_PREFIX + recoveryKey, { width: 320, margin: 2, errorCorrectionLevel: 'M' });
  const when = created.toLocaleString('vi-VN');
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="kaipass-recovery-key" content="${esc(recoveryKey)}">
<title>Bộ khôi phục KaiPass</title>
<style>
  body { margin: 0; padding: 40px 24px; background: #f4f6fb; color: #121826; font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  .sheet { max-width: 640px; margin: 0 auto; padding: 36px; background: #fff; border: 1px solid #e2e7f0; border-radius: 18px; }
  h1 { margin: 0 0 4px; font-size: 24px; }
  .sub { margin: 0 0 24px; color: #667085; }
  .box { display: flex; gap: 24px; align-items: center; padding: 20px; border: 2px dashed #cfd6e3; border-radius: 14px; }
  .key { font: 600 21px/1.6 ui-monospace, 'SF Mono', Menlo, Consolas, monospace; letter-spacing: .04em; word-break: break-all; }
  img { width: 160px; height: 160px; flex: none; }
  ol { padding-left: 20px; }
  .warn { margin-top: 20px; padding: 12px 14px; border-radius: 10px; background: #fff6e0; color: #7a4a00; }
  .meta { margin-top: 18px; color: #98a2b3; font-size: 13px; }
  @media print { body { background: #fff; padding: 0; } .sheet { border: none; } }
</style>
</head>
<body>
<div class="sheet">
  <h1>Bộ khôi phục KaiPass</h1>
  <p class="sub">Dùng khi quên master password.</p>
  <div class="box">
    <img src="${qr}" alt="Mã QR của khoá khôi phục">
    <div>
      <div style="color:#667085;font-size:13px;margin-bottom:4px">Khoá khôi phục</div>
      <div class="key">${esc(recoveryKey)}</div>
    </div>
  </div>
  <ol>
    <li>Ở màn hình mở khoá KaiPass, bấm <b>Quên master password?</b></li>
    <li>Chọn chính file này, hoặc ảnh chụp tờ giấy đã in (có mã QR), hoặc gõ khoá ở trên.</li>
    <li>Đặt master password mới.</li>
  </ol>
  <div class="warn">Ai có khoá này cùng quyền vào Google Drive (hoặc thiết bị) của bạn sẽ mở được vault. Cất file hoặc bản in ở nơi an toàn, <b>không</b> để chung thư mục Google Drive với vault và không lưu chung với master password.</div>
  <p class="meta">Tạo lúc ${esc(when)}. Tạo khoá mới trong Cài đặt thì khoá này hết hiệu lực.</p>
</div>
</body>
</html>
`;
}

/** Reads a recovery key from the kit file, a text file, or an image of the kit's QR code. */
export async function keyFromFile(file: Blob): Promise<string | undefined> {
  if (file.type.startsWith('image/')) {
    const text = await readQrImage(file);
    return text ? extractKey(text) : undefined;
  }
  return extractKey(await file.text());
}
