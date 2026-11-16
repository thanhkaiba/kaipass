/**
 * The desktop app's native side (desktop/main.cjs), reached through `window.KaiPassDesktop`, which
 * its preload script exposes: Google sign-in through the system browser, Touch ID, a clipboard that
 * clears itself, QR codes read off the screen, and "the computer locked" events.
 */
type Bridge = {
  call(method: string, args?: Record<string, unknown>): Promise<unknown>;
  on(event: string, fn: () => void): () => void;
};

const bridge: Bridge | undefined =
  typeof window !== 'undefined' ? (window as unknown as { KaiPassDesktop?: Bridge }).KaiPassDesktop : undefined;

export const isDesktop = !!bridge;

export class DesktopError extends Error {}

export async function desktop<T = unknown>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!bridge) throw new DesktopError('Chỉ có trong app máy tính');
  try {
    return (await bridge.call(method, args)) as T;
  } catch (e) {
    // Electron wraps the message: "Error invoking remote method 'kaipass': Error: <message>".
    const raw = e instanceof Error ? e.message : String(e);
    throw new DesktopError(raw.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ''));
  }
}

export function onDesktop(event: string, fn: () => void): () => void {
  return bridge ? bridge.on(event, fn) : () => {};
}

export interface DesktopInfo {
  platform: 'darwin' | 'win32' | 'linux';
  version: string;
  google: { configured: boolean; builtIn: boolean; signedIn: boolean };
  bio: { available: boolean; enrolled: boolean };
}

export const desktopInfo = () => desktop<DesktopInfo>('info');
