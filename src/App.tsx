import { useCallback, useEffect, useState } from 'react';
import { forget, recall, remember, writeFillIndex } from './ext/browser';
import { preloadGoogle } from './lib/drive';
import { isExtension, isPopup } from './lib/platform';
import { autoLockMinutes } from './lib/prefs';
import { Session, storedMeta, type Meta } from './lib/session';
import { ToastProvider } from './ui/bits';
import { Lock } from './ui/Lock';
import { Main } from './ui/Main';
import { Setup } from './ui/Setup';

type Phase = { k: 'loading' } | { k: 'setup' } | { k: 'locked'; meta: Meta } | { k: 'open'; session: Session };

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
    return session.subscribe(publish);
  }, [phase]);

  const lock = useCallback(
    (session: Session) => {
      session.close();
      void forget().then(refresh);
    },
    [refresh],
  );

  return (
    <ToastProvider>
      {phase.k === 'setup' && <Setup onReady={open} />}
      {phase.k === 'locked' && <Lock meta={phase.meta} onReady={open} onWiped={refresh} />}
      {phase.k === 'open' && (
        <Main key={phase.session.meta.mode} session={phase.session} onLock={lock} onReplace={open} />
      )}
    </ToastProvider>
  );
}
