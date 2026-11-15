import { useState, type FormEvent } from 'react';
import { normalizeOtp } from '../lib/totp';
import type { Folder, ItemDraft, ItemField } from '../lib/vault';
import { errorText, Generator, Icon, SecretInput, TextInput } from './bits';
import { TYPE_LABEL } from './types';

export function ItemEditor({
  initial,
  folders,
  onSave,
  onCancel,
}: {
  initial: ItemDraft;
  folders: Folder[];
  onSave: (d: ItemDraft) => Promise<void>;
  onCancel: () => void;
}) {
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
        <h2>{initial.id ? 'Sửa' : 'Thêm'}: {TYPE_LABEL[d.type]}</h2>
        <div className="actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Huỷ
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Đang lưu…' : 'Lưu'}
          </button>
        </div>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

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
            extra={
              <button
                type="button"
                className="iconbtn"
                onClick={() => setGen(!gen)}
                title="Tạo mật khẩu"
                aria-label="Tạo mật khẩu"
              >
                <Icon name="dice" />
              </button>
            }
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
            label="Mã bí mật OTP (dán chuỗi otpauth:// hoặc secret key)"
            value={d.otp}
            onChange={(otp) => set({ otp })}
            mono
          />
        </>
      )}

      <fieldset className="custom">
        <legend>{d.type === 'login' ? 'Trường khác' : 'Thông tin'}</legend>
        {d.fields.map((f, i) => (
          <div className="custom-row" key={i}>
            <input
              aria-label="Tên trường"
              placeholder="Tên trường"
              value={f.name}
              onChange={(e) => setField(i, { name: e.target.value })}
            />
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
            <button
              type="button"
              className={`iconbtn${f.secret ? ' on' : ''}`}
              title={f.secret ? 'Đang ẩn giá trị' : 'Đang hiện giá trị'}
              aria-label="Ẩn giá trị"
              aria-pressed={f.secret}
              onClick={() => setField(i, { secret: !f.secret })}
            >
              <Icon name={f.secret ? 'eyeOff' : 'eye'} />
            </button>
            <button
              type="button"
              className="iconbtn"
              title="Bỏ trường"
              aria-label="Bỏ trường"
              onClick={() => set({ fields: d.fields.filter((_, j) => j !== i) })}
            >
              <Icon name="x" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="link"
          onClick={() => set({ fields: [...d.fields, { name: '', value: '', secret: false }] })}
        >
          <Icon name="plus" /> Thêm trường
        </button>
      </fieldset>

      <div className="field">
        <label htmlFor="notes">Ghi chú</label>
        <textarea id="notes" rows={5} value={d.notes} onChange={(e) => set({ notes: e.target.value })} />
      </div>

      <div className="two">
        <div className="field">
          <label htmlFor="folder">Thư mục</label>
          <select id="folder" value={d.folderId} onChange={(e) => set({ folderId: e.target.value })}>
            <option value="">(không có)</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {'  '.repeat(f.depth)}
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <TextInput label="Nhãn (cách nhau bằng dấu phẩy)" value={tags} onChange={setTags} />
      </div>
      <label className="check">
        <input type="checkbox" checked={d.favorite} onChange={(e) => set({ favorite: e.target.checked })} />
        Yêu thích
      </label>
    </form>
  );
}
