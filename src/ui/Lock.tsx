import { useState, type FormEvent } from 'react';
import { Session, wipeDevice, type Meta } from '../lib/session';
import { errorText, SecretInput } from './bits';

export function Lock({
  meta,
  onReady,
  onWiped,
}: {
  meta: Meta;
  onReady: (s: Session) => void;
  onWiped: () => void;
}) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onReady(await Session.unlock(pw));
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const wipe = async () => {
    const drive = meta.mode === 'drive';
    const ok = window.confirm(
      drive
        ? 'Xoá bản sao vault trên thiết bị này? File trên Google Drive vẫn còn nguyên.'
        : 'Xoá vault trên thiết bị này? Vault này không có bản nào khác, dữ liệu sẽ mất hẳn.',
    );
    if (!ok) return;
    await wipeDevice();
    onWiped();
  };

  return (
    <div className="center">
      <form className="panel" onSubmit={submit}>
        <div className="brand">
          <img src="./icon.svg" alt="" />
          <h1>KaiPass</h1>
        </div>
        <SecretInput
          label="Master password"
          value={pw}
          onChange={setPw}
          autoFocus
          autoComplete="current-password"
        />
        <button className="primary" disabled={busy || !pw}>
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
        <button type="button" className="link danger" onClick={wipe}>
          Xoá dữ liệu trên thiết bị này
        </button>
      </form>
    </div>
  );
}
