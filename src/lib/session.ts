import { AuthNeeded, Drive } from './drive';
import { kv } from './store';
import { Vault, WrongPasswordError } from './vault';

export const FILE_NAME = 'kaipass.kdbx';

export interface Meta {
  mode: 'local' | 'drive';
  clientId?: string;
  fileId?: string;
  /** Revision of the Drive file that our local copy was last reconciled with. */
  rev?: string;
  /** True while the local copy has changes Drive has not seen. */
  dirty: boolean;
  lastSync?: number;
}

export type SyncStatus = 'local' | 'synced' | 'syncing' | 'pending' | 'auth' | 'offline' | 'error';

const K_VAULT = 'vault';
const K_META = 'meta';
const K_EDIT = 'editState';

export async function storedMeta(): Promise<Meta | undefined> {
  return (await kv.get<ArrayBuffer>(K_VAULT)) ? kv.get<Meta>(K_META) : undefined;
}

export async function wipeDevice(): Promise<void> {
  await kv.clear();
  sessionStorage.clear();
}

/** An unlocked vault plus the bookkeeping that keeps the local copy and Drive in step. */
export class Session {
  status: SyncStatus;
  error = '';
  readonly drive?: Drive;
  private listeners = new Set<() => void>();
  private seq = 0;
  private syncing = false;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  private constructor(
    readonly vault: Vault,
    readonly meta: Meta,
    drive?: Drive,
  ) {
    this.drive = drive;
    this.status = meta.mode === 'local' ? 'local' : meta.dirty ? 'pending' : 'synced';
  }

  /** Opens the copy stored on this device. */
  static async unlock(password: string): Promise<Session> {
    const bytes = await kv.get<ArrayBuffer>(K_VAULT);
    const meta = await kv.get<Meta>(K_META);
    if (!bytes || !meta) throw new Error('Chưa có vault trên thiết bị này');
    const vault = await Vault.open(bytes, password);
    const edit = await kv.get<string>(K_EDIT);
    if (edit) vault.editState = JSON.parse(edit);
    const drive = meta.mode === 'drive' && meta.clientId ? new Drive(meta.clientId) : undefined;
    return new Session(vault, meta, drive);
  }

  /** Stores a brand-new or imported vault on this device only. */
  static async adoptLocal(vault: Vault): Promise<Session> {
    const s = new Session(vault, { mode: 'local', dirty: false });
    await s.persist(await vault.save());
    return s;
  }

  /** Uploads a new vault to Drive (the signed-in account has none yet). */
  static async createOnDrive(vault: Vault, drive: Drive): Promise<Session> {
    const bytes = await vault.save();
    const remote = await drive.create(FILE_NAME, bytes);
    const s = new Session(
      vault,
      { mode: 'drive', clientId: drive.clientId, fileId: remote.id, rev: remote.rev, dirty: false, lastSync: Date.now() },
      drive,
    );
    await s.persist(bytes);
    return s;
  }

  /** Adopts the vault that already exists on Drive. */
  static async adoptFromDrive(
    bytes: ArrayBuffer,
    password: string,
    drive: Drive,
    remote: { id: string; rev: string },
  ): Promise<Session> {
    const vault = await Vault.open(bytes, password);
    const s = new Session(
      vault,
      { mode: 'drive', clientId: drive.clientId, fileId: remote.id, rev: remote.rev, dirty: false, lastSync: Date.now() },
      drive,
    );
    await s.persist(bytes);
    return s;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private async persist(bytes?: ArrayBuffer): Promise<void> {
    if (bytes) await kv.set(K_VAULT, bytes);
    await kv.set(K_META, { ...this.meta });
    await kv.set(K_EDIT, JSON.stringify(this.vault.editState));
  }

  /** Call after every change to the vault: writes the local copy, then schedules a Drive sync. */
  async commit(): Promise<void> {
    this.seq++;
    if (this.meta.mode === 'drive') {
      this.meta.dirty = true;
      if (this.status !== 'syncing') this.status = 'pending';
    }
    await this.persist(await this.vault.save());
    this.emit();
    if (this.meta.mode === 'drive') {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.sync(), 1500);
    }
  }

  /** Moves a device-only vault onto Drive. Fails if that account already holds a vault. */
  async moveToDrive(drive: Drive): Promise<Session> {
    if (await drive.find(FILE_NAME)) {
      throw new Error(
        'Tài khoản Google này đã có sẵn một vault. Hãy xuất file .kdbx để giữ dữ liệu ở đây, rồi "Xoá dữ liệu trên thiết bị" và kết nối lại Google Drive.',
      );
    }
    const next = await Session.createOnDrive(this.vault, drive);
    this.close();
    return next;
  }

  /**
   * Reconciles with Drive. `interactive` means we are inside a click handler and may open
   * Google's sign-in popup.
   */
  async sync(interactive = false): Promise<void> {
    const { meta, drive, vault } = this;
    if (this.closed || meta.mode !== 'drive' || !drive || !meta.fileId) return;
    if (this.syncing) {
      this.again = true;
      return;
    }
    clearTimeout(this.timer);
    this.syncing = true;
    this.error = '';
    try {
      if (!drive.hasToken()) {
        if (!interactive) {
          this.status = 'auth';
          return;
        }
        await drive.signIn();
      }
      this.status = 'syncing';
      this.emit();

      const remote = await drive.stat(meta.fileId);
      if (!remote) {
        // The Drive file is gone: put our copy back.
        const seq = this.seq;
        const bytes = await vault.save();
        const created = await drive.create(FILE_NAME, bytes);
        meta.fileId = created.id;
        meta.rev = created.rev;
        if (seq === this.seq) meta.dirty = false;
      } else {
        if (remote.rev !== meta.rev) {
          const bytes = await drive.download(remote.id);
          if (meta.dirty) {
            await vault.merge(bytes);
            await kv.set(K_VAULT, await vault.save());
          } else {
            await vault.replaceWith(bytes);
            await kv.set(K_VAULT, bytes);
          }
          meta.rev = remote.rev;
        }
        if (meta.dirty) {
          const seq = this.seq;
          const bytes = await vault.save();
          const updated = await drive.update(remote.id, bytes);
          meta.rev = updated.rev;
          if (seq === this.seq) {
            meta.dirty = false;
            vault.clearEditState();
          }
        }
      }
      meta.lastSync = Date.now();
      this.status = meta.dirty ? 'pending' : 'synced';
    } catch (e) {
      if (e instanceof AuthNeeded) {
        this.status = 'auth';
      } else if (e instanceof WrongPasswordError) {
        this.status = 'error';
        this.error =
          'Vault trên Drive đang dùng master password khác (có thể bạn đã đổi trên thiết bị khác). Vào Cài đặt → Đổi master password, đặt trùng với mật khẩu mới rồi đồng bộ lại.';
      } else if (e instanceof TypeError || !navigator.onLine) {
        this.status = 'offline';
      } else {
        this.status = 'error';
        this.error = e instanceof Error ? e.message : String(e);
      }
    } finally {
      this.syncing = false;
      if (!this.closed) {
        await this.persist();
        this.emit();
        if (this.again || (meta.dirty && this.status === 'pending')) {
          this.again = false;
          this.timer = setTimeout(() => void this.sync(), 500);
        }
      }
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.listeners.clear();
  }
}
