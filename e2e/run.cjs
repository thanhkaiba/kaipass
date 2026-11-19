// End-to-end check against the production build. Google sign-in and the Drive API are replaced by
// an in-memory fake, so this exercises the app's sync logic but not Google itself.
// Run: npm run build && npm run e2e
const { spawn } = require('node:child_process');
const { createHmac } = require('node:crypto');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require('playwright');
const { strToU8, zipSync } = require('fflate');
const kdbxweb = require('kdbxweb');
const { argon2id, argon2d } = require('hash-wasm');
const { fakeDrive } = require('./fake-drive.cjs');
const QRCode = require('qrcode');

/** Google Authenticator export payload (protobuf), as its "Export accounts" QR code holds it. */
function migrationUri(entries) {
  const varint = (n) => { const o = []; while (n > 127) { o.push((n & 0x7f) | 0x80); n >>>= 7; } o.push(n); return o; };
  const bytes = (f, b) => [...varint(f * 8 + 2), ...varint(b.length), ...b];
  const num = (f, n) => [...varint(f * 8), ...varint(n)];
  const text = (t) => [...Buffer.from(t, 'utf8')];
  const payload = entries.flatMap((e) => bytes(1, [...bytes(1, [...Buffer.from(e.secret)]), ...bytes(2, text(e.name)), ...bytes(3, text(e.issuer)), ...num(4, 1), ...num(5, 1), ...num(6, 2)]));
  return `otpauth-migration://offline?data=${encodeURIComponent(Buffer.from([...payload, ...num(2, 1)]).toString('base64'))}`;
}

const PORT = 4173;
const URL_ = `http://localhost:${PORT}/`;
const PW = 'correct horse battery';
const shots = process.env.SHOTS_DIR;
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const MINI_PDF =
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type) => {
  const out = await (type === 2 ? argon2id : argon2d)({
    password: new Uint8Array(password),
    salt: new Uint8Array(salt),
    memorySize: memory,
    iterations,
    hashLength: length,
    parallelism,
    outputType: 'binary',
  });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
});

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}

function totpNow(secretAscii, offsetMs = 0) {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor((Date.now() + offsetMs) / 30000), 4);
  const mac = createHmac('sha1', secretAscii).update(counter).digest();
  const off = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(off) & 0x7fffffff) % 1e6).padStart(6, '0');
}

async function titlesIn(bytes, password = PW) {
  const cred = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password));
  const db = await kdbxweb.Kdbx.load(new Uint8Array(bytes).buffer, cred);
  return [...db.getDefaultGroup().allEntries()].map((e) => e.fields.get('Title')).sort();
}

// ---- fake Google ----

const GIS_STUB = `
window.google = { accounts: { oauth2: {
  initTokenClient: (cfg) => ({ requestAccessToken: () => setTimeout(() => {
    window.__signIns = (window.__signIns || 0) + 1;
    cfg.callback({ access_token: 'fake-token', expires_in: 3600, scope: cfg.scope });
  }, 10) }),
  hasGrantedAllScopes: () => true,
} } };`;

async function device(browser, drive, viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({
    viewport,
    acceptDownloads: true,
    serviceWorkers: 'block',
    deviceScaleFactor: Number(process.env.SHOT_SCALE || 1),
  });
  await ctx.route('https://accounts.google.com/gsi/client', (r) =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: GIS_STUB }),
  );
  await ctx.route('https://www.googleapis.com/**', drive.handler);
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/net::ERR_INTERNET_DISCONNECTED/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on('dialog', (d) => d.accept());
  await page.goto(URL_);
  return { ctx, page, problems };
}

const status = (page) => page.getByTestId('sync-status');
const waitStatus = (page, s) => status(page).and(page.locator(`[data-status="${s}"]`)).waitFor({ timeout: 20000 });
/** The six-digit code once the app has worked it out (it shows dots for a moment first). */
async function otpText(page) {
  const el = page.getByTestId('otp-code');
  await el.filter({ hasText: /\d/ }).waitFor({ timeout: 5000 }).catch(() => {});
  return (await el.textContent()).replace(/\s/g, '');
}
const titles = async (page) => (await page.locator('.item-title').allTextContents()).sort();

async function addLogin(page, title, extra = {}) {
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Đăng nhập' }).click();
  await page.getByLabel('Tên', { exact: true }).fill(title);
  await page.getByLabel('Tên đăng nhập').fill(extra.username ?? 'user@example.com');
  await page.getByLabel('Mật khẩu', { exact: true }).fill(extra.password ?? 'p@ss-' + title);
  if (extra.otp) await page.getByLabel(/Mã bí mật OTP/).fill(extra.otp);
  if (extra.url) await page.getByLabel('Địa chỉ web').fill(extra.url);
  await page.getByRole('button', { name: 'Lưu' }).click();
  await page.locator('.detail-title h2', { hasText: title }).waitFor();
}

