/**
 * KaiPass for macOS, Windows and Linux: a window around the same web app, served from the app's own
 * files at kaipass://app, plus what a web page cannot do on a computer: Google sign-in through the
 * system browser (staying signed in), locking when the computer locks, Touch ID, a clipboard that
 * clears itself, and reading a QR code off the screen.
 */
const { app, BrowserWindow, Menu, clipboard, desktopCapturer, ipcMain, net, powerMonitor, protocol, safeStorage, screen, session, shell, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const oauth = require('./oauth.cjs');

const ORIGIN = 'kaipass://app';
const WEB_ROOT = path.join(__dirname, 'app');
const isMac = process.platform === 'darwin';
// Tests point sign-in at a local stand-in for Google and "open the browser" at a plain request.
const TEST = process.env.KAIPASS_TEST === '1';
const ENDPOINTS = TEST && process.env.KAIPASS_OAUTH_AUTH ? { auth: process.env.KAIPASS_OAUTH_AUTH, token: process.env.KAIPASS_OAUTH_TOKEN } : oauth.GOOGLE;

if (TEST && process.env.KAIPASS_USER_DATA) app.setPath('userData', process.env.KAIPASS_USER_DATA);

protocol.registerSchemesAsPrivileged([
  { scheme: 'kaipass', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

/** @type {BrowserWindow | null} */
let win = null;

// ---- small encrypted files in the app's data folder ----

const dataFile = (name) => path.join(app.getPath('userData'), name);

/** Encrypted with a key the operating system keeps (Keychain, DPAPI, libsecret). */
function saveSecret(name, value) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Máy này không có kho khoá của hệ điều hành để lưu an toàn');
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(dataFile(name), safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 });
}

function readSecret(name) {
  try {
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(dataFile(name))));
  } catch {
    return null;
  }
}

function dropSecret(name) {
  fs.rmSync(dataFile(name), { force: true });
}

// ---- Google sign-in ----

function builtInClient() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'oauth.json'), 'utf8'));
    return c.clientId ? c : null;
  } catch {
    return null;
  }
}

const googleClient = () => readSecret('google-client.bin') || builtInClient();

async function openInBrowser(url) {
  if (TEST) {
    // Stands in for the user approving in their browser: follow the redirect back to the app.
    const res = await fetch(url, { redirect: 'manual' });
    const next = res.headers.get('location');
    if (next) await fetch(next);
    return;
  }
  await shell.openExternal(url);
}

async function googleToken({ interactive }) {
  const client = googleClient();
  if (!client) throw new Error('need-client');
  const saved = readSecret('google.bin');
  if (saved?.refreshToken) {
    try {
      const t = await oauth.refresh({ ...client, refreshToken: saved.refreshToken, endpoints: ENDPOINTS });
      return { token: t.accessToken, expiresIn: t.expiresIn - 120 };
    } catch (e) {
      // A revoked or expired grant needs a fresh sign-in; anything else (no network) is just an error.
      if (e.code !== 'invalid_grant') throw e;
      dropSecret('google.bin');
    }
  }
  if (!interactive) throw new Error('consent-needed');
  const t = await oauth.signIn({ ...client, open: openInBrowser, endpoints: ENDPOINTS });
  if (t.refreshToken) saveSecret('google.bin', { refreshToken: t.refreshToken });
  win?.show();
  win?.focus();
  return { token: t.accessToken, expiresIn: t.expiresIn - 120 };
}

// ---- unlock with Touch ID (macOS) ----

const bioAvailable = () => isMac && safeStorage.isEncryptionAvailable() && systemPreferences.canPromptTouchID();

async function touchId(reason) {
  try {
    await systemPreferences.promptTouchID(reason);
  } catch {
    throw new Error('Đã huỷ');
  }
}

// ---- clipboard that clears itself ----

let clearTimer;
function copy(text, sensitive) {
  clipboard.writeText(text);
  clearTimeout(clearTimer);
  if (sensitive) {
    clearTimer = setTimeout(() => {
      // Only what KaiPass put there.
      if (clipboard.readText() === text) clipboard.clear();
    }, 30_000);
  }
}

// ---- QR codes shown on screen ----

async function captureScreens() {
  // Step aside so the code behind KaiPass's own window is visible.
  const wasVisible = win?.isVisible();
  win?.hide();
  await new Promise((r) => setTimeout(r, 350));
  try {
    const displays = screen.getAllDisplays();
    const biggest = displays.reduce((m, d) => Math.max(m, d.size.width * d.scaleFactor, d.size.height * d.scaleFactor), 0);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(biggest), height: Math.round(biggest) } });
    return sources.filter((s) => !s.thumbnail.isEmpty()).map((s) => s.thumbnail.toDataURL());
  } finally {
    if (wasVisible) {
      win?.show();
      win?.focus();
    }
  }
}

// ---- what the page may ask for ----

