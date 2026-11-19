// Loads the built extension into Chromium and checks autofill against local test pages.
// Run: KAIPASS_TEST_HOSTS=1 npm run build:ext && npm run e2e:ext
// The test build is granted access to localhost because a test cannot click the toolbar icon,
// which is what grants access to the current tab in real use.
const { createHmac } = require('node:crypto');
const { mkdtempSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require('playwright');
const { fakeDrive } = require('./fake-drive.cjs');
const QRCode = require('qrcode');
const kdbxweb = require('kdbxweb');
const { argon2id, argon2d } = require('hash-wasm');

kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type) => {
  const out = await (type === 2 ? argon2id : argon2d)({
    password: new Uint8Array(password), salt: new Uint8Array(salt), memorySize: memory,
    iterations, hashLength: length, parallelism, outputType: 'binary',
  });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
});

/** Plays "another device": adds a login to the vault file on the fake Drive. */
async function addOnOtherDevice(drive, title, url, username, password) {
  const cred = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(PW));
  const db = await kdbxweb.Kdbx.load(new Uint8Array(drive.state.file).buffer, cred);
  const entry = db.createEntry(db.getDefaultGroup());
  entry.fields.set('Title', title);
  entry.fields.set('UserName', username);
  entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(password));
  entry.fields.set('URL', url);
  entry.times.update();
  drive.state.file = Buffer.from(await db.save());
  drive.state.rev++;
}

const EXT_DIR = join(__dirname, '..', 'dist-ext');
const EXT_ID = 'eokdpgifmehmgjoelmomohkajehodpeg';
const PORT = 4190;
const PW = 'correct horse battery';
const SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const shots = process.env.SHOTS_DIR;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}

function codes() {
  const at = (t) => {
    const counter = Buffer.alloc(8);
    counter.writeUInt32BE(Math.floor(t / 30000), 4);
    const mac = createHmac('sha1', '12345678901234567890').update(counter).digest();
    const off = mac[mac.length - 1] & 15;
    return String((mac.readUInt32BE(off) & 0x7fffffff) % 1e6).padStart(6, '0');
  };
  return [at(Date.now() - 30000), at(Date.now())];
}

const PAGES = {
  '/login': `<form><input name="email" type="email" placeholder="Email"><input name="pass" type="password"><button>Sign in</button></form>`,
  '/react': `<div id="out"></div><input id="u" autocomplete="username"><input id="p" type="password" autocomplete="current-password">
    <script>for (const id of ['u','p']) document.getElementById(id).addEventListener('input', (e) => { document.getElementById('out').dataset[id] = e.target.value; });</script>`,
  '/signup': `<form><input name="search" placeholder="Search"></form><form><input name="username"><input name="new" type="password" autocomplete="new-password"><input name="confirm" type="password" autocomplete="new-password"></form>`,
  '/register': `<h1>Create your account</h1><form method="post" action="/welcome"><input name="fullname" placeholder="Full name"><input name="email" type="email" placeholder="Email"><input name="password" type="password" placeholder="Password"><input name="password_confirm" type="password" placeholder="Confirm password"><button type="submit">Create account</button></form>`,
  '/change': `<form method="post" action="/welcome"><input name="current" type="password" autocomplete="current-password"><input name="newpw" type="password" placeholder="New password"><input name="again" type="password" placeholder="Repeat"><button type="submit">Save</button></form>`,
  '/flow-user': `<h1>Sign in</h1><form method="post" action="/flow-pass"><input name="identifier" autocomplete="username" placeholder="Email"><button type="submit">Next</button></form>`,
  '/flow-pass': `<form method="post" action="/flow-otp"><input name="password" type="password" autocomplete="current-password"><button type="button" aria-label="Show password">eye</button><button type="submit">Sign in</button></form>`,
  '/flow-otp': `<h1>Two-step verification</h1><form method="post" action="/flow-done"><input name="code" autocomplete="one-time-code" inputmode="numeric"><button type="submit">Verify</button></form>`,
  '/flow-done': `<h1>Signed in</h1>`,
  '/mail-otp': `<h1>Check your email</h1><p>We sent a 6-digit verification code to your email. Enter it below.</p><form method="post" action="/flow-done"><input name="code" autocomplete="one-time-code" inputmode="numeric"><button type="submit">Verify</button></form>`,
  '/mflow-user': `<h1>Sign in</h1><form method="post" action="/mail-otp"><input name="identifier" autocomplete="username" placeholder="Email"><button type="submit">Next</button></form>`,
  '/user-first': `<form><input name="identifier" type="text" autocomplete="username"><button>Next</button></form>`,
  '/otp': `<form><input name="code" autocomplete="one-time-code" inputmode="numeric"></form>`,
  '/digits': `<form>${'<input class="d" maxlength="1" inputmode="numeric">'.repeat(6)}</form>`,
  '/hidden': `<form><input name="email" style="display:none"><input name="pass" type="password" style="display:none"><input name="user" type="text"><input name="password" type="password"></form>`,
  '/signin': `<form method="post" action="/welcome"><input name="email" type="text" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>`,
  '/username-step': `<form method="post" action="/password-step"><input name="identifier" autocomplete="username"><button type="submit">Next</button></form>`,
  '/password-step': `<form method="post" action="/welcome"><input name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>`,
  '/spa': `<div><input id="u" autocomplete="username"><input id="p" type="password"><button type="button" id="go">Sign in</button></div><p id="msg"></p>
    <script>document.getElementById('go').addEventListener('click', () => { document.getElementById('msg').textContent = 'Welcome'; });</script>`,
  '/welcome': `<h1>Welcome</h1>`,
  '/low': `<form style="margin-top:420px"><input name="email" type="email" autocomplete="username"><input name="pass" type="password"></form>`,
  '/frame': `<p>Trang chứa khung của site khác</p><iframe src="http://127.0.0.1:${PORT}/login" width="400" height="200"></iframe>`,
};

/** What forms on the test site were sent with: { path, form }. */
const posts = [];

