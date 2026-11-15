/**
 * Google Drive storage. The app only asks for the `drive.file` scope, so it can see nothing in the
 * user's Drive except files it created itself, and Drive only ever receives the encrypted vault.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const google: any;

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GIS_URL = 'https://accounts.google.com/gsi/client';
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

export class AuthNeeded extends Error {
  constructor() {
    super('Cần đăng nhập Google');
  }
}

let gis: Promise<void> | undefined;

/** Loads Google's sign-in script. Call early so a later click can open the popup immediately. */
export function preloadGoogle(): Promise<void> {
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

  private token(): string | undefined {
    try {
      const saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null');
      if (saved && saved.clientId === this.clientId && saved.exp > Date.now() + 60_000) return saved.token;
    } catch {
      /* ignore */
    }
    return undefined;
  }

  hasToken(): boolean {
    return !!this.token();
  }

  /** Opens Google's consent popup. Must be called from a click handler. */
  async signIn(): Promise<void> {
    await preloadGoogle();
    await new Promise<void>((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: SCOPE,
        prompt: '',
        callback: (r: any) => {
          if (r.error) return reject(new Error(r.error_description || r.error));
          if (!google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) {
            return reject(new Error('Bạn chưa cấp quyền Google Drive cho app'));
          }
          sessionStorage.setItem(
            TOKEN_KEY,
            JSON.stringify({
              clientId: this.clientId,
              token: r.access_token,
              exp: Date.now() + Number(r.expires_in) * 1000,
            }),
          );
          resolve();
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
  }

  signOut(): void {
    sessionStorage.removeItem(TOKEN_KEY);
  }

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const token = this.token();
    if (!token) throw new AuthNeeded();
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      this.signOut();
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
}
