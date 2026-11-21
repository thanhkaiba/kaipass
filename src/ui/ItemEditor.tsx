import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
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
  onChange,
}: {
  initial: ItemDraft;
  folders: Folder[];
  onSave: (d: ItemDraft) => Promise<void>;
  onCancel: () => void;
  /** A Google Authenticator export holds several accounts: add them all as new items. */
  onImportMany?: (accounts: OtpAccount[]) => void;
  /** Every change to the form as it is typed, so an edit in progress can survive the window closing. */
  onChange?: (d: ItemDraft) => void;
}) {
  const [scanning, setScanning] = useState(false);
  const toast = useToast();
  const [d, setD] = useState<ItemDraft>(initial);
  const [tags, setTags] = useState(initial.tags.join(', '));
  const [gen, setGen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ItemDraft>) => setD((cur) => ({ ...cur, ...patch }));
  useEffect(() => {
    onChange?.({ ...d, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, tags]);
  const setField = (i: number, patch: Partial<ItemField>) =>
    set({ fields: d.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });

  // Removing a field is one stray click away, so it can be taken back: with the "Hoàn tác" button,
  // or with Ctrl/⌘+Z as long as nothing was typed since (after that, Ctrl+Z belongs to the text).
  const form = useRef<HTMLFormElement>(null);
  const [removed, setRemoved] = useState<{ at: number; field: ItemField }[]>([]);
  const typedSince = useRef(false);
  // Where the keyboard goes once the list of fields has been redrawn (set by remove / restore).
  const [focusOn, setFocusOn] = useState<{ selector: string; index: number } | null>(null);
  useLayoutEffect(() => {
    if (!focusOn) return;
    form.current?.querySelectorAll<HTMLElement>(focusOn.selector)[focusOn.index]?.focus();
    setFocusOn(null);
  }, [focusOn]);

  const removeField = (i: number) => {
    setRemoved((r) => [...r, { at: i, field: d.fields[i] }]);
    typedSince.current = false;
    const left = d.fields.length - 1;
    set({ fields: d.fields.filter((_, j) => j !== i) });
    // The button just pressed is gone: keep the keyboard in the form, on the neighbouring field.
    setFocusOn(left > 0 ? { selector: '.custom-name', index: Math.min(i, left - 1) } : { selector: '.add-field', index: 0 });
  };

  const restoreField = () => {
    const last = removed.at(-1);
    if (!last) return;
    setRemoved((r) => r.slice(0, -1));
    const fields = [...d.fields];
    const at = Math.min(last.at, fields.length);
    fields.splice(at, 0, last.field);
    set({ fields });
    setFocusOn({ selector: '.custom-value', index: at });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z' && removed.length > 0 && !typedSince.current) {
      e.preventDefault();
      restoreField();
    }
  };

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
    <form className="detail editor" onSubmit={submit} ref={form} onKeyDown={onKeyDown} onInput={() => (typedSince.current = true)}>
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
          <button type="button" className="cancel" onClick={onCancel} disabled={busy}>
            Huỷ
          </button>
          <button className="primary save" disabled={busy}>
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
            {d.passkey && (
              <div className="undo-bar">
                <Icon name="finger" />
                <span className="grow">
                  Passkey cho <strong>{d.passkey.rpId}</strong>
                </span>
                <button
                  type="button"
                  className="danger"
                  onClick={() => window.confirm(`Xoá passkey của ${d.passkey!.rpId}? Bạn sẽ không đăng nhập trang đó bằng passkey này được nữa.`) && set({ passkey: undefined })}
                >
                  Xoá passkey
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <section className="card">
        <div className="label-row">
          <h3 className="grow">{d.type === 'login' ? 'Trường khác' : 'Thông tin'}</h3>
          <IconButton
            icon="plus"
            className="add-field"
            label="Thêm trường"
            onClick={() => set({ fields: [...d.fields, { name: '', value: '', secret: false }] })}
          />
        </div>
        {d.fields.length === 0 && <p className="muted small">Ví dụ: câu hỏi bảo mật, mã PIN, số tài khoản…</p>}
        {d.fields.map((f, i) => (
          <div className="custom-field" key={i}>
            <div className="custom-main">
              <input
                className="custom-name"
                aria-label="Tên trường"
                placeholder="Tên trường"
                value={f.name}
                onChange={(e) => setField(i, { name: e.target.value })}
              />
              <input
                aria-label={`Giá trị ${f.name}`}
                placeholder="Giá trị"
                type={f.secret ? 'password' : 'text'}
                className="custom-value mono"
                autoComplete="off"
                spellCheck={false}
                value={f.value}
                onChange={(e) => setField(i, { value: e.target.value })}
              />
            </div>
            <IconButton
              icon={f.secret ? 'eyeOff' : 'eye'}
              label="Ẩn giá trị"
              tip={f.secret ? 'Đang ẩn (bấm để hiện)' : 'Đang hiện (bấm để ẩn)'}
              pressed={f.secret}
              onClick={() => setField(i, { secret: !f.secret })}
            />
            <IconButton icon="x" tone="danger" label="Bỏ trường" onClick={() => removeField(i)} />
          </div>
        ))}
        {removed.length > 0 && (
          <div className="undo-bar" role="status">
            <Icon name="restore" />
            <span className="grow">
              Đã bỏ trường <strong>{removed.at(-1)!.field.name || '(chưa đặt tên)'}</strong>
              {removed.length > 1 && ` và ${removed.length - 1} trường khác`}
            </span>
            <button type="button" onClick={restoreField} data-tip="Ctrl/⌘ + Z">
              Hoàn tác
            </button>
          </div>
        )}
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
