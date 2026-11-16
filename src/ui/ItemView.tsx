import { useRef, useState } from 'react';
import type { Item, Vault } from '../lib/vault';
import { Attachments } from './Attachments';
import { CopyBtn, formatSize, Icon, OtpCode, useToast } from './bits';
import { fieldLabel, TYPE_LABEL } from './types';

function Row({ label, value, secret, link }: { label: string; value: string; secret?: boolean; link?: boolean }) {
  const [show, setShow] = useState(false);
  if (!value) return null;
  const href = link && /^https?:\/\//i.test(value) ? value : undefined;
  return (
    <div className="row">
      <div className="row-main">
        <div className="row-label">{label}</div>
        <div className={`row-value${secret ? ' mono' : ''}`}>
          {secret && !show ? '••••••••••' : value}
        </div>
      </div>
      {secret && (
        <button
          type="button"
          className="iconbtn"
          onClick={() => setShow(!show)}
          title={show ? 'Ẩn' : 'Hiện'}
          aria-label={`${show ? 'Ẩn' : 'Hiện'} ${label}`}
        >
          <Icon name={show ? 'eyeOff' : 'eye'} />
        </button>
      )}
      {href && (
        <a className="iconbtn" href={href} target="_blank" rel="noopener noreferrer" title="Mở trang" aria-label="Mở trang">
          <Icon name="external" />
        </a>
      )}
      <CopyBtn value={value} secret={secret} what={label.toLowerCase()} />
    </div>
  );
}

export function ItemView({
  item,
  vault,
  change,
  onEdit,
  onBack,
  onFill,
}: {
  item: Item;
  vault: Vault;
  /** Runs a vault mutation, then saves and syncs. */
  change: (fn: () => void | Promise<void>) => Promise<void>;
  onEdit: () => void;
  onBack: () => void;
  /** Present in the extension popup when this item belongs to the page being viewed. */
  onFill?: () => void;
}) {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const attach = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      if (
        file.size > 10 * 1024 * 1024 &&
        !window.confirm(`${file.name} nặng ${formatSize(file.size)}. File lớn làm mỗi lần đồng bộ chậm hơn. Vẫn đính kèm?`)
      ) {
        continue;
      }
      const data = await file.arrayBuffer();
      await change(() => vault.addAttachment(item.id, file.name, data));
    }
    if (fileInput.current) fileInput.current.value = '';
  };

  return (
    <div className="detail">
      <header className="detail-head">
        <button type="button" className="iconbtn only-narrow" onClick={onBack} aria-label="Quay lại danh sách">
          <Icon name="back" />
        </button>
        <div className="detail-title">
          <h2>{item.title || '(không tên)'}</h2>
          <span className="muted small">
            {TYPE_LABEL[item.type]}
            {item.folderName && ` · ${item.folderName}`}
          </span>
        </div>
        <div className="actions">
          {item.trashed ? (
            <>
              <button type="button" onClick={() => change(() => vault.restore(item.id))}>
                <Icon name="restore" /> Khôi phục
              </button>
              <button
                type="button"
                className="danger"
                onClick={() =>
                  window.confirm(`Xoá hẳn "${item.title}"? Không khôi phục được.`) &&
                  change(() => vault.remove(item.id))
                }
              >
                <Icon name="trash" /> Xoá hẳn
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`iconbtn${item.favorite ? ' fav' : ''}`}
                title={item.favorite ? 'Bỏ yêu thích' : 'Yêu thích'}
                aria-label="Yêu thích"
                aria-pressed={item.favorite}
                onClick={() => change(() => vault.setFavorite(item.id, !item.favorite))}
              >
                <Icon name="star" filled={item.favorite} />
              </button>
              <button
                type="button"
                className="iconbtn"
                title="Chuyển vào thùng rác"
                aria-label="Chuyển vào thùng rác"
                onClick={() => change(() => vault.remove(item.id)).then(() => toast('Đã chuyển vào thùng rác'))}
              >
                <Icon name="trash" />
              </button>
              {onFill ? (
                <>
                  <button type="button" className="iconbtn" onClick={onEdit} title="Sửa" aria-label="Sửa">
                    <Icon name="edit" />
                  </button>
                  <button type="button" className="primary" onClick={onFill}>
                    Điền vào trang
                  </button>
                </>
              ) : (
                <button type="button" className="primary" onClick={onEdit}>
                  <Icon name="edit" /> Sửa
                </button>
              )}
            </>
          )}
        </div>
      </header>

      <section className="card">
        <Row label="Tên đăng nhập" value={item.username} />
        <Row label="Mật khẩu" value={item.password} secret />
        {item.otp && (
          <div className="row">
            <div className="row-main">
              <div className="row-label">Mã OTP</div>
              <OtpCode uri={item.otp} />
            </div>
          </div>
        )}
        <Row label="Địa chỉ web" value={item.url} link />
        {item.fields.map((f) => (
          <Row key={f.name} label={fieldLabel(f.name)} value={f.value} secret={f.secret} link={!f.secret} />
        ))}
      </section>

      {item.otp && (
        <section className="card">
          <Row label="Mã bí mật OTP" value={item.otp} secret />
        </section>
      )}

      {item.notes && (
        <section className="card">
          <div className="row">
            <div className="row-main">
              <div className="row-label">Ghi chú</div>
              <div className="row-value notes">{item.notes}</div>
            </div>
            <CopyBtn value={item.notes} what="ghi chú" />
          </div>
        </section>
      )}

      <section className="card">
        <div className="row">
          <div className="row-main">
            <div className="row-label">File đính kèm</div>
            {item.attachments.length === 0 && <div className="muted small">Chưa có file nào</div>}
          </div>
          {!item.trashed && (
            <button type="button" onClick={() => fileInput.current?.click()}>
              <Icon name="clip" /> Đính kèm
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            data-testid="attach-input"
            onChange={(e) => void attach(e.target.files)}
          />
        </div>
        <Attachments
          item={item}
          vault={vault}
          onRemove={(name) =>
            window.confirm(`Gỡ file "${name}"?`) && void change(() => vault.removeAttachment(item.id, name))
          }
        />
      </section>

      {item.tags.length > 0 && (
        <div className="tags">
          {item.tags.map((t) => (
            <span className="tag" key={t}>
              {t}
            </span>
          ))}
        </div>
      )}
      <p className="muted small">
        Sửa lần cuối {item.modified ? new Date(item.modified).toLocaleString('vi-VN') : '—'}
      </p>
    </div>
  );
}
