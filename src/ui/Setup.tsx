import { useEffect, useRef, useState, type FormEvent } from 'react';
import { GOOGLE_CLIENT_ID } from '../config';
import { Drive, preloadGoogle } from '../lib/drive';
import { desktop, desktopInfo } from '../lib/desktop';
import { isDesktop, isExtension } from '../lib/platform';
import { ForgotDialog } from './Forgot';
import { FILE_NAME, Session } from '../lib/session';
import { Vault } from '../lib/vault';
import { Brand, CopyBtn, errorText, Icon, IconButton, InfoTip, passwordProblem, SecretInput, TextInput } from './bits';

const ENV_CLIENT_ID: string = GOOGLE_CLIENT_ID;
const CLIENT_ID_KEY = 'kaipass.clientId';

export function savedClientId(): string {
  return ENV_CLIENT_ID || localStorage.getItem(CLIENT_ID_KEY) || '';
}

export function rememberClientId(id: string): void {
  if (!ENV_CLIENT_ID) localStorage.setItem(CLIENT_ID_KEY, id);
}

export const needsClientId = !ENV_CLIENT_ID;

/** The extension signs in through a redirect address that must be registered with Google. */
export function RedirectHint() {
  if (!isExtension) return null;
  return (
    <details className="danger-zone hint">
      <summary className="muted">
        <Icon name="info" /> Redirect URI cho Google
      </summary>
      <div className="share-link">
        <code className="wrap small">{Drive.extensionRedirect()}</code>
        <CopyBtn value={Drive.extensionRedirect()} what="redirect URI" />
      </div>
    </details>
  );
}

/**
 * The desktop app signs in through the system browser, which needs a Google OAuth client of type
 * "Desktop app". Unless the build came with one, the user picks the client's JSON file once; it is
 * kept encrypted by the operating system.
 */
