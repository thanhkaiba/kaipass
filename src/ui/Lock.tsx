import { useEffect, useState, type FormEvent } from 'react';
import { bioEnrolled, BioUnavailable, bioPassword, disableBio } from '../lib/bio';
import { forcedTabId, isPopup } from '../lib/platform';
import { Session, type Meta } from '../lib/session';
import { WrongPasswordError } from '../lib/vault';
import { errorText, Icon, SecretInput } from './bits';
import { ForgotDialog } from './Forgot';

const BIO_WINDOW = new URLSearchParams(location.search).has('bio');

export function Lock({
  meta,
  onReady,
  onRecovered,
  onWiped,
}: {
  meta: Meta;
  onReady: (s: Session, password: string) => void;
  /** Unlocked with the recovery key: a new master password must be set. */
  onRecovered: (s: Session) => void;
  onWiped: () => void;
}) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [bio, setBio] = useState(false);
  const [forgot, setForgot] = useState(false);

  const unlockWith = async (password: string) => {
    setBusy(true);
    setError('');
    try {
      onReady(await Session.unlock(password), password);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      throw err;
    }
  };

  const useBio = async () => {
    // The device's fingerprint / PIN dialog takes focus, which closes the extension's toolbar
    // popup, so from there the prompt runs in a small window of its own.
    if (isPopup && !BIO_WINDOW) {
      await chrome.windows.create({
        url: chrome.runtime.getURL(`index.html?popup&bio${forcedTabId !== undefined ? `&tab=${forcedTabId}` : await activeTabParam()}`),
        type: 'popup',
        width: 420,
        height: 640,
        focused: true,
      });
      window.close();
      return;
    }
    setBusy(true);
    setError('');
    let password: string;
    try {
      password = await bioPassword();
    } catch (err) {
      if (err instanceof BioUnavailable) {
        await disableBio();
        setBio(false);
      }
      setError(errorText(err));
      setBusy(false);
      return;
    }
    try {
      await unlockWith(password);
    } catch (err) {
      if (err instanceof WrongPasswordError) {
        await disableBio();
        setBio(false);
        setError('Master password đã đổi ở thiết bị khác. Hãy nhập master password mới; sau đó bật lại mở khoá bằng vân tay trong Cài đặt.');
      }
    }
  };

  useEffect(() => {
    void bioEnrolled().then((on) => {
      setBio(on);
      if (on && BIO_WINDOW) void useBio();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void unlockWith(pw).catch(() => {});
  };

  return (
    <div className="center">
      <form className="panel" onSubmit={submit}>
        <div className="brand">
          <img src="./icon.svg" alt="" />
          <h1>KaiPass</h1>
        </div>
        {bio && (
          <button type="button" className="primary bio" onClick={() => void useBio()} disabled={busy}>
            <Icon name="finger" /> Mở khoá bằng vân tay / mật khẩu máy
          </button>
        )}
        <SecretInput
          label="Master password"
          value={pw}
          onChange={setPw}
          autoFocus={!bio}
          autoComplete="current-password"
        />
        <button className={bio ? undefined : 'primary'} disabled={busy || !pw}>
          {busy ? 'Đang mở khoá…' : 'Mở khoá'}
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p className="muted small">
          {meta.mode === 'drive' ? 'Vault đồng bộ với Google Drive.' : 'Vault chỉ lưu trên thiết bị này.'}
        </p>
        <button type="button" className="link" onClick={() => setForgot(true)}>
          Quên master password?
        </button>
      </form>
      {forgot && (
        <ForgotDialog
          meta={meta}
          onClose={() => setForgot(false)}
          onWiped={onWiped}
          onRecovered={async (password) => onRecovered(await Session.unlock(password))}
        />
      )}
    </div>
  );
}

async function activeTabParam(): Promise<string> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id !== undefined ? `&tab=${tab.id}` : '';
}
