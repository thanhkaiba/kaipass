import type * as K from 'kdbxweb';
import { kdbxweb } from './kx';

export type ItemType = 'login' | 'card' | 'identity' | 'note';

export interface ItemField {
  name: string;
  value: string;
  secret: boolean;
}

export interface Attachment {
  name: string;
  size: number;
}

export interface ItemDraft {
  id?: string;
  type: ItemType;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  /** otpauth:// URI, or empty */
  otp: string;
  fields: ItemField[];
  tags: string[];
  favorite: boolean;
  folderId: string;
}

export interface Item extends ItemDraft {
  id: string;
  folderName: string;
  attachments: Attachment[];
  created: number;
  modified: number;
  trashed: boolean;
}

export interface Folder {
  id: string;
  name: string;
  depth: number;
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Sai master password');
  }
}

const STD = ['Title', 'UserName', 'Password', 'URL', 'Notes'];
const OTP = 'otp';
const TYPE_TAG: Record<Exclude<ItemType, 'login'>, string> = {
  card: 'kaipass-card',
  identity: 'kaipass-identity',
  note: 'kaipass-note',
};
const FAV_TAG = 'kaipass-fav';
const RESERVED_TAGS = new Set<string>([...Object.values(TYPE_TAG), FAV_TAG]);
// KDBX stores tags as one string split on these characters, so a tag must not contain them.
const TAG_SEPARATORS = /[;,:]/g;

// Argon2id, 64 MiB, 3 passes: about a second on a phone, expensive to brute-force.
const KDF_MEMORY = 64 * 1024 * 1024;
const KDF_ITERATIONS = 3;
const KDF_PARALLELISM = 2;

function text(v: K.KdbxEntryField | undefined): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : v.getText();
}

function binaryValue(bin: K.KdbxBinary | K.KdbxBinaryWithHash): K.KdbxBinary {
  return kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(bin) ? bin.value : bin;
}

function credentials(password: string): K.KdbxCredentials {
  return new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password));
}

async function load(bytes: ArrayBuffer, cred: K.KdbxCredentials): Promise<K.Kdbx> {
  try {
    return await kdbxweb.Kdbx.load(bytes, cred);
  } catch (e) {
    if (e instanceof kdbxweb.KdbxError && e.code === kdbxweb.Consts.ErrorCodes.InvalidKey) {
      throw new WrongPasswordError();
    }
    throw e;
  }
}

export class Vault {
  private constructor(private db: K.Kdbx) {}

  static async create(password: string, name = 'KaiPass'): Promise<Vault> {
    const db = kdbxweb.Kdbx.create(credentials(password), name);
    db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
    const kdf = db.header.kdfParameters!;
    const T = kdbxweb.VarDictionary.ValueType;
    kdf.set('M', T.UInt64, kdbxweb.Int64.from(KDF_MEMORY));
    kdf.set('I', T.UInt64, kdbxweb.Int64.from(KDF_ITERATIONS));
    kdf.set('P', T.UInt32, KDF_PARALLELISM);
    return new Vault(db);
  }

  static async open(bytes: ArrayBuffer, password: string): Promise<Vault> {
    return new Vault(await load(bytes, credentials(password)));
  }

  /** Serialises and encrypts the whole vault. */
  async save(): Promise<ArrayBuffer> {
    this.db.cleanup({ historyRules: true, binaries: true });
    return this.db.save();
  }

  /** Folds another copy of this vault (e.g. the one on Drive) into this one. */
  async merge(bytes: ArrayBuffer): Promise<void> {
    const remote = await load(bytes, this.db.credentials);
    this.db.merge(remote);
  }

  /** Discards this copy in favour of another one encrypted with the same password. */
  async replaceWith(bytes: ArrayBuffer): Promise<void> {
    this.db = await load(bytes, this.db.credentials);
  }

