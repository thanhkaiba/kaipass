/**
 * Icon sets the user can switch between (Settings → Appearance). Each set other than the built-in
 * one is a separate chunk, downloaded the first time it is chosen. The choice is per device.
 */
import { useSyncExternalStore } from 'react';

export type PackId = 'kaipass' | 'lucide' | 'phosphor' | 'phosphor-duotone' | 'phosphor-fill' | 'pixel' | 'emoji';

export const PACKS: { id: PackId; label: string; note: string; credit: string }[] = [
  { id: 'kaipass', label: 'KaiPass', note: 'Nét mảnh, mặc định', credit: 'KaiPass' },
  { id: 'lucide', label: 'Lucide', note: 'Gọn gàng, hiện đại', credit: 'Lucide · ISC' },
  { id: 'phosphor', label: 'Phosphor', note: 'Mềm, bo tròn', credit: 'Phosphor Icons · MIT' },
  { id: 'phosphor-duotone', label: 'Phosphor Duotone', note: 'Hai tông màu, dễ thương', credit: 'Phosphor Icons · MIT' },
  { id: 'phosphor-fill', label: 'Phosphor Fill', note: 'Đặc, nổi bật', credit: 'Phosphor Icons · MIT' },
  { id: 'pixel', label: 'Pixel', note: 'Kiểu game 8-bit', credit: 'Pixelarticons · MIT' },
  { id: 'emoji', label: 'Emoji', note: 'Emoji của máy bạn', credit: 'Font emoji hệ thống' },
];

const LOADERS: Partial<Record<PackId, () => Promise<{ default: Record<string, string> }>>> = {
  lucide: () => import('../icons/lucide'),
  phosphor: () => import('../icons/phosphor'),
  'phosphor-duotone': () => import('../icons/phosphor-duotone'),
  'phosphor-fill': () => import('../icons/phosphor-fill'),
  pixel: () => import('../icons/pixel'),
};

export const EMOJI: Record<string, string> = {
  copy: '📋', eye: '👀', eyeOff: '🙈', star: '⭐', plus: '➕', lock: '🔒', settings: '⚙️', trash: '🗑️',
  edit: '✏️', search: '🔍', back: '◀️', external: '↗️', refresh: '🔄', login: '🌐', card: '💳', identity: '🪪',
  note: '📝', folder: '📁', download: '📥', upload: '📤', clip: '📎', menu: '🍔', x: '✖️', all: '🗂️',
  dice: '🎲', restore: '♻️', finger: '👆', share: '💌', image: '🖼️', pdf: '📄', cloud: '☁️', device: '💻',
  shield: '🛡️', key: '🔑', info: 'ℹ️', check: '✅', arrow: '➡️', more: '💬', link: '🔗', clock: '⏰',
  alert: '⚠️', sparkle: '✨', qr: '🔳', camera: '📷', puzzle: '🧩',
};

const KEY = 'kaipass.icons';
const cache = new Map<PackId, Record<string, string>>();
type State = { id: PackId; icons: Record<string, string> | null };
let state: State = { id: 'kaipass', icons: null };
const listeners = new Set<() => void>();

function stored(): PackId {
  try {
    const v = localStorage.getItem(KEY) as PackId | null;
    return v && PACKS.some((p) => p.id === v) ? v : 'kaipass';
  } catch {
    return 'kaipass';
  }
}

export async function loadPack(id: PackId): Promise<Record<string, string> | null> {
  const loader = LOADERS[id];
  if (!loader) return null;
  if (!cache.has(id)) cache.set(id, (await loader()).default);
  return cache.get(id)!;
}

export async function setPack(id: PackId): Promise<void> {
  const icons = await loadPack(id);
  state = { id, icons };
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* private mode: the choice lasts until the page closes */
  }
  listeners.forEach((l) => l());
}

export function useIconPack(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

// Restore the saved choice at start-up.
void setPack(stored()).catch(() => {});

// ---- accent colour ----

export const ACCENTS = [
  { id: 'blue', label: 'Xanh dương', color: '#2f6bff' },
  { id: 'violet', label: 'Tím', color: '#7c4dff' },
  { id: 'pink', label: 'Hồng', color: '#e8458b' },
  { id: 'green', label: 'Xanh lá', color: '#12a150' },
  { id: 'orange', label: 'Cam', color: '#f06a1d' },
  { id: 'teal', label: 'Xanh ngọc', color: '#0e9fa8' },
] as const;

const ACCENT_KEY = 'kaipass.accent';

export function getAccent(): string {
  try {
    return localStorage.getItem(ACCENT_KEY) ?? 'blue';
  } catch {
    return 'blue';
  }
}

export function setAccent(id: string): void {
  if (id === 'blue') document.documentElement.removeAttribute('data-accent');
  else document.documentElement.setAttribute('data-accent', id);
  try {
    localStorage.setItem(ACCENT_KEY, id);
  } catch {
    /* ignore */
  }
}

setAccent(getAccent());