export function DesktopClientSetup({ onChange }: { onChange?: (ready: boolean) => void }) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!isDesktop) return;
    void desktopInfo().then((i) => {
      setReady(i.google.configured);
      onChange?.(i.google.configured);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!isDesktop || ready !== false) return null;
  return (
    <div className="client-setup" data-testid="desktop-client-setup">
      <strong>Làm một lần: cho KaiPass trên máy tính đăng nhập Google</strong>
      <ol>
        <li>
          Google Cloud Console → Credentials → Create credentials → OAuth client ID → loại <strong>Desktop app</strong>
        </li>
        <li>
          Bấm <strong>Download JSON</strong>, rồi chọn file đó ở đây
        </li>
      </ol>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        aria-label="File JSON của client Desktop"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setError('');
          try {
            await desktop('googleConfigure', { file: await f.text() });
            setReady(true);
            onChange?.(true);
          } catch (err) {
            setError(errorText(err));
          }
        }}
      />
      <button type="button" onClick={() => input.current?.click()}>
        <Icon name="upload" /> Chọn file JSON
      </button>
      {error && (
        <p className="error" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

type Step =
  | { k: 'choose' }
  | { k: 'local' }
  | { k: 'file' }
  | { k: 'drive' }
  | { k: 'drive-new'; drive: Drive }
  | { k: 'drive-existing'; drive: Drive; bytes: ArrayBuffer; remote: { id: string; rev: string } };

export function Setup({
  onReady,
  onRecovered,
}: {
  onReady: (s: Session, password: string) => void;
  onRecovered: (s: Session) => void;
}) {
  const [forgot, setForgot] = useState(false);
  const [step, setStep] = useState<Step>({ k: 'choose' });
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [clientId, setClientId] = useState(savedClientId);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [desktopReady, setDesktopReady] = useState(!isDesktop);

  useEffect(() => {
    if (step.k === 'drive' && !isExtension) preloadGoogle().catch(() => {});
  }, [step.k]);

  const go = (next: Step) => {
    setStep(next);
    setPw('');
    setConfirm('');
    setError('');
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const newPassword = (): string | undefined => {
    const problem = passwordProblem(pw, confirm);
    if (problem) setError(problem);
    return problem ? undefined : pw;
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (step.k === 'local') {
      const password = newPassword();
      if (password) {
        void run(async () => onReady(await Session.adoptLocal(await Vault.create(password)), password));
      }
    } else if (step.k === 'file') {
      if (!file) return setError('Chưa chọn file .kdbx');
      void run(async () => onReady(await Session.adoptLocal(await Vault.open(await file.arrayBuffer(), pw)), pw));
    } else if (step.k === 'drive') {
      // The desktop app has its own client (see DesktopClientSetup); the id here only labels the token.
      const id = isDesktop ? 'desktop' : clientId.trim();
      if (!id) return setError('Cần nhập Google OAuth Client ID');
      void run(async () => {
        const drive = new Drive(id);
        await drive.signIn();
        rememberClientId(id);
        const remote = await drive.find(FILE_NAME);
        if (remote) go({ k: 'drive-existing', drive, remote, bytes: await drive.download(remote.id) });
        else go({ k: 'drive-new', drive });
      });
    } else if (step.k === 'drive-new') {
      const password = newPassword();
      if (password) {
        void run(async () =>
          onReady(await Session.createOnDrive(await Vault.create(password), step.drive), password),
        );
      }
    } else if (step.k === 'drive-existing') {
      void run(async () => onReady(await Session.adoptFromDrive(step.bytes, pw, step.drive, step.remote), pw));
    }
  };

  const creating = step.k === 'local' || step.k === 'drive-new';

  const back = (
    <IconButton icon="back" label="Quay lại" onClick={() => go({ k: 'choose' })} disabled={busy} />
  );
  const heading = (title: string) => (
    <div className="step-head">
      {back}
      <h2>{title}</h2>
    </div>
  );

  return (
    <div className="center">
      <form className="panel" onSubmit={submit}>
        {step.k === 'choose' && (
          <>
            <div className="panel-head">
              <Brand />
              <p className="panel-sub">
                Mã hoá trên thiết bị của bạn <InfoTip text="Mật khẩu, thẻ, giấy tờ được mã hoá ngay trên máy bằng master password. Nơi lưu chỉ giữ file đã mã hoá." />
              </p>
            </div>
            <div className="choices">
              <Choice icon="cloud" title="Lưu trên Google Drive" sub="Đồng bộ mọi thiết bị" onClick={() => go({ k: 'drive' })} />
              <Choice icon="device" title="Chỉ lưu trên thiết bị này" sub="Không đồng bộ" onClick={() => go({ k: 'local' })} />
              <Choice icon="upload" title="Mở file .kdbx có sẵn" sub="Bản sao lưu hoặc file KeePass" onClick={() => go({ k: 'file' })} />
            </div>
          </>
        )}

        {step.k === 'drive' && (
          <>
            {heading('Google Drive')}
            <p className="muted small">
              App chỉ thấy file do chính nó tạo <InfoTip text="KaiPass xin quyền drive.file: không đọc được file nào khác trong Drive của bạn." />
            </p>
            {needsClientId && !isDesktop && (
              <TextInput
                label="Google OAuth Client ID"
                hint="Tạo miễn phí trong Google Cloud Console, xem README."
                value={clientId}
                onChange={setClientId}
                placeholder="1234567890-abc.apps.googleusercontent.com"
                autoFocus
                mono
              />
            )}
            <DesktopClientSetup onChange={setDesktopReady} />
            <button className="primary" disabled={busy || !desktopReady}>
              <Icon name="login" /> {busy ? 'Đang kết nối…' : 'Đăng nhập Google'}
            </button>
            <RedirectHint />
          </>
        )}

        {step.k === 'drive-existing' && (
          <>
            {heading('Đã tìm thấy vault trên Drive')}
            <SecretInput
              label="Master password"
              hideLabel
              placeholder="Master password"
              value={pw}
              onChange={setPw}
              autoFocus
              autoComplete="current-password"
            />
            <button className="primary" disabled={busy || !pw}>
              {busy ? 'Đang mở…' : 'Mở vault'}
            </button>
            <div className="panel-foot">
              <button type="button" className="link subtle" onClick={() => setForgot(true)}>
                Quên master password?
              </button>
            </div>
          </>
        )}

        {step.k === 'file' && (
          <>
            {heading('Mở file .kdbx')}
            <div className="field">
              <label htmlFor="kdbx-file" className="sr-only">
                File
              </label>
              <input id="kdbx-file" type="file" accept=".kdbx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
            <SecretInput label="Master password của file" value={pw} onChange={setPw} autoComplete="current-password" />
            <button className="primary" disabled={busy || !pw || !file}>
              {busy ? 'Đang mở…' : 'Mở file'}
            </button>
          </>
        )}

        {creating && (
          <>
            {heading('Tạo master password')}
            <SecretInput label="Master password" value={pw} onChange={setPw} autoFocus autoComplete="new-password" />
            <SecretInput label="Nhập lại" value={confirm} onChange={setConfirm} autoComplete="new-password" />
            <p className="warn small">
              <Icon name="alert" />
              <span>Quên là mất dữ liệu, trừ khi bạn tạo khoá khôi phục trong Cài đặt.</span>
            </p>
            <button className="primary" disabled={busy}>
              {busy ? 'Đang tạo…' : 'Tạo vault'}
            </button>
          </>
        )}

        {error && (
          <p className="error" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </p>
        )}
      </form>
      {/* Outside the form above: the dialog has a form of its own. */}
      {forgot && step.k === 'drive-existing' && (
        <ForgotDialog
          meta={{ mode: 'drive', clientId: step.drive.clientId }}
          drive={step.drive}
          onClose={() => setForgot(false)}
          onRecovered={async (password) =>
            onRecovered(await Session.adoptFromDrive(step.bytes, password, step.drive, step.remote))
          }
        />
      )}
    </div>
  );
}

function Choice({ icon, title, sub, onClick }: { icon: string; title: string; sub: string; onClick: () => void }) {
  return (
    <button type="button" className="choice" onClick={onClick}>
      <span className="choice-icon">
        <Icon name={icon} />
      </span>
      <span className="choice-text">
        <strong>{title}</strong>
        <small>{sub}</small>
      </span>
      <span className="chev">
        <Icon name="arrow" />
      </span>
    </button>
  );
}
