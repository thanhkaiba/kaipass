// Runs the real desktop app (Electron) with Google replaced by local stand-ins: a fake OAuth server
// for the system-browser sign-in, and the in-memory fake Drive.
// Run: npm run build:desktop && (cd desktop && npm install && npm run prepare-app) && xvfb-run -a npm run e2e:desktop
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, existsSync, writeFileSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { _electron } = require('playwright');
const QRCode = require('qrcode');
const { fakeDrive } = require('./fake-drive.cjs');

const DESKTOP = join(__dirname, '..', 'desktop');
const PW = 'correct horse battery';
const shots = process.env.SHOTS_DIR;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}

/** Google's sign-in and token endpoints, as far as the app's flow goes. */
function fakeGoogle() {
  const g = { authRequests: [], tokenRequests: [], refreshes: 0, challenge: '', revoked: false };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/auth') {
      const q = Object.fromEntries(url.searchParams);
      g.authRequests.push(q);
      g.challenge = q.code_challenge;
      res.writeHead(302, { Location: `${q.redirect_uri}/?code=the-code&state=${encodeURIComponent(q.state)}` }).end();
      return;
    }
    if (url.pathname === '/token') {
      let body = '';
      for await (const c of req) body += c;
      const p = Object.fromEntries(new URLSearchParams(body));
      g.tokenRequests.push(p);
      const json = (status, o) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
      if (p.client_id !== 'desk-123.apps.googleusercontent.com' || p.client_secret !== 'desk-secret') return json(401, { error: 'invalid_client' });
      if (p.grant_type === 'authorization_code') {
        const ok = p.code === 'the-code' && createHash('sha256').update(p.code_verifier || '').digest('base64url') === g.challenge;
        if (!ok) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: 'fake-token', refresh_token: 'refresh-1', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file', token_type: 'Bearer' });
      }
      if (p.grant_type === 'refresh_token') {
        if (g.revoked || p.refresh_token !== 'refresh-1') return json(400, { error: 'invalid_grant' });
        g.refreshes++;
        return json(200, { access_token: 'fake-token', expires_in: 3600, token_type: 'Bearer' });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ g, server, base: `http://127.0.0.1:${server.address().port}` })));
}

const waitStatus = (page, s) => page.getByTestId('sync-status').and(page.locator(`[data-status="${s}"]`)).waitFor({ state: 'attached', timeout: 20000 });

