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

const PORT = 4173;
const URL_ = `http://localhost:${PORT}/`;
const PW = 'correct horse battery';
const shots = process.env.SHOTS_DIR;

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

function totpNow(secretAscii) {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(Date.now() / 30000), 4);
  const mac = createHmac('sha1', secretAscii).update(counter).digest();
  const off = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(off) & 0x7fffffff) % 1e6).padStart(6, '0');
}

async function titlesIn(bytes) {
  const cred = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(PW));
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
const titles = async (page) => (await page.locator('.item-title').allTextContents()).sort();

async function addLogin(page, title, extra = {}) {
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Đăng nhập' }).click();
  await page.getByLabel('Tên', { exact: true }).fill(title);
  await page.getByLabel('Tên đăng nhập').fill(extra.username ?? 'user@example.com');
  await page.getByLabel('Mật khẩu', { exact: true }).fill(extra.password ?? 'p@ss-' + title);
  if (extra.otp) await page.getByLabel(/Mã bí mật OTP/).fill(extra.otp);
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
  const shown = (await page.getByTestId('otp-code').textContent()).replace(/\s/g, '');
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
  check('OTP nhập từ 1Password chạy được', (await page.getByTestId('otp-code').textContent()).replace(/\s/g, '').length === 6);

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

  check('không có lỗi trong console (bản build có CSP)', problems.length === 0, problems.join(' | '));
  await ctx.close();
}

async function driveFlow(browser) {
  console.log('\n# Đồng bộ Google Drive (Google được giả lập)');
  const drive = fakeDrive();

  const a = await device(browser, drive);
  await a.page.getByRole('button', { name: /Lưu trên Google Drive/ }).click();
  await a.page.getByLabel('Google OAuth Client ID').fill('test-client.apps.googleusercontent.com');
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

  const b = await device(browser, drive, { width: 390, height: 800 });
  await b.page.getByRole('button', { name: /Lưu trên Google Drive/ }).click();
  await b.page.getByLabel('Google OAuth Client ID').fill('test-client.apps.googleusercontent.com');
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
  await status(a.page).click();
  await waitStatus(a.page, 'synced');
  check('bấm một lần là đồng bộ lại', true);

  // Changing the master password on A: B is told what to do instead of silently failing.
  await a.page.getByRole('button', { name: 'Cài đặt' }).click();
  await a.page.getByLabel('Master password hiện tại').fill(PW);
  await a.page.getByLabel('Master password mới').fill(PW + ' v2');
  await a.page.getByLabel('Nhập lại').fill(PW + ' v2');
  await a.page.getByRole('button', { name: 'Đổi master password' }).click();
  await a.page.getByText('Đã đổi master password').waitFor();
  await a.page.getByRole('button', { name: 'Đóng' }).click();
  await waitStatus(a.page, 'synced');
  await b.page.getByRole('button', { name: 'Mở bộ lọc' }).click();
  await status(b.page).click();
  await waitStatus(b.page, 'error');
  check('máy B báo rõ khi master password đã đổi ở máy khác', (await status(b.page).getAttribute('title')).includes('master password khác'));

  for (const d of [a, b]) {
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
