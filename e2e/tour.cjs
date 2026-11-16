// Takes a screenshot of every screen, for reviewing the design by eye. Not a test.
//   npm run build:android && node e2e/tour.cjs phone      (Android app's web build, phone size)
//   npm run build && node e2e/tour.cjs desktop            (web build, desktop size)
// Screenshots go to $SHOTS_DIR (default ./tour).
const { spawn } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { chromium } = require('playwright');
const { fakeDrive } = require('./fake-drive.cjs');
const { fakeNative, BRIDGE } = require('./fake-native.cjs');

const mode = process.argv[2] === 'desktop' ? 'desktop' : 'phone';
const phone = mode === 'phone';
const PORT = 4177;
const URL_ = `http://localhost:${PORT}/`;
const PW = 'correct horse battery';
const out = process.env.SHOTS_DIR || join(__dirname, '..', 'tour');
mkdirSync(out, { recursive: true });
const SIZE = phone ? { width: 412, height: 860 } : { width: 1280, height: 800 };
/** A phone with the keyboard up leaves about this much of the page. */
const KEYBOARD = { width: 412, height: 470 };

const GIS_STUB = `window.google = { accounts: { oauth2: {
  initTokenClient: (cfg) => ({ requestAccessToken: () => setTimeout(() => cfg.callback({ access_token: 'fake-token', expires_in: 3600, scope: cfg.scope }), 10) }),
  hasGrantedAllScopes: () => true,
} } };`;

