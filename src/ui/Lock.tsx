import { useEffect, useState, type FormEvent } from 'react';
import { bioEnrolled, BioUnavailable, bioPassword, disableBio } from '../lib/bio';
import { forcedTabId, isAndroid, isPopup } from '../lib/platform';
import { Session, type Meta } from '../lib/session';
import { WrongPasswordError } from '../lib/vault';
import { Brand, errorText, Icon, SecretInput } from './bits';
import { ForgotDialog } from './Forgot';

const BIO_WINDOW = new URLSearchParams(location.search).has('bio');
/**
 * The window the extension opens for the fingerprint prompt asks once, when it opens. If the vault
 * locks again later while that window is still around, it waits for a click instead of popping the
 * system prompt up on its own.
 */
let askedOnOpen = false;
/** Set when Android's autofill opened KaiPass to fill a login: the app or site it is for. */
const AUTOFILL_FOR = isAndroid ? new URLSearchParams(location.search).get('autofill') : null;

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
      // Closing the phone's fingerprint prompt is a choice, not an error: just show the password box.
      if (!(isAndroid && err instanceof Error && err.message === 'Đã huỷ')) setError(errorText(err));
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
      // The extension's own window and the Android app ask for the fingerprint straight away.
      if (on && (isAndroid || (BIO_WINDOW && !askedOnOpen))) {
        askedOnOpen = true;
        void useBio();
      }
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
        <div className="panel-head">
          <Brand />
          <span
            className="badge"
            data-tip={meta.mode === 'drive' ? 'Vault đồng bộ với Google Drive' : 'Vault chỉ lưu trên thiết bị này'}
          >
            <Icon name={meta.mode === 'drive' ? 'cloud' : 'device'} />
            {meta.mode === 'drive' ? 'Google Drive' : 'Thiết bị này'}
          </span>
        </div>
        {AUTOFILL_FOR && (
          <p className="autofill-for" role="status">
            <Icon name="key" />
            <span>
              Mở khoá để tự điền cho <strong>{AUTOFILL_FOR}</strong>
            </span>
          </p>
        )}
        {bio && (
          <>
            <button type="button" className="primary bio-btn" onClick={() => void useBio()} disabled={busy}>
              <Icon name="finger" /> Mở khoá bằng vân tay / mật khẩu máy
            </button>
            <div className="or">hoặc</div>
          </>
        )}
        <div className="unlock-row">
          <SecretInput
            label="Master password"
            hideLabel
            placeholder="Master password"
            value={pw}
            onChange={setPw}
            autoFocus={!bio}
            autoComplete="current-password"
          />
          <button className={`go${bio ? '' : ' primary'}`} disabled={busy || !pw} aria-label="Mở khoá" data-tip="Mở khoá">
            <Icon name={busy ? 'clock' : 'arrow'} />
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </p>
        )}
        <div className="panel-foot">
          <button type="button" className="link subtle" onClick={() => setForgot(true)}>
            Quên master password?
          </button>
        </div>
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
