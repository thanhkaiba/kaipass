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
import { Avatar, Brand, CopyBtn, errorText, Icon, IconButton, InfoTip, Modal, OtpCode, SecretInput, useToast } from './bits';
import { fieldLabel } from './types';

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
  const [usePass, setUsePass] = useState(false);
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
    <Modal title={`Chia sẻ: ${item.title}`} icon="share" onClose={onClose}>
      {link ? (
        <div className="share-form">
          <div className="share-link">
            <Icon name="link" />
            <input readOnly value={link.url} aria-label="Link chia sẻ" className="mono" onFocus={(e) => e.target.select()} />
            <CopyBtn value={link.url} what="link" />
          </div>
          <div className="pill-row">
            <span className="tag">
              <Icon name="clock" size={13} /> Hết hạn {when(link.record.expires)}
            </span>
            {link.record.kind === 'drive' ? (
              <span className="tag" data-tip="Bạn có thể thu hồi link này bất cứ lúc nào">
                <Icon name="cloud" size={13} /> Thu hồi được
              </span>
            ) : (
              <span className="tag" data-tip="Link chứa toàn bộ dữ liệu (đã mã hoá), không thu hồi được. Gửi qua kênh an toàn.">
                <Icon name="alert" size={13} /> Không thu hồi được
              </span>
            )}
            {link.record.passphrase && (
              <span className="tag" data-tip="Gửi mật khẩu chia sẻ qua kênh khác với kênh gửi link">
                <Icon name="lock" size={13} /> Có mật khẩu
              </span>
            )}
          </div>
          <button type="button" onClick={() => setLink(null)}>
            <Icon name="plus" /> Tạo link khác
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void make();
          }}
          className="share-form"
        >
          <div className="field">
            <div className="label-row">
              <span className="row-label">Hết hạn sau</span>
              <InfoTip text="Người nhận mở link bằng trình duyệt, không cần cài KaiPass. Khoá giải mã chỉ nằm trong link." />
            </div>
            <div className="segmented" role="group" aria-label="Hết hạn sau">
              {EXPIRY.map(([label, ms]) => (
                <button type="button" key={ms} aria-pressed={expiry === ms} onClick={() => setExpiry(ms)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="group">
            {item.otp && (
              <div className="setting">
                <span className={`setting-icon${withOtp ? ' on' : ''}`}>
                  <Icon name="clock" />
                </span>
                <div className="setting-text">
                  <strong>
                    Kèm mã OTP <InfoTip text="Người nhận tự tạo được mã OTP" />
                  </strong>
                </div>
                <button type="button" role="switch" className="switch" aria-label="Kèm mã OTP" aria-checked={withOtp} onClick={() => setWithOtp(!withOtp)} />
              </div>
            )}
            <div className="setting">
              <span className={`setting-icon${usePass ? ' on' : ''}`}>
                <Icon name="lock" />
              </span>
              <div className="setting-text">
                <strong>
                  Mật khẩu chia sẻ <InfoTip text="Có mật khẩu thì link thôi là chưa đủ để mở. Gửi mật khẩu qua kênh khác." />
                </strong>
              </div>
              <button
                type="button"
                role="switch"
                className="switch"
                aria-label="Đặt mật khẩu chia sẻ"
                aria-checked={usePass}
                onClick={() => {
                  setUsePass(!usePass);
                  setPassphrase('');
                }}
              />
            </div>
            {usePass && (
              <div className="setting-panel">
                <SecretInput label="Mật khẩu chia sẻ" hideLabel placeholder="Mật khẩu chia sẻ" value={passphrase} onChange={setPassphrase} autoComplete="new-password" autoFocus />
              </div>
            )}
          </div>
          {(item.attachments.length > 0 || !onDrive) && (
            <p className="note">
              <Icon name="info" />
              <span>
                {[
                  item.attachments.length > 0 && 'Không kèm file đính kèm.',
                  !onDrive && 'Link tự chứa: không thu hồi được.',
                ]
                  .filter(Boolean)
                  .join(' ')}
              </span>
              {!onDrive && (
                <InfoTip
                  text={
                    drive && !GOOGLE_API_KEY
                      ? 'Chưa cấu hình Google API key nên link chứa dữ liệu (đã mã hoá) bên trong, và hạn dùng chỉ được KaiPass kiểm tra. Xem README để bật link thu hồi được.'
                      : 'Vault đang chỉ lưu trên thiết bị nên link chứa dữ liệu (đã mã hoá) bên trong, và hạn dùng chỉ được KaiPass kiểm tra.'
                  }
                />
              )}
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              <Icon name="alert" />
              <span>{error}</span>
            </p>
          )}
          <div className="actions">
            <button className="primary" disabled={busy || (usePass && !passphrase)}>
              <Icon name="link" /> {busy ? 'Đang tạo…' : 'Tạo link'}
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
        <div className="stack">
          <h3>Link đang còn hạn</h3>
          <div className="group">
            {existing.map((r) => (
              <div className="row share-row" key={r.id}>
                <span className="file-icon">
                  <Icon name={r.kind === 'drive' ? 'cloud' : 'link'} />
                </span>
                <div className="row-main">
                  <div className="row-value">
                    {r.kind === 'drive' ? 'Link qua Google Drive' : 'Link tự chứa'}
                    {r.passphrase && ' · có mật khẩu'}
                  </div>
                  <div className="muted small">Hết hạn {when(r.expires)}</div>
                </div>
                <IconButton
                  icon={r.kind === 'drive' ? 'x' : 'trash'}
                  tone="danger"
                  label={r.kind === 'drive' ? 'Thu hồi' : 'Bỏ'}
                  tip={r.kind === 'drive' ? 'Thu hồi link' : 'Bỏ khỏi danh sách (link vẫn mở được tới khi hết hạn)'}
                  onClick={() => void revoke(r)}
                />
              </div>
            ))}
          </div>
        </div>
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
      <div className="row-actions">
        {secret && (
          <IconButton icon={show ? 'eyeOff' : 'eye'} label={`${show ? 'Ẩn' : 'Hiện'} ${label}`} tip={show ? 'Ẩn' : 'Hiện'} onClick={() => setShow(!show)} />
        )}
        <CopyBtn value={value} secret={secret} what={label.toLowerCase()} />
      </div>
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
        <div className="step-head">
          <Brand small />
          <span className="grow" />
          <span className="badge" data-tip="Ai đó đã chia sẻ thông tin này với bạn qua KaiPass">
            <Icon name="share" /> Được chia sẻ
          </span>
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
            <SecretInput
              label="Mật khẩu chia sẻ"
              hint="Người gửi đã đặt mật khẩu cho link này. Hãy hỏi họ."
              value={pass}
              onChange={setPass}
              autoFocus
            />
            <button className="primary" disabled={busy || !pass}>
              Mở
            </button>
          </form>
        )}
        {error && (
          <p className="error" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </p>
        )}
        {item && envelope && (
          <>
            <div className="detail-head">
              <Avatar title={item.title} icon={item.type} size={44} />
              <div className="detail-title">
                <h2>{item.title || '(không tên)'}</h2>
                <div className="detail-meta">
                  <span className="tag">
                    <Icon name="clock" size={13} /> Hết hạn {when(envelope.expires)}
                  </span>
                </div>
              </div>
            </div>
            <SharedItemCard item={item} />
            <button type="button" className="primary" onClick={save}>
              <Icon name="plus" /> Lưu vào KaiPass của bạn
            </button>
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
    <Modal title="Thêm từ link chia sẻ" icon="link" onClose={onClose}>
      {link === null ? (
        <form
          className="share-form"
          onSubmit={(e) => {
            e.preventDefault();
            setLink(parseLink(text));
          }}
        >
          <div className="field">
            <div className="label-row">
              <label htmlFor="share-url">Link chia sẻ KaiPass</label>
              <InfoTip text="Link chia sẻ từ 1Password không đọc được ở đây: mở link đó trong trình duyệt rồi copy từng mục. Với OTP, nhờ người gửi kèm chuỗi otpauth://." />
            </div>
            <input id="share-url" value={text} onChange={(e) => setText(e.target.value)} autoFocus placeholder="https://…#share=…" />
          </div>
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