(async () => {
  PAGES['/qr'] = `<h1>Bật xác thực hai bước</h1><img alt="qr" src="${await QRCode.toDataURL('otpauth://totp/Local%20site:alice%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Local%20site', { width: 260, margin: 4 })}">`;
  const server = http
    .createServer(async (req, res) => {
      const body = PAGES[req.url.split('?')[0]];
      if (req.method === 'POST') {
        let sent = '';
        for await (const chunk of req) sent += chunk;
        posts.push({ path: req.url, form: Object.fromEntries(new URLSearchParams(sent)) });
      }
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>test</title>${body ?? 'not found'}`);
    })
    .listen(PORT);

  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'kaipass-ext-')), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 400, height: 600 },
    deviceScaleFactor: Number(process.env.SHOT_SCALE || 1),
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  try {
    const site = await ctx.newPage();
    await site.setViewportSize({ width: 900, height: 500 });
    await site.goto(`http://localhost:${PORT}/login`);

    const ext = await ctx.newPage();
    const problems = [];
    ext.on('pageerror', (e) => problems.push(e.message));
    ext.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    ext.on('dialog', (d) => d.accept());
    await ext.goto(`chrome-extension://${EXT_ID}/index.html?popup`);
    check('extension tải được với ID cố định', (await ext.title()) === 'KaiPass');
    const tabId = await ext.evaluate(async (port) => (await chrome.tabs.query({ url: `http://localhost:${port}/*` }))[0].id, PORT);
    const popupUrl = `chrome-extension://${EXT_ID}/index.html?popup&tab=${tabId}`;
    /** Opens the popup on its list, as if it had not been used for a while (see the "reopening" checks for the rest). */
    const openPopup = async () => {
      await ext.evaluate(() => chrome.storage.session.remove('kaipass.view')).catch(() => {});
      await ext.goto(popupUrl);
      await ext.getByTestId('suggestions').or(ext.getByLabel('Master password')).first().waitFor();
    };
    const fillFromPopup = async (label = 'Điền Local site') => {
      await openPopup();
      await ext.getByRole('button', { name: label }).click();
      await ext.locator('.toast').waitFor();
      return ext.locator('.toast').textContent();
    };

    // Create a vault inside the extension and save one login for the test site.
    await ext.goto(popupUrl);
    await ext.getByRole('button', { name: /Chỉ lưu trên thiết bị này/ }).click();
    await ext.getByLabel('Master password', { exact: true }).fill(PW);
    await ext.getByLabel('Nhập lại').fill(PW);
    await ext.getByRole('button', { name: 'Tạo vault' }).click();
    await ext.getByTestId('suggestions').waitFor();
    check('popup nhận ra trang đang mở', (await ext.getByTestId('suggestions').textContent()).includes('localhost'));
    check('chưa lưu gì thì không gợi ý', (await ext.getByTestId('suggestions').textContent()).includes('Chưa có đăng nhập'));

    await ext.getByRole('button', { name: 'Thêm', exact: true }).click();
    await ext.getByRole('menuitem', { name: 'Đăng nhập' }).click();
    await ext.getByLabel('Tên', { exact: true }).fill('Local site');
    await ext.getByLabel('Tên đăng nhập').fill('alice@example.com');
    await ext.getByLabel('Mật khẩu', { exact: true }).fill('s3cret-pw');
    await ext.getByLabel('Địa chỉ web', { exact: true }).fill(`http://localhost:${PORT}/login`);
    await ext.getByLabel(/Mã bí mật OTP/).fill(SECRET_B32);
    await ext.getByRole('button', { name: 'Lưu' }).click();
    await ext.getByRole('button', { name: 'Điền vào trang' }).waitFor();
    check('mục khớp trang có nút "Điền vào trang"', true);
    if (shots) await ext.screenshot({ path: join(shots, 'ext-item.png') });

    // A PDF opens in the viewer inside the extension (its CSP must allow blob: frames).
    const pdfPath = join(mkdtempSync(join(tmpdir(), 'kaipass-pdf-')), 'giay-to.pdf');
    require('node:fs').writeFileSync(pdfPath, '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
    await ext.evaluate(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    await ext.getByTestId('attach-input').setInputFiles(pdfPath);
    await ext.getByRole('button', { name: 'giay-to.pdf', exact: true }).click();
    await ext.getByTestId('viewer-pdf').waitFor();
    await ext.waitForTimeout(500);
    const csp = await ext.evaluate(() => window.__csp);
    check('extension mở được PDF đính kèm (không bị CSP chặn)', csp.length === 0, csp.join(' | '));
    await ext.getByRole('button', { name: 'Đóng' }).click();

    // Scanning the QR code shown in the page (the 2FA set-up screen of a site).
    await site.goto(`http://localhost:${PORT}/qr`);
    await site.bringToFront();
    // A fresh window on the list (the other popup is still showing the item just saved).
    await ext.evaluate(() => chrome.storage.session.remove('kaipass.view'));
    const scanWin = await (async () => {
      const [w] = await Promise.all([
        ctx.waitForEvent('page'),
        ext.evaluate((url) => chrome.windows.create({ url, type: 'popup', width: 420, height: 640, focused: false }), popupUrl),
      ]);
      return w;
    })();
    await scanWin.getByTestId('suggestions').waitFor();
    await scanWin.getByRole('button', { name: 'Thêm', exact: true }).click();
    await scanWin.getByRole('menuitem', { name: 'Quét mã QR (OTP)…' }).click();
    await scanWin.getByRole('button', { name: /Quét trên trang đang mở/ }).click();
    await scanWin.getByLabel('Tên', { exact: true }).waitFor({ timeout: 10000 });
    check('extension: quét mã QR hiện trên trang đang mở', (await scanWin.getByLabel('Tên', { exact: true }).inputValue()) === 'Local site' && (await scanWin.getByLabel('Địa chỉ web', { exact: true }).inputValue()) === 'https://localhost');
    if (shots) await scanWin.screenshot({ path: join(shots, 'ext-qr.png') });
    await scanWin.close();
    await site.goto(`http://localhost:${PORT}/login`);

    // Reopening the popup must not ask for the master password again.
    await openPopup();
    check('mở lại popup không phải nhập lại master password', await ext.getByTestId('suggestions').isVisible());
    check('popup gợi ý đúng đăng nhập của trang', await ext.getByRole('button', { name: 'Điền Local site' }).isVisible());
    if (shots) await ext.screenshot({ path: join(shots, 'ext-popup.png') });

    // Plain login form: username and password, OTP has nowhere to go yet.
    const toast = await fillFromPopup();
    check('điền tên đăng nhập', (await site.locator('[name=email]').inputValue()) === 'alice@example.com');
    check('điền mật khẩu', (await site.locator('[name=pass]').inputValue()) === 's3cret-pw');
    check('trang chưa có ô OTP thì báo cho người dùng', /OTP/.test(toast), toast);
    if (shots) await site.screenshot({ path: join(shots, 'ext-filled.png') });

    // Forms driven by JavaScript frameworks only notice real input events.
    await site.goto(`http://localhost:${PORT}/react`);
    await fillFromPopup();
    const seen = await site.locator('#out').evaluate((el) => ({ ...el.dataset }));
    check('trang dùng JavaScript nhận được giá trị đã điền', seen.u === 'alice@example.com' && seen.p === 's3cret-pw', JSON.stringify(seen));

    // Sign-up forms: do not put the saved password into "new password" boxes or the search box.
    await site.goto(`http://localhost:${PORT}/signup`);
    await fillFromPopup();
    check('không điền mật khẩu cũ vào ô "mật khẩu mới"', (await site.locator('[name=new]').inputValue()) === '' && (await site.locator('[name=confirm]').inputValue()) === '');
    check('không điền vào ô tìm kiếm', (await site.locator('[name=search]').inputValue()) === '');

    // Username-first login (Google style).
    await site.goto(`http://localhost:${PORT}/user-first`);
    await fillFromPopup();
    check('đăng nhập hai bước: điền tên đăng nhập ở bước đầu', (await site.locator('[name=identifier]').inputValue()) === 'alice@example.com');

    // One-time code step.
    await site.goto(`http://localhost:${PORT}/otp`);
    await fillFromPopup();
    const filledCode = await site.locator('[name=code]').inputValue();
    check('điền mã OTP vào ô nhập mã', codes().includes(filledCode), filledCode);

    await site.goto(`http://localhost:${PORT}/digits`);
    await fillFromPopup();
    const digits = (await site.locator('.d').evaluateAll((els) => els.map((e) => e.value))).join('');
    check('điền mã OTP vào dạng 6 ô rời', codes().includes(digits), digits);

    // Hidden decoy fields must be skipped.
    await site.goto(`http://localhost:${PORT}/hidden`);
    await fillFromPopup();
    check('bỏ qua ô ẩn, điền ô đang hiển thị', (await site.locator('[name=password]').inputValue()) === 's3cret-pw' && (await site.locator('[name=pass]').inputValue()) === '' && (await site.locator('[name=user]').inputValue()) === 'alice@example.com');

    // A frame from another site embedded in the page must not receive the password.
    await site.goto(`http://localhost:${PORT}/frame`);
    const frameToast = await fillFromPopup();
    const inFrame = await site.frameLocator('iframe').locator('[name=pass]').inputValue();
    check('không điền vào khung của site khác', inFrame === '' && /Không tìm thấy/.test(frameToast), `${inFrame} / ${frameToast}`);

    // A different site gets no suggestion.
    await site.goto(`http://127.0.0.1:${PORT}/login`);
    await openPopup();
    check('site khác không được gợi ý đăng nhập này', (await ext.getByTestId('suggestions').textContent()).includes('Chưa có đăng nhập'));

    // ---- reopening the popup: back where it was left ----
    await site.goto(`http://localhost:${PORT}/login`);
    await openPopup();
    await ext.locator('.item', { hasText: 'Local site' }).first().click();
    await ext.locator('.detail-title h2', { hasText: 'Local site' }).waitFor();
    await ext.goto(popupUrl); // Chrome closes the popup when the user clicks elsewhere; this is it opening again
    await ext.locator('.detail-title h2', { hasText: 'Local site' }).waitFor({ timeout: 5000 }).then(
      () => check('mở lại popup: hiện lại mục đang xem', true),
      () => check('mở lại popup: hiện lại mục đang xem', false),
    );
    await ext.getByRole('button', { name: 'Sửa' }).click();
    await ext.getByLabel('Tên', { exact: true }).fill('Local site (đang sửa)');
    await ext.getByLabel('Ghi chú').fill('gõ dở');
    await ext.goto(popupUrl);
    await ext.getByLabel('Tên', { exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
    check('mở lại popup khi đang sửa dở: giữ nguyên chữ đã gõ', (await ext.getByLabel('Tên', { exact: true }).inputValue().catch(() => '')) === 'Local site (đang sửa)' && (await ext.getByLabel('Ghi chú').inputValue().catch(() => '')) === 'gõ dở');
    await ext.getByRole('button', { name: 'Huỷ' }).click();
    await ext.goto(popupUrl);
    await ext.locator('.detail-title h2', { hasText: 'Local site' }).waitFor({ timeout: 5000 });
    check('huỷ sửa rồi mở lại: về mục đó, không còn bản nháp', (await ext.getByLabel('Ghi chú').count()) === 0 && (await ext.locator('.detail-title h2').textContent()) === 'Local site');
    const otherTab = await ext.evaluate(async () => (await chrome.tabs.create({ url: 'about:blank', active: false })).id);
    await ext.goto(`chrome-extension://${EXT_ID}/index.html?popup&tab=${otherTab}`);
    await ext.locator('.items').waitFor();
    check('mở popup ở tab khác: về danh sách', await ext.locator('.items').isVisible() && !(await ext.locator('.detail-title').isVisible()));
    await ext.evaluate((id) => chrome.tabs.remove(id), otherTab);
    await ext.goto(popupUrl);
    await ext.locator('.item', { hasText: 'Local site' }).first().click();
    await ext.locator('.detail-title h2', { hasText: 'Local site' }).waitFor();
    await ext.getByRole('button', { name: 'Quay lại danh sách' }).click();
    check('có lưu chỗ đang xem trong bộ nhớ của trình duyệt', (await ext.evaluate(async () => Object.keys(await chrome.storage.session.get('kaipass.view')).length)) === 1);
    await ext.getByRole('button', { name: 'Khoá' }).click();
    await ext.getByLabel('Master password').waitFor();
    check('khoá vault thì quên luôn chỗ đang xem', (await ext.evaluate(async () => Object.keys(await chrome.storage.session.get('kaipass.view')).length)) === 0);
    await ext.getByLabel('Master password').fill(PW);
    await ext.getByRole('button', { name: 'Mở khoá', exact: true }).click();
    await ext.getByTestId('suggestions').waitFor();

    // ---- in-page suggestions (content script) ----
    // These checks read what was filled, so the form must stay put: auto sign-in has its own section below.
    const setAutoSubmit = (on) => ext.evaluate((v) => chrome.storage.local.set({ 'kaipass.inline': { icon: true, toast: true, autoSubmit: v } }), on);
    await setAutoSubmit(false);
    const ui = site.locator('kaipass-ui');
    await site.goto(`http://localhost:${PORT}/login`);
    await ui.locator('.toast').waitFor({ state: 'visible', timeout: 10000 });
    const card = await ui.locator('.toast').boundingBox();
    check('thẻ gợi ý hiện phía trên, né sang góc khi sẽ che ô nhập của trang', (await ui.locator('.toast').textContent()).includes('Local site') && card.y < 30 && card.x + card.width > 880, JSON.stringify(card));
    await site.goto(`http://localhost:${PORT}/low`);
    await ui.locator('.toast').waitFor({ state: 'visible', timeout: 10000 });
    const centred = await ui.locator('.toast').boundingBox();
    check('trang có form ở dưới: thẻ gợi ý nằm giữa phía trên', Math.abs(centred.x + centred.width / 2 - 450) < 3 && centred.y < 30, JSON.stringify(centred));
    await site.goto(`http://localhost:${PORT}/login`);
    await ui.locator('.toast').waitFor({ state: 'visible', timeout: 10000 });
    if (shots) await site.screenshot({ path: join(shots, 'inline-toast.png') });
    await ui.locator('.toast .row').first().click();
    await site.waitForFunction(() => document.querySelector('[name=pass]').value !== '');
    check('bấm vào thẻ gợi ý là điền tên đăng nhập và mật khẩu', (await site.locator('[name=email]').inputValue()) === 'alice@example.com' && (await site.locator('[name=pass]').inputValue()) === 's3cret-pw');
    check('thẻ gợi ý tự ẩn sau khi điền', !(await ui.locator('.toast').isVisible()));

    await site.goto(`http://localhost:${PORT}/login`);
    await site.locator('[name=email]').click();
    await ui.locator('.badge').waitFor({ state: 'visible' });
    check('ô đăng nhập có biểu tượng KaiPass', true);
    await ui.locator('.panel .row').first().waitFor({ state: 'visible' });
    check('bấm vào ô hiện danh sách tài khoản', (await ui.locator('.panel').textContent()).includes('alice@example.com'));
    if (shots) await site.screenshot({ path: join(shots, 'inline-panel.png') });
    await ui.locator('.panel .row').first().click();
    await site.waitForFunction(() => document.querySelector('[name=pass]').value !== '');
    check('chọn trong danh sách là điền vào form', (await site.locator('[name=pass]').inputValue()) === 's3cret-pw');

    // The browser's own password list opens below a field, so ours opens above when it can.
    await site.goto(`http://localhost:${PORT}/low`);
    await site.locator('[name=email]').click();
    await ui.locator('.panel .row').first().waitFor({ state: 'visible' });
    const fieldBox = await site.locator('[name=email]').boundingBox();
    const panelBox = await ui.locator('.panel').boundingBox();
    check('danh sách KaiPass mở phía trên ô nhập (không bị danh sách của Chrome che)', panelBox.y + panelBox.height <= fieldBox.y, `${panelBox.y + panelBox.height} vs ${fieldBox.y}`);

    await site.goto(`http://localhost:${PORT}/otp`);
    await site.locator('[name=code]').click();
    await ui.locator('.panel .row').first().waitFor({ state: 'visible' });
    await ui.locator('.panel .row').first().click();
    await site.waitForFunction(() => document.querySelector('[name=code]').value.length === 6);
    check('ô OTP: chọn tài khoản là điền mã OTP', codes().includes(await site.locator('[name=code]').inputValue()));

    // A script on the page cannot trigger a fill by faking a click.
    await site.goto(`http://localhost:${PORT}/login`);
    await ui.locator('.toast').waitFor({ state: 'visible' });
    await site.evaluate(() => document.querySelector('kaipass-ui').shadowRoot.querySelector('.toast .row').click());
    await site.waitForTimeout(500);
    check('click giả từ script của trang không làm điền', (await site.locator('[name=pass]').inputValue()) === '');

    // Another site, and a frame from another site, get nothing.
    await site.goto(`http://127.0.0.1:${PORT}/login`);
    await site.waitForTimeout(800);
    check('site khác không hiện thẻ gợi ý', !(await ui.locator('.toast').isVisible().catch(() => false)));
    await site.locator('[name=email]').click();
    await ui.locator('.panel').waitFor({ state: 'hidden' });
    await ui.locator('.badge').click();
    await ui.locator('.panel .note').waitFor({ state: 'visible' });
    check('site khác: danh sách báo chưa có đăng nhập', (await ui.locator('.panel').textContent()).includes('Chưa có đăng nhập'));
    await site.goto(`http://localhost:${PORT}/frame`);
    const frame = site.frameLocator('iframe');
    await frame.locator('[name=pass]').click();
    await frame.locator('kaipass-ui .badge').waitFor({ state: 'visible' });
    await frame.locator('kaipass-ui .badge').click();
    await frame.locator('kaipass-ui .panel .note').waitFor({ state: 'visible' });
    check('khung của site khác trong trang không được gợi ý', (await frame.locator('kaipass-ui .panel').textContent()).includes('Chưa có đăng nhập'));

    // ---- offering to save logins typed into pages ----
    const fillIndex = () => ext.evaluate(async () => (await chrome.storage.session.get('kaipass.fill'))['kaipass.fill'] ?? []);
    const waitIndex = async (ok) => {
      for (let i = 0; i < 100; i++) {
        if (ok(await fillIndex())) return;
        await site.waitForTimeout(100);
      }
      throw new Error('fill index never reached the expected state');
    };
    const saveCard = ui.locator('.save');
    const signIn = async (origin, user, pass) => {
      await site.goto(`${origin}/signin`);
      await site.locator('[name=email]').fill(user);
      await site.locator('[name=password]').fill(pass);
      await site.getByRole('button', { name: 'Sign in' }).click();
      await site.waitForURL(/\/welcome$/);
    };
    const ip = `http://127.0.0.1:${PORT}`;
    /** Picks bob from the suggestion card on the one-page sign-in form and waits for the result page. */
    const signInByCard = async () => {
      await site.goto(`${ip}/signin`);
      await ui.locator('.toast .row', { hasText: 'bob' }).first().click();
      await site.waitForURL(/\/welcome$/, { timeout: 15000 });
    };

    await signIn(ip, 'bob', 'pw-bob-1');
    await saveCard.waitFor({ state: 'visible', timeout: 10000 });
    check('đăng nhập bằng tài khoản mới: hỏi lưu ở trang kế tiếp', (await saveCard.textContent()).includes('Lưu đăng nhập') && (await saveCard.textContent()).includes('bob'));
    check('thẻ hỏi lưu không hiện mật khẩu', !(await saveCard.textContent()).includes('pw-bob-1'));
    if (shots) await site.screenshot({ path: join(shots, 'save-card.png') });
    await saveCard.getByRole('button', { name: 'Lưu', exact: true }).click();
    await waitIndex((list) => list.some((e) => e.username === 'bob'));
    const bob = (await fillIndex()).filter((e) => e.hosts.includes('127.0.0.1'));
    check('bấm Lưu: tài khoản vào vault với đúng tên miền', bob.length === 1 && bob[0].password === 'pw-bob-1' && bob[0].title === '127.0.0.1', JSON.stringify(bob.map((e) => e.title)));
    await ext.locator('.item-title', { hasText: '127.0.0.1' }).first().waitFor({ timeout: 10000 });
    check('cửa sổ KaiPass đang mở tự thấy mục vừa lưu', true);

    await signIn(ip, 'bob', 'pw-bob-1');
    await site.waitForTimeout(1500);
    check('đăng nhập lại bằng tài khoản đã lưu: không hỏi', !(await saveCard.isVisible()));

    await signIn(ip, 'bob', 'pw-bob-2');
    await saveCard.waitFor({ state: 'visible', timeout: 10000 });
    check('đổi mật khẩu: hỏi cập nhật', (await saveCard.textContent()).includes('Cập nhật mật khẩu'));
    await saveCard.getByRole('button', { name: 'Cập nhật' }).click();
    await waitIndex((list) => list.some((e) => e.password === 'pw-bob-2'));
    const bob2 = (await fillIndex()).filter((e) => e.hosts.includes('127.0.0.1'));
    check('cập nhật mật khẩu, không tạo mục trùng', bob2.length === 1 && bob2[0].password === 'pw-bob-2');

    // ---- a strong password suggested wherever a new one is asked for ----
    await site.goto(`${ip}/register`);
    await site.locator('[name=email]').fill('dave@example.com');
    await site.locator('[name=password]').click();
    await ui.locator('.panel .gen').waitFor({ state: 'visible', timeout: 10000 });
    const first = await ui.locator('.panel .gen .pw').textContent();
    check('ô mật khẩu mới: gợi ý mật khẩu mạnh 20 ký tự', first.length === 20 && /[A-Z]/.test(first) && /[a-z]/.test(first) && /[0-9]/.test(first), first);
    if (shots) await site.screenshot({ path: join(shots, 'inline-generate.png') });
    await ui.locator('.panel .again').click();
    const strong = await ui.locator('.panel .gen .pw').textContent();
    check('bấm ↻ ra mật khẩu khác', strong !== first && strong.length === 20);
    await ui.locator('.panel .wide').click();
    check('điền vào cả ô mật khẩu và ô nhập lại', (await site.locator('[name=password]').inputValue()) === strong && (await site.locator('[name=password_confirm]').inputValue()) === strong);
    await saveCard.waitFor({ state: 'visible', timeout: 10000 });
    check('hỏi lưu ngay khi dùng mật khẩu vừa tạo', (await saveCard.textContent()).includes('dave@example.com') && !(await saveCard.textContent()).includes(strong));
    await saveCard.getByRole('button', { name: 'Lưu', exact: true }).click();
    await waitIndex((list) => list.some((e) => e.username === 'dave@example.com'));
    check('mật khẩu vừa tạo nằm trong vault', (await fillIndex()).find((e) => e.username === 'dave@example.com').password === strong);
    await site.getByRole('button', { name: 'Create account' }).click();
    await site.waitForURL(/\/welcome$/);
    await site.waitForTimeout(1500);
    check('gửi form sau đó không hỏi lưu lần nữa, không tạo mục trùng', !(await saveCard.isVisible()) && (await fillIndex()).filter((e) => e.password === strong).length === 1);

    await site.goto(`${ip}/change`);
    await site.locator('[name=current]').fill('pw-bob-2');
    await site.locator('[name=newpw]').click();
    await ui.locator('.panel .gen').waitFor({ state: 'visible', timeout: 10000 });
    const changed = await ui.locator('.panel .gen .pw').textContent();
    await ui.locator('.panel .wide').click();
    check('form đổi mật khẩu: chỉ điền ô mới và ô nhập lại, giữ nguyên ô mật khẩu cũ', (await site.locator('[name=current]').inputValue()) === 'pw-bob-2' && (await site.locator('[name=newpw]').inputValue()) === changed && (await site.locator('[name=again]').inputValue()) === changed);
    await saveCard.waitFor({ state: 'visible', timeout: 10000 });
    await saveCard.getByRole('button', { name: 'Để sau' }).click();

    await site.goto(`${ip}/signin`);
    await site.locator('[name=password]').click();
    await ui.locator('.panel .row').first().waitFor({ state: 'visible', timeout: 10000 });
    check('ô mật khẩu đăng nhập thường: hiện tài khoản đã lưu, không gợi ý tạo mới', (await ui.locator('.panel .gen').count()) === 0);

    // ---- pick a login once: KaiPass signs in and carries on through password and OTP ----
    await setAutoSubmit(true);
    posts.length = 0;
    await site.goto(`http://localhost:${PORT}/flow-user`);
    await ui.locator('.toast .row').first().waitFor({ state: 'visible', timeout: 10000 });
    await ui.locator('.toast .row', { hasText: 'Local site' }).click();
    await site.waitForURL(/\/flow-done$/, { timeout: 15000 });
    const sent = Object.fromEntries(posts.map((p) => [p.path, p.form]));
    check('chọn gợi ý: tự điền tên đăng nhập và bấm Next', sent['/flow-pass']?.identifier === 'alice@example.com', JSON.stringify(posts));
    check('bước mật khẩu: tự điền và bấm Sign in (không bấm nhầm nút hiện mật khẩu)', sent['/flow-otp']?.password === 's3cret-pw');
    check('bước OTP: tự điền mã hiện tại và xác nhận', codes().includes(sent['/flow-done']?.code), sent['/flow-done']?.code);
    check('cả ba bước chỉ gửi mỗi form một lần', posts.length === 3);

    // A rejected password must not be sent again by itself: the site shows the password page again.
    posts.length = 0;
    await site.goto(`http://localhost:${PORT}/flow-pass`);
    await ui.locator('.toast').waitFor({ state: 'visible', timeout: 10000 });
    await site.waitForTimeout(1200);
    check('trang hỏi lại mật khẩu: không tự gửi lần hai, chỉ hiện gợi ý', posts.length === 0 && (await site.locator('[name=password]').inputValue()) === '');

    // One page with username and password: fill both and sign in.
    posts.length = 0;
    await signInByCard();
    check('form có cả tên đăng nhập và mật khẩu: điền rồi tự đăng nhập', posts.length === 1 && posts[0].form.password === 'pw-bob-2' && posts[0].form.email === 'bob');

    // The login used last comes first next time.
    await site.goto(`${ip}/signin`);
    await ui.locator('.toast .row').first().waitFor({ state: 'visible', timeout: 10000 });
    const before = await ui.locator('.toast .row .user').allTextContents();
    check('tài khoản vừa dùng được xếp lên đầu gợi ý', before[0] === 'bob' && before.length >= 2, before.join());
    const other = before[1];
    await ui.locator('.toast .row', { hasText: other }).click();
    await site.waitForURL(/\/welcome$/, { timeout: 15000 });
    await site.goto(`${ip}/signin`);
    await ui.locator('.toast .row').first().waitFor({ state: 'visible', timeout: 10000 });
    check('dùng tài khoản khác thì tài khoản đó lên đầu', (await ui.locator('.toast .row .user').first().textContent()) === other, other);
    // ---- a code the site emailed, read from a linked Gmail account (Gmail is faked) ----
    const gmail = { calls: [], box: [], token: 'mail-token' };
    const b64 = (t) => Buffer.from(t, 'utf8').toString('base64url');
    await ctx.route('https://gmail.googleapis.com/**', (route) => {
      const req = route.request();
      const url = new URL(req.url());
      gmail.calls.push(url.pathname + url.search);
      const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (req.headers().authorization !== `Bearer ${gmail.token}`) return json(401, { error: { message: 'invalid token' } });
      if (url.pathname.endsWith('/profile')) return json(200, { emailAddress: 'Alice@example.com' });
      if (url.pathname.endsWith('/messages')) {
        const after = Number(/after:(\d+)/.exec(url.searchParams.get('q'))[1]) * 1000;
        return json(200, { messages: gmail.box.filter((m) => m.at >= after).sort((a, b) => b.at - a.at).map((m) => ({ id: m.id })) });
      }
      const m = gmail.box.find((x) => url.pathname.endsWith(`/messages/${x.id}`));
      if (!m) return json(404, {});
      return json(200, { id: m.id, internalDate: String(m.at), snippet: '', payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }], parts: [{ mimeType: 'text/html', body: { data: b64(m.html) } }] } });
    });
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
    // Google's consent window cannot be driven from a test: the worker's call answers like Google would.
    const stubGoogle = () =>
      sw.evaluate(() => {
        globalThis.__mailFlows ??= [];
        chrome.identity.launchWebAuthFlow = async ({ url, interactive }) => {
          const q = new URL(url).searchParams;
          globalThis.__mailFlows.push({ interactive, scope: q.get('scope'), hint: q.get('login_hint'), prompt: q.get('prompt') });
          return `${q.get('redirect_uri')}#access_token=mail-token&token_type=Bearer&expires_in=3600&state=${q.get('state')}`;
        };
      });
    await stubGoogle();
    await openPopup();
    await ext.getByRole('navigation', { name: 'Điều hướng' }).getByRole('button', { name: 'Cài đặt' }).click();
    await ext.getByRole('button', { name: 'Gợi ý trên web', exact: true }).click();
    await ext.getByRole('button', { name: 'Liên kết', exact: true }).click();
    await ext.getByText('alice@example.com').waitFor({ timeout: 10000 });
    const linkFlow = (await sw.evaluate(() => globalThis.__mailFlows))[0];
    check('liên kết Gmail: xin quyền chỉ đọc, cho chọn tài khoản', linkFlow.interactive === true && linkFlow.scope.endsWith('/auth/gmail.readonly') && linkFlow.prompt === 'select_account', JSON.stringify(linkFlow));
    if (shots) await ext.screenshot({ path: join(shots, 'mail-link.png') });
    await ext.getByRole('dialog', { name: 'Cài đặt' }).getByRole('button', { name: 'Đóng' }).click();

    // The page says a code was emailed and the login saved for this site uses the linked address.
    const mail = site.locator('kaipass-ui').locator('.mail');
    gmail.calls.length = 0;
    gmail.box = [{ id: 'old', at: Date.now() - 10 * 60_000, from: 'Local site <no-reply@localhost>', subject: 'Your code', html: '<p>Verification code: <b>111111</b></p>' }];
    posts.length = 0;
    await site.goto(`http://localhost:${PORT}/mail-otp`);
    await mail.locator('.wait').waitFor({ state: 'visible', timeout: 10000 });
    check('trang báo gửi mã qua email: KaiPass chờ thư, bỏ qua mã cũ từ 10 phút trước', (await mail.textContent()).includes('alice@example.com') && (await site.locator('[name=code]').inputValue()) === '');
    gmail.box.push({ id: 'new', at: Date.now(), from: 'Local site <no-reply@localhost>', subject: 'Sign-in verification', html: '<html><body><p>Hi Alice,</p><p>Your verification code is</p><h2>640 915</h2><p>It expires in 10 minutes. © 2026</p></body></html>' });
    await mail.locator('.code').waitFor({ state: 'visible', timeout: 15000 });
    check('thư tới: hiện mã lấy từ email', (await mail.locator('.code').textContent()) === '640915', await mail.textContent());
    if (shots) await site.screenshot({ path: join(shots, 'mail-code.png') });
    await mail.locator('.row').click();
    await site.waitForURL(/\/flow-done$/, { timeout: 15000 });
    check('bấm vào mã: điền và xác nhận', posts.at(-1)?.form.code === '640915', JSON.stringify(posts));

    // The same message is still in the mailbox: its code was used, so it is not offered again.
    gmail.calls.length = 0;
    await site.goto(`http://localhost:${PORT}/mail-otp`);
    await mail.locator('.wait').waitFor({ state: 'visible', timeout: 10000 });
    await site.waitForTimeout(3500);
    check('mã đã dùng không được gợi ý lại', (await mail.locator('.code').count()) === 0 && gmail.calls.length > 0);

    // Started from a suggestion with that address: the emailed code goes in by itself, and the
    // authenticator code is not used for a box that wants the emailed one.
    posts.length = 0;
    gmail.box = [{ id: 'auto', at: Date.now(), from: 'Local site <no-reply@localhost>', subject: '482117 is your Local site code', html: '<p>Use 482117 to sign in.</p>' }];
    await site.goto(`http://localhost:${PORT}/mflow-user`);
    await ui.locator('.toast .row', { hasText: 'Local site' }).first().click();
    await site.waitForURL(/\/flow-done$/, { timeout: 20000 });
    check('đăng nhập từ gợi ý bằng email đã liên kết: tự điền mã từ email (không dùng nhầm mã ứng dụng)', posts.at(-1)?.form.code === '482117' && posts[0]?.form.identifier === 'alice@example.com', JSON.stringify(posts));

    // Not that address, or not an emailed code: the mailbox is never opened.
    gmail.calls.length = 0;
    await site.goto(`${ip}/mail-otp`);
    await site.waitForTimeout(2500);
    check('trang khác, không đăng nhập bằng email đã liên kết: không đọc hộp thư', gmail.calls.length === 0 && !(await mail.isVisible()), gmail.calls.join());
    await site.goto(`http://localhost:${PORT}/otp`);
    await site.waitForTimeout(2000);
    check('ô mã không nhắc tới email: không đọc hộp thư', gmail.calls.length === 0);

    // Google signed out: the card asks to sign in again instead of failing quietly.
    await stubGoogle();
    gmail.token = 'mail-token-2';
    gmail.box = [{ id: 're', at: Date.now(), from: 'Local site', subject: 'Code', html: 'Your verification code: 303808' }];
    await sw.evaluate(() => {
      const ok = chrome.identity.launchWebAuthFlow;
      chrome.identity.launchWebAuthFlow = async (o) => {
        if (!o.interactive) throw new Error('interaction required');
        return (await ok(o)).replace('mail-token', 'mail-token-2');
      };
      return chrome.storage.session.remove('kaipass.mailTokens');
    });
    await site.goto(`http://localhost:${PORT}/mail-otp`);
    await mail.getByRole('button', { name: 'Đăng nhập lại Gmail' }).waitFor({ state: 'visible', timeout: 10000 });
    check('hết phiên Gmail: thẻ báo cần đăng nhập lại', true);
    posts.length = 0;
    await mail.getByRole('button', { name: 'Đăng nhập lại Gmail' }).click();
    // Still the sign-in started from the suggestion a moment ago, so the code goes in by itself.
    await site.waitForURL(/\/flow-done$/, { timeout: 15000 });
    check('đăng nhập lại Gmail xong thì lấy được mã', posts.at(-1)?.form.code === '303808', JSON.stringify(posts));

    // Unlinked: nothing is read any more.
    await openPopup();
    await ext.getByRole('navigation', { name: 'Điều hướng' }).getByRole('button', { name: 'Cài đặt' }).click();
    await ext.getByRole('button', { name: 'Gợi ý trên web', exact: true }).click();
    await ext.getByRole('button', { name: 'Bỏ liên kết alice@example.com' }).click();
    await ext.getByText('Chưa liên kết').waitFor();
    await ext.getByRole('dialog', { name: 'Cài đặt' }).getByRole('button', { name: 'Đóng' }).click();
    gmail.calls.length = 0;
    await site.goto(`http://localhost:${PORT}/mail-otp`);
    await site.waitForTimeout(2000);
    check('bỏ liên kết: không đọc hộp thư nữa, token cũng bị xoá', gmail.calls.length === 0 && (await ext.evaluate(async () => JSON.stringify(await chrome.storage.session.get('kaipass.mailTokens')))) === '{"kaipass.mailTokens":{}}');
    await ctx.unroute('https://gmail.googleapis.com/**');
    await setAutoSubmit(false);

    await site.goto(`${ip}/username-step`);
    await site.locator('[name=identifier]').fill('carol');
    await site.getByRole('button', { name: 'Next' }).click();
    await site.waitForURL(/password-step/);
    await site.locator('[name=password]').fill('pw-carol');
    await site.getByRole('button', { name: 'Sign in' }).click();
    await site.waitForURL(/\/welcome$/);
    await saveCard.waitFor({ state: 'visible', timeout: 10000 });
    check('đăng nhập hai bước: nhớ tên đăng nhập ở bước đầu', (await saveCard.textContent()).includes('carol'));
    await saveCard.getByRole('button', { name: 'Không bao giờ cho trang này' }).click();
    await signIn(ip, 'dave', 'pw-dave');
    await site.waitForTimeout(1500);
    check('chọn "Không bao giờ": trang đó không hỏi nữa', !(await saveCard.isVisible()));

    await site.goto(`http://localhost:${PORT}/spa`);
    await site.locator('#u').fill('erin');
    await site.locator('#p').fill('pw-erin');
    await site.locator('#go').click();
    await saveCard.waitFor({ state: 'visible', timeout: 10000 });
    check('trang không chuyển (app một trang): vẫn hỏi lưu', (await saveCard.textContent()).includes('erin'));
    await saveCard.getByRole('button', { name: 'Để sau' }).click();
    await site.reload();
    await site.waitForTimeout(1500);
    check('bấm "Để sau": không hỏi lại khi tải lại trang', !(await saveCard.isVisible()));

    // Turning the suggestion card off in settings is respected.
    await ext.evaluate(() => chrome.storage.local.set({ 'kaipass.inline': { icon: true, toast: false } }));
    await site.goto(`http://localhost:${PORT}/login`);
    await site.waitForTimeout(800);
    check('tắt thẻ gợi ý trong Cài đặt thì trang không hiện thẻ', !(await ui.locator('.toast').isVisible().catch(() => false)));
    await ext.evaluate(() => chrome.storage.local.remove('kaipass.inline'));

    // Locking forgets the remembered master password.
    await ext.getByRole('button', { name: 'Mở bộ lọc' }).click();
    await ext.getByRole('button', { name: 'Khoá' }).click();
    await ext.getByLabel('Master password').waitFor();
    await ext.goto(popupUrl);
    await ext.getByLabel('Master password').waitFor();
    check('bấm Khoá thì lần mở sau phải nhập master password', true);
    await site.goto(`http://localhost:${PORT}/login`);
    await site.waitForTimeout(800);
    check('đã khoá thì không hiện thẻ gợi ý', !(await ui.locator('.toast').isVisible().catch(() => false)));
    await site.locator('[name=email]').click();
    await ui.locator('.badge').click();
    await ui.locator('.panel .action').waitFor({ state: 'visible' });
    check('đã khoá: danh sách có nút "Mở khoá"', (await ui.locator('.panel .action').textContent()) === 'Mở khoá');
    const [win] = await Promise.all([ctx.waitForEvent('page'), ui.locator('.panel .action').click()]);
    await win.waitForLoadState();
    check('bấm "Mở khoá" mở cửa sổ KaiPass gắn với tab đang xem', /index\.html\?popup&tab=\d+/.test(win.url()), win.url());
    await win.close();
    const stored = await ext.evaluate(async () => JSON.stringify(await chrome.storage.local.get()) + JSON.stringify({ ...localStorage }));
    check('master password không bị ghi xuống đĩa', !stored.includes(PW), stored.slice(0, 200));

    // Google Drive from inside the extension. Google's sign-in window cannot be driven from a test,
    // so chrome.identity.launchWebAuthFlow is replaced by a stub that answers like Google would.
    const drive = fakeDrive();
    await ctx.route('https://www.googleapis.com/**', drive.handler);
    await ext.addInitScript(() => {
      window.__flows = [];
      chrome.identity.launchWebAuthFlow = async ({ url, interactive }) => {
        const q = new URL(url).searchParams;
        window.__flows.push({ interactive, prompt: q.get('prompt'), redirect: q.get('redirect_uri'), scope: q.get('scope') });
        return `${q.get('redirect_uri')}#access_token=fake-token&token_type=Bearer&expires_in=3600&state=${q.get('state')}`;
      };
    });
    await ext.goto(popupUrl);
    await ext.getByRole('button', { name: 'Quên master password?' }).click();
    await ext.getByText('Xoá dữ liệu trên thiết bị này', { exact: true }).first().click();
    await ext.getByLabel('Gõ "XOÁ" để xác nhận').fill('xoa');
    await ext.getByRole('button', { name: 'Xoá dữ liệu trên thiết bị này' }).click();
    await ext.getByRole('button', { name: /Lưu trên Google Drive/ }).click();
    check('hiện địa chỉ redirect cần khai báo với Google', (await ext.locator('code.wrap').textContent()) === `https://${EXT_ID}.chromiumapp.org/`);
    
    await ext.getByRole('button', { name: 'Đăng nhập Google' }).click();
    await ext.getByLabel('Master password', { exact: true }).fill(PW);
    await ext.getByLabel('Nhập lại').fill(PW);
    await ext.getByRole('button', { name: 'Tạo vault' }).click();
    await ext.getByTestId('suggestions').waitFor();
    const flow = (await ext.evaluate(() => window.__flows))[0];
    check('extension xin đúng quyền drive.file qua địa chỉ redirect của nó', flow.interactive === true && flow.scope.endsWith('/auth/drive.file') && flow.redirect === `https://${EXT_ID}.chromiumapp.org/`, JSON.stringify(flow));
    check('extension tạo vault trên Drive', drive.state.rev === 1 && drive.state.file.length > 500);

    // When Google's token has expired the extension renews it without asking.
    await ext.evaluate(() => chrome.storage.session.remove('kaipass.gtoken'));
    await openPopup();
    await ext.getByRole('button', { name: 'Mở bộ lọc' }).click();
    await ext.locator('[data-testid=sync-status][data-status=synced]').waitFor({ timeout: 15000 });
    const renew = (await ext.evaluate(() => window.__flows)).at(-1);
    check('hết phiên Google thì extension tự gia hạn, không cần bấm', renew.interactive === false && renew.prompt === 'none', JSON.stringify(renew));

    // Another device adds a login; visiting a login page brings it into the suggestions without
    // opening KaiPass.
    await addOnOtherDevice(drive, 'Từ máy khác', `http://localhost:${PORT}/login`, 'frank', 'pw-frank');
    const revBefore = drive.state.rev;
    await site.goto(`http://localhost:${PORT}/login`);
    let synced = false;
    for (let i = 0; i < 100 && !synced; i++) {
      const list = await ext.evaluate(async () => (await chrome.storage.session.get('kaipass.fill'))['kaipass.fill'] ?? []);
      synced = list.some((e) => e.username === 'frank');
      if (!synced) await site.waitForTimeout(100);
    }
    check('đồng bộ nền: gợi ý có tài khoản thêm từ máy khác', synced);
    await site.reload();
    await ui.locator('.toast').waitFor({ state: 'visible', timeout: 10000 });
    check('trang đăng nhập gợi ý tài khoản vừa đồng bộ', (await ui.locator('.toast').textContent()).includes('Từ máy khác'));
    await ext.locator('li .item-title', { hasText: 'Từ máy khác' }).waitFor({ state: 'attached', timeout: 10000 });
    check('cửa sổ KaiPass đang mở cũng thấy tài khoản đó', true);
    check('đồng bộ nền không ghi đè file trên Drive khi không có gì mới', drive.state.rev === revBefore);

    // Saving from the page in Drive mode uploads to Drive.
    await site.goto(`http://localhost:${PORT}/signin`);
    await site.locator('[name=email]').fill('gina');
    await site.locator('[name=password]').fill('pw-gina');
    await site.getByRole('button', { name: 'Sign in' }).click();
    await site.waitForURL(/\/welcome$/);
    await ui.locator('.save').waitFor({ state: 'visible', timeout: 10000 });
    await ui.locator('.save').getByRole('button', { name: 'Lưu', exact: true }).click();
    let uploaded = false;
    for (let i = 0; i < 100 && !uploaded; i++) {
      uploaded = drive.state.rev > revBefore;
      if (!uploaded) await site.waitForTimeout(100);
    }
    const onDrive = uploaded
      ? [...(await kdbxweb.Kdbx.load(new Uint8Array(drive.state.file).buffer, new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(PW)))).getDefaultGroup().allEntries()].map((e) => e.fields.get('UserName'))
      : [];
    check('lưu từ trang khi dùng Drive: tải lên Drive, giữ cả mục của máy khác', onDrive.includes('gina') && onDrive.includes('frank'), onDrive.join());

    check('không có lỗi trong console', problems.length === 0, problems.join(' | '));
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    await ctx.close();
    server.close();
  }
  console.log(failures ? `\n${failures} kiểm tra thất bại` : '\nTất cả kiểm tra đều đạt');
  process.exit(failures ? 1 : 0);
})();
