const AUTOLOCK_KEY = 'kaipass.autolock';

/** Minutes of inactivity before the vault locks; 0 means never. */
export function autoLockMinutes(): number {
  const v = Number(localStorage.getItem(AUTOLOCK_KEY) ?? 10);
  return Number.isFinite(v) && v >= 0 ? v : 10;
}

export function setAutoLockMinutes(minutes: number): void {
  localStorage.setItem(AUTOLOCK_KEY, String(minutes));
}
