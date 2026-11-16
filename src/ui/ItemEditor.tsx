import { useState, type FormEvent } from 'react';
import { normalizeOtp } from '../lib/totp';
import type { OtpAccount } from '../lib/qr';
import type { Folder, ItemDraft, ItemField } from '../lib/vault';
import { QrScanDialog } from './QrScan';
import { Avatar, errorText, Generator, Icon, IconButton, SecretInput, TextInput, useToast } from './bits';
import { TYPE_LABEL } from './types';

export function ItemEditor({
  initial,
  folders,
  onSave,
  onCancel,
  onImportMany,
}: {
  initial: ItemDraft;
  folders: Folder[];
  onSave: (d: ItemDraft) => Promise<void>;
  onCancel: () => void;
  /** A Google Authenticator export holds several accounts: add them all as new items. */
  onImportMany?: (accounts: OtpAccount[]) => void;
}) {
  const [scanning, setScanning] = useState(false);
  const toast = useToast();
  const [d, setD] = useState<ItemDraft>(initial);
  const [tags, setTags] = useState(initial.tags.join(', '));
  const [gen, setGen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ItemDraft>) => setD((cur) => ({ ...cur, ...patch }));
  const setField = (i: number, patch: Partial<ItemField>) =>
    set({ fields: d.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!d.title.trim()) return setError('Cần nhập tên');
    let otp = '';
    try {
      otp = normalizeOtp(d.otp, d.title.trim());
    } catch (err) {
      return setError(errorText(err));
    }
    setBusy(true);
    try {
      await onSave({ ...d, otp, tags: tags.split(',') });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form className="detail editor" onSubmit={submit}>
      <header className="detail-head">
        <Avatar title={d.title} icon={d.type} url={d.url} size={48} />
        <div className="detail-title">
          <h2>{d.title.trim() || (initial.id ? 'Sửa' : `${TYPE_LABEL[d.type]} mới`)}</h2>
          <div className="detail-meta">
            <span className="tag">
              <Icon name={d.type} size={13} /> {TYPE_LABEL[d.type]}
            </span>
          </div>
        </div>
        <div className="actions">
          <IconButton
            icon="star"
            label="Yêu thích"
            tone={d.favorite ? 'star' : undefined}
            filled={d.favorite}
            pressed={d.favorite}
            onClick={() => set({ favorite: !d.favorite })}
          />
          <button type="button" onClick={onCancel} disabled={busy}>
            Huỷ
          </button>
          <button className="primary" disabled={busy}>
            <Icon name="check" /> {busy ? 'Đang lưu…' : 'Lưu'}
          </button>
        </div>
      </header>
      {error && (
        <p className="error" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}

      <section className="card">
        <TextInput label="Tên" value={d.title} onChange={(title) => set({ title })} autoFocus={!initial.id} />
        {d.type === 'login' && (
          <>
            <TextInput label="Tên đăng nhập" value={d.username} onChange={(username) => set({ username })} />
            <SecretInput
              label="Mật khẩu"
              value={d.password}
              onChange={(password) => set({ password })}
              autoComplete="new-password"
              mono
              extra={<IconButton icon="dice" label="Tạo mật khẩu" pressed={gen} onClick={() => setGen(!gen)} />}
            />
            {gen && (
              <Generator
                onUse={(password) => {
                  set({ password });
                  setGen(false);
                }}
              />
            )}
            <TextInput label="Địa chỉ web" value={d.url} onChange={(url) => set({ url })} placeholder="https://" />
            <SecretInput
              label="Mã bí mật OTP"
              hint="Quét mã QR (nút bên phải), hoặc dán chuỗi otpauth://… hay secret key mà trang web đưa khi bật xác thực hai bước."
              value={d.otp}
              onChange={(otp) => set({ otp })}
              mono
              extra={<IconButton icon="qr" label="Quét mã QR" tip="Quét mã QR: trên trang, ảnh chụp màn hình, ảnh, camera" onClick={() => setScanning(true)} />}
            />
          </>
        )}
      </section>

      <section className="card">
        <div className="label-row">
          <h3 className="grow">{d.type === 'login' ? 'Trường khác' : 'Thông tin'}</h3>
          <IconButton
            icon="plus"
            label="Thêm trường"
            onClick={() => set({ fields: [...d.fields, { name: '', value: '', secret: false }] })}
          />
        </div>
        {d.fields.length === 0 && <p className="muted small">Ví dụ: câu hỏi bảo mật, mã PIN, số tài khoản…</p>}
        {d.fields.map((f, i) => (
          <div className="custom-row" key={i}>
            <input aria-label="Tên trường" placeholder="Tên trường" value={f.name} onChange={(e) => setField(i, { name: e.target.value })} />
            <input
              aria-label={`Giá trị ${f.name}`}
              placeholder="Giá trị"
              type={f.secret ? 'password' : 'text'}
              className="mono"
              autoComplete="off"
              spellCheck={false}
              value={f.value}
              onChange={(e) => setField(i, { value: e.target.value })}
            />
            <IconButton
              icon={f.secret ? 'eyeOff' : 'eye'}
              label="Ẩn giá trị"
              tip={f.secret ? 'Đang ẩn (bấm để hiện)' : 'Đang hiện (bấm để ẩn)'}
              pressed={f.secret}
              onClick={() => setField(i, { secret: !f.secret })}
            />
            <IconButton icon="x" tone="danger" label="Bỏ trường" onClick={() => set({ fields: d.fields.filter((_, j) => j !== i) })} />
          </div>
        ))}
      </section>

      <section className="card">
        <div className="field">
          <label htmlFor="notes" className="row-label">
            Ghi chú
          </label>
          <textarea id="notes" rows={4} value={d.notes} onChange={(e) => set({ notes: e.target.value })} />
        </div>
        <div className="two">
          <div className="field">
            <label htmlFor="folder" className="row-label">
              Thư mục
            </label>
            <select id="folder" value={d.folderId} onChange={(e) => set({ folderId: e.target.value })}>
              <option value="">(không có)</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {'\u00a0\u00a0'.repeat(f.depth)}
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          <TextInput label="Nhãn" hint="Cách nhau bằng dấu phẩy" value={tags} onChange={setTags} placeholder="công việc, ngân hàng" />
        </div>
      </section>
      {scanning && (
        <QrScanDialog
          onClose={() => setScanning(false)}
          onFound={(result) => {
            setScanning(false);
            if (result.accounts.length > 1 && onImportMany) return onImportMany(result.accounts);
            const a = result.accounts[0];
            set({
              otp: a.uri,
              title: d.title.trim() ? d.title : a.issuer || a.account,
              username: d.username.trim() ? d.username : a.account,
            });
            toast(result.skipped ? `Đã thêm mã OTP (bỏ qua ${result.skipped} mã không hỗ trợ)` : 'Đã thêm mã OTP');
          }}
        />
      )}
    </form>
  );
}
