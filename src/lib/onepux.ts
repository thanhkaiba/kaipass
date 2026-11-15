import { unzipSync, strFromU8 } from 'fflate';
import type { ItemDraft, ItemField, ItemType, Vault } from './vault';
import { normalizeOtp } from './totp';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ImportResult {
  items: number;
  attachments: number;
  skipped: string[];
}

const CATEGORY: Record<string, ItemType> = {
  '001': 'login',
  '002': 'card',
  '003': 'note',
  '004': 'identity',
  '005': 'login',
  '006': 'note',
  '103': 'identity', // driver licence
  '106': 'identity', // passport
  '108': 'identity', // social security number
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Flattens one 1Password field value into text. Returns '' for things we do not carry over. */
function fieldText(value: any): { text: string; secret: boolean } {
  if (!value || typeof value !== 'object') return { text: '', secret: false };
  const [kind, v] = Object.entries(value)[0] ?? [];
  if (v == null || v === '') return { text: '', secret: false };
  switch (kind) {
    case 'concealed':
    case 'creditCardNumber':
      return { text: String(v), secret: true };
    case 'date': {
      const d = new Date(Number(v) * 1000);
      return {
        text: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
        secret: false,
      };
    }
    case 'monthYear': {
      const n = Number(v);
      return { text: `${pad(n % 100)}/${Math.floor(n / 100)}`, secret: false };
    }
    case 'email':
      return { text: typeof v === 'string' ? v : String((v as any).email_address ?? ''), secret: false };
    case 'address': {
      const a = v as any;
      const parts = [a.street, a.city, a.state, a.zip, a.country].filter(Boolean);
      return { text: parts.join(', '), secret: false };
    }
    case 'sshKey':
      return { text: String((v as any).privateKey ?? ''), secret: true };
    case 'reference':
    case 'file':
    case 'totp':
      return { text: '', secret: false };
    default:
      return { text: typeof v === 'object' ? JSON.stringify(v) : String(v), secret: false };
  }
}

/**
 * Imports a 1Password .1pux export into the vault. Each 1Password vault becomes a folder
 * (unless there is only one), archived items go to an "Archive" folder.
 */
export async function importOnePux(vault: Vault, data: Uint8Array): Promise<ImportResult> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data);
  } catch {
    throw new Error('File không phải định dạng .1pux');
  }
  const raw = files['export.data'];
  if (!raw) throw new Error('File .1pux thiếu export.data');
  const doc = JSON.parse(strFromU8(raw));

  const fileById = new Map<string, { name: string; data: Uint8Array }>();
  for (const [path, bytes] of Object.entries(files)) {
    const m = /^files\/([^_/]+)__(.+)$/.exec(path);
    if (m) fileById.set(m[1], { name: m[2], data: bytes });
  }

  const result: ImportResult = { items: 0, attachments: 0, skipped: [] };
  const vaults: any[] = (doc.accounts ?? []).flatMap((a: any) => a.vaults ?? []);
  const folderIds = new Map<string, string>();
  const folderFor = (name: string): string => {
    const existing = folderIds.get(name) ?? vault.folders().find((f) => f.name === name)?.id;
    const id = existing ?? vault.createFolder(name);
    folderIds.set(name, id);
    return id;
  };

  for (const v of vaults) {
    const vaultName: string = v.attrs?.name || v.name || 'Imported';
    for (const it of v.items ?? []) {
      const overview = it.overview ?? {};
      const details = it.details ?? {};
      const title: string = overview.title || '(không tên)';
      try {
        const draft: ItemDraft = {
          type: CATEGORY[it.categoryUuid] ?? 'note',
          title,
          username: '',
          password: details.password ?? '',
          url: overview.url ?? '',
          notes: details.notesPlain ?? '',
          otp: '',
          fields: [],
          tags: Array.isArray(overview.tags) ? overview.tags : [],
          favorite: Number(it.favIndex) > 0,
          folderId:
            it.state === 'archived'
              ? folderFor('Archive')
              : vaults.length > 1
                ? folderFor(vaultName)
                : '',
        };
        const attachments: { name: string; data: Uint8Array }[] = [];
        const addFile = (documentId?: string, fileName?: string) => {
          const f = documentId ? fileById.get(documentId) : undefined;
          if (f) attachments.push({ name: fileName || f.name, data: f.data });
        };

        for (const lf of details.loginFields ?? []) {
          if (lf.designation === 'username') draft.username = lf.value ?? '';
          else if (lf.designation === 'password') draft.password = lf.value ?? '';
        }
        (overview.urls ?? [])
          .map((u: any) => u?.url)
          .filter((u: string) => u && u !== draft.url)
          .forEach((u: string, i: number) =>
            draft.fields.push({ name: `KP2A_URL_${i + 1}`, value: u, secret: false }),
          );

        for (const section of details.sections ?? []) {
          for (const f of section.fields ?? []) {
            const label = [section.title, f.title || f.id].filter(Boolean).join(': ') || 'Field';
            const value = f.value ?? {};
            if (value.totp) {
              try {
                const uri = normalizeOtp(String(value.totp), title);
                if (!draft.otp) draft.otp = uri;
                else draft.fields.push({ name: label, value: uri, secret: true });
              } catch {
                draft.fields.push({ name: label, value: String(value.totp), secret: true });
              }
              continue;
            }
            if (value.file) {
              addFile(value.file.documentId, value.file.fileName);
              continue;
            }
            const { text, secret } = fieldText(value);
            if (text) draft.fields.push({ name: label, value: text, secret } satisfies ItemField);
          }
        }
        addFile(details.documentAttributes?.documentId, details.documentAttributes?.fileName);

        const id = vault.upsert(draft);
        for (const a of attachments) {
          const copy = a.data.buffer.slice(a.data.byteOffset, a.data.byteOffset + a.data.byteLength);
          await vault.addAttachment(id, a.name, copy as ArrayBuffer);
          result.attachments++;
        }
        result.items++;
      } catch (e) {
        result.skipped.push(`${title}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return result;
}
