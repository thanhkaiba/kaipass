import { useEffect, useState } from 'react';
import { openInTab, remember } from '../ext/browser';
import { defaultInlinePrefs, INLINE_PREFS_KEY, type InlinePrefs } from '../ext/match';
import { Drive, preloadGoogle } from '../lib/drive';
import { importOnePux, type ImportResult } from '../lib/onepux';
import { isExtension, isPopup } from '../lib/platform';
import { autoLockMinutes, setAutoLockMinutes } from '../lib/prefs';
import { bioEnrolled, bioSupported, disableBio, enrollBio } from '../lib/bio';
import { recoveryEnabled, removeRecovery, resealRecovery, setUpRecovery } from '../lib/recovery';
import { type Session } from '../lib/session';
import { WipeSection } from './Forgot';
import { CopyBtn, downloadBytes, errorText, Modal, passwordProblem, SecretInput, TextInput, useToast } from './bits';
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
  const [inline, setInline] = useState<InlinePrefs>(defaultInlinePrefs);

  useEffect(() => {
    if (!isExtension) return;
    void chrome.storage.local.get(INLINE_PREFS_KEY).then((r) => setInline({ ...defaultInlinePrefs, ...(r[INLINE_PREFS_KEY] as Partial<InlinePrefs> | undefined) }));
  }, []);

  const setInlinePref = (patch: Partial<InlinePrefs>) => {
    const next = { ...inline, ...patch };
    setInline(next);
    void chrome.storage.local.set({ [INLINE_PREFS_KEY]: next });
  };

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
      await resealRecovery(newPw, session.drive);
      if (bio) {
        await disableBio();
        setBio(false);
        toast('Đã đổi master password. Hãy bật lại mở khoá bằng vân tay.');
      }
      setOldPw('');
      setNewPw('');
      setConfirm('');
      toast('Đã đổi master password');
    });

  // ---- quick unlock and recovery ----
  const [bio, setBio] = useState(false);
  const [bioOk, setBioOk] = useState(false);
  const [hasRecovery, setHasRecovery] = useState(false);
  const [confirmPw, setConfirmPw] = useState('');
  const [newKey, setNewKey] = useState('');
  const [keptKey, setKeptKey] = useState(false);
  useEffect(() => {
    void bioSupported().then(setBioOk);
    void bioEnrolled().then(setBio);
    void recoveryEnabled().then(setHasRecovery);
  }, []);

  const needPassword = async () => {
    if (!(await vault.checkPassword(confirmPw))) throw new Error('Nhập đúng master password hiện tại ở ô bên trên trước');
    return confirmPw;
  };

  const turnOnBio = () =>
    run('bio', async () => {
      await enrollBio(await needPassword());
      setBio(true);
      setConfirmPw('');
      toast('Đã bật mở khoá bằng vân tay / mật khẩu máy');
    });

  const makeRecovery = () =>
    run('recovery', async () => {
      if (hasRecovery && !window.confirm('Tạo khoá khôi phục mới? Khoá cũ sẽ không dùng được nữa.')) return;
      setNewKey(await setUpRecovery(await needPassword(), session.drive));
      setKeptKey(false);
      setHasRecovery(true);
      setConfirmPw('');
    });

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
        <h3>Mở khoá nhanh và khôi phục</h3>
        <SecretInput
          label="Master password hiện tại (để bật các mục dưới)"
          value={confirmPw}
          onChange={setConfirmPw}
          autoComplete="current-password"
        />

        <div className="setting-row">
          <div className="grow">
            <strong>Vân tay / mật khẩu máy</strong>
            <div className="muted small">
              {bio
                ? 'Đang bật trên thiết bị này.'
                : bioOk
                  ? 'Mở khoá bằng Touch ID, Windows Hello, vân tay điện thoại hoặc mật khẩu máy. Chỉ áp dụng cho thiết bị này.'
                  : 'Thiết bị hoặc trình duyệt này không có khoá màn hình dùng được cho việc này.'}
            </div>
          </div>
          {bio ? (
            <button
              type="button"
              onClick={() =>
                void disableBio().then(() => {
                  setBio(false);
                  toast('Đã tắt mở khoá bằng vân tay');
                })
              }
            >
              Tắt
            </button>
          ) : isPopup ? (
            <button type="button" onClick={openInTab}>
              Bật trong tab
            </button>
          ) : (
            <button type="button" onClick={() => void turnOnBio()} disabled={!bioOk || !!busy || !confirmPw}>
              {busy === 'bio' ? 'Đang bật…' : 'Bật'}
            </button>
          )}
        </div>

        <div className="setting-row">
          <div className="grow">
            <strong>Khoá khôi phục</strong>
            <div className="muted small">
              {hasRecovery
                ? 'Đã tạo. Dùng khi quên master password.'
                : 'Cách duy nhất để mở lại vault nếu quên master password. Chưa tạo.'}
            </div>
          </div>
          <button type="button" onClick={() => void makeRecovery()} disabled={!!busy || !confirmPw}>
            {busy === 'recovery' ? 'Đang tạo…' : hasRecovery ? 'Tạo khoá mới' : 'Tạo'}
          </button>
          {hasRecovery && !newKey && (
            <button
              type="button"
              className="danger"
              onClick={() =>
                window.confirm('Tắt khoá khôi phục? Quên master password sẽ không còn cách nào mở lại vault.') &&
                void removeRecovery(session.drive).then(() => setHasRecovery(false))
              }
            >
              Tắt
            </button>
          )}
        </div>
        {newKey && (
          <div
            className="recovery-key"
            data-testid="recovery-key"
            ref={(el) => el?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
          >
            <p className="warn small">
              Đây là lần duy nhất khoá này được hiển thị. Ghi ra giấy hoặc in, cất ở nơi an toàn, tách biệt với
              master password. Ai có khoá này và quyền vào Google Drive (hoặc thiết bị) của bạn sẽ mở được vault.
            </p>
            <div className="inputrow">
              <code className="key mono">{newKey}</code>
              <CopyBtn value={newKey} secret what="khoá khôi phục" />
            </div>
            <button
              type="button"
              onClick={() =>
                downloadBytes(
                  'KaiPass-khoa-khoi-phuc.txt',
                  `Khoá khôi phục KaiPass\n\n${newKey}\n\nTạo lúc ${new Date().toLocaleString('vi-VN')}.\nDùng ở màn hình mở khoá → "Quên master password?".\nCất ở nơi an toàn, không lưu chung với master password.\n`,
                  'text/plain',
                )
              }
            >
              Tải file .txt
            </button>
            <label className="check">
              <input type="checkbox" checked={keptKey} onChange={(e) => setKeptKey(e.target.checked)} />
              Tôi đã cất khoá này ở nơi an toàn
            </label>
            <button type="button" className="primary" disabled={!keptKey} onClick={() => setNewKey('')}>
              Xong
            </button>
          </div>
        )}
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

      {isExtension && (
        <section>
          <h3>Gợi ý trên trang web</h3>
          <label className="check">
            <input type="checkbox" checked={inline.icon} onChange={(e) => setInlinePref({ icon: e.target.checked })} />
            Hiện biểu tượng KaiPass và danh sách tài khoản trong ô đăng nhập
          </label>
          <label className="check">
            <input type="checkbox" checked={inline.toast} onChange={(e) => setInlinePref({ toast: e.target.checked })} />
            Hiện thẻ gợi ý ở góc trên khi trang có ô đăng nhập
          </label>
        </section>
      )}

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
        <WipeSection
          mode={meta.mode}
          onWiped={() => {
            session.close();
            window.location.reload();
          }}
        />
      </section>
    </Modal>
  );
}
