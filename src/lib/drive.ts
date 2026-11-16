/**
 * Google Drive storage. The app only asks for the `drive.file` scope, so it can see nothing in the
 * user's Drive except files it created itself, and Drive only ever receives the encrypted vault.
 */

import { native } from './android';
import { desktop } from './desktop';
import { isAndroid, isDesktop, isExtension, memory } from './platform';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const google: any;

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GIS_URL = 'https://accounts.google.com/gsi/client';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const TOKEN_KEY = 'kaipass.gtoken';
const FIELDS = 'id,headRevisionId,modifiedTime,trashed';
const KDBX_MIME = 'application/x-keepass2';

export interface RemoteFile {
  id: string;
  /** Changes whenever the file content changes. */
  rev: string;
}

/** The Google account does not allow files to be shared with "anyone with the link". */
export class ShareBlocked extends Error {
  constructor() {
    super('Tài khoản Google này không cho chia sẻ file công khai');
  }
}

export class AuthNeeded extends Error {
  constructor() {
    super('Cần đăng nhập Google');
  }
}

let gis: Promise<void> | undefined;

/** Loads Google's sign-in script. Call early so a later click can open the popup immediately. */
export function preloadGoogle(): Promise<void> {
  // The Android and desktop apps sign in outside the page (Google Play services, system browser).
  if (isAndroid || isDesktop) return Promise.resolve();
  gis ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_URL;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gis = undefined;
      reject(new Error('Không tải được thư viện đăng nhập Google (kiểm tra mạng)'));
    };
    document.head.appendChild(s);
  });
  return gis;
}

function toRemote(f: any): RemoteFile {
  return { id: f.id, rev: f.headRevisionId || f.modifiedTime };
}

export class Drive {
  constructor(readonly clientId: string) {}

  private async token(): Promise<string | undefined> {
    const saved = await memory.get<{ clientId: string; token: string; exp: number }>(TOKEN_KEY);
    if (saved && saved.clientId === this.clientId && saved.exp > Date.now() + 60_000) return saved.token;
    return undefined;
  }

  async hasToken(): Promise<boolean> {
    return !!(await this.token());
  }

  private async keep(token: string, expiresIn: number): Promise<void> {
    await memory.set(TOKEN_KEY, { clientId: this.clientId, token, exp: Date.now() + expiresIn * 1000 });
  }

