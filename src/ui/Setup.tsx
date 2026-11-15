import { useEffect, useState, type FormEvent } from 'react';
import { Drive, preloadGoogle } from '../lib/drive';
import { isExtension } from '../lib/platform';
import { FILE_NAME, Session } from '../lib/session';
import { Vault } from '../lib/vault';
import { errorText, Icon, passwordProblem, SecretInput, TextInput } from './bits';

const ENV_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
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
    <p className="muted small">
      Trong Google Cloud Console, thêm địa chỉ này vào <strong>Authorized redirect URIs</strong> của
      OAuth client: <code className="wrap">{Drive.extensionRedirect()}</code>
    </p>
  );
}

type Step =
  | { k: 'choose' }
  | { k: 'local' }
  | { k: 'file' }
  | { k: 'drive' }
  | { k: 'drive-new'; drive: Drive }
  | { k: 'drive-existing'; drive: Drive; bytes: ArrayBuffer; remote: { id: string; rev: string } };

export function Setup({ onReady }: { onReady: (s: Session, password: string) => void }) {
  const [step, setStep] = useState<Step>({ k: 'choose' });
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [clientId, setClientId] = useState(savedClientId);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
      const id = clientId.trim();
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

  return (
    <div className="center">
      <form className="panel" onSubmit={submit}>
        <div className="brand">
          <img src="./icon.svg" alt="" />
          <h1>KaiPass</h1>
        </div>

        {step.k === 'choose' && (
          <>
            <p className="muted">
              Mật khẩu, thẻ, giấy tờ của bạn được mã hoá ngay trên thiết bị này bằng master password. Nơi
              lưu chỉ giữ file đã mã hoá.
            </p>
            <button type="button" className="choice" onClick={() => go({ k: 'drive' })}>
              <strong>Lưu trên Google Drive</strong>
              <span>Đồng bộ giữa máy tính và điện thoại. Chọn mục này nếu đã có vault trên Drive.</span>
            </button>
            <button type="button" className="choice" onClick={() => go({ k: 'local' })}>
              <strong>Chỉ lưu trên thiết bị này</strong>
              <span>Không đồng bộ. Có thể chuyển lên Google Drive sau.</span>
            </button>
            <button type="button" className="choice" onClick={() => go({ k: 'file' })}>
              <strong>Mở file .kdbx có sẵn</strong>
              <span>Dùng bản sao lưu hoặc file KeePass bạn đang có.</span>
            </button>
          </>
        )}

        {step.k === 'drive' && (
          <>
            <h2>Kết nối Google Drive</h2>
            {needsClientId && (
              <>
                <TextInput
                  label="Google OAuth Client ID"
                  value={clientId}
                  onChange={setClientId}
                  placeholder="1234567890-abc.apps.googleusercontent.com"
                  autoFocus
                  mono
                />
                <p className="muted small">
                  Tạo miễn phí trong Google Cloud Console, xem hướng dẫn ở file README. App chỉ xin quyền
                  với những file do chính nó tạo ra.
                </p>
              </>
            )}
            <RedirectHint />
            <button className="primary" disabled={busy}>
              {busy ? 'Đang kết nối…' : 'Đăng nhập Google'}
            </button>
          </>
        )}

        {step.k === 'drive-existing' && (
          <>
            <h2>Đã tìm thấy vault trên Drive</h2>
            <SecretInput
              label="Master password"
              value={pw}
              onChange={setPw}
              autoFocus
              autoComplete="current-password"
            />
            <button className="primary" disabled={busy || !pw}>
              {busy ? 'Đang mở…' : 'Mở vault'}
            </button>
          </>
        )}

        {step.k === 'file' && (
          <>
            <h2>Mở file .kdbx</h2>
            <div className="field">
              <label htmlFor="kdbx-file">File</label>
              <input
                id="kdbx-file"
                type="file"
                accept=".kdbx"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <SecretInput label="Master password của file" value={pw} onChange={setPw} autoComplete="current-password" />
            <button className="primary" disabled={busy || !pw || !file}>
              {busy ? 'Đang mở…' : 'Mở file'}
            </button>
          </>
        )}

        {creating && (
          <>
            <h2>Tạo master password</h2>
            <SecretInput label="Master password" value={pw} onChange={setPw} autoFocus autoComplete="new-password" />
            <SecretInput label="Nhập lại" value={confirm} onChange={setConfirm} autoComplete="new-password" />
            <p className="warn small">
              Không ai khôi phục được master password. Quên là mất toàn bộ dữ liệu, nên hãy ghi lại và cất ở
              nơi an toàn.
            </p>
            <button className="primary" disabled={busy}>
              {busy ? 'Đang tạo…' : 'Tạo vault'}
            </button>
          </>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {step.k !== 'choose' && (
          <button type="button" className="link" onClick={() => go({ k: 'choose' })} disabled={busy}>
            <Icon name="back" /> Quay lại
          </button>
        )}
      </form>
    </div>
  );
}
