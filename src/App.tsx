import { useCallback, useEffect, useState } from 'react';
import { forget, recall, remember, writeFillIndex } from './ext/browser';
import { BUMP_KEY } from './ext/match';
import { preloadGoogle } from './lib/drive';
import { isExtension, isPopup } from './lib/platform';
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

export default function App() {
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });

  /** `password` is given when the user has just typed it, so the extension can stay unlocked. */
  const open = useCallback((session: Session, password?: string) => {
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
    const publish = () => void writeFillIndex(session.vault.items());
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

  const lock = useCallback(
    (session: Session) => {
      session.close();
      void forget().then(refresh);
    },
    [refresh],
  );

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
