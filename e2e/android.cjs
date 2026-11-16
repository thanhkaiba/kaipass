// Checks the web app as the Android app runs it (npm run build:android): the native side
// (Google Play sign-in, fingerprint, clipboard, files, autofill) is replaced by a fake that records
// what the page asks for. The Kotlin side has its own unit tests (android/app/src/test).
// Run: npm run build:android && npm run e2e:android
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { chromium } = require('playwright');
const { fakeDrive } = require('./fake-drive.cjs');
const { fakeNative, BRIDGE } = require('./fake-native.cjs');

const PORT = 4175;
const URL_ = `http://localhost:${PORT}/`;
const PW = 'correct horse battery';
const shots = process.env.SHOTS_DIR;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}

async function addLogin(page, title, extra = {}) {
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await page.getByRole('menuitem', { name: extra.type ?? 'Đăng nhập' }).click();
  await page.getByLabel('Tên', { exact: true }).fill(title);
  if (!extra.type) {
    await page.getByLabel('Tên đăng nhập').fill(extra.username ?? 'user@example.com');
    await page.getByLabel('Mật khẩu', { exact: true }).fill(extra.password ?? `p@ss-${title}`);
    if (extra.otp) await page.getByLabel(/Mã bí mật OTP/).fill(extra.otp);
    if (extra.url) await page.getByLabel('Địa chỉ web').fill(extra.url);
  }
  await page.getByRole('button', { name: 'Lưu' }).click();
  await page.locator('.detail-title h2', { hasText: title }).waitFor();
  // On a phone the item opens full screen; go back to the list.
  await page.getByRole('button', { name: 'Quay lại danh sách' }).click();
}

/** On a phone, Settings is in the bottom bar and opens on its list of sections. */
async function openSettings(page) {
  await page.getByRole('navigation', { name: 'Điều hướng' }).getByRole('button', { name: 'Cài đặt' }).click();
}
const backToSections = (page) => page.getByRole('button', { name: 'Quay lại Cài đặt' }).click();

const waitStatus = (page, s) => page.getByTestId('sync-status').and(page.locator(`[data-status="${s}"]`)).waitFor({ state: 'attached', timeout: 20000 });
const until = async (page, fn, what) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return true;
    await page.waitForTimeout(100);
  }
  throw new Error(`Hết giờ chờ: ${what}`);
};

