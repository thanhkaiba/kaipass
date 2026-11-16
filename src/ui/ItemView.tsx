import { useRef, useState } from 'react';
import type { Drive } from '../lib/drive';
import type { Item, Vault } from '../lib/vault';
import { Attachments } from './Attachments';
import { Avatar, CopyBtn, formatSize, Icon, IconButton, OtpCode, useToast } from './bits';
import { ShareDialog } from './Share';
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
          {secret && !show ? '••••••••••' : href ? <a href={href} target="_blank" rel="noopener noreferrer">{value}</a> : value}
        </div>
      </div>
      <div className="row-actions">
        {secret && (
          <IconButton
            icon={show ? 'eyeOff' : 'eye'}
            label={`${show ? 'Ẩn' : 'Hiện'} ${label}`}
            tip={show ? 'Ẩn' : 'Hiện'}
            onClick={() => setShow(!show)}
          />
        )}
        {href && (
          <a className="iconbtn" href={href} target="_blank" rel="noopener noreferrer" aria-label="Mở trang" data-tip="Mở trang">
            <Icon name="external" />
          </a>
        )}
        <CopyBtn value={value} secret={secret} what={label.toLowerCase()} />
      </div>
    </div>
  );
}

export function ItemView({
  item,
  vault,
  drive,
  change,
  onEdit,
  onBack,
  onFill,
}: {
  item: Item;
  vault: Vault;
  drive?: Drive;
  /** Runs a vault mutation, then saves and syncs. */
  change: (fn: () => void | Promise<void>) => Promise<void>;
  onEdit: () => void;
  onBack: () => void;
  /** Present in the extension popup when this item belongs to the page being viewed. */
  onFill?: () => void;
}) {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [sharing, setSharing] = useState(false);

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

  const hasMain = item.username || item.password || item.otp || item.url || item.fields.length > 0;

  return (
    <div className="detail">
      <header className="detail-head">
        <IconButton icon="back" label="Quay lại danh sách" className="only-narrow" onClick={onBack} />
        <Avatar title={item.title} icon={item.type} url={item.url} size={48} />
        <div className="detail-title">
          <h2>{item.title || '(không tên)'}</h2>
          <div className="detail-meta">
            <span className="tag">
              <Icon name={item.type} size={13} /> {TYPE_LABEL[item.type]}
            </span>
            {item.folderName && (
              <span className="tag">
                <Icon name="folder" size={13} /> {item.folderName}
              </span>
            )}
          </div>
        </div>
        <div className="actions">
          {item.trashed ? (
            <>
              <button type="button" onClick={() => change(() => vault.restore(item.id))}>
                <Icon name="restore" /> Khôi phục
              </button>
              <IconButton
                icon="trash"
                tone="danger"
                label="Xoá hẳn"
                onClick={() =>
                  window.confirm(`Xoá hẳn "${item.title}"? Không khôi phục được.`) && void change(() => vault.remove(item.id))
                }
              />
            </>
          ) : (
            <>
              <IconButton
                icon="star"
                label="Yêu thích"
                tip={item.favorite ? 'Bỏ yêu thích' : 'Yêu thích'}
                tone={item.favorite ? 'star' : undefined}
                filled={item.favorite}
                pressed={item.favorite}
                onClick={() => void change(() => vault.setFavorite(item.id, !item.favorite))}
              />
              <IconButton icon="share" label="Chia sẻ" onClick={() => setSharing(true)} />
              <IconButton
                icon="trash"
                tone="danger"
                label="Chuyển vào thùng rác"
                onClick={() => void change(() => vault.remove(item.id)).then(() => toast('Đã chuyển vào thùng rác'))}
              />
              {onFill ? (
                <>
                  <IconButton icon="edit" label="Sửa" onClick={onEdit} />
                  <button type="button" className="primary" onClick={onFill}>
                    Điền vào trang
                  </button>
                </>
              ) : (
                <button type="button" className="primary" onClick={onEdit} aria-label="Sửa" data-tip="Sửa">
                  <Icon name="edit" />
                  <span className="hide-narrow">Sửa</span>
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {hasMain && (
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
          {item.otp && <Row label="Mã bí mật OTP" value={item.otp} secret />}
        </section>
      )}

      {item.notes && (
        <section className="card">
          <div className="row">
            <div className="row-main">
              <div className="row-label">Ghi chú</div>
              <div className="row-value notes">{item.notes}</div>
            </div>
            <div className="row-actions">
              <CopyBtn value={item.notes} what="ghi chú" />
            </div>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-title">
          <h3>File đính kèm</h3>
          {item.attachments.length > 0 && <span className="count">{item.attachments.length}</span>}
          {!item.trashed && <IconButton icon="clip" label="Đính kèm file" onClick={() => fileInput.current?.click()} />}
          <input ref={fileInput} type="file" multiple hidden data-testid="attach-input" onChange={(e) => void attach(e.target.files)} />
        </div>
        {item.attachments.length === 0 && (
          <button type="button" className="dropzone" onClick={() => fileInput.current?.click()} disabled={item.trashed}>
            <Icon name="upload" /> Thêm file
          </button>
        )}
        <Attachments
          item={item}
          vault={vault}
          onRemove={(name) => window.confirm(`Gỡ file "${name}"?`) && void change(() => vault.removeAttachment(item.id, name))}
        />
      </section>

      {item.tags.length > 0 && (
        <div className="tags">
          {item.tags.map((t) => (
            <span className="tag" key={t}>
              # {t}
            </span>
          ))}
        </div>
      )}
      <p className="meta-foot">
        <Icon name="clock" />
        {item.modified ? new Date(item.modified).toLocaleString('vi-VN') : '—'}
      </p>
      {sharing && <ShareDialog item={item} drive={drive} onClose={() => setSharing(false)} />}
    </div>
  );
}
