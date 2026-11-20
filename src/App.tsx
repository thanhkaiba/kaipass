import { useCallback, useEffect, useState } from 'react';
import { forget, recall, remember, writeFillIndex } from './ext/browser';
import { BUMP_KEY } from './ext/match';
import { preloadGoogle } from './lib/drive';
import { native } from './lib/android';
import { onDesktop } from './lib/desktop';
import { androidEntries } from './lib/androidIndex';
import { isAndroid, isExtension, isPopup } from './lib/platform';
import { autoLockMinutes } from './lib/prefs';
import { Session, storedMeta, type Meta } from './lib/session';
import { parseLink } from './lib/share';
import { ToastProvider } from './ui/bits';
import { Lock } from './ui/Lock';
import { Main } from './ui/Main';
import { ResetPassword } from './ui/Forgot';
import { Setup } from './ui/Setup';
import { ShareView } from './ui/Share';

const SHARE_LINK = !isExtension && location.hash.startsWith('#share=');

type Phase =
  | { k: 'loading' }
  | { k: 'setup' }
  | { k: 'locked'; meta: Meta }
  | { k: 'reset'; session: Session }
  | { k: 'open'; session: Session };

if (isPopup) document.documentElement.classList.add('popup');
// Windows the extension opens itself (to unlock by fingerprint, or from a page's "open KaiPass")
// carry the tab they act on; unlike the toolbar popup they have a size of their own to fill.
if (isPopup && /[?&](tab|bio)\b/.test(location.search)) document.documentElement.classList.add('popup-window');

/** This window was opened only to unlock the vault for a page (see the background worker's 'open'). */
const UNLOCK_ONLY = isPopup && new URLSearchParams(location.search).has('unlock');

export default function App() {
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });

  /** `password` is given when the user has just typed it, so the extension can stay unlocked. */
  const open = useCallback((session: Session, password?: string) => {
    if (password && UNLOCK_ONLY) {
      // Opened from a web page's "KaiPass is locked": unlock, hand the logins to the page, and get
      // out of the way so the user is back on the form they were filling.
      void remember(password, autoLockMinutes())
        .then(() => writeFillIndex(session.vault))
        .then(() => window.close());
      setPhase({ k: 'open', session });
      return;
    }
    if (password) void remember(password, autoLockMinutes());
    setPhase({ k: 'open', session });
    void session.sync();
  }, []);

  const refresh = useCallback(async () => {
    const meta = await storedMeta();
    if (!meta) return setPhase({ k: 'setup' });
    if (meta.mode === 'drive' && !isExtension) preloadGoogle().catch(() => {});
    const password = await recall();
    if (password) {
      try {
        return open(await Session.unlock(password));
      } catch {
        await forget();
      }
    }
    setPhase({ k: 'locked', meta });
  }, [open]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep the background worker's list of fillable logins in step with the open vault.
  useEffect(() => {
    if (phase.k !== 'open' || !isExtension) return;
    const { session } = phase;
    const publish = () => void writeFillIndex(session.vault);
    publish();
    const unsubscribe = session.subscribe(publish);
    // The background worker saved a login or synced: fold its changes into the open vault.
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes[BUMP_KEY]) void session.reloadLocal().catch(() => {});
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      unsubscribe();
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, [phase]);

  // Android: the autofill service offers the open vault's logins, and forgets them on lock.
  useEffect(() => {
    if (phase.k !== 'open' || !isAndroid) return;
    const { session } = phase;
    const publish = () =>
      void native('setFillIndex', { entries: androidEntries(session.vault), lockMinutes: autoLockMinutes() }).catch(() => {});
    publish();
    const unsubscribe = session.subscribe(publish);
    return () => {
      unsubscribe();
      void native('clearFillIndex').catch(() => {});
    };
  }, [phase]);

  const lock = useCallback(
    (session: Session) => {
      session.close();
      void forget().then(refresh);
    },
    [refresh],
  );

  // Desktop app: the computer locked or went to sleep, or the user chose "Khoá" in the menu.
  useEffect(() => {
    if (phase.k !== 'open') return;
    const { session } = phase;
    return onDesktop('lock', () => lock(session));
  }, [phase, lock]);

  if (SHARE_LINK) {
    return (
      <ToastProvider>
        <ShareView link={parseLink(location.href)} />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      {phase.k === 'setup' && <Setup onReady={open} onRecovered={(session) => setPhase({ k: 'reset', session })} />}
      {phase.k === 'locked' && (
        <Lock
          meta={phase.meta}
          onReady={open}
          onRecovered={(session) => setPhase({ k: 'reset', session })}
          onWiped={refresh}
        />
      )}
      {phase.k === 'reset' && <ResetPassword session={phase.session} onDone={(pw) => open(phase.session, pw)} />}
      {phase.k === 'open' && (
        <Main key={phase.session.meta.mode} session={phase.session} onLock={lock} onReplace={open} />
      )}
    </ToastProvider>
  );
}