(async () => {
  const google = await fakeGoogle();
  const drive = fakeDrive();
  const userData = mkdtempSync(join(tmpdir(), 'kaipass-desktop-'));
  const launch = async () => {
    const app = await _electron.launch({
      // KAIPASS_DESKTOP_EXE runs a packaged build instead of the sources.
      executablePath: process.env.KAIPASS_DESKTOP_EXE || require(join(DESKTOP, 'node_modules', 'electron')),
      args: [...(process.env.KAIPASS_DESKTOP_EXE ? [] : [DESKTOP]), '--no-sandbox', '--password-store=basic'],
      env: { ...process.env, KAIPASS_TEST: '1', KAIPASS_USER_DATA: userData, KAIPASS_OAUTH_AUTH: `${google.base}/auth`, KAIPASS_OAUTH_TOKEN: `${google.base}/token` },
    });
    await app.context().route('https://www.googleapis.com/**', drive.handler);
    const page = await app.firstWindow();
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
    return { app, page, problems };
  };

  let run;
  try {
    run = await launch();
    let { app, page, problems } = run;
    const shot = async (name) => shots && (await page.screenshot({ path: join(shots, `desktop-app-${name}.png`) }));

    await page.getByRole('button', { name: /Lưu trên Google Drive/ }).waitFor();
    check('app máy tính: mở lên từ file của chính nó', page.url() === 'kaipass://app/index.html');
    check('trang không chạm được vào Node, chỉ có cầu nối hẹp', await page.evaluate(() => typeof window.require === 'undefined' && typeof window.process === 'undefined' && Object.keys(window.KaiPassDesktop).sort().join() === 'call,on'));
    await shot('setup');

    // ---- one-time Google client for desktop ----
    await page.getByRole('button', { name: /Lưu trên Google Drive/ }).click();
    await page.getByTestId('desktop-client-setup').waitFor();
    check('chưa có client Google: hướng dẫn tạo, nút đăng nhập bị khoá', await page.getByRole('button', { name: 'Đăng nhập Google' }).isDisabled());
    await shot('client-setup');
    const dir = mkdtempSync(join(tmpdir(), 'kaipass-client-'));
    const webJson = join(dir, 'web.json');
    const deskJson = join(dir, 'desktop.json');
    writeFileSync(webJson, JSON.stringify({ web: { client_id: 'w.apps.googleusercontent.com', client_secret: 'x' } }));
    writeFileSync(deskJson, JSON.stringify({ installed: { client_id: 'desk-123.apps.googleusercontent.com', client_secret: 'desk-secret', project_id: 'p' } }));
    await page.getByLabel('File JSON của client Desktop').setInputFiles(webJson);
    check('từ chối file của client loại Web', (await page.getByRole('alert').textContent()).includes('Desktop app'));
    await page.getByLabel('File JSON của client Desktop').setInputFiles(deskJson);
    await page.getByTestId('desktop-client-setup').waitFor({ state: 'detached', timeout: 8000 }).catch(async () => {
      throw new Error(`client chưa được nhận: ${await page.getByRole('alert').textContent().catch(() => '?')} | ${await app.evaluate(({ safeStorage }) => `${safeStorage.isEncryptionAvailable()} ${safeStorage.getSelectedStorageBackend?.()}`)}`);
    });
    const clientFile = readFileSync(join(userData, 'google-client.bin'));
    check('nhận file client Desktop, lưu đã mã hoá', !clientFile.includes('desk-secret'));

    // ---- sign in through the "browser" ----
    await page.getByRole('button', { name: 'Đăng nhập Google' }).click();
    await page.getByLabel('Master password', { exact: true }).waitFor();
    const auth = google.g.authRequests[0];
    const exchange = google.g.tokenRequests[0];
    check('đăng nhập Google qua trình duyệt hệ thống: chỉ xin quyền drive.file, có PKCE', auth.scope === 'https://www.googleapis.com/auth/drive.file' && auth.code_challenge_method === 'S256' && auth.code_challenge.length >= 43 && auth.access_type === 'offline');
    check('địa chỉ nhận kết quả chỉ ở máy này (127.0.0.1)', /^http:\/\/127\.0\.0\.1:\d+$/.test(auth.redirect_uri) && exchange.redirect_uri === auth.redirect_uri);
    check('đổi mã lấy token có code_verifier', exchange.grant_type === 'authorization_code' && exchange.code_verifier.length >= 43);
    const saved = readFileSync(join(userData, 'google.bin'));
    check('refresh token được lưu đã mã hoá', saved.length > 0 && !saved.includes('refresh-1'));

    await page.getByLabel('Master password', { exact: true }).fill(PW);
    await page.getByLabel('Nhập lại').fill(PW);
    await page.getByRole('button', { name: 'Tạo vault' }).click();
    await waitStatus(page, 'synced');
    check('tạo vault và đồng bộ lên Drive', drive.state.rev === 1);

    await page.getByRole('button', { name: 'Thêm', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Đăng nhập' }).click();
    await page.getByLabel('Tên', { exact: true }).fill('GitHub');
    await page.getByLabel('Tên đăng nhập').fill('theo');
    await page.getByLabel('Mật khẩu', { exact: true }).fill('p@ss-GitHub');
    await page.getByRole('button', { name: 'Lưu' }).click();
    await page.locator('.detail-title h2', { hasText: 'GitHub' }).waitFor();
    await waitStatus(page, 'synced');
    await shot('main');

    // ---- clipboard through the app ----
    await page.getByRole('button', { name: 'Copy Mật khẩu' }).click();
    await page.getByText(/Đã copy/).first().waitFor();
    check('chép mật khẩu qua clipboard của hệ điều hành', (await app.evaluate(({ clipboard }) => clipboard.readText())) === 'p@ss-GitHub');

    // ---- a QR code shown on screen ----
    const qr = await QRCode.toDataURL('otpauth://totp/GitHub:theo?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=GitHub', { width: 360, margin: 4 });
    await app.evaluate(async ({ BrowserWindow }, url) => {
      const w = new BrowserWindow({ x: 40, y: 40, width: 460, height: 500, show: true });
      await w.loadURL(`data:text/html,<body style="margin:0;background:white;display:grid;place-items:center;height:100vh"><img src="${url}">`);
      global.__qrWindow = w;
    }, qr);
    await page.getByRole('button', { name: 'Sửa' }).click();
    await page.getByRole('button', { name: 'Quét mã QR' }).click();
    await page.getByRole('button', { name: /Quét mã QR đang hiện trên màn hình/ }).click();
    const scanned = await page
      .getByText('Đã thêm mã OTP')
      .first()
      .waitFor({ timeout: 15000 })
      .then(() => true, () => false);
    await app.evaluate(() => global.__qrWindow?.destroy());
    if (scanned) {
      check('quét mã QR đang hiện trên màn hình', (await page.getByLabel(/Mã bí mật OTP/).inputValue()).startsWith('otpauth://totp/'));
      await page.getByRole('button', { name: 'Lưu' }).click();
      await page.getByTestId('otp-code').waitFor();
    } else {
      // Screen capture depends on the display server; a headless X server may not provide it.
      console.log(`SKIP  quét mã QR trên màn hình (máy test không chụp được màn hình): ${(await page.getByRole('alert').textContent().catch(() => '')) || ''}`);
      await page.getByRole('dialog').getByRole('button', { name: 'Đóng' }).click();
      await page.getByRole('button', { name: 'Huỷ' }).click();
    }

    // ---- the computer locks: so does the vault ----
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
    await page.getByLabel('Master password').waitFor();
    check('máy tính khoá màn hình thì vault khoá theo', true);
    await shot('lock');
    await page.getByLabel('Master password').fill(PW);
    await page.getByRole('button', { name: 'Mở khoá', exact: true }).click();
    await waitStatus(page, 'synced');

    // ---- narrow window uses the phone layout ----
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(400, 700));
    await page.getByRole('navigation', { name: 'Điều hướng' }).waitFor();
    check('thu hẹp cửa sổ thì chuyển sang bố cục gọn', await page.getByRole('navigation', { name: 'Điều hướng' }).isVisible());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 780));

    check('không có lỗi trong console', problems.length === 0, problems.join(' | '));
    await app.close();

    // ---- next launch: still signed in, no browser needed ----
    const authCount = google.g.authRequests.length;
    run = await launch();
    ({ app, page, problems } = run);
    await page.getByLabel('Master password').waitFor();
    check('mở lại app: vault vẫn còn, đang khoá', true);
    await page.getByLabel('Master password').fill(PW);
    await page.getByRole('button', { name: 'Mở khoá', exact: true }).click();
    await waitStatus(page, 'synced');
    check('mở lại app: tự gia hạn đăng nhập Google, không mở trình duyệt', google.g.refreshes >= 1 && google.g.authRequests.length === authCount, `refreshes=${google.g.refreshes}`);
    check('mục đã lưu vẫn còn', (await page.locator('.item-title').allTextContents()).includes('GitHub'));

    // ---- Google access revoked: the next manual sync signs in again through the browser ----
    google.g.revoked = true;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('sessionStorage.clear()'));
    await page.getByTestId('sync-status').click();
    for (let i = 0; i < 50 && google.g.authRequests.length === authCount; i++) await page.waitForTimeout(100);
    await waitStatus(page, 'synced');
    check('quyền Google bị thu hồi: bấm đồng bộ thì đăng nhập lại qua trình duyệt', google.g.authRequests.length === authCount + 1);
    check('không có lỗi trong console (lần 2)', problems.filter((p) => !/status of 400/.test(p)).length === 0, problems.join(' | '));
    await app.close();
  } catch (e) {
    console.error(e);
    failures++;
    await run?.page.screenshot({ path: join(tmpdir(), 'kaipass-desktop-fail.png') }).catch(() => {});
    await run?.app.close().catch(() => {});
  } finally {
    google.server.close();
  }
  console.log(failures ? `\n${failures} kiểm tra thất bại` : '\nTất cả kiểm tra đều đạt');
  process.exit(failures ? 1 : 0);
})();
