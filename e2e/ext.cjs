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
  '/user-first': `<form><input name="identifier" type="text" autocomplete="username"><button>Next</button></form>`,
  '/otp': `<form><input name="code" autocomplete="one-time-code" inputmode="numeric"></form>`,
  '/digits': `<form>${'<input class="d" maxlength="1" inputmode="numeric">'.repeat(6)}</form>`,
  '/hidden': `<form><input name="email" style="display:none"><input name="pass" type="password" style="display:none"><input name="user" type="text"><input name="password" type="password"></form>`,
  '/frame': `<p>Trang chứa khung của site khác</p><iframe src="http://127.0.0.1:${PORT}/login" width="400" height="200"></iframe>`,
};

(async () => {
  const server = http
    .createServer((req, res) => {
      const body = PAGES[req.url.split('?')[0]];
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
    const openPopup = async () => {
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

    // Locking forgets the remembered master password.
    await ext.getByRole('button', { name: 'Mở bộ lọc' }).click();
    await ext.getByRole('button', { name: 'Khoá' }).click();
    await ext.getByLabel('Master password').waitFor();
    await ext.goto(popupUrl);
    await ext.getByLabel('Master password').waitFor();
    check('bấm Khoá thì lần mở sau phải nhập master password', true);
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
