import { useEffect, useState, type FormEvent } from 'react';
import { GOOGLE_API_KEY } from '../config';
import { ShareBlocked, type Drive } from '../lib/drive';
import {
  canShareOnDrive,
  createShare,
  fetchEnvelope,
  listShares,
  open,
  parseLink,
  revokeShare,
  SharePassphraseError,
  stashIncoming,
  toShared,
  type Envelope,
  type ParsedLink,
  type ShareRecord,
  type SharedItem,
} from '../lib/share';
import type { Item } from '../lib/vault';
import { CopyBtn, errorText, Icon, Modal, OtpCode, SecretInput, useToast } from './bits';
import { fieldLabel, TYPE_LABEL } from './types';

const EXPIRY: [string, number][] = [
  ['1 giờ', 3600_000],
  ['1 ngày', 86_400_000],
  ['7 ngày', 7 * 86_400_000],
  ['14 ngày', 14 * 86_400_000],
  ['30 ngày', 30 * 86_400_000],
];

const when = (t: number) => new Date(t).toLocaleString('vi-VN');

// ---- sender side ----

export function ShareDialog({ item, drive, onClose }: { item: Item; drive?: Drive; onClose: () => void }) {
  const toast = useToast();
  const [expiry, setExpiry] = useState(EXPIRY[2][1]);
  const [withOtp, setWithOtp] = useState(!!item.otp);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState<{ url: string; record: ShareRecord } | null>(null);
  const [existing, setExisting] = useState<ShareRecord[]>([]);
  const onDrive = canShareOnDrive(drive);

  const reload = () => listShares().then((all) => setExisting(all.filter((r) => r.itemId === item.id && r.expires > Date.now())));
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const make = async (preferInline = false) => {
    setBusy(true);
    setError('');
    try {
      const made = await createShare({
        item: toShared(item, withOtp),
        itemId: item.id,
        expires: Date.now() + expiry,
        passphrase,
        drive,
        preferInline,
      });
      setLink(made);
      void reload();
    } catch (e) {
      if (e instanceof ShareBlocked) {
        setError(
          'Tài khoản Google này (thường là tài khoản công ty) không cho chia sẻ file công khai. Bạn có thể tạo link tự chứa thay thế, nhưng loại link đó không thu hồi được.',
        );
      } else {
        setError(errorText(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (r: ShareRecord) => {
    if (!window.confirm(r.kind === 'drive' ? 'Thu hồi link này? Người nhận sẽ không mở được nữa.' : 'Bỏ link này khỏi danh sách? Link tự chứa không thu hồi được, người đã có link vẫn mở được tới khi hết hạn.')) return;
    try {
      await revokeShare(r, drive);
      if (link?.record.id === r.id) setLink(null);
      toast(r.kind === 'drive' ? 'Đã thu hồi link' : 'Đã bỏ khỏi danh sách');
      void reload();
    } catch (e) {
      toast(errorText(e));
    }
  };

  return (
    <Modal title={`Chia sẻ: ${item.title}`} onClose={onClose}>
      {link ? (
        <section>
          <h3>Link chia sẻ</h3>
          <div className="inputrow share-link">
            <input readOnly value={link.url} aria-label="Link chia sẻ" className="mono" onFocus={(e) => e.target.select()} />
            <CopyBtn value={link.url} what="link" />
          </div>
          <p className="muted small">
            Hết hạn lúc {when(link.record.expires)}.{' '}
            {link.record.kind === 'drive'
              ? 'Bạn có thể thu hồi bất cứ lúc nào.'
              : 'Link này chứa toàn bộ dữ liệu (đã mã hoá) nên không thu hồi được; hãy gửi qua kênh an toàn.'}
          </p>
          {link.record.passphrase && (
            <p className="warn small">Gửi mật khẩu chia sẻ cho người nhận qua một kênh khác với kênh gửi link.</p>
          )}
          <button type="button" onClick={() => setLink(null)}>
            Tạo link khác
          </button>
        </section>
      ) : (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void make();
          }}
          className="share-form"
        >
          <p className="muted small">
            Người nhận mở link bằng trình duyệt, không cần cài KaiPass. Dữ liệu được mã hoá; khoá giải mã chỉ
            nằm trong link.
          </p>
          <div className="field">
            <label htmlFor="share-exp">Hết hạn sau</label>
            <select id="share-exp" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
              {EXPIRY.map(([label, ms]) => (
                <option key={ms} value={ms}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {item.otp && (
            <label className="check">
              <input type="checkbox" checked={withOtp} onChange={(e) => setWithOtp(e.target.checked)} />
              Kèm mã OTP (người nhận tự tạo được mã)
            </label>
          )}
          <SecretInput
            label="Mật khẩu chia sẻ (không bắt buộc)"
            value={passphrase}
            onChange={setPassphrase}
            autoComplete="new-password"
          />
          {item.attachments.length > 0 && <p className="muted small">File đính kèm không được chia sẻ.</p>}
          {!onDrive && (
            <p className="muted small">
              {drive && !GOOGLE_API_KEY
                ? 'Chưa cấu hình Google API key nên link sẽ ở dạng tự chứa: không thu hồi được, hạn dùng chỉ được KaiPass kiểm tra. Xem README để bật link thu hồi được.'
                : 'Vault đang chỉ lưu trên thiết bị nên link sẽ ở dạng tự chứa: không thu hồi được, hạn dùng chỉ được KaiPass kiểm tra.'}
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button className="primary" disabled={busy}>
              {busy ? 'Đang tạo…' : 'Tạo link'}
            </button>
            {error && onDrive && (
              <button type="button" onClick={() => void make(true)} disabled={busy}>
                Tạo link tự chứa
              </button>
            )}
          </div>
        </form>
      )}

      {existing.length > 0 && (
        <section>
          <h3>Link đang còn hạn</h3>
          {existing.map((r) => (
            <div className="row share-row" key={r.id}>
              <div className="row-main">
                <div className="row-value">
                  {r.kind === 'drive' ? 'Link qua Google Drive' : 'Link tự chứa'}
                  {r.passphrase && ' · có mật khẩu'}
                </div>
                <div className="muted small">
                  Tạo {when(r.created)} · hết hạn {when(r.expires)}
                </div>
              </div>
              <button type="button" className="danger" onClick={() => void revoke(r)}>
                {r.kind === 'drive' ? 'Thu hồi' : 'Bỏ'}
              </button>
            </div>
          ))}
        </section>
      )}
    </Modal>
  );
}

// ---- recipient side ----

function Field({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [show, setShow] = useState(false);
  if (!value) return null;
  return (
    <div className="row">
      <div className="row-main">
        <div className="row-label">{label}</div>
        <div className={`row-value${secret ? ' mono' : ''}`}>{secret && !show ? '••••••••••' : value}</div>
      </div>
      {secret && (
        <button type="button" className="iconbtn" onClick={() => setShow(!show)} aria-label={`${show ? 'Ẩn' : 'Hiện'} ${label}`}>
          <Icon name={show ? 'eyeOff' : 'eye'} />
        </button>
      )}
      <CopyBtn value={value} secret={secret} what={label.toLowerCase()} />
    </div>
  );
}

export function SharedItemCard({ item }: { item: SharedItem }) {
  return (
    <section className="card">
      <Field label="Tên đăng nhập" value={item.username} />
      <Field label="Mật khẩu" value={item.password} secret />
      {item.otp && (
        <div className="row">
          <div className="row-main">
            <div className="row-label">Mã OTP</div>
            <OtpCode uri={item.otp} />
          </div>
        </div>
      )}
      <Field label="Địa chỉ web" value={item.url} />
      {item.fields.map((f) => (
        <Field key={f.name} label={fieldLabel(f.name)} value={f.value} secret={f.secret} />
      ))}
      {item.otp && <Field label="Mã bí mật OTP" value={item.otp} secret />}
      {item.notes && <Field label="Ghi chú" value={item.notes} />}
    </section>
  );
}

/** Opens a link: fetches and decrypts, asking for the passphrase when one is needed. */
export function useSharedLink(link: ParsedLink | undefined) {
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const [item, setItem] = useState<SharedItem | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    if (!link) {
      setError('Link chia sẻ không hợp lệ');
      setBusy(false);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const env = await fetchEnvelope(link);
        if (!alive) return;
        setEnvelope(env);
        if (!env.salt) setItem(await open(env, link.secret));
      } catch (e) {
        if (alive) setError(errorText(e));
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [link]);

  const unlock = async (passphrase: string) => {
    if (!envelope || !link) return;
    setBusy(true);
    setError('');
    try {
      setItem(await open(envelope, link.secret, passphrase));
    } catch (e) {
      setError(e instanceof SharePassphraseError ? e.message : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return { envelope, item, error, busy, unlock };
}

export function ShareView({ link }: { link: ParsedLink | undefined }) {
  const { envelope, item, error, busy, unlock } = useSharedLink(link);
  const [pass, setPass] = useState('');

  const save = () => {
    if (!item) return;
    stashIncoming(item);
    history.replaceState(null, '', location.pathname + location.search);
    location.reload();
  };

  return (
    <div className="center">
      <div className="panel share-view" data-testid="share-view">
        <div className="brand">
          <img src="./icon.svg" alt="" />
          <div>
            <h1>KaiPass</h1>
            <p className="muted small">Ai đó đã chia sẻ thông tin này với bạn</p>
          </div>
        </div>
        {busy && <p className="muted">Đang mở…</p>}
        {envelope && !item && envelope.salt && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void unlock(pass);
            }}
            className="share-form"
          >
            <SecretInput label="Mật khẩu chia sẻ" value={pass} onChange={setPass} autoFocus />
            <p className="muted small">Người gửi đã đặt mật khẩu cho link này. Hãy hỏi họ.</p>
            <button className="primary" disabled={busy || !pass}>
              Mở
            </button>
          </form>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {item && envelope && (
          <>
            <div>
              <h2>{item.title || '(không tên)'}</h2>
              <p className="muted small">
                {TYPE_LABEL[item.type] ?? ''} · link hết hạn lúc {when(envelope.expires)}
              </p>
            </div>
            <SharedItemCard item={item} />
            <button type="button" className="primary" onClick={save}>
              Lưu vào KaiPass của bạn
            </button>
            <p className="muted small">Không dùng KaiPass? Bấm copy từng mục để dán vào trình quản lý mật khẩu của bạn.</p>
          </>
        )}
      </div>
    </div>
  );
}

/** "Thêm → Từ link chia sẻ" inside the vault: paste a link, see it, then edit and save it. */
export function ImportShareDialog({ onUse, onClose }: { onUse: (item: SharedItem) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const [link, setLink] = useState<ParsedLink | undefined | null>(null);
  return (
    <Modal title="Thêm từ link chia sẻ" onClose={onClose}>
      {link === null ? (
        <form
          className="share-form"
          onSubmit={(e) => {
            e.preventDefault();
            setLink(parseLink(text));
          }}
        >
          <div className="field">
            <label htmlFor="share-url">Link chia sẻ KaiPass</label>
            <input id="share-url" value={text} onChange={(e) => setText(e.target.value)} autoFocus placeholder="https://…#share=…" />
          </div>
          <p className="muted small">
            Link chia sẻ từ 1Password không đọc được ở đây: mở link đó trong trình duyệt rồi copy từng mục. Với
            OTP, nhờ người gửi kèm chuỗi otpauth://.
          </p>
          <button className="primary" disabled={!text.trim()}>
            Mở link
          </button>
        </form>
      ) : (
        <ImportShareBody link={link} onUse={onUse} onBack={() => setLink(null)} />
      )}
    </Modal>
  );
}

function ImportShareBody({ link, onUse, onBack }: { link: ParsedLink | undefined; onUse: (item: SharedItem) => void; onBack: () => void }) {
  const { envelope, item, error, busy, unlock } = useSharedLink(link);
  const [pass, setPass] = useState('');
  return (
    <div className="share-form">
      {busy && <p className="muted">Đang mở…</p>}
      {envelope && !item && envelope.salt && (
        <>
          <SecretInput label="Mật khẩu chia sẻ" value={pass} onChange={setPass} autoFocus />
          <button type="button" className="primary" disabled={busy || !pass} onClick={() => void unlock(pass)}>
            Mở
          </button>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {item && (
        <>
          <h3>{item.title}</h3>
          <SharedItemCard item={item} />
          <button type="button" className="primary" onClick={() => onUse(item)}>
            Thêm vào vault
          </button>
        </>
      )}
      <button type="button" className="link" onClick={onBack}>
        <Icon name="back" /> Link khác
      </button>
    </div>
  );
}