  async changePassword(password: string): Promise<void> {
    await this.db.credentials.setPassword(kdbxweb.ProtectedValue.fromString(password));
  }

  async checkPassword(password: string): Promise<boolean> {
    const a = new Uint8Array(await credentials(password).getHash());
    const b = new Uint8Array(await this.db.credentials.getHash());
    let diff = a.length ^ b.length;
    for (let i = 0; i < a.length && i < b.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  get editState(): K.KdbxEditState {
    return this.db.getLocalEditState();
  }

  set editState(state: K.KdbxEditState) {
    this.db.setLocalEditState(state);
  }

  clearEditState(): void {
    this.db.removeLocalEditState();
  }

  // ---- folders ----

  private get root(): K.KdbxGroup {
    return this.db.getDefaultGroup();
  }

  private get bin(): K.KdbxGroup | undefined {
    const id = this.db.meta.recycleBinUuid;
    return id ? this.db.getGroup(id) : undefined;
  }

  private inBin(node: K.KdbxEntry | K.KdbxGroup): boolean {
    const bin = this.bin;
    if (!bin) return false;
    for (let g = node instanceof kdbxweb.KdbxGroup ? node : node.parentGroup; g; g = g.parentGroup) {
      if (g === bin) return true;
    }
    return false;
  }

  folders(): Folder[] {
    const out: Folder[] = [];
    const walk = (g: K.KdbxGroup, depth: number) => {
      for (const child of g.groups) {
        if (child === this.bin) continue;
        out.push({ id: child.uuid.id, name: child.name || '(không tên)', depth });
        walk(child, depth + 1);
      }
    };
    walk(this.root, 0);
    return out;
  }

  private group(id: string): K.KdbxGroup {
    return (id && this.db.getGroup(id)) || this.root;
  }

  createFolder(name: string): string {
    return this.db.createGroup(this.root, name.trim()).uuid.id;
  }

  renameFolder(id: string, name: string): void {
    const g = this.db.getGroup(id);
    if (!g || g === this.root) return;
    g.name = name.trim();
    g.times.update();
  }

  /** Moves the folder's items to the top level, then removes the folder. */
  deleteFolder(id: string): void {
    const g = this.db.getGroup(id);
    if (!g || g === this.root || g === this.bin) return;
    for (const e of [...g.allEntries()]) this.db.move(e, this.root);
    this.db.move(g, null);
  }

  // ---- items ----

  private entry(id: string): K.KdbxEntry | undefined {
    for (const e of this.root.allEntries()) if (e.uuid.id === id) return e;
    return undefined;
  }

  private toItem(e: K.KdbxEntry): Item {
    const tags = e.tags || [];
    const type =
      (Object.keys(TYPE_TAG) as (keyof typeof TYPE_TAG)[]).find((t) => tags.includes(TYPE_TAG[t])) ||
      'login';
    const fields: ItemField[] = [];
    for (const [name, value] of e.fields) {
      if (STD.includes(name) || name === OTP) continue;
      fields.push({ name, value: text(value), secret: typeof value !== 'string' });
    }
    const attachments: Attachment[] = [];
    for (const [name, bin] of e.binaries) {
      attachments.push({ name, size: binaryValue(bin).byteLength });
    }
    const parent = e.parentGroup;
    return {
      id: e.uuid.id,
      type,
      title: text(e.fields.get('Title')),
      username: text(e.fields.get('UserName')),
      password: text(e.fields.get('Password')),
      url: text(e.fields.get('URL')),
      notes: text(e.fields.get('Notes')),
      otp: text(e.fields.get(OTP)),
      fields,
      tags: tags.filter((t) => !RESERVED_TAGS.has(t)),
      favorite: tags.includes(FAV_TAG),
      folderId: parent && parent !== this.root ? parent.uuid.id : '',
      folderName: parent && parent !== this.root ? parent.name || '' : '',
      attachments,
      created: e.times.creationTime?.getTime() ?? 0,
      modified: e.times.lastModTime?.getTime() ?? 0,
      trashed: this.inBin(e),
    };
  }

  items(): Item[] {
    return [...this.root.allEntries()].map((e) => this.toItem(e));
  }

  item(id: string): Item | undefined {
    const e = this.entry(id);
    return e && this.toItem(e);
  }

  /** Creates or updates an item; returns its id. */
  upsert(d: ItemDraft): string {
    let e = d.id ? this.entry(d.id) : undefined;
    const target = this.group(d.folderId);
    if (e) {
      e.pushHistory();
      if (e.parentGroup !== target && !this.inBin(e)) this.db.move(e, target);
    } else {
      e = this.db.createEntry(target);
    }
    const P = kdbxweb.ProtectedValue;
    for (const name of [...e.fields.keys()]) e.fields.delete(name);
    e.fields.set('Title', d.title.trim());
    e.fields.set('UserName', d.username);
    e.fields.set('Password', P.fromString(d.password));
    e.fields.set('URL', d.url.trim());
    e.fields.set('Notes', d.notes);
    if (d.otp.trim()) e.fields.set(OTP, P.fromString(d.otp.trim()));
    const used = new Set<string>([...STD, OTP]);
    for (const f of d.fields) {
      const base = f.name.trim();
      if (!base || !f.value) continue;
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base} ${n}`;
      used.add(name);
      e.fields.set(name, f.secret ? P.fromString(f.value) : f.value);
    }
    const tags = d.tags
      .map((t) => t.replace(TAG_SEPARATORS, ' ').trim())
      .filter((t) => t && !RESERVED_TAGS.has(t));
    if (d.type !== 'login') tags.push(TYPE_TAG[d.type]);
    if (d.favorite) tags.push(FAV_TAG);
    e.tags = [...new Set(tags)];
    e.times.update();
    return e.uuid.id;
  }

  setFavorite(id: string, favorite: boolean): void {
    const e = this.entry(id);
    if (!e) return;
    e.tags = e.tags.filter((t) => t !== FAV_TAG);
    if (favorite) e.tags.push(FAV_TAG);
    e.times.update();
  }

  /** Moves an item to the bin; an item already in the bin is deleted for good. */
  remove(id: string): void {
    const e = this.entry(id);
    if (!e) return;
    if (this.inBin(e)) this.db.move(e, null);
    else this.db.remove(e);
  }

  restore(id: string): void {
    const e = this.entry(id);
    if (!e || !this.inBin(e)) return;
    const prev = e.previousParentGroup && this.db.getGroup(e.previousParentGroup);
    this.db.move(e, prev && !this.inBin(prev) ? prev : this.root);
  }

  emptyBin(): void {
    const bin = this.bin;
    if (!bin) return;
    for (const e of [...bin.allEntries()]) this.db.move(e, null);
    for (const g of [...bin.groups]) this.db.move(g, null);
  }

  // ---- attachments ----

  async addAttachment(id: string, fileName: string, data: ArrayBuffer): Promise<void> {
    const e = this.entry(id);
    if (!e) return;
    const dot = fileName.lastIndexOf('.');
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot) : '';
    let name = fileName;
    for (let n = 2; e.binaries.has(name); n++) name = `${stem} (${n})${ext}`;
    e.pushHistory();
    e.binaries.set(name, await this.db.createBinary(data));
    e.times.update();
  }

  attachment(id: string, name: string): Uint8Array | undefined {
    const bin = this.entry(id)?.binaries.get(name);
    if (!bin) return undefined;
    const value = binaryValue(bin);
    return value instanceof kdbxweb.ProtectedValue ? value.getBinary() : new Uint8Array(value);
  }

  removeAttachment(id: string, name: string): void {
    const e = this.entry(id);
    if (!e || !e.binaries.has(name)) return;
    e.pushHistory();
    e.binaries.delete(name);
    e.times.update();
  }
}