async function run(browser) {
  const drive = fakeDrive();
  const n = fakeNative();
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: Number(process.env.SHOT_SCALE || 1), isMobile: true, hasTouch: true });
  const googleScripts = [];
  await ctx.route('https://accounts.google.com/**', (r) => {
    googleScripts.push(r.request().url());
    return r.abort();
  });
  await ctx.route('https://www.googleapis.com/**', drive.handler);
  await ctx.exposeBinding('__nativeCall', async (_src, raw) => {
    const { method, args } = JSON.parse(raw);
    try {
      return { ok: true, result: (await n.handle(method, args || {})) ?? null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  await ctx.addInitScript(BRIDGE);
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  const shot = async (name) => shots && (await page.screenshot({ path: join(shots, `android-${name}.png`) }));

  await page.goto(URL_);
  await page.getByRole('button', { name: /Lưu trên Google Drive/ }).click();
  await page.getByRole('button', { name: 'Đăng nhập Google' }).click();
  await page.getByLabel('Master password', { exact: true }).fill(PW);
  await page.getByLabel('Nhập lại').fill(PW);
  await page.getByRole('button', { name: 'Tạo vault' }).click();
  await waitStatus(page, 'synced');
  check('Android: đăng nhập Google qua app (Google Play), vault lên Drive', n.calls.includes('googleToken') && drive.state.rev === 1);
  check('Android: không tải script đăng nhập Google của web', googleScripts.length === 0, googleScripts.join());

  // ---- logins handed to the autofill service ----
  await addLogin(page, 'GitHub', { url: 'https://github.com/login', otp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' });
  await addLogin(page, 'Shopee app', { url: 'androidapp://com.shopee.vn', username: 'shop' });
  await addLogin(page, 'Ghi chú wifi', { type: 'Ghi chú' });
  await until(page, () => n.index?.entries?.length === 2, 'danh sách tự điền');
  const gh = n.index.entries.find((e) => e.title === 'GitHub');
  const sp = n.index.entries.find((e) => e.title === 'Shopee app');
  check('Android: gửi đăng nhập cho dịch vụ tự điền (chỉ mục đăng nhập)', !!gh && !!sp && !n.index.entries.some((e) => e.title === 'Ghi chú wifi'));
  check('Android: kèm tên miền đã tính sẵn để khớp trang', gh.hosts.join() === 'github.com' && gh.sites.join() === 'github.com' && gh.labels.join() === 'github' && gh.otp.startsWith('otpauth://'));
  check('Android: địa chỉ androidapp:// thành app', sp.apps.join() === 'com.shopee.vn' && sp.hosts.length === 0);
  check('Android: theo thời gian tự khoá', n.index.lockMinutes === 10);

  // ---- the keyboard opening must not push the screen's top out of view ----
  await page.locator('.item', { hasText: 'GitHub' }).click();
  await page.getByRole('button', { name: 'Sửa' }).click();
  await page.getByLabel('Nhãn').focus();
  await page.setViewportSize({ width: 412, height: 460 });
  await page.waitForTimeout(500);
  const fit = await page.evaluate(() => ({
    pageScroll: document.scrollingElement.scrollTop,
    extra: document.scrollingElement.scrollHeight - innerHeight,
    head: Math.round(document.querySelector('.editor .detail-head').getBoundingClientRect().top),
    field: document.activeElement.getBoundingClientRect(),
  }));
  check('Android: mở bàn phím không đẩy giao diện ra khỏi màn hình', fit.pageScroll === 0 && fit.extra === 0, JSON.stringify(fit));
  check('Android: khi gõ vẫn thấy Huỷ/Lưu và ô đang nhập', fit.head === 0 && fit.field.top > 40 && fit.field.bottom < 460, JSON.stringify(fit));
  await page.setViewportSize({ width: 412, height: 860 });
  await page.getByRole('button', { name: 'Huỷ' }).click();
  await page.getByRole('button', { name: 'Quay lại danh sách' }).click();

  // ---- clipboard goes through the app (sensitive, cleared by Android) ----
  await page.locator('.item', { hasText: 'GitHub' }).click();
  await page.getByRole('button', { name: 'Copy Mật khẩu' }).click();
  await until(page, () => n.copies.length > 0, 'chép');
  check('Android: chép mật khẩu qua app, đánh dấu nhạy cảm', n.copies.at(-1).text === 'p@ss-GitHub' && n.copies.at(-1).sensitive === true);

  // ---- Settings → Tự điền ----
  await page.getByRole('button', { name: 'Quay lại danh sách' }).click();
  await openSettings(page);
  await page.getByRole('button', { name: 'Tự điền', exact: true }).click();
  check('Android: Cài đặt → Tự điền báo chưa bật', (await page.locator('.setting', { hasText: 'Dịch vụ tự điền' }).textContent()).includes('Chưa bật'));
  await shot('settings-autofill');
  check('Android: Cài đặt cho thấy package và SHA-1 để đối chiếu với Google Cloud', (await page.locator('.app-id').textContent()).includes('SHA-1: DC:A5:E3:99'));
  await page.locator('.setting', { hasText: 'Dịch vụ tự điền' }).getByRole('button', { name: 'Bật' }).click();
  await page.evaluate(() => window.__emit('resume'));
  await page.getByText('KaiPass đang tự điền').waitFor();
  check('Android: mở cài đặt tự điền của máy, quay lại thì cập nhật', n.calls.includes('openAutofillSettings'));

  // ---- fingerprint through the phone's keystore ----
  await backToSections(page);
  await page.getByRole('button', { name: 'Bảo mật', exact: true }).click();
  await page.getByRole('switch', { name: 'Vân tay / mật khẩu máy' }).click();
  await page.getByLabel('Xác nhận master password').fill(PW);
  await page.getByRole('button', { name: 'Bật', exact: true }).click();
  await page.getByText('Đã bật mở khoá bằng vân tay').waitFor();
  check('Android: bật vân tay lưu master password qua keystore của máy', n.bio === PW);
  await page.getByRole('dialog', { name: 'Cài đặt' }).getByRole('button', { name: 'Đóng' }).click();

  await page.getByRole('button', { name: 'Khoá' }).click();
  // The lock screen asks for the fingerprint by itself; the fake passes.
  await until(page, () => n.indexClears >= 1 && n.calls.includes('bioUnlock'), 'khoá rồi hỏi vân tay');
  await waitStatus(page, 'synced');
  check('Android: khoá thì xoá danh sách tự điền', n.indexClears >= 1);
  check('Android: màn hình khoá tự hỏi vân tay và mở', n.calls.filter((c) => c === 'bioUnlock').length >= 1);
  await until(page, () => n.index?.entries?.length === 2, 'danh sách tự điền sau khi mở');
  check('Android: mở lại thì gửi lại danh sách tự điền', true);

  // ---- the lock screen autofill opens ----
  n.bioFails = true;
  await page.goto(`${URL_}?autofill=shopee.vn`);
  await page.getByText('Mở khoá để tự điền cho').waitFor();
  check('Android: màn hình khoá cho biết đang mở để tự điền cho trang nào', (await page.locator('.autofill-for').textContent()).includes('shopee.vn'));
  await shot('autofill-lock');
  await page.getByLabel('Master password').fill(PW);
  await page.getByRole('button', { name: 'Mở khoá', exact: true }).click();
  await waitStatus(page, 'synced');
  n.bioFails = false;

  // ---- logins typed elsewhere, handed over to save ----
  n.pendingSave = { domain: 'github.com', package: 'com.android.chrome', appLabel: 'Chrome', username: 'user@example.com', password: 'new-gh-pass' };
  await page.evaluate(() => window.__emit('pendingSave'));
  await page.getByRole('dialog', { name: 'Cập nhật mật khẩu?' }).waitFor();
  check('Android: nhận ra đăng nhập đã có cùng tài khoản → hỏi cập nhật', (await page.getByRole('dialog').textContent()).includes('GitHub'));
  await shot('save-update');
  await page.getByRole('button', { name: 'Cập nhật', exact: true }).click();
  await until(page, () => n.saveDone.length === 1, 'saveDone');
  await until(page, () => n.index?.entries?.find((e) => e.title === 'GitHub')?.password === 'new-gh-pass', 'mật khẩu mới trong danh sách');
  check('Android: cập nhật mật khẩu, báo app xong', n.saveDone[0].saved === true);

  n.pendingSave = { domain: null, package: 'vn.com.vng.zalo', appLabel: 'Zalo', username: '0901234567', password: 'zalo-pw' };
  await page.evaluate(() => window.__emit('pendingSave'));
  await page.getByRole('dialog', { name: 'Lưu đăng nhập?' }).waitFor();
  await shot('save-new');
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  await until(page, () => n.index?.entries?.some((e) => e.apps.includes('vn.com.vng.zalo')), 'mục Zalo trong danh sách');
  const zalo = n.index.entries.find((e) => e.apps.includes('vn.com.vng.zalo'));
  check('Android: lưu đăng nhập mới từ app, gắn với app đó', zalo.title === 'Zalo' && zalo.username === '0901234567' && zalo.password === 'zalo-pw');

  n.pendingSave = { domain: 'example.com', package: 'org.mozilla.firefox', appLabel: 'Firefox', username: 'a', password: 'b' };
  await page.evaluate(() => window.__emit('pendingSave'));
  await page.getByRole('button', { name: 'Không lưu' }).click();
  await until(page, () => n.saveDone.length === 3, 'saveDone');
  check('Android: không lưu thì báo app và không tạo mục', n.saveDone[2].saved === false && !n.index.entries.some((e) => e.title === 'example.com'));

  // ---- files are saved through the app ----
  await openSettings(page);
  await page.getByRole('button', { name: 'Dữ liệu' }).click();
  await page.getByRole('button', { name: 'Tải file .kdbx' }).click();
  await until(page, () => n.files.length > 0, 'lưu file');
  check('Android: tải file xuống qua hộp "Lưu" của Android', /^kaipass-.*\.kdbx$/.test(n.files[0].name) && Buffer.from(n.files[0].data, 'base64').readUInt32LE(0) === 0x9aa2d903);
  await page.getByRole('dialog', { name: 'Cài đặt' }).getByRole('button', { name: 'Đóng' }).click();

  check('Android: không có lỗi trong console', problems.length === 0, problems.join(' | '));
  await ctx.close();
}

(async () => {
  const server = spawn('npx', ['vite', 'preview', '--outDir', 'dist-android', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(URL_)).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const browser = await chromium.launch();
    await run(browser);
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