const handlers = {
  info: () => ({
    platform: process.platform,
    version: app.getVersion(),
    google: { configured: !!googleClient(), builtIn: !!builtInClient(), signedIn: !!readSecret('google.bin')?.refreshToken },
    bio: { available: bioAvailable(), enrolled: fs.existsSync(dataFile('bio.bin')) },
  }),
  googleToken,
  googleConfigure: ({ file }) => {
    const client = oauth.parseClientFile(String(file));
    saveSecret('google-client.bin', client);
    dropSecret('google.bin');
    return { clientId: client.clientId };
  },
  googleSignOut: () => dropSecret('google.bin'),
  bioEnroll: async ({ password }) => {
    if (!bioAvailable()) throw new Error('Máy này không có Touch ID');
    await touchId('bật mở khoá KaiPass bằng Touch ID');
    saveSecret('bio.bin', { password: String(password) });
  },
  bioUnlock: async () => {
    const saved = readSecret('bio.bin');
    if (!saved?.password) throw new Error('Chưa bật mở khoá bằng Touch ID trên máy này');
    await touchId('mở khoá KaiPass');
    return { password: saved.password };
  },
  bioDisable: () => dropSecret('bio.bin'),
  copy: ({ text, sensitive }) => copy(String(text), !!sensitive),
  openUrl: ({ url }) => (/^https?:\/\//i.test(String(url)) ? shell.openExternal(String(url)) : undefined),
  captureScreens,
};

ipcMain.handle('kaipass', async (event, method, args) => {
  // Only KaiPass's own page, in its main frame.
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || !frame.url.startsWith(`${ORIGIN}/`)) throw new Error('Không được phép');
  const fn = handlers[method];
  if (!fn) throw new Error(`Không hỗ trợ: ${method}`);
  return (await fn(args || {})) ?? null;
});

const emit = (name) => win?.webContents.send('kaipass-event', name);

// ---- the window ----

function serveApp() {
  protocol.handle('kaipass', (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('', { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(WEB_ROOT, rel));
    if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + path.sep)) return new Response('', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function guardSession() {
  const s = session.defaultSession;
  // The camera for QR codes; nothing else (no notifications, location, …).
  s.setPermissionRequestHandler((wc, permission, done) => done(wc.getURL().startsWith(`${ORIGIN}/`) && ['media', 'clipboard-sanitized-write'].includes(permission)));
  // Google's and Anthropic's APIs answer cross-origin calls for web origins; make sure the app's own
  // origin gets the same answer.
  s.webRequest.onHeadersReceived({ urls: ['https://www.googleapis.com/*', 'https://api.anthropic.com/*'] }, (details, done) => {
    const headers = { ...details.responseHeaders };
    for (const k of Object.keys(headers)) if (/^access-control-allow-(origin|headers|methods)$/i.test(k)) delete headers[k];
    headers['Access-Control-Allow-Origin'] = [ORIGIN];
    headers['Access-Control-Allow-Headers'] = ['*, Authorization, Content-Type'];
    headers['Access-Control-Allow-Methods'] = ['GET, POST, PATCH, PUT, DELETE, OPTIONS'];
    done({ responseHeaders: headers, statusLine: details.method === 'OPTIONS' ? 'HTTP/1.1 204 No Content' : details.statusLine });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 380,
    minHeight: 520,
    title: 'KaiPass',
    backgroundColor: '#f4f6fb',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => (win = null));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // The recovery kit opens in its own window to print; web links go to the browser.
    if (url.startsWith(`blob:${ORIGIN}/`)) return { action: 'allow', overrideBrowserWindowOptions: { width: 820, height: 900, autoHideMenuBar: true, webPreferences: { sandbox: true } } };
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  void win.loadURL(`${ORIGIN}/index.html`);
}

function buildMenu() {
  const lock = { label: 'Khoá KaiPass', accelerator: 'CmdOrCtrl+L', click: () => emit('lock') };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' }] : []),
      { label: 'KaiPass', submenu: [lock, { type: 'separator' }, isMac ? { role: 'close' } : { role: 'quit' }] },
      { role: 'editMenu' },
      { label: 'Hiển thị', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]),
  );
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.whenReady().then(() => {
    // A Linux session without a keyring (GNOME Keyring, KWallet) has no OS key store. Fall back to
    // Chromium's built-in key so sign-in still works; the files stay readable only by this user.
    // What is kept this way is the Google token for the app's own (encrypted) vault file.
    if (process.platform === 'linux' && !safeStorage.isEncryptionAvailable()) safeStorage.setUsePlainTextEncryption(true);
    serveApp();
    guardSession();
    buildMenu();
    createWindow();
    // Lock the vault whenever the computer locks or sleeps.
    powerMonitor.on('lock-screen', () => emit('lock'));
    powerMonitor.on('suspend', () => emit('lock'));
    app.on('activate', () => (win ? win.show() : createWindow()));
  });
  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
  // No page may open other windows or web views.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });
}
