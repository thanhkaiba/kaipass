import { useEffect, useRef, useState, type FormEvent } from 'react';
import { openInTab } from '../ext/browser';
import { isPopup } from '../lib/platform';
import { extractKey, keyFromFile } from '../lib/recoveryKit';
import { Drive } from '../lib/drive';
import { disableBio } from '../lib/bio';
import { findRecovery, recoverPassword, resealRecovery, type RecoveryRecord } from '../lib/recovery';
import { storedVaultBytes, wipeDevice, type Meta, type Session } from '../lib/session';
import { Brand, downloadBytes, errorText, Icon, InfoTip, Modal, passwordProblem, SecretInput, TextInput, useToast } from './bits';

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
      <summary>
        <Icon name="trash" />
        <span>Xoá dữ liệu trên thiết bị này</span>
      </summary>
      <div className="danger-body">
        {onlyCopy ? (
          <p className="warn small">
            <Icon name="alert" />
            <span>
              Vault <strong>chỉ có trên thiết bị này</strong>: xoá là mất hẳn. Tải bản sao lưu trước.
            </span>
          </p>
        ) : (
          <p className="note">
            <Icon name="cloud" />
            <span>Chỉ xoá bản trên máy này. Vault trên Google Drive vẫn còn.</span>
          </p>
        )}
        <button type="button" onClick={() => void backup()} aria-label="Tải bản sao lưu đã mã hoá (.kdbx)" data-tip="File vẫn được mã hoá, mở lại bằng master password hoặc khoá khôi phục">
          <Icon name="download" /> Tải bản sao lưu
        </button>
        <TextInput label='Gõ "XOÁ" để xác nhận' value={typed} onChange={setTyped} placeholder="XOÁ" />
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
          <Icon name="trash" /> Xoá dữ liệu trên thiết bị này
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
  const kitInput = useRef<HTMLInputElement>(null);
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

  const recover = async (text: string) => {
    if (!record) return;
    setBusy(true);
    setError('');
    try {
      await onRecovered(await recoverPassword(record, extractKey(text) ?? text));
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void recover(key);
  };

  /** The kit file, a text file, or a photo / screenshot of the printed kit's QR code. */
  const fromFile = async (file: Blob) => {
    const found = await keyFromFile(file).catch(() => undefined);
    if (!found) return setError('Không tìm thấy khoá khôi phục trong file này');
    setKey(found);
    void recover(found);
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      const blob = item?.getAsFile();
      if (blob) {
        e.preventDefault();
        void fromFile(blob);
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record]);

  return (
    <Modal title="Quên master password" icon="key" onClose={onClose}>
      <p className="note">
        <Icon name="shield" />
        <span>Master password không rời khỏi máy bạn nên không ai lấy lại được. Chỉ khoá khôi phục mở được vault.</span>
      </p>
      {busy && record === undefined && <p className="muted">Đang tìm khoá khôi phục…</p>}
      {record && (
        <form className="share-form" onSubmit={submit}>
          <TextInput
            label="Khoá khôi phục"
            hint="30 ký tự trong bộ khôi phục (file KaiPass-khoi-phuc-….html). Dán nguyên đoạn văn bản cũng được. Sau đó bạn sẽ đặt master password mới."
            value={key}
            onChange={setKey}
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
            mono
            autoFocus
          />
          <button className="primary" disabled={busy || !key.trim()}>
            {busy ? 'Đang khôi phục…' : 'Khôi phục'}
          </button>
          <div className="or">hoặc</div>
          {isPopup ? (
            <button type="button" onClick={openInTab} data-tip="Cửa sổ nhỏ sẽ đóng khi chọn file">
              <Icon name="external" /> Mở trong tab để chọn file khôi phục
            </button>
          ) : (
            <>
              <input
                ref={kitInput}
                type="file"
                accept=".html,.htm,.txt,image/*"
                className="sr-only"
                aria-label="File khôi phục"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void fromFile(f);
                  e.target.value = '';
                }}
              />
              <button type="button" onClick={() => kitInput.current?.click()} disabled={busy} data-tip="File KaiPass-khoi-phuc-….html, hoặc ảnh chụp bản in. Cũng có thể dán ảnh bằng Ctrl+V.">
                <Icon name="upload" /> Chọn file khôi phục hoặc ảnh
              </button>
            </>
          )}
        </form>
      )}
      {record === null && (
        <div className="share-form">
          <p className="warn small">
            <Icon name="alert" />
            <span>Không tìm thấy khoá khôi phục{drive && !givenDrive ? ' trên thiết bị này' : ''}.</span>
            <InfoTip text="Nếu một thiết bị khác vẫn mở được KaiPass (chưa khoá, hoặc mở bằng vân tay), vào Cài đặt → Bảo mật → Master password ở thiết bị đó để đổi." />
          </p>
          {drive && !givenDrive && (
            <button type="button" onClick={() => void look(true)} disabled={busy}>
              <Icon name="cloud" /> Tìm trên Google Drive
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
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
        <div className="panel-head">
          <Brand />
          <h2>Đặt master password mới</h2>
          <p className="panel-sub">
            Đã mở bằng khoá khôi phục <InfoTip text="Khoá khôi phục vẫn dùng được cho lần sau." />
          </p>
        </div>
        <SecretInput label="Master password mới" value={pw} onChange={setPw} autoFocus autoComplete="new-password" />
        <SecretInput label="Nhập lại" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        {error && (
          <p className="error" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? 'Đang lưu…' : 'Lưu master password mới'}
        </button>
      </form>
    </div>
  );
}