(async () => {
  const server = spawn('npx', ['vite', 'preview', '--outDir', phone ? 'dist-android' : 'dist', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
  let n = 0;
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(URL_)).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const browser = await chromium.launch();
    const drive = fakeDrive();
    const native = fakeNative();
    const ctx = await browser.newContext({
      viewport: SIZE,
      deviceScaleFactor: 2,
      isMobile: phone,
      hasTouch: phone,
      serviceWorkers: 'block',
      colorScheme: process.env.DARK ? 'dark' : 'light',
    });
    await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: GIS_STUB }));
    await ctx.route('https://www.googleapis.com/**', drive.handler);
    if (phone) {
      await ctx.exposeBinding('__nativeCall', async (_s, raw) => {
        const { method, args } = JSON.parse(raw);
        try {
          return { ok: true, result: (await native.handle(method, args || {})) ?? null };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      });
      await ctx.addInitScript(BRIDGE);
    }
    const page = await ctx.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    const shot = async (name) => {
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(out, `${mode}-${String(++n).padStart(2, '0')}-${name}.png`) });
    };
    /** The same screen as a phone shows it with the keyboard open. */
    const withKeyboard = async (name) => {
      if (!phone) return;
      await page.setViewportSize(KEYBOARD);
      await page.evaluate(() => document.activeElement?.scrollIntoView?.({ block: 'center' }));
      await shot(`${name}-keyboard`);
      await page.setViewportSize(SIZE);
    };
    const step = async (name, fn) => {
      try {
        await fn();
      } catch (e) {
        console.log(`SKIP ${name}: ${e.message.split('\n')[0]}`);
        await page.screenshot({ path: join(out, `${mode}-ERR-${name}.png`) }).catch(() => {});
      }
    };
    const back = async () => phone && (await page.getByRole('button', { name: 'Quay lại danh sách' }).click());
    const nav = async () => phone && (await page.getByRole('button', { name: 'Mở bộ lọc' }).click());
    const closeModal = async () => page.getByRole('dialog').last().getByRole('button', { name: 'Đóng' }).first().click();
    const add = async (type) => {
      await page.getByRole('button', { name: 'Thêm', exact: true }).click();
      await page.getByRole('menuitem', { name: type }).click();
    };
    const save = async (title) => {
      await page.getByRole('button', { name: 'Lưu' }).click();
      await page.locator('.detail-title h2', { hasText: title }).waitFor();
    };
    const login = async (title, o = {}) => {
      await add('Đăng nhập');
      await page.getByLabel('Tên', { exact: true }).fill(title);
      await page.getByLabel('Tên đăng nhập').fill(o.username ?? 'theo@example.com');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(o.password ?? 'Tr0ub4dor&3-horse');
      if (o.url) await page.getByLabel('Địa chỉ web').fill(o.url);
      if (o.otp) await page.getByLabel(/Mã bí mật OTP/).fill('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
      await save(title);
      await back();
    };

    await page.goto(URL_);
    await page.getByRole('button', { name: /Lưu trên Google Drive/ }).waitFor();
    await shot('setup');
    await page.getByRole('button', { name: /Lưu trên Google Drive/ }).click();
    await shot('setup-drive');
    await page.getByRole('button', { name: 'Đăng nhập Google' }).click();
    await page.getByLabel('Master password', { exact: true }).waitFor();
    await shot('setup-password');
    await page.getByLabel('Master password', { exact: true }).fill(PW);
    await withKeyboard('setup-password');
    await page.getByLabel('Nhập lại').fill(PW);
    await page.getByRole('button', { name: 'Tạo vault' }).click();
    await page.getByTestId('sync-status').waitFor({ state: 'attached' });
    await shot('empty');

    await login('GitHub', { url: 'https://github.com/login', otp: true });
    await login('Google công việc', { url: 'https://accounts.google.com', username: 'theo@congty.vn' });
    await login('Shopee', { url: 'https://shopee.vn', username: '0901234567' });
    await login('Vietcombank', { url: 'https://vcbdigibank.vietcombank.com.vn', username: '0901234567' });
    await login('AWS (prod)', { url: 'https://123456789012.signin.aws.amazon.com/console', username: 'theo', otp: true });
    await login('Wifi nhà', { username: 'Tang3', password: 'matkhauwifi' });
    await step('card', async () => {
      await add('Thẻ');
      await page.getByLabel('Tên', { exact: true }).fill('Visa Techcombank');
      await page.getByLabel('Giá trị Số thẻ').fill('4111111111111111');
      await page.getByLabel('Giá trị Hết hạn').fill('12/2030');
      await shot('edit-card');
      await save('Visa Techcombank');
      await shot('view-card');
      await back();
    });
    await step('note', async () => {
      await add('Ghi chú');
      await page.getByLabel('Tên', { exact: true }).fill('Recovery codes GitHub');
      await page.getByLabel('Ghi chú').fill('1a2b-3c4d\n5e6f-7g8h\n9i0j-1k2l');
      await save('Recovery codes GitHub');
      await back();
    });

    await shot('list');
    await step('search', async () => {
      await page.getByLabel('Tìm kiếm').fill('goo');
      await shot('search');
      await withKeyboard('search');
      await page.getByLabel('Tìm kiếm').fill('');
    });
    await step('add-menu', async () => {
      await page.getByRole('button', { name: 'Thêm', exact: true }).click();
      await shot('add-menu');
      if (phone) await page.locator('.menu-backdrop').click({ position: { x: 20, y: 20 } });
      else await page.getByRole('button', { name: 'Thêm', exact: true }).click();
    });
    await step('nav', async () => {
      if (!phone) return;
      await nav();
      await shot('nav');
      await page.getByRole('navigation').getByRole('button', { name: 'Đóng' }).click();
    });
    await step('view-login', async () => {
      await page.locator('.item', { hasText: 'GitHub' }).first().click();
      await page.getByTestId('otp-code').waitFor();
      await shot('view-login');
      await page.getByRole('button', { name: 'Sửa' }).click();
      await shot('edit-login');
      await page.evaluate(() => document.querySelector('.detail, .editor, main')?.scrollTo?.(0, 99999));
      await page.mouse.wheel(0, 3000);
      await shot('edit-login-bottom');
      await page.getByLabel('Mật khẩu', { exact: true }).focus();
      await withKeyboard('edit-login');
      await step('generator', async () => {
        await page.getByRole('button', { name: /Tạo mật khẩu/ }).first().click();
        await shot('generator');
        await withKeyboard('generator');
        await closeModal().catch(() => page.keyboard.press('Escape'));
      });
      await page.getByRole('button', { name: 'Huỷ' }).click();
    });
    await step('share', async () => {
      await page.getByRole('button', { name: 'Chia sẻ', exact: true }).click();
      await shot('share');
      await page.getByRole('dialog').locator('input[type=password]').fill('chia-se-123');
      await page.getByRole('button', { name: 'Tạo link' }).click();
      await page.getByLabel('Link chia sẻ').waitFor();
      await shot('share-link');
      await closeModal();
    });
    await back().catch(() => {});

    const menuItem = async (name) => {
      await page.getByRole('button', { name: 'Thêm', exact: true }).click();
      await page.getByRole('menuitem', { name }).click();
    };
    await step('qr', async () => {
      await menuItem('Quét mã QR (OTP)…');
      await shot('qr');
      await closeModal();
    });
    await step('ai-paste', async () => {
      await menuItem('Dán tin nhắn (Claude)…');
      await shot('ai-paste');
      await page.getByLabel('Tin nhắn có thông tin tài khoản').focus();
      await withKeyboard('ai-paste');
      await closeModal();
    });
    await step('import-share', async () => {
      await menuItem('Từ link chia sẻ…');
      await shot('import-share');
      await page.getByRole('dialog').locator('input, textarea').first().focus();
      await withKeyboard('import-share');
      await closeModal();
    });

    const settings = async () => {
      if (!phone) await page.getByRole('button', { name: 'Cài đặt' }).click();
      else await page.getByRole('navigation', { name: 'Điều hướng' }).getByRole('button', { name: 'Cài đặt' }).click();
    };
    await step('settings', async () => {
      await settings();
      const dialog = page.getByRole('dialog', { name: 'Cài đặt' });
      const tabs = await dialog.locator('.tabs button, nav button, .settings-nav button').allTextContents();
      console.log('tabs:', tabs.join(' | '));
      await shot('settings');
      const toMenu = async () => phone && (await dialog.getByRole('button', { name: 'Quay lại Cài đặt' }).click());
      for (const t of ['Bảo mật', 'Dữ liệu', 'Tự điền', 'Claude AI', 'Giao diện', 'Thiết bị']) {
        const b = dialog.getByRole('button', { name: t, exact: true });
        if (!(await b.count())) continue;
        await b.click();
        await shot(`settings-${t.replace(/\s+/g, '-')}`);
        await dialog.locator('.settings, .settings-body').evaluateAll((els) => els.forEach((e) => e.scrollTo(0, 99999)));
        await page.waitForTimeout(100);
        await shot(`settings-${t.replace(/\s+/g, '-')}-bottom`);
        await toMenu();
      }
      await step('settings-password', async () => {
        await dialog.getByRole('button', { name: 'Bảo mật', exact: true }).click();
        await dialog.getByRole('button', { name: /Đổi master password|Đổi/ }).first().click();
        await shot('settings-change-password');
        await dialog.locator('input').first().focus();
        await withKeyboard('settings-change-password');
      });
      await step('settings-ai-key', async () => {
        await toMenu();
        await dialog.getByRole('button', { name: 'Claude AI', exact: true }).click();
        await dialog.locator('input').first().focus();
        await withKeyboard('settings-ai-key');
      });
      await closeModal();
    });

    await step('save-prompt', async () => {
      if (!phone) return;
      native.pendingSave = { domain: 'github.com', package: 'com.android.chrome', appLabel: 'Chrome', username: 'theo@example.com', password: 'new-pass-123' };
      await page.evaluate(() => window.__emit('pendingSave'));
      await page.getByRole('dialog', { name: 'Cập nhật mật khẩu?' }).waitFor();
      await shot('save-prompt');
      await page.getByRole('dialog').locator('input').first().focus();
      await withKeyboard('save-prompt');
      await page.getByRole('button', { name: 'Không lưu' }).click();
    });

    await step('generator-tool', async () => {
      if (!phone) return;
      await page.getByRole('button', { name: 'Tạo mật khẩu' }).click();
      await shot('generator-tool');
      await closeModal();
    });

    await step('lock', async () => {
      native.bioFails = true;
      await page.getByRole('button', { name: 'Khoá' }).click();
      await page.getByLabel('Master password').waitFor();
      await shot('lock');
      await page.getByLabel('Master password').focus();
      await withKeyboard('lock');
      await page.getByRole('button', { name: 'Quên master password?' }).click();
      await shot('forgot');
    });

    await browser.close();
    console.log(`${n} ảnh trong ${out}`);
  } catch (e) {
    console.error(e);
  } finally {
    server.kill();
  }
})();
