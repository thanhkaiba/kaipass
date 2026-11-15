import { useEffect, useState } from 'react';
import { openInTab, remember } from '../ext/browser';
import { Drive, preloadGoogle } from '../lib/drive';
import { importOnePux, type ImportResult } from '../lib/onepux';
import { isExtension, isPopup } from '../lib/platform';
import { autoLockMinutes, setAutoLockMinutes } from '../lib/prefs';
import { wipeDevice, type Session } from '../lib/session';
import { downloadBytes, errorText, Modal, passwordProblem, SecretInput, TextInput, useToast } from './bits';
import { needsClientId, RedirectHint, rememberClientId, savedClientId } from './Setup';

export function Settings({
  session,
  onClose,
  onReplace,
}: {
  session: Session;
  onClose: () => void;
  onReplace: (s: Session) => void;
}) {
  const toast = useToast();
  const { vault, meta } = session;
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [clientId, setClientId] = useState(savedClientId);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [lockMin, setLockMin] = useState(autoLockMinutes);

  useEffect(() => {
    if (meta.mode === 'local' && !isExtension) preloadGoogle().catch(() => {});
  }, [meta.mode]);

  const run = async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  };

  const importFile = (file: File | undefined) => {
    if (!file) return;
    void run('import', async () => {
      const result = await importOnePux(vault, new Uint8Array(await file.arrayBuffer()));
      await session.commit();
      setImported(result);
    });
  };

  const exportFile = () =>
    run('export', async () => {
      const day = new Date().toISOString().slice(0, 10);
      downloadBytes(`kaipass-${day}.kdbx`, await vault.save());
    });

  const connectDrive = () => {
    const id = clientId.trim();
    if (!id) return setError('Cần nhập Google OAuth Client ID');
    void run('drive', async () => {
      const drive = new Drive(id);
      await drive.signIn();
      rememberClientId(id);
      const next = await session.moveToDrive(drive);
      toast('Đã chuyển vault lên Google Drive');
      onClose();
      onReplace(next);
    });
  };

  const changePassword = () =>
    run('password', async () => {
      if (!(await vault.checkPassword(oldPw))) throw new Error('Master password hiện tại không đúng');
      const problem = passwordProblem(newPw, confirm);
      if (problem) throw new Error(problem);
      await vault.changePassword(newPw);
      await session.commit();
      await remember(newPw, autoLockMinutes());
      setOldPw('');
      setNewPw('');
      setConfirm('');
      toast('Đã đổi master password');
    });

  const wipe = async () => {
    const ok = window.confirm(
      meta.mode === 'drive'
        ? 'Xoá bản sao vault trên thiết bị này? File trên Google Drive vẫn còn nguyên.'
        : 'Xoá vault trên thiết bị này? Vault này không có bản nào khác, dữ liệu sẽ mất hẳn.',
    );
    if (!ok) return;
    session.close();
    await wipeDevice();
    window.location.reload();
  };

  return (
    <Modal title="Cài đặt" onClose={onClose}>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {isPopup && (
        <section>
          <p className="warn small">
            Cửa sổ nhỏ này tự đóng khi bạn chọn file. Để nhập từ 1Password hoặc đính kèm file, hãy mở
            KaiPass trong tab.
          </p>
          <button type="button" onClick={openInTab}>
            Mở KaiPass trong tab
          </button>
        </section>
      )}

      <section>
        <h3>Nơi lưu</h3>
        {meta.mode === 'drive' ? (
          <>
            <p>
              Vault đồng bộ với file <code>kaipass.kdbx</code> trên Google Drive.
              {meta.lastSync && ` Lần gần nhất: ${new Date(meta.lastSync).toLocaleString('vi-VN')}.`}
            </p>
            <button type="button" onClick={() => void session.sync(true)} disabled={session.status === 'syncing'}>
              Đồng bộ ngay
            </button>
          </>
        ) : (
          <>
            <p>Vault chỉ nằm trên thiết bị này. Chuyển lên Google Drive để dùng trên thiết bị khác.</p>
            {needsClientId && (
              <TextInput
                label="Google OAuth Client ID"
                value={clientId}
                onChange={setClientId}
                placeholder="1234567890-abc.apps.googleusercontent.com"
                mono
              />
            )}
            <RedirectHint />
            <button type="button" onClick={connectDrive} disabled={!!busy}>
              {busy === 'drive' ? 'Đang kết nối…' : 'Chuyển lên Google Drive'}
            </button>
          </>
        )}
      </section>

      <section>
        <h3>Nhập từ 1Password</h3>
        <p className="muted small">
          Trong app 1Password trên máy tính: File → Export, chọn định dạng 1PUX. Sau khi nhập xong, hãy xoá
          file đó vì nó chứa mật khẩu chưa mã hoá.
        </p>
        <input
          type="file"
          accept=".1pux"
          aria-label="File .1pux"
          disabled={!!busy}
          onChange={(e) => {
            importFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        {busy === 'import' && <p className="muted">Đang nhập…</p>}
        {imported && (
          <div className="ok" role="status">
            Đã nhập {imported.items} mục và {imported.attachments} file đính kèm.
            {imported.skipped.length > 0 && (
              <>
                {' '}
                Bỏ qua {imported.skipped.length} mục lỗi:
                <ul>
                  {imported.skipped.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </section>

      <section>
        <h3>Sao lưu</h3>
        <p className="muted small">
          File .kdbx vẫn được mã hoá bằng master password, mở được bằng KeePassXC, KeePassium, KeePassDX.
        </p>
        <button type="button" onClick={() => void exportFile()} disabled={!!busy}>
          Tải file .kdbx
        </button>
      </section>

      <section>
        <h3>Đổi master password</h3>
        <SecretInput label="Master password hiện tại" value={oldPw} onChange={setOldPw} autoComplete="current-password" />
        <SecretInput label="Master password mới" value={newPw} onChange={setNewPw} autoComplete="new-password" />
        <SecretInput label="Nhập lại" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        <button type="button" onClick={() => void changePassword()} disabled={!!busy || !oldPw || !newPw}>
          {busy === 'password' ? 'Đang đổi…' : 'Đổi master password'}
        </button>
      </section>

      <section>
        <h3>Tự khoá</h3>
        <div className="field">
          <label htmlFor="autolock">Khoá sau khi không dùng</label>
          <select
            id="autolock"
            value={lockMin}
            onChange={(e) => {
              const v = Number(e.target.value);
              setLockMin(v);
              setAutoLockMinutes(v);
            }}
          >
            <option value={1}>1 phút</option>
            <option value={5}>5 phút</option>
            <option value={10}>10 phút</option>
            <option value={30}>30 phút</option>
            <option value={0}>Không tự khoá</option>
          </select>
        </div>
      </section>

      <section>
        <h3>Thiết bị này</h3>
        <button type="button" className="danger" onClick={() => void wipe()}>
          Xoá dữ liệu trên thiết bị này
        </button>
      </section>
    </Modal>
  );
}
