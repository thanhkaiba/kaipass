import { useCallback, useEffect, useState } from 'react';
import { preloadGoogle } from './lib/drive';
import { storedMeta, type Meta, type Session } from './lib/session';
import { ToastProvider } from './ui/bits';
import { Lock } from './ui/Lock';
import { Main } from './ui/Main';
import { Setup } from './ui/Setup';

type Phase = { k: 'loading' } | { k: 'setup' } | { k: 'locked'; meta: Meta } | { k: 'open'; session: Session };

export default function App() {
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });

  const refresh = useCallback(async () => {
    const meta = await storedMeta();
    if (meta?.mode === 'drive') preloadGoogle().catch(() => {});
    setPhase(meta ? { k: 'locked', meta } : { k: 'setup' });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = useCallback((session: Session) => {
    setPhase({ k: 'open', session });
    void session.sync();
  }, []);

  const lock = useCallback(
    (session: Session) => {
      session.close();
      void refresh();
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