async function shot(page, name) {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function localFlow(browser) {
  console.log('\n# Vault chỉ trên thiết bị');
  const { page, problems, ctx } = await device(browser, fakeDrive());
  await page.getByRole('button', { name: /Chỉ lưu trên thiết bị này/ }).waitFor();
  await shot(page, '01-setup');
  await page.getByRole('button', { name: /Chỉ lưu trên thiết bị này/ }).click();
  await page.getByLabel('Master password', { exact: true }).fill('short');
  await page.getByLabel('Nhập lại').fill('short');
  await page.getByRole('button', { name: 'Tạo vault' }).click();
  check('từ chối master password quá ngắn', await page.getByRole('alert').isVisible());
  await page.getByLabel('Master password', { exact: true }).fill(PW);
  await page.getByLabel('Nhập lại').fill(PW);
  await page.getByRole('button', { name: 'Tạo vault' }).click();
  await waitStatus(page, 'local');
  check('tạo vault mới', true);

  // Base32 of the ASCII secret "12345678901234567890"
  await addLogin(page, 'GitHub', { otp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' });
  const expected = totpNow('12345678901234567890');
  const shown = (await otpText(page));
  // The 30-second window can roll over between the two readings.
  check('mã OTP khớp với chuẩn TOTP', [expected, totpNow('12345678901234567890')].includes(shown), `${shown} vs ${expected}`);
  check('mật khẩu bị che mặc định', (await page.locator('.row-value.mono').first().textContent()).startsWith('•'));
  await page.getByRole('button', { name: 'Hiện Mật khẩu' }).click();
  check('bấm hiện thì thấy mật khẩu', (await page.locator('.row-value.mono').first().textContent()) === 'p@ss-GitHub');
  await shot(page, '02-login');

  // Card with the template fields
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Thẻ' }).click();
  await page.getByLabel('Tên', { exact: true }).fill('Visa VCB');
  await page.getByLabel('Giá trị Số thẻ').fill('4111111111111111');
  await page.getByLabel('Giá trị Hết hạn').fill('12/2030');
  await page.getByRole('button', { name: 'Lưu' }).click();
  await page.locator('.detail-title h2', { hasText: 'Visa VCB' }).waitFor();
  check('lưu thẻ với các trường mẫu', (await page.locator('.row-label').allTextContents()).includes('Số thẻ'));

  // Attachment
  const dir = mkdtempSync(join(tmpdir(), 'kaipass-e2e-'));
  const scan = join(dir, 'cccd.txt');
  writeFileSync(scan, 'mat truoc cccd');
  await page.getByTestId('attach-input').setInputFiles(scan);
  await page.getByText('cccd.txt').waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Tải cccd.txt' }).click()]);
  check('đính kèm và tải lại file', readFileSync(await dl.path(), 'utf8') === 'mat truoc cccd');

  // Images get a thumbnail and open in the viewer; PDFs and text files open in the viewer too.
  const png = join(dir, 'cccd-mat-truoc.png');
  writeFileSync(png, Buffer.from(PNG_B64, 'base64'));
  const pdf = join(dir, 'so-do.pdf');
  writeFileSync(pdf, MINI_PDF);
  await page.getByTestId('attach-input').setInputFiles([png, pdf]);
  await page.getByRole('button', { name: 'Xem cccd-mat-truoc.png' }).waitFor();
  const thumbOk = await page.locator('.thumb img').evaluate((img) => img.complete && img.naturalWidth > 0);
  check('ảnh đính kèm hiện thumbnail', thumbOk);
  await page.getByRole('button', { name: 'Xem cccd-mat-truoc.png' }).click();
  await page.getByTestId('viewer-image').waitFor();
  check('bấm thumbnail mở ảnh lớn', await page.getByTestId('viewer-image').evaluate((img) => img.naturalWidth > 0));
  await shot(page, '09-viewer');
  await page.keyboard.press('ArrowRight');
  await page.getByTestId('viewer-pdf').waitFor();
  check('mũi tên chuyển sang file kế tiếp (PDF)', true);
  await page.keyboard.press('ArrowRight');
  check('file .txt xem được dạng chữ', (await page.getByTestId('viewer').textContent()).includes('mat truoc cccd'));
  await page.getByRole('button', { name: 'Đóng' }).click();

  // 1Password import
  const pux = join(dir, 'export.1pux');
  writeFileSync(
    pux,
    zipSync({
      'export.data': strToU8(
        JSON.stringify({
          accounts: [{ vaults: [{ attrs: { name: 'Personal' }, items: [
            { categoryUuid: '001', state: 'active', overview: { title: 'Từ 1Password', url: 'https://example.com' },
              details: { loginFields: [{ designation: 'username', value: 'alice' }, { designation: 'password', value: 'pw1' }],
                sections: [{ title: '', fields: [{ title: 'one-time password', value: { totp: 'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' } }] }] } },
            { categoryUuid: '003', state: 'active', overview: { title: 'Recovery key' }, details: { notesPlain: 'AAAA-BBBB' } },
          ] }] }],
        }),
      ),
    }),
  );
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  await page.getByRole('button', { name: 'Dữ liệu' }).click();
  await page.getByLabel('File .1pux').setInputFiles(pux);
  await page.getByText('Đã nhập 2 mục').waitFor();
  check('nhập file .1pux', true);
  await shot(page, '03-settings');

  // Encrypted backup opens outside the app
  const [backup] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Tải file .kdbx' }).click()]);
  if (shots) await backup.saveAs(join(shots, 'backup.kdbx'));
  const inBackup = await titlesIn(readFileSync(await backup.path()));
  check('file .kdbx tải về mở được bằng thư viện KeePass', inBackup.join() === ['GitHub', 'Recovery key', 'Từ 1Password', 'Visa VCB'].sort().join(), inBackup.join());
  await page.getByRole('button', { name: 'Đóng' }).click();

  await page.getByRole('button', { name: 'Từ 1Password' }).click();
  check('OTP nhập từ 1Password chạy được', (await otpText(page)).length === 6);

  // ---- sharing (device-only vault: links carry the encrypted item) ----
  const makeShare = async (title, { passphrase = '', expiry } = {}) => {
    await page.getByRole('button', { name: title, exact: false }).first().click();
    await page.getByRole('button', { name: 'Chia sẻ', exact: true }).click();
    if (expiry) await page.getByRole('group', { name: 'Hết hạn sau' }).getByRole('button', { name: expiry }).click();
    const passSwitch = page.getByRole('switch', { name: 'Đặt mật khẩu chia sẻ' });
    if (((await passSwitch.getAttribute('aria-checked')) === 'true') !== !!passphrase) await passSwitch.click();
    if (passphrase) await page.getByRole('textbox', { name: 'Mật khẩu chia sẻ' }).fill(passphrase);
    await page.getByRole('button', { name: 'Tạo link' }).click();
    const url = await page.getByLabel('Link chia sẻ').inputValue();
    await page.getByRole('button', { name: 'Đóng' }).click();
    return url;
  };
  await page.getByRole('button', { name: 'GitHub' }).first().click();
  await page.getByRole('button', { name: 'Chia sẻ', exact: true }).click();
  check('link không thu hồi được: cảnh báo rõ và bật sẵn mật khẩu chia sẻ',
    (await page.getByTestId('inline-warning').textContent()).includes('Ai có link vẫn') &&
    (await page.getByRole('switch', { name: 'Đặt mật khẩu chia sẻ' }).getAttribute('aria-checked')) === 'true');
  await page.getByRole('button', { name: 'Tạo mật khẩu chia sẻ' }).click();
  const madePass = await page.getByRole('textbox', { name: 'Mật khẩu chia sẻ' }).inputValue();
  check('ô mật khẩu chia sẻ: nút tạo sẵn mật khẩu', /^[A-Za-z0-9]{14}$/.test(madePass) && (await page.getByRole('button', { name: 'Tạo link' }).isEnabled()), madePass);
  await page.getByRole('button', { name: 'Đóng' }).click();
  const shareLink = await makeShare('GitHub', { expiry: '1 giờ' });
  check('tạo link chia sẻ dạng tự chứa', shareLink.startsWith(URL_) && shareLink.includes('#share=l.'), shareLink.slice(0, 60));
  const leakedInLink = ['p@ss-GitHub', 'GEZDGNBVGY3TQOJQ', 'user@example.com'].filter((x) => decodeURIComponent(shareLink).includes(x));
  check('link không chứa dữ liệu đọc được', leakedInLink.length === 0, leakedInLink.join());

  const recipient = await device(browser, fakeDrive());
  const rp = recipient.page;
  await rp.goto(shareLink);
  await rp.getByTestId('share-view').getByRole('heading', { name: 'GitHub' }).waitFor();
  await rp.getByRole('button', { name: 'Hiện Mật khẩu' }).click();
  check('người nhận mở link, thấy mật khẩu', (await rp.getByTestId('share-view').textContent()).includes('p@ss-GitHub'));
  check('người nhận có mã OTP chạy được', /^\d{6}$/.test((await otpText(rp))));
  await shot(rp, '10-share-view');

  const tampered = shareLink.replace(/#share=l\.(.{20})(.)/, (m, a, c) => `#share=l.${a}${c === 'A' ? 'B' : 'A'}`);
  await rp.goto(URL_);
  await rp.goto(tampered);
  await rp.getByRole('alert').waitFor();
  check('link bị sửa thì không mở được', true);

  const later = await device(browser, fakeDrive());
  await later.ctx.clock.install({ time: Date.now() + 2 * 3600_000 });
  await later.page.goto(shareLink);
  await later.page.getByRole('alert').waitFor();
  check('link quá hạn thì không mở được', (await later.page.getByRole('alert').textContent()).includes('hết hạn'));
  await later.ctx.close();

  const passLink = await makeShare('Visa VCB', { passphrase: 'mèo con' });
  await rp.goto(URL_);
  await rp.goto(passLink);
  await rp.getByLabel('Mật khẩu chia sẻ').fill('sai rồi');
  await rp.getByRole('button', { name: 'Mở', exact: true }).click();
  await rp.getByRole('alert').waitFor();
  check('link có mật khẩu: sai mật khẩu bị từ chối', (await rp.getByRole('alert').textContent()).includes('Sai mật khẩu chia sẻ'));
  await rp.getByLabel('Mật khẩu chia sẻ').fill('mèo con');
  await rp.getByRole('button', { name: 'Mở', exact: true }).click();
  await rp.getByTestId('share-view').getByRole('heading', { name: 'Visa VCB' }).waitFor();
  check('link có mật khẩu: đúng mật khẩu thì mở được', (await rp.getByTestId('share-view').textContent()).includes('Số thẻ'));

  // The recipient keeps it in their own KaiPass.
  await rp.getByRole('button', { name: 'Lưu vào KaiPass của bạn' }).click();
  await rp.getByRole('button', { name: /Chỉ lưu trên thiết bị này/ }).click();
  await rp.getByLabel('Master password', { exact: true }).fill('recipient password 1');
  await rp.getByLabel('Nhập lại').fill('recipient password 1');
  await rp.getByRole('button', { name: 'Tạo vault' }).click();
  await rp.getByLabel('Tên', { exact: true }).waitFor();
  check('"Lưu vào KaiPass" mở sẵn mục để lưu', (await rp.getByLabel('Tên', { exact: true }).inputValue()) === 'Visa VCB');
  await rp.getByRole('button', { name: 'Lưu' }).click();
  await rp.locator('.detail-title h2', { hasText: 'Visa VCB' }).waitFor();

  await rp.getByRole('button', { name: 'Thêm', exact: true }).click();
  await rp.getByRole('menuitem', { name: 'Từ link chia sẻ…' }).click();
  await rp.getByLabel('Link chia sẻ KaiPass').fill(shareLink);
  await rp.getByRole('button', { name: 'Mở link' }).click();
  await rp.getByRole('button', { name: 'Thêm vào vault' }).click();
  await rp.getByRole('button', { name: 'Lưu' }).click();
  await rp.locator('.detail-title h2', { hasText: 'GitHub' }).waitFor();
  const importedOtp = await otpText(rp).catch((e) => `ERR ${e.message.slice(0, 200)}`);
  check('"Thêm → Từ link chia sẻ" đưa mục vào vault, kèm OTP', /^\d{6}$/.test(importedOtp.replace(/\s/g, '')), importedOtp);
  check('người nhận: không có lỗi trong console', recipient.problems.length === 0, recipient.problems.join(' | '));
  await recipient.ctx.close();

  await page.getByRole('button', { name: 'GitHub' }).first().click();
  await page.getByRole('button', { name: 'Chia sẻ', exact: true }).click();
  await page.getByText('Link đang còn hạn').waitFor();
  check('danh sách link đang còn hạn', (await page.locator('.share-row').count()) === 1);
  await page.getByRole('button', { name: 'Bỏ', exact: true }).click();
  await page.getByText('Link đang còn hạn').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Đóng' }).click();

  // Search, bin, restore
  await page.getByLabel('Tìm kiếm').fill('visa');
  check('tìm kiếm lọc danh sách', (await titles(page)).join() === 'Visa VCB');
  await page.getByLabel('Tìm kiếm').fill('');
  await page.getByRole('button', { name: 'Recovery key' }).click();
  await page.getByRole('button', { name: 'Chuyển vào thùng rác' }).click();
  await page.getByRole('button', { name: /Thùng rác/ }).click();
  check('mục đã xoá nằm trong thùng rác', (await titles(page)).join() === 'Recovery key');
  await page.getByRole('button', { name: 'Recovery key' }).click();
  await page.getByRole('button', { name: 'Khôi phục' }).click();
  await page.getByRole('button', { name: /Tất cả/ }).click();
  check('khôi phục từ thùng rác', (await titles(page)).includes('Recovery key'));
  await shot(page, '04-list');

  // Lock, wrong password, unlock, reload
  await page.getByRole('button', { name: 'Khoá' }).click();
  await page.getByLabel('Master password').fill('wrong password');
  await page.getByRole('button', { name: 'Mở khoá' }).click();
  check('sai master password bị từ chối', (await page.getByRole('alert').textContent()).includes('Sai master password'));
  await shot(page, '05-lock');
  await page.reload();
  await page.getByLabel('Master password').fill(PW);
  await page.getByRole('button', { name: 'Mở khoá' }).click();
  await waitStatus(page, 'local');
  check('dữ liệu còn nguyên sau khi tải lại trang', (await titles(page)).length === 4);

  // Nothing readable is left in browser storage
  const leaked = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('kaipass'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const all = await new Promise((res) => { const r = db.transaction('kv').objectStore('kv').getAll(); r.onsuccess = () => res(r.result); });
    const text = all.map((v) => (v instanceof ArrayBuffer ? new TextDecoder('latin1').decode(v) : JSON.stringify(v))).join('\n');
    const local = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    return ['p@ss-GitHub', '4111111111111111', 'GEZDGNBVGY3TQOJQ', 'correct horse'].filter((s) => text.includes(s) || local.includes(s));
  });
  check('bộ nhớ trình duyệt không chứa dữ liệu chưa mã hoá', leaked.length === 0, leaked.join());

  // ---- lock screen safety ----
  await page.getByRole('button', { name: 'Khoá' }).click();
  await page.getByLabel('Master password').waitFor();
  check('màn hình mở khoá không có nút xoá', (await page.getByRole('button', { name: 'Xoá dữ liệu trên thiết bị này' }).count()) === 0);
  await shot(page, '11-lock');
  await page.getByRole('button', { name: 'Quên master password?' }).click();
  await page.getByText('Không tìm thấy khoá khôi phục').waitFor();
  check('chưa tạo khoá khôi phục: báo rõ là không lấy lại được', (await page.getByRole('dialog').textContent()).includes('không ai'));
  await page.getByText('Xoá dữ liệu trên thiết bị này', { exact: true }).first().click();
  const wipeBtn = page.getByRole('button', { name: 'Xoá dữ liệu trên thiết bị này' });
  check('nút xoá bị khoá cho tới khi gõ XOÁ', await wipeBtn.isDisabled());
  await page.getByLabel('Gõ "XOÁ" để xác nhận').fill('xoá');
  check('gõ XOÁ thì mới bấm được', await wipeBtn.isEnabled());
  check('vault chỉ trên máy: cảnh báo sẽ mất hẳn', (await page.locator('.danger-body').textContent()).includes('chỉ có trên thiết bị này'));
  const [lockBackup] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Tải bản sao lưu đã mã hoá (.kdbx)' }).click()]);
  check('tải được bản sao lưu ngay từ màn hình khoá', (await titlesIn(readFileSync(await lockBackup.path()))).length === 4);
  await shot(page, '12-forgot');
  await page.getByRole('button', { name: 'Đóng' }).click();
  await page.getByLabel('Master password').fill(PW);
  await page.getByRole('button', { name: 'Mở khoá', exact: true }).click();
  await waitStatus(page, 'local');

  // ---- unlocking with the device (virtual fingerprint reader) ----
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  await page.getByRole('switch', { name: 'Vân tay / mật khẩu máy' }).click();
  await page.getByLabel('Xác nhận master password').fill(PW);
  await page.getByRole('button', { name: 'Bật', exact: true }).click();
  await page.getByText('Đã bật mở khoá bằng vân tay').waitFor();
  check('bật mở khoá bằng vân tay / mật khẩu máy', true);
  await page.getByRole('button', { name: 'Đóng' }).click();
  await page.getByRole('button', { name: 'Khoá' }).click();
  await page.getByRole('button', { name: 'Mở khoá bằng vân tay / mật khẩu máy' }).click();
  await waitStatus(page, 'local');
  check('mở khoá bằng vân tay', (await titles(page)).length === 4);

  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
  await page.getByRole('button', { name: 'Khoá' }).click();
  await page.getByRole('button', { name: 'Mở khoá bằng vân tay / mật khẩu máy' }).click();
  await page.getByRole('alert').waitFor();
  check('vân tay không khớp thì vẫn khoá', await page.getByLabel('Master password').isVisible());
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
  await page.getByLabel('Master password').fill(PW);
  await page.getByRole('button', { name: 'Mở khoá', exact: true }).click();
  await waitStatus(page, 'local');

  // ---- recovery key ----
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  await page.getByRole('button', { name: 'Tạo', exact: true }).click();
  await page.getByLabel('Xác nhận master password').fill(PW);
  const [kitDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Tạo khoá', exact: true }).click()]);
  const recoveryKey = await page.getByTestId('recovery-key').locator('code').textContent();
  check('tạo khoá khôi phục', /^([A-Z2-9]{5}-){5}[A-Z2-9]{5}$/.test(recoveryKey), recoveryKey);
  const kitPath = join(mkdtempSync(join(tmpdir(), 'kaipass-kit-')), kitDownload.suggestedFilename());
  await kitDownload.saveAs(kitPath);
  check('tự tải về bộ khôi phục có khoá', /^KaiPass-khoi-phuc-.*\.html$/.test(kitDownload.suggestedFilename()) && readFileSync(kitPath, 'utf8').includes(recoveryKey), kitDownload.suggestedFilename());
  if (shots) await kitDownload.saveAs(join(shots, 'kit.html'));
  check('phải xác nhận đã cất khoá mới đóng được', await page.getByRole('button', { name: 'Xong' }).isDisabled());
  await shot(page, '13-recovery-key');
  await page.getByLabel('Tôi đã cất khoá này ở nơi an toàn').check();
  await page.getByRole('button', { name: 'Xong' }).click();
  await page.getByRole('button', { name: 'Đóng' }).click();

  await page.getByRole('button', { name: 'Khoá' }).click();
  await page.getByRole('button', { name: 'Quên master password?' }).click();
  await page.getByLabel('Khoá khôi phục').fill('AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF');
  await page.getByRole('button', { name: 'Khôi phục', exact: true }).click();
  await page.getByText('Khoá khôi phục không đúng').waitFor();
  check('khoá khôi phục sai bị từ chối', true);
  await page.getByLabel('File khôi phục').setInputFiles(kitPath);
  await page.getByRole('heading', { name: 'Đặt master password mới' }).waitFor();
  check('chọn file bộ khôi phục: mở được, không phải gõ khoá, bắt đặt master password mới', true);
  const PW2 = 'brand new master 2026';
  await page.getByLabel('Master password mới').fill(PW2);
  await page.getByLabel('Nhập lại').fill(PW2);
  await page.getByRole('button', { name: 'Lưu master password mới' }).click();
  await waitStatus(page, 'local');
  check('sau khôi phục: dữ liệu còn nguyên', (await titles(page)).length === 4);
  await page.getByRole('button', { name: 'Khoá' }).click();
  check('sau khôi phục: tắt mở khoá bằng vân tay (đã đổi mật khẩu)', (await page.getByRole('button', { name: 'Mở khoá bằng vân tay / mật khẩu máy' }).count()) === 0);
  await page.getByLabel('Master password').fill(PW);
  await page.getByRole('button', { name: 'Mở khoá', exact: true }).click();
  await page.getByRole('alert').waitFor();
  check('master password cũ không còn dùng được', (await page.getByRole('alert').textContent()).includes('Sai master password'));
  await page.getByRole('button', { name: 'Quên master password?' }).click();
  // A photo of the printed kit: only its QR code is read.
  const photo = join(mkdtempSync(join(tmpdir(), 'kaipass-photo-')), 'ban-in.png');
  await QRCode.toFile(photo, `kaipass-recovery:${recoveryKey}`, { width: 420, margin: 6 });
  await page.getByLabel('File khôi phục').setInputFiles(photo);
  await page.getByRole('heading', { name: 'Đặt master password mới' }).waitFor();
  check('ảnh chụp bản in (mã QR): khôi phục được, khoá vẫn dùng được sau khi đổi master password', true);
  await page.getByLabel('Master password mới').fill(PW2);
  await page.getByLabel('Nhập lại').fill(PW2);
  await page.getByRole('button', { name: 'Lưu master password mới' }).click();
  await waitStatus(page, 'local');

  const leaked2 = await page.evaluate(async (secrets) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('kaipass'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const all = await new Promise((res) => { const r = db.transaction('kv').objectStore('kv').getAll(); r.onsuccess = () => res(r.result); });
    const text = all.map((v) => (v instanceof ArrayBuffer ? new TextDecoder('latin1').decode(v) : JSON.stringify(v))).join('\n');
    return secrets.filter((x) => text.includes(x));
  }, [PW, PW2, recoveryKey, recoveryKey.replace(/-/g, '')]);
  check('vân tay và khoá khôi phục không để lộ mật khẩu trong bộ nhớ trình duyệt', leaked2.length === 0, leaked2.join());

  // ---- adding OTP from a QR code, without a camera ----
  const qrDir = mkdtempSync(join(tmpdir(), 'kaipass-qr-'));
  const qrFile = async (name, text) => {
    const path = join(qrDir, name);
    await QRCode.toFile(path, text, { width: 360, margin: 4 });
    return path;
  };
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Đăng nhập' }).click();
  await page.getByRole('button', { name: 'Quét mã QR' }).click();
  await page.getByLabel('Chọn ảnh có mã QR').setInputFiles(await qrFile('dropbox.png', 'otpauth://totp/Dropbox:me%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Dropbox'));
  await page.getByText('Đã thêm mã OTP').waitFor();
  check('quét QR từ ảnh: điền mã OTP, tên và tên đăng nhập', (await page.getByLabel('Tên', { exact: true }).inputValue()) === 'Dropbox' && (await page.getByLabel('Tên đăng nhập').inputValue()) === 'me@example.com');
  await page.getByRole('button', { name: 'Lưu' }).click();
  await page.locator('.detail-title h2', { hasText: 'Dropbox' }).waitFor();
  const scannedCode = await otpText(page);
  check('mục quét từ QR có mã OTP đúng', scannedCode === totpNow('12345678901234567890') || scannedCode === totpNow('12345678901234567890', -30000), scannedCode);

  // A screenshot pasted with Ctrl+V.
  const pngB64 = (await QRCode.toBuffer('otpauth://totp/Notion:team%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Notion', { width: 300, margin: 4 })).toString('base64');
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Quét mã QR (OTP)…' }).click();
  await shot(page, '14-qr-scan');
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, pngB64);
  await page.getByLabel('Tên', { exact: true }).waitFor();
  check('dán ảnh chụp màn hình có QR: mở sẵn mục mới có OTP', (await page.getByLabel('Tên', { exact: true }).inputValue()) === 'Notion');
  await page.getByRole('button', { name: 'Lưu' }).click();
  await page.locator('.detail-title h2', { hasText: 'Notion' }).waitFor();

  // A Google Authenticator export with several accounts.
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Quét mã QR (OTP)…' }).click();
  await page.getByLabel('Chọn ảnh có mã QR').setInputFiles(await qrFile('ga.png', migrationUri([
    { secret: '12345678901234567890', name: 'theo@example.com', issuer: 'AWS' },
    { secret: '12345678901234567890', name: 'theo.shop', issuer: 'Shopee' },
  ])));
  await page.getByText('Đã thêm 2 tài khoản có mã OTP').waitFor();
  const afterGa = await titles(page);
  check('mã xuất từ Google Authenticator: thêm đủ các tài khoản', afterGa.includes('AWS') && afterGa.includes('Shopee'), afterGa.join());

  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Quét mã QR (OTP)…' }).click();
  await page.getByLabel('Chọn ảnh có mã QR').setInputFiles(await qrFile('url.png', 'https://example.com/not-otp'));
  await page.getByRole('alert').waitFor();
  check('QR không phải mã OTP: báo rõ', (await page.getByRole('alert').textContent()).includes('không phải mã xác thực hai bước'));
  await page.getByRole('button', { name: 'Đóng' }).click();

  // ---- "paste a message": Claude splits it into items (the API is faked here) ----
  const claude = { requests: [], reply: null };
  // The SDK sends the key as "Authorization: Bearer"; older versions used "x-api-key".
  const apiKeyOf = (req) => req.headers()['x-api-key'] ?? (req.headers().authorization ?? '').replace(/^Bearer /, '');
  await ctx.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === '/v1/models') {
      if (apiKeyOf(req) !== 'sk-ant-test') return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' }) });
    }
    claude.requests.push({ headers: req.headers(), body: JSON.parse(req.postData()) });
    const r = claude.reply;
    if (r.status) return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: claude.requests.at(-1).body.model,
        content: r.refusal ? [] : [{ type: 'text', text: JSON.stringify({ items: typeof r.items === 'function' ? r.items(claude.requests.at(-1).body) : r.items }) }],
        stop_reason: r.refusal ? 'refusal' : 'end_turn', stop_sequence: null,
        usage: { input_tokens: 120, output_tokens: 80 },
      }),
    });
  });
  const aiItem = (o) => ({ type: 'login', title: '', username: '', password: '', url: '', otp: '', notes: '', fields: [], ...o });
  const openPaste = async () => {
    await page.getByRole('button', { name: 'Thêm', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Dán tin nhắn (Claude)…' }).click();
  };

  claude.reply = { items: [aiItem({ title: 'AWS (prod)', username: 'theo', password: 'Abc@123456', url: 'https://123456789012.signin.aws.amazon.com/console', otp: 'JBSWY3DPEHPK3PXP', fields: [{ name: 'Account ID', value: '123456789012', secret: false }] })] };
  await openPaste();
  await page.getByLabel('Tin nhắn có thông tin tài khoản').fill('acc AWS prod: theo / Abc@123456\nMFA secret: JBSWY3DPEHPK3PXP\nlink: https://123456789012.signin.aws.amazon.com/console');
  await page.getByLabel('Claude API key').fill('sk-ant-wrong');
  await page.getByRole('button', { name: 'Tách bằng Claude' }).click();
  await page.getByRole('alert').waitFor();
  check('Claude: API key sai bị báo rõ trước khi gửi nội dung', (await page.getByRole('alert').textContent()).includes('API key không đúng') && claude.requests.length === 0);
  await page.getByLabel('Claude API key').fill('sk-ant-test');
  await shot(page, '15-ai-paste');
  await page.getByRole('button', { name: 'Tách bằng Claude' }).click();
  await page.getByLabel('Tên', { exact: true }).waitFor();
  const sent = claude.requests.at(-1);
  check('Claude: một tài khoản thì mở sẵn để xem lại trước khi lưu', (await page.getByLabel('Tên', { exact: true }).inputValue()) === 'AWS (prod)' && (await page.getByLabel('Tên đăng nhập').inputValue()) === 'theo' && (await page.getByLabel('Mật khẩu', { exact: true }).inputValue()) === 'Abc@123456');
  check('Claude: gọi đúng mô hình, có kết quả theo cấu trúc và dự phòng khi bị từ chối',
    sent.body.model === 'claude-opus-5-5' && sent.body.output_config?.format?.type === 'json_schema' && sent.body.fallbacks === 'default' &&
    (sent.headers['anthropic-beta'] ?? '').includes('server-side-fallback-2026-07-01') && (sent.headers['x-api-key'] ?? sent.headers.authorization?.replace(/^Bearer /, '')) === 'sk-ant-test',
    JSON.stringify({ model: sent.body.model, format: sent.body.output_config?.format?.type, fallbacks: sent.body.fallbacks, beta: sent.headers['anthropic-beta'] }));
  check('Claude: chỉ gửi nội dung đã dán, không gửi vault', JSON.stringify(sent.body).includes('acc AWS prod') && !JSON.stringify(sent.body).includes('p@ss-GitHub'));
  await page.getByRole('button', { name: 'Lưu' }).click();
  await page.locator('.detail-title h2', { hasText: 'AWS (prod)' }).waitFor();
  check('Claude: mục lưu có mã OTP chạy được', /^\d{6}$/.test(await otpText(page)));

  claude.reply = { items: [aiItem({ title: 'Shopee', username: 'shop1', password: 'pw1' }), aiItem({ type: 'note', title: 'Wi-Fi văn phòng', fields: [{ name: 'Mật khẩu Wi-Fi', value: 'wifi-pass', secret: true }] })] };
  await openPaste();
  check('Claude: đã lưu API key, không hỏi lại, cho thấy key đang dùng', (await page.getByLabel('Claude API key').count()) === 0 && (await page.locator('.ai-key-row').textContent()).includes('sk-ant-…test'));
  await page.getByLabel('Tin nhắn có thông tin tài khoản').fill('shopee shop1/pw1, wifi văn phòng: wifi-pass');
  const shotB64 = (await QRCode.toBuffer('just an image', { width: 120 })).toString('base64');
  await page.evaluate(async (b64) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'shot.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, shotB64);
  await page.getByAltText('Ảnh dán 1').waitFor();
  await page.getByRole('button', { name: 'Tách bằng Claude' }).click();
  await page.getByText('Claude tìm thấy 2 mục').waitFor();
  check('Claude: ảnh chụp màn hình được gửi kèm', claude.requests.at(-1).body.messages[0].content.some((b) => b.type === 'image' && b.source.media_type === 'image/png'));
  await page.getByLabel('Chọn Wi-Fi văn phòng').uncheck();
  await page.getByRole('button', { name: 'Thêm 1 mục' }).click();
  await page.getByText('Đã thêm 1 mục').waitFor();
  const afterAi = await titles(page);
  check('Claude: nhiều mục thì chọn rồi thêm', afterAi.includes('Shopee') && !afterAi.includes('Wi-Fi văn phòng'));

  claude.reply = { refusal: true, items: [] };
  await openPaste();
  await page.getByLabel('Tin nhắn có thông tin tài khoản').fill('something');
  await page.getByRole('button', { name: 'Tách bằng Claude' }).click();
  await page.getByRole('alert').waitFor();
  check('Claude: bị từ chối thì báo rõ', (await page.getByRole('alert').textContent()).includes('từ chối'));
  await page.getByRole('button', { name: 'Đóng' }).click();

  await openPaste();
  await page.getByRole('button', { name: 'Đổi trong Cài đặt' }).click();
  check('Claude: key đã lưu nằm trong Cài đặt → Claude AI', (await page.getByRole('dialog', { name: 'Cài đặt' }).textContent()).includes('sk-ant-tes…test'));
  await page.getByLabel('Mô hình Claude').selectOption('claude-haiku-5-5');
  await page.getByRole('button', { name: 'Đóng' }).click();
  claude.reply = { items: [] };
  await openPaste();
  await page.getByLabel('Tin nhắn có thông tin tài khoản').fill('nothing useful');
  await page.getByRole('button', { name: 'Tách bằng Claude' }).click();
  await page.getByRole('alert').waitFor();
  const haikuReq = claude.requests.at(-1);
  check('Claude: đổi mô hình trong Cài đặt có tác dụng (Haiku không gửi dự phòng)', haikuReq.body.model === 'claude-haiku-5-5' && haikuReq.body.fallbacks === undefined);
  check('Claude: không có gì thì báo, không tạo mục rỗng', (await page.getByRole('alert').textContent()).includes('Không thấy'));
  await page.getByRole('button', { name: 'Đóng' }).click();

  // ---- icon packs and accent colour ----
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  await page.getByRole('button', { name: 'Giao diện' }).click();
  await page.getByRole('button', { name: 'Bộ icon Phosphor Duotone' }).click();
  await page.locator('.sidebar .icon-raw svg').first().waitFor({ state: 'attached' });
  check('đổi bộ icon: dùng ngay', (await page.locator('.sidebar .icon-raw').count()) > 5);
  await page.getByRole('button', { name: 'Hồng' }).click();
  check('đổi màu chủ đạo', (await page.evaluate(() => document.documentElement.dataset.accent)) === 'pink');
  await shot(page, '16-look');
  await page.getByRole('button', { name: 'Đóng' }).click();
  await page.reload();
  await page.getByLabel('Master password').waitFor();
  await page.locator('.icon-raw svg').first().waitFor({ state: 'attached' });
  check('bộ icon và màu được nhớ sau khi tải lại', (await page.evaluate(() => document.documentElement.dataset.accent)) === 'pink');
  await page.getByLabel('Master password').fill(PW2);
  await page.getByRole('button', { name: 'Mở khoá', exact: true }).click();
  await waitStatus(page, 'local');
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  await page.getByRole('button', { name: 'Giao diện' }).click();
  await page.getByRole('button', { name: 'Bộ icon Emoji' }).click();
  await page.locator('.sidebar .icon-emoji').first().waitFor({ state: 'attached' });
  check('bộ icon Emoji', (await page.locator('.sidebar .icon-emoji').count()) > 5);
  await page.getByRole('button', { name: 'Bộ icon KaiPass' }).click();
  await page.getByRole('button', { name: 'Xanh dương' }).click();
  await page.getByRole('button', { name: 'Đóng' }).click();

  // ---- logos of well-known sites, and website icons ----
  const avatarOf = (title) => page.locator('.item', { has: page.locator('.item-title', { hasText: new RegExp(`^${title}$`) }) }).locator('.avatar');
  check('logo: mục "GitHub" có logo GitHub (theo tên)', (await avatarOf('GitHub').getAttribute('data-brand')) === 'github' && (await avatarOf('GitHub').locator('svg path').count()) === 1);
  await addLogin(page, 'Ngân hàng', { url: 'https://www.vietcombank.com.vn/vi-VN' });
  check('logo: theo địa chỉ web (Vietcombank, màu thương hiệu + chữ)', (await avatarOf('Ngân hàng').getAttribute('data-brand')) === 'vietcombank' && (await avatarOf('Ngân hàng').textContent()) === 'V');
  check('logo: hiện cả ở trang chi tiết', (await page.locator('.detail [data-brand="vietcombank"]').count()) === 1);
  const iconRequests = [];
  const appIcon = readFileSync(join(__dirname, '../dist/icon-48.png'));
  const onePixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await page.route(/^https:\/\/([a-z]+\.)?example\.test\//, (route) => {
    const u = route.request().url();
    iconRequests.push(u);
    // The site's own address answers with a blank pixel, which must be skipped; its favicon.ico
    // fails (Playwright cannot route /favicon.ico); the parent domain has the real icon.
    route.fulfill({ status: 200, contentType: 'image/png', body: u.startsWith('https://shop.') ? onePixel : appIcon });
  });
  await addLogin(page, 'Cửa hàng', { url: 'https://shop.example.test/login' });
  check('icon trang web: mặc định không tải gì từ mạng', iconRequests.length === 0 && (await avatarOf('Cửa hàng').textContent()) === 'C');
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  await page.getByRole('button', { name: 'Giao diện' }).click();
  check('logo: có xem trước trong Cài đặt', (await page.locator('.brand-preview [data-brand]').count()) === 6);
  await page.getByLabel('Tải icon cho các trang khác').selectOption('site');
  await page.getByRole('button', { name: 'Đóng' }).click();
  await avatarOf('Cửa hàng').locator('img[src="https://example.test/apple-touch-icon.png"]').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.avatar.favicon img')].some((i) => i.complete && i.naturalWidth >= 8));
  check('icon trang web: lấy từ chính trang, bỏ qua ảnh rỗng và ảnh lỗi', iconRequests[0] === 'https://shop.example.test/apple-touch-icon.png' && (await avatarOf('Cửa hàng').locator('img').count()) === 1);
  check('icon trang web: không ảnh hưởng mục đã có logo', (await avatarOf('GitHub').locator('img').count()) === 0);
  await shot(page, '17-logos');
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  await page.getByRole('button', { name: 'Giao diện' }).click();
  await page.getByRole('switch', { name: 'Logo các trang nổi tiếng' }).click();
  await page.getByLabel('Tải icon cho các trang khác').selectOption('off');
  await page.getByRole('button', { name: 'Đóng' }).click();
  check('logo: tắt được, quay về chữ cái', (await avatarOf('GitHub').getAttribute('data-brand')) === null && (await avatarOf('GitHub').textContent()) === 'G' && (await avatarOf('Cửa hàng').textContent()) === 'C');
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  await page.getByRole('button', { name: 'Giao diện' }).click();
  await page.getByRole('switch', { name: 'Logo các trang nổi tiếng' }).click();
  await page.getByRole('button', { name: 'Đóng' }).click();

  // ---- find logos with Claude ----
  await addLogin(page, 'Ngân hàng của mẹ');
  await addLogin(page, 'Ví điện tử');
  claude.reply = {
    items: (body) => {
      const lines = body.messages[0].content.split('\n').filter((l) => / \| /.test(l));
      return lines.map((l) => {
        const [n, title] = l.split(' | ');
        const a = { n: Number(n), brand: '', name: '', color: '', letter: '' };
        if (title === 'Ngân hàng của mẹ') return { ...a, brand: 'acb', name: 'ACB' };
        if (title === 'Ví điện tử') return { ...a, name: 'Viettel Money', color: 'EE0033', letter: 'VM' };
        if (title === 'Cửa hàng') return { ...a, brand: 'notabrand', name: 'Shop ABC' };
        return a;
      });
    },
  };
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  await page.getByRole('button', { name: 'Giao diện' }).click();
  const missingText = await page.locator('.setting', { hasText: 'Tìm logo bằng Claude' }).textContent();
  await page.getByText('Danh sách mục chưa có logo').click();
  const missingList = await page.getByRole('list', { name: 'Mục chưa có logo' }).textContent();
  check('logo Claude: liệt kê mục chưa có logo', /\d+ mục chưa có logo/.test(missingText) && missingList.includes('Ngân hàng của mẹ') && missingList.includes('Cửa hàng') && !missingList.includes('GitHub'));
  await page.locator('.setting', { hasText: 'Tìm logo bằng Claude' }).getByRole('button', { name: 'Tìm' }).click();
  await page.getByLabel('Gán logo ACB cho Ngân hàng của mẹ').waitFor();
  const logoReq = JSON.stringify(claude.requests.at(-1).body);
  check('logo Claude: chỉ gửi tên mục và tên trang, không gửi tài khoản/mật khẩu', logoReq.includes('Ngân hàng của mẹ') && logoReq.includes('shop.example.test') && !logoReq.includes('p@ss-') && !logoReq.includes('user@example.com'));
  check('logo Claude: có logo sẵn và logo màu + chữ, bỏ id không có thật', (await page.getByRole('checkbox', { name: /^Gán logo/ }).count()) === 2 && (await page.getByLabel('Gán logo Viettel Money cho Ví điện tử').count()) === 1);
  await page.getByText(/Vẫn chưa có logo: \d+ mục/).click();
  check('logo Claude: ghi rõ mục vẫn chưa có logo', (await page.getByRole('list', { name: 'Vẫn chưa có logo' }).textContent()).includes('Shop ABC, không rõ màu'));
  await shot(page, '18-logo-claude');
  await page.getByRole('button', { name: 'Lưu 2 logo' }).click();
  await page.getByText('Đã gán logo cho 2 mục').waitFor();
  await page.getByRole('button', { name: 'Đóng' }).click();
  check('logo Claude: áp dụng ngay vào danh sách', (await avatarOf('Ngân hàng của mẹ').getAttribute('data-brand')) === 'acb' && (await avatarOf('Ví điện tử').textContent()) === 'VM');
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  await page.getByRole('button', { name: 'Giao diện' }).click();
  check('logo Claude: ghi lại số mục đã gán', (await page.locator('.setting', { hasText: 'Tìm logo bằng Claude' }).textContent()).includes('2 mục do Claude gán'));
  await page.getByRole('button', { name: 'Gỡ các logo do Claude gán' }).click();
  await page.getByRole('button', { name: 'Đóng' }).click();
  check('logo Claude: gỡ được', (await avatarOf('Ngân hàng của mẹ').getAttribute('data-brand')) === null);

  // ---- editing: a removed field can be taken back; Ctrl+A stays inside the box ----
  await page.getByRole('button', { name: 'Visa VCB' }).first().click();
  await page.getByRole('button', { name: 'Sửa' }).click();
  const fieldNames = () => page.getByLabel('Tên trường').evaluateAll((els) => els.map((e) => e.value));
  const beforeRemove = await fieldNames();
  await page.locator('.custom-field', { has: page.locator('input[value="Số thẻ"]') }).getByRole('button', { name: 'Bỏ trường' }).click();
  check('bỏ một trường: hiện nút Hoàn tác', (await page.locator('.undo-bar').textContent()).includes('Số thẻ') && !(await fieldNames()).includes('Số thẻ'));
  check('bỏ trường xong con trỏ vẫn ở trong form', await page.waitForFunction(() => document.activeElement?.classList.contains('custom-name'), null, { timeout: 3000 }).then(() => true, () => false));
  await page.keyboard.press('Control+z');
  check('Ctrl+Z lấy lại trường vừa bỏ, đúng vị trí và giá trị', JSON.stringify(await fieldNames()) === JSON.stringify(beforeRemove) && (await page.getByLabel('Giá trị Số thẻ').inputValue()) === '4111111111111111' && (await page.locator('.undo-bar').count()) === 0);
  await page.locator('.custom-field', { has: page.locator('input[value="Hết hạn"]') }).getByRole('button', { name: 'Bỏ trường' }).click();
  await page.getByLabel('Tên', { exact: true }).fill('Visa VCB 2');
  await page.keyboard.press('Control+z');
  check('đã gõ chữ sau khi bỏ trường: Ctrl+Z hoàn tác chữ, không đụng tới trường', !(await fieldNames()).includes('Hết hạn'));
  await page.getByRole('button', { name: 'Hoàn tác' }).click();
  check('nút Hoàn tác vẫn lấy lại được trường', (await fieldNames()).includes('Hết hạn'));
  await page.getByLabel('Ghi chú').fill('dòng ghi chú');
  await page.keyboard.press('Control+a');
  const inBox = await page.evaluate(() => ({ start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd, page: String(getSelection()) }));
  check('Ctrl+A trong ô nhập: chỉ chọn chữ trong ô', inBox.start === 0 && inBox.end === 'dòng ghi chú'.length && inBox.page === 'dòng ghi chú', JSON.stringify(inBox));
  await page.evaluate(() => {
    document.activeElement.setSelectionRange(0, 0);
    document.activeElement.blur();
    getSelection().removeAllRanges();
  });
  await page.keyboard.press('Control+a');
  check('Ctrl+A ngoài ô nhập: không chọn cả trang', (await page.evaluate(() => String(getSelection()))) === '');
  await page.getByRole('button', { name: 'Huỷ' }).click();

  // ---- list order ----
  const firstTitle = () => page.locator('.item-title').first().textContent();
  const alphabetical = await firstTitle();
  await page.getByLabel('Sắp xếp').selectOption('recent');
  check('sắp xếp "Mới sửa": mục vừa thêm lên đầu', (await firstTitle()) === 'Ví điện tử', await firstTitle());
  await page.getByLabel('Sắp xếp').selectOption('used');
  check('sắp xếp "Hay dùng": mục mở nhiều nhất lên đầu', (await firstTitle()) === 'GitHub', await firstTitle());
  await page.getByLabel('Sắp xếp').selectOption('name');
  check('sắp xếp theo tên như cũ', (await firstTitle()) === alphabetical);

  // Wiping for real, through the guarded path.
  await page.getByRole('button', { name: 'Khoá' }).click();
  await page.getByRole('button', { name: 'Quên master password?' }).click();
  await page.getByText('Xoá dữ liệu trên thiết bị này', { exact: true }).first().click();
  await page.getByLabel('Gõ "XOÁ" để xác nhận').fill('XOÁ');
  await page.getByRole('button', { name: 'Xoá dữ liệu trên thiết bị này' }).click();
  await page.getByRole('button', { name: /Chỉ lưu trên thiết bị này/ }).waitFor();
  check('xoá xong quay về màn hình tạo vault', true);

  // The only expected one: the deliberate wrong-API-key check answers 401.
  const unexpected = problems.filter((p) => !/status of 401/.test(p));
  check('không có lỗi trong console (bản build có CSP)', unexpected.length === 0, unexpected.join(' | '));
  await ctx.close();
}

async function driveFlow(browser) {
  console.log('\n# Đồng bộ Google Drive (Google được giả lập)');
  const drive = fakeDrive();

  const a = await device(browser, drive);
  await a.page.getByRole('button', { name: /Lưu trên Google Drive/ }).click();
  
  await a.page.getByRole('button', { name: 'Đăng nhập Google' }).click();
  await a.page.getByLabel('Master password', { exact: true }).fill(PW);
  await a.page.getByLabel('Nhập lại').fill(PW);
  await a.page.getByRole('button', { name: 'Tạo vault' }).click();
  await waitStatus(a.page, 'synced');
  check('máy A tạo vault trên Drive', drive.state.rev === 1);
  check('Drive chỉ nhận dữ liệu đã mã hoá', !drive.state.file.toString('latin1').includes('KaiPass'));

  await addLogin(a.page, 'Từ máy A');
  await a.page.waitForFunction(() => document.querySelector('[data-testid=sync-status]').dataset.status !== 'synced');
  await waitStatus(a.page, 'synced');
  check('thay đổi ở máy A được đẩy lên Drive', (await titlesIn(drive.state.file)).join() === 'Từ máy A');

  // ---- sharing through Drive: revocable links ----
  const shareFromA = async () => {
    await a.page.getByRole('button', { name: 'Từ máy A' }).first().click();
    await a.page.getByRole('button', { name: 'Chia sẻ', exact: true }).click();
    await a.page.getByRole('button', { name: 'Tạo link' }).click();
  };
  await shareFromA();
  const driveLink = await a.page.getByLabel('Link chia sẻ').inputValue();
  await a.page.getByRole('button', { name: 'Đóng' }).click();
  check('vault trên Drive: link chia sẻ qua Drive', /#share=d\.share1\./.test(driveLink), driveLink.slice(0, 80));
  check('file chia sẻ trên Drive chỉ có dữ liệu mã hoá', !drive.state.shares.get('share1').body.toString().includes('p@ss-'));
  const viewer = await device(browser, drive);
  await viewer.page.goto(driveLink);
  await viewer.page.getByTestId('share-view').getByRole('heading', { name: 'Từ máy A' }).waitFor();
  check('người nhận mở link Drive mà không cần đăng nhập Google', true);
  check('trình duyệt gửi kèm địa chỉ trang (cho API key giới hạn theo trang)', drive.state.lastShareReferrer.startsWith(URL_), drive.state.lastShareReferrer);

  await a.page.getByRole('button', { name: 'Chia sẻ', exact: true }).click();
  await a.page.getByRole('button', { name: 'Thu hồi' }).click();
  await a.page.getByText('Đã thu hồi link').waitFor();
  await a.page.getByRole('button', { name: 'Đóng' }).click();
  await viewer.page.reload();
  await viewer.page.getByRole('alert').waitFor();
  check('thu hồi: link không mở được nữa', (await viewer.page.getByRole('alert').textContent()).includes('thu hồi'));

  drive.state.blockPublic = true;
  await shareFromA();
  await a.page.getByRole('alert').waitFor();
  check('tài khoản cấm chia sẻ công khai: báo rõ', (await a.page.getByRole('alert').textContent()).includes('không cho chia sẻ file công khai'));
  check('không để lại file chia sẻ dở', drive.state.shares.size === 0);
  await a.page.getByRole('button', { name: 'Tạo link tự chứa' }).click();
  check('vẫn tạo được link tự chứa', (await a.page.getByLabel('Link chia sẻ').inputValue()).includes('#share=l.'));
  await a.page.getByRole('button', { name: 'Đóng' }).click();
  drive.state.blockPublic = false;

  await shareFromA();
  await a.page.getByRole('button', { name: 'Đóng' }).click();
  for (const s of drive.state.shares.values()) s.expires = Date.now() - 1000;
  await a.page.reload();
  await a.page.getByLabel('Master password').fill(PW);
  await a.page.getByRole('button', { name: 'Mở khoá' }).click();
  await waitStatus(a.page, 'synced');
  for (let i = 0; i < 50 && drive.state.shares.size > 0; i++) await a.page.waitForTimeout(100);
  check('link Drive quá hạn bị xoá khỏi Drive khi mở KaiPass', drive.state.shares.size === 0);
  await viewer.ctx.close();

  const b = await device(browser, drive, { width: 390, height: 800 });
  await b.page.getByRole('button', { name: /Lưu trên Google Drive/ }).click();
  
  await b.page.getByRole('button', { name: 'Đăng nhập Google' }).click();
  await b.page.getByRole('heading', { name: 'Đã tìm thấy vault trên Drive' }).waitFor();
  await b.page.getByLabel('Master password').fill(PW);
  await b.page.getByRole('button', { name: 'Mở vault' }).click();
  await b.page.locator('.item-title', { hasText: 'Từ máy A' }).waitFor();
  check('máy B (màn hình điện thoại) mở được vault từ Drive', true);
  await shot(b.page, '06-phone-list');

  await addLogin(b.page, 'Từ máy B');
  await shot(b.page, '07-phone-detail');
  await b.page.getByRole('button', { name: 'Quay lại danh sách' }).click();
  await b.page.getByRole('button', { name: 'Mở bộ lọc' }).click();
  await waitStatus(b.page, 'synced');
  await shot(b.page, '08-phone-nav');

  await status(a.page).click();
  await a.page.locator('.item-title', { hasText: 'Từ máy B' }).waitFor();
  check('máy A nhận thay đổi của máy B', true);

  // Both devices change things while A cannot reach Drive.
  drive.state.down = true;
  await addLogin(a.page, 'A lúc mất mạng');
  await a.page.waitForFunction(() => ['offline', 'pending'].includes(document.querySelector('[data-testid=sync-status]').dataset.status));
  check('máy A vẫn lưu được khi không tới được Drive', (await titles(a.page)).includes('A lúc mất mạng'));
  drive.state.down = false;
  await b.page.getByRole('button', { name: 'Đóng' }).click();
  await addLogin(b.page, 'B trong lúc đó');
  await b.page.getByRole('button', { name: 'Quay lại danh sách' }).click();
  await b.page.getByRole('button', { name: 'Mở bộ lọc' }).click();
  await waitStatus(b.page, 'synced');

  await status(a.page).click();
  await waitStatus(a.page, 'synced');
  const want = ['A lúc mất mạng', 'B trong lúc đó', 'Từ máy A', 'Từ máy B'].sort().join();
  check('máy A gộp thay đổi của cả hai máy', (await titles(a.page)).join() === want, (await titles(a.page)).join());
  check('file trên Drive chứa đủ cả bốn mục', (await titlesIn(drive.state.file)).join() === want);
  await status(b.page).click();
  await b.page.getByRole('button', { name: 'Đóng' }).click();
  await b.page.locator('.item-title', { hasText: 'A lúc mất mạng' }).waitFor();
  check('máy B nhận bản đã gộp', (await titles(b.page)).join() === want);

  // Expired Google token: unlock works offline-style, one click signs in again.
  await a.page.evaluate(() => sessionStorage.clear());
  await a.page.reload();
  await a.page.getByLabel('Master password').fill(PW);
  await a.page.getByRole('button', { name: 'Mở khoá' }).click();
  await waitStatus(a.page, 'auth');
  check('hết phiên Google: vẫn mở khoá được, báo cần đăng nhập lại', (await titles(a.page)).join() === want);
  const authBar = a.page.locator('.auth-bar');
  await authBar.waitFor();
  const barBox = await authBar.boundingBox();
  check('hết phiên Google: thanh báo chạy ngang cả app, ở trên cùng', barBox.y === 0 && barBox.width === 1280 && (await authBar.textContent()).includes('Phiên Google đã hết'));
  await shot(a.page, '19-auth-bar');
  await authBar.getByRole('button', { name: 'Để sau' }).click();
  check('bấm "Để sau": thanh báo ẩn, còn icon đăng nhập lại', (await authBar.count()) === 0 && (await a.page.getByRole('button', { name: 'Đăng nhập lại Google' }).isVisible()));
  await a.page.getByRole('button', { name: 'Đăng nhập lại Google' }).click();
  await waitStatus(a.page, 'synced');
  check('bấm icon là đăng nhập và đồng bộ lại', (await a.page.getByRole('button', { name: 'Đăng nhập lại Google' }).count()) === 0);
  // The bar's own button does the same.
  await a.page.evaluate(() => sessionStorage.clear());
  await a.page.reload();
  await a.page.getByLabel('Master password').fill(PW);
  await a.page.getByRole('button', { name: 'Mở khoá' }).click();
  await authBar.getByRole('button', { name: 'Đăng nhập lại' }).click();
  await waitStatus(a.page, 'synced');
  check('nút "Đăng nhập lại" trên thanh báo: một lần bấm là đồng bộ lại', (await authBar.count()) === 0);

  // Changing the master password on A: B is told what to do instead of silently failing.
  await a.page.getByRole('button', { name: 'Cài đặt' }).click();
  await a.page.getByRole('button', { name: 'Đổi', exact: true }).click();
  await a.page.getByLabel('Master password hiện tại', { exact: true }).fill(PW);
  await a.page.getByLabel('Master password mới').fill(PW + ' v2');
  await a.page.getByLabel('Nhập lại').fill(PW + ' v2');
  await a.page.getByRole('button', { name: 'Đổi master password' }).click();
  await a.page.getByText('Đã đổi master password').waitFor();
  await a.page.getByRole('button', { name: 'Đóng' }).click();
  await waitStatus(a.page, 'synced');
  await b.page.getByRole('button', { name: 'Mở bộ lọc' }).click();
  await status(b.page).click();
  await waitStatus(b.page, 'error');
  check('máy B báo rõ khi master password đã đổi ở máy khác', (await status(b.page).getAttribute('data-tip')).includes('master password khác'));

  // A recovery key made on A lets a brand-new device in, through the record stored on Drive.
  const PWv2 = PW + ' v2';
  await a.page.getByRole('button', { name: 'Cài đặt' }).click();
  await a.page.getByRole('button', { name: 'Tạo', exact: true }).click();
  await a.page.getByLabel('Xác nhận master password').fill(PWv2);
  await a.page.getByRole('button', { name: 'Tạo khoá', exact: true }).click();
  const driveKey = await a.page.getByTestId('recovery-key').locator('code').textContent();
  await a.page.getByLabel('Tôi đã cất khoá này ở nơi an toàn').check();
  await a.page.getByRole('button', { name: 'Xong' }).click();
  await a.page.getByRole('button', { name: 'Đóng' }).click();
  for (let i = 0; i < 50 && !drive.state.others.has('kaipass-recovery.json'); i++) await a.page.waitForTimeout(100);
  check('khoá khôi phục: bản ghi (đã mã hoá) được lưu lên Drive', drive.state.others.has('kaipass-recovery.json') && !drive.state.others.get('kaipass-recovery.json').body.toString().includes(PWv2));

  const c = await device(browser, drive);
  await c.page.getByRole('button', { name: /Lưu trên Google Drive/ }).click();
  await c.page.getByRole('button', { name: 'Đăng nhập Google' }).click();
  await c.page.getByRole('heading', { name: 'Đã tìm thấy vault trên Drive' }).waitFor();
  await c.page.getByRole('button', { name: 'Quên master password?' }).click();
  await c.page.getByLabel('Khoá khôi phục').fill(driveKey);
  await c.page.getByRole('button', { name: 'Khôi phục', exact: true }).click();
  await c.page.getByRole('heading', { name: 'Đặt master password mới' }).waitFor();
  await c.page.getByLabel('Master password mới').fill(PW + ' v3');
  await c.page.getByLabel('Nhập lại').fill(PW + ' v3');
  await c.page.getByRole('button', { name: 'Lưu master password mới' }).click();
  await waitStatus(c.page, 'synced');
  check('máy mới: khôi phục bằng khoá khôi phục trên Drive, thấy đủ dữ liệu', (await titles(c.page)).join() === want, (await titles(c.page)).join());
  const onDriveNow = await titlesIn(drive.state.file, PW + ' v3').catch(() => []);
  const oldStillWorks = await titlesIn(drive.state.file, PWv2).then(() => true, () => false);
  check('vault trên Drive giờ dùng master password mới', onDriveNow.join() === want && !oldStillWorks);

  for (const d of [a, b, c]) {
    const real = d.problems.filter((p) => !/Failed to load resource/.test(p));
    check('không có lỗi trong console', real.length === 0, real.join(' | '));
    await d.ctx.close();
  }
}

(async () => {
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(URL_)).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const browser = await chromium.launch();
    await localFlow(browser);
    await driveFlow(browser);
    await browser.close();
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    server.kill();
  }
  console.log(failures ? `\n${failures} kiểm tra thất bại` : '\nTất cả kiểm tra đều đạt');
  process.exit(failures ? 1 : 0);
})();
