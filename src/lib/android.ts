/**
 * The Android app's native side (android/app/.../WebHostActivity.kt). The app serves this web app
 * from its own files and injects `KaiPassNative`, a message channel only this page's origin can
 * use. Each call is a JSON message with an id; the reply carries the same id. The app also sends
 * events (no id), e.g. when autofill hands over a login to save.
 */
type Port = { postMessage(message: string): void; onmessage: ((e: { data: string }) => void) | null };

const port: Port | undefined =
  typeof window !== 'undefined' ? ((window as unknown as { KaiPassNative?: Port }).KaiPassNative ?? undefined) : undefined;

export const isAndroid = !!port;

export class NativeError extends Error {}

let seq = 0;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners = new Map<string, Set<(data: unknown) => void>>();

if (port) {
  port.onmessage = (e) => {
    let m: { id?: number; ok?: boolean; result?: unknown; error?: string; event?: string; data?: unknown };
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.event) {
      listeners.get(m.event)?.forEach((l) => l(m.data));
      return;
    }
    const w = m.id !== undefined ? waiting.get(m.id) : undefined;
    if (!w) return;
    waiting.delete(m.id!);
    if (m.ok) w.resolve(m.result);
    else w.reject(new NativeError(m.error || 'Lỗi trên Android'));
  };
}

export function native<T = unknown>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!port) return Promise.reject(new NativeError('Chỉ có trong app Android'));
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
    port.postMessage(JSON.stringify({ id, method, args }));
  });
}

export function onNative(event: string, fn: (data: unknown) => void): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(fn);
  return () => listeners.get(event)?.delete(fn);
}

export interface AndroidInfo {
  version: string;
  sdk: number;
  /** This app's package and signing certificate SHA-1, for the Google Cloud setup. */
  package: string;
  sha1: string;
  autofill: { supported: boolean; enabled: boolean };
  bio: { available: boolean; enrolled: boolean };
}

export const androidInfo = () => native<AndroidInfo>('info');

/** A login typed into an app or page that autofill handed over to save. */
export interface PendingSave {
  /** Identifies this entry in the app's waiting list. */
  id: string;
  /** KaiPass generated this password on a sign-up form (rather than the user typing it). */
  generated?: boolean;
  domain: string | null;
  package: string;
  appLabel: string;
  username: string;
  password: string;
}

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Asks where to save a file (Android's "save as"), then writes it. */
export async function saveFileAndroid(name: string, bytes: BlobPart, mime: string): Promise<boolean> {
  const data = b64(new Uint8Array(await new Blob([bytes]).arrayBuffer()));
  const r = await native<{ saved: boolean }>('saveFile', { name, mime, data });
  return r.saved;
}

// Lets the app answer events from the start (it replies through the last channel used).
if (port) void native('hello').catch(() => {});
