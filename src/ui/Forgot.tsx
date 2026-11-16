import { useEffect, useState, type FormEvent } from 'react';
import { Drive } from '../lib/drive';
import { disableBio } from '../lib/bio';
import { findRecovery, recoverPassword, resealRecovery, type RecoveryRecord } from '../lib/recovery';
import { storedVaultBytes, wipeDevice, type Meta, type Session } from '../lib/session';
import { downloadBytes, errorText, Modal, passwordProblem, SecretInput, TextInput, useToast } from './bits';

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').trim().toUpperCase();

/** Deleting this device's copy, guarded so a passer-by cannot do it with one tap. */
export function WipeSection({ mode, onWiped }: { mode: Meta['mode']; onWiped: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const onlyCopy = mode === 'local';
  const ok = fold(typed) === 'XOA';

  const backup = async () => {
    const bytes = await storedVaultBytes();
    if (bytes) downloadBytes(`kaipass-${new Date().toISOString().slice(0, 10)}.kdbx`, bytes);
  };

  return (
    <details className="danger-zone">
      <summary>Xoá dữ liệu trên thiết bị này</summary>
      <div className="danger-body">
        {onlyCopy ? (
          <p className="warn small">
            Vault này <strong>chỉ có trên thiết bị này</strong>. Xoá là mất hẳn mọi mật khẩu. Hãy tải bản sao lưu
            trước: file vẫn được mã hoá, và mở lại được bằng master password (hoặc khoá khôi phục).
          </p>
        ) : (
          <p className="muted small">
            Chỉ xoá bản sao trên thiết bị này. File trên Google Drive vẫn còn; đăng nhập Google lại là có vault.
          </p>
        )}
        <button type="button" onClick={() => void backup()}>
          Tải bản sao lưu đã mã hoá (.kdbx)
        </button>
        <TextInput label='Gõ "XOÁ" để xác nhận' value={typed} onChange={setTyped} />
        <button
          type="button"
          className="danger"
          disabled={!ok || busy}
          onClick={async () => {
            setBusy(true);
            await wipeDevice();
            onWiped();
          }}
        >
          Xoá dữ liệu trên thiết bị này
        </button>
      </div>
    </details>
  );
}

/**
 * "Forgot master password": recover with the recovery key if one was set up, or explain why
 * nothing else can bring the vault back.
 */
export function ForgotDialog({
  meta,
  drive: givenDrive,
  onRecovered,
  onWiped,
  onClose,
}: {
  meta: Pick<Meta, 'mode' | 'clientId'>;
  /** Already signed in (new-device setup); otherwise one is made from meta.clientId on demand. */
  drive?: Drive;
  /** Called with the master password the recovery key unlocked. */
  onRecovered: (password: string) => Promise<void>;
  onWiped?: () => void;
  onClose: () => void;
}) {
  const [record, setRecord] = useState<RecoveryRecord | null | undefined>(undefined);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const drive = givenDrive ?? (meta.mode === 'drive' && meta.clientId ? new Drive(meta.clientId) : undefined);

  const look = async (signIn: boolean) => {
    setBusy(true);
    setError('');
    try {
      if (signIn && drive && !(await drive.hasToken())) await drive.signIn();
      setRecord((await findRecovery(signIn ? drive : undefined)) ?? null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void look(!!givenDrive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!record) return;
    setBusy(true);
    setError('');
    try {
      await onRecovered(await recoverPassword(record, key));
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Quên master password" onClose={onClose}>
      <p className="small">
        KaiPass không gửi master password đi đâu, nên không ai (kể cả người làm ra app) lấy lại được. Cách duy
        nhất là <strong>khoá khôi phục</strong>, nếu trước đó bạn đã tạo trong Cài đặt.
      </p>
      {busy && record === undefined && <p className="muted">Đang tìm khoá khôi phục…</p>}
      {record && (
        <form className="share-form" onSubmit={submit}>
          <TextInput label="Khoá khôi phục" value={key} onChange={setKey} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" mono autoFocus />
          <button className="primary" disabled={busy || !key.trim()}>
            {busy ? 'Đang khôi phục…' : 'Khôi phục'}
          </button>
          <p className="muted small">Sau khi khôi phục, bạn sẽ đặt master password mới.</p>
        </form>
      )}
      {record === null && (
        <div className="share-form">
          <p className="warn small">Không tìm thấy khoá khôi phục{drive && !givenDrive ? ' trên thiết bị này' : ''}.</p>
          {drive && !givenDrive && (
            <button type="button" onClick={() => void look(true)} disabled={busy}>
              Tìm trên Google Drive
            </button>
          )}
          <p className="muted small">
            Nếu một thiết bị khác vẫn mở được KaiPass (chưa khoá, hoặc mở bằng vân tay), hãy vào Cài đặt → Đổi master
            password ở thiết bị đó.
          </p>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {onWiped && <WipeSection mode={meta.mode} onWiped={onWiped} />}
    </Modal>
  );
}

/** Shown after a recovery: the old master password is gone, so a new one is required. */
export function ResetPassword({ session, onDone }: { session: Session; onDone: (password: string) => void }) {
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(pw, confirm);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      await session.vault.changePassword(pw);
      await session.commit();
      await resealRecovery(pw, session.drive);
      await disableBio();
      toast('Đã đặt master password mới');
      onDone(pw);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <form className="panel" onSubmit={submit}>
        <div className="brand">
          <img src="./icon.svg" alt="" />
          <h1>KaiPass</h1>
        </div>
        <h2>Đặt master password mới</h2>
        <p className="muted small">Đã mở vault bằng khoá khôi phục. Khoá khôi phục vẫn dùng được cho lần sau.</p>
        <SecretInput label="Master password mới" value={pw} onChange={setPw} autoFocus autoComplete="new-password" />
        <SecretInput label="Nhập lại" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? 'Đang lưu…' : 'Lưu master password mới'}
        </button>
      </form>
    </div>
  );
}