  /** Opens Google's consent window. On the web this must be called from a click handler. */
  async signIn(): Promise<void> {
    if (isExtension) return this.extensionSignIn(true);
    if (isAndroid) return this.androidSignIn(true);
    if (isDesktop) return this.desktopSignIn(true);
    await preloadGoogle();
    const r = await new Promise<any>((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: SCOPE,
        prompt: '',
        callback: (res: any) => {
          if (res.error) return reject(new Error(res.error_description || res.error));
          if (!google.accounts.oauth2.hasGrantedAllScopes(res, SCOPE)) {
            return reject(new Error('Bạn chưa cấp quyền Google Drive cho app'));
          }
          resolve(res);
        },
        error_callback: (e: any) =>
          reject(
            new Error(
              e?.type === 'popup_closed'
                ? 'Bạn đã đóng cửa sổ đăng nhập Google'
                : e?.type === 'popup_failed_to_open'
                  ? 'Trình duyệt đã chặn cửa sổ đăng nhập Google'
                  : e?.message || 'Đăng nhập Google thất bại',
            ),
          ),
      });
      client.requestAccessToken();
    });
    await this.keep(r.access_token, Number(r.expires_in));
  }

  /**
   * Tries to get a fresh token without showing anything. Only the extension can do this;
   * returns false when the user has to sign in by hand.
   */
  async silent(): Promise<boolean> {
    if (!isExtension && !isAndroid && !isDesktop) return false;
    try {
      if (isDesktop) await this.desktopSignIn(false);
      else if (isAndroid) await this.androidSignIn(false);
      else await this.extensionSignIn(false);
      return true;
    } catch {
      return false;
    }
  }

  /** Google Play services on the phone: picks the account and asks for Drive access once. */
  private async androidSignIn(interactive: boolean): Promise<void> {
    const r = await native<{ token: string; expiresIn: number }>('googleToken', { interactive });
    await this.keep(r.token, r.expiresIn);
  }

  /**
   * The desktop app opens the system browser once, then keeps a refresh token (encrypted by the
   * operating system) and renews access quietly.
   */
  private async desktopSignIn(interactive: boolean): Promise<void> {
    let r: { token: string; expiresIn: number };
    try {
      r = await desktop<{ token: string; expiresIn: number }>('googleToken', { interactive });
    } catch (e) {
      if (e instanceof Error && e.message === 'need-client') {
        throw new Error('Chưa có client Google cho app máy tính. Chọn file JSON của client "Desktop app" trước (Cài đặt → Dữ liệu).');
      }
      throw e;
    }
    await this.keep(r.token, r.expiresIn);
  }

  /** The address Google must be told to redirect to; shown to the user during setup. */
  static extensionRedirect(): string {
    return isExtension ? chrome.identity.getRedirectURL() : '';
  }

  private async extensionSignIn(interactive: boolean): Promise<void> {
    const state = crypto.randomUUID();
    const query = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'token',
      redirect_uri: Drive.extensionRedirect(),
      scope: SCOPE,
      state,
    });
    if (!interactive) query.set('prompt', 'none');
    let back: string | undefined;
    try {
      back = await chrome.identity.launchWebAuthFlow({ url: `${AUTH_URL}?${query}`, interactive });
    } catch (e) {
      throw new Error(
        `Đăng nhập Google thất bại${e instanceof Error && e.message ? `: ${e.message}` : ''}. Kiểm tra lại Client ID và địa chỉ redirect.`,
      );
    }
    const reply = new URLSearchParams(new URL(back ?? 'https://invalid/').hash.slice(1));
    const token = reply.get('access_token');
    if (reply.get('state') !== state || !token) {
      throw new Error(reply.get('error') || 'Google không trả về quyền truy cập');
    }
    await this.keep(token, Number(reply.get('expires_in') || 3600));
  }

  async signOut(): Promise<void> {
    await memory.remove(TOKEN_KEY);
  }

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.token();
    if (!token) throw new AuthNeeded();
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      // Google Play services caches tokens: tell it this one is dead, or it hands it out again.
      if (isAndroid) await native('googleClearToken', { token }).catch(() => {});
      await this.signOut();
      throw new AuthNeeded();
    }
    return res;
  }

  private async fail(res: Response): Promise<never> {
    let detail = '';
    try {
      detail = (await res.json())?.error?.message ?? '';
    } catch {
      /* ignore */
    }
    throw new Error(`Google Drive báo lỗi ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  /** Finds the vault file this app created earlier, if any. */
  async find(name: string): Promise<RemoteFile | undefined> {
    const q = `name = '${name.replace(/['\\]/g, '\\$&')}' and trashed = false`;
    const res = await this.call(
      `${API}?q=${encodeURIComponent(q)}&spaces=drive&orderBy=modifiedTime desc&fields=files(${FIELDS})`,
    );
    if (!res.ok) return this.fail(res);
    const file = (await res.json()).files?.[0];
    return file ? toRemote(file) : undefined;
  }

  /** Returns undefined when the file was deleted or moved to Drive's bin. */
  async stat(id: string): Promise<RemoteFile | undefined> {
    const res = await this.call(`${API}/${encodeURIComponent(id)}?fields=${FIELDS}`);
    if (res.status === 404) return undefined;
    if (!res.ok) return this.fail(res);
    const file = await res.json();
    return file.trashed ? undefined : toRemote(file);
  }

  async download(id: string): Promise<ArrayBuffer> {
    const res = await this.call(`${API}/${encodeURIComponent(id)}?alt=media`);
    if (!res.ok) return this.fail(res);
    return res.arrayBuffer();
  }

  async create(name: string, bytes: ArrayBuffer): Promise<RemoteFile> {
    const boundary = `kaipass${crypto.randomUUID().replace(/-/g, '')}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify({ name, mimeType: KDBX_MIME }),
      `\r\n--${boundary}\r\nContent-Type: ${KDBX_MIME}\r\n\r\n`,
      bytes,
      `\r\n--${boundary}--`,
    ]);
    const res = await this.call(`${UPLOAD}?uploadType=multipart&fields=${FIELDS}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!res.ok) return this.fail(res);
    return toRemote(await res.json());
  }

  async update(id: string, bytes: ArrayBuffer): Promise<RemoteFile> {
    const res = await this.call(
      `${UPLOAD}/${encodeURIComponent(id)}?uploadType=media&fields=${FIELDS}`,
      { method: 'PATCH', headers: { 'Content-Type': KDBX_MIME }, body: bytes },
    );
    if (!res.ok) return this.fail(res);
    return toRemote(await res.json());
  }

  // ---- share links ----

  /** Uploads an encrypted share and makes it readable by anyone who has its id. */
  async createShare(bytes: ArrayBuffer, expires: number): Promise<string> {
    const boundary = `kaipass${crypto.randomUUID().replace(/-/g, '')}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify({
        name: 'kaipass-share.bin',
        mimeType: 'application/octet-stream',
        appProperties: { kaipassShare: '1', expires: String(expires) },
      }),
      `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      bytes,
      `\r\n--${boundary}--`,
    ]);
    const res = await this.call(`${UPLOAD}?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!res.ok) return this.fail(res);
    const { id } = await res.json();
    const perm = await this.call(`${API}/${encodeURIComponent(id)}/permissions?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    });
    if (!perm.ok) {
      await this.deleteFile(id).catch(() => {});
      throw new ShareBlocked();
    }
    return id;
  }

  /** Deletes a file this app created. Missing files count as deleted. */
  async deleteFile(id: string): Promise<void> {
    const res = await this.call(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) return this.fail(res);
  }

  /** Deletes share files whose expiry has passed; returns how many. */
  async deleteExpiredShares(now = Date.now()): Promise<number> {
    const q = "appProperties has { key='kaipassShare' and value='1' } and trashed = false";
    const res = await this.call(`${API}?q=${encodeURIComponent(q)}&spaces=drive&fields=files(id,appProperties)&pageSize=1000`);
    if (!res.ok) return this.fail(res);
    let n = 0;
    for (const f of (await res.json()).files ?? []) {
      if (Number(f.appProperties?.expires) < now) {
        await this.deleteFile(f.id);
        n++;
      }
    }
    return n;
  }

  /** Reads a public share without signing in. */
  static async fetchShare(id: string, apiKey: string): Promise<ArrayBuffer | undefined> {
    const res = await fetch(`${API}/${encodeURIComponent(id)}?alt=media&key=${encodeURIComponent(apiKey)}`, {
      // An API key restricted to the app's address needs to see where the request comes from.
      referrerPolicy: 'strict-origin-when-cross-origin',
    });
    if (res.status === 404 || res.status === 403) return undefined;
    if (!res.ok) throw new Error(`Google Drive báo lỗi ${res.status}`);
    return res.arrayBuffer();
  }
}
