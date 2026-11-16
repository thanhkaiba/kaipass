import { useEffect, useRef, useState } from 'react';
import type { ItemDraft, Vault } from '../lib/vault';
import { Avatar, errorText, Icon, InfoTip, Modal, SecretInput } from './bits';
import { TYPE_LABEL } from './types';

type Ai = typeof import('../lib/ai');
type Img = { mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; url: string };

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
const MAX_IMAGE = 5 * 1024 * 1024;

async function toImage(file: Blob): Promise<Img> {
  if (!IMAGE_TYPES.includes(file.type as Img['mediaType'])) throw new Error('Chỉ nhận ảnh PNG, JPEG, WebP hoặc GIF');
  if (file.size > MAX_IMAGE) throw new Error('Ảnh quá lớn (tối đa 5 MB)');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mediaType: file.type as Img['mediaType'], data: btoa(s), url: URL.createObjectURL(file) };
}

/**
 * Paste what someone sent (text and/or screenshots), let Claude split it into items, review, save.
 * Nothing is saved without the user looking at it first.
 */
export function AiPasteDialog({
  vault,
  onSaveKey,
  onEdit,
  onAddAll,
  onClose,
}: {
  vault: Vault;
  onSaveKey: (key: string) => Promise<void>;
  /** One item, or the user wants to check one: open it in the editor. */
  onEdit: (draft: ItemDraft) => void;
  onAddAll: (drafts: ItemDraft[]) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<Img[]>([]);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [found, setFound] = useState<ItemDraft[] | null>(null);
  const [picked, setPicked] = useState<boolean[]>([]);
  const ai = useRef<Promise<Ai>>(undefined);
  const hasKey = !!vault.getSetting('anthropicKey');
  const model = vault.getSetting('aiModel') || 'claude-opus-5-5';

  // The SDK is only downloaded when this dialog is used.
  const load = () => (ai.current ??= import('../lib/ai'));

  useEffect(() => {
    void load();
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.items ?? [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()!);
      if (!files.length) return;
      e.preventDefault();
      void Promise.all(files.map(toImage)).then((imgs) => setImages((cur) => [...cur, ...imgs]), (err) => setError(errorText(err)));
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  useEffect(() => () => images.forEach((i) => URL.revokeObjectURL(i.url)), [images]);

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const { extractItems } = await load();
      if (!hasKey) {
        const { checkKey } = await load();
        await checkKey(key.trim());
        await onSaveKey(key.trim());
      }
      const drafts = await extractItems({
        apiKey: vault.getSetting('anthropicKey') || key.trim(),
        model,
        text,
        images: images.map(({ mediaType, data }) => ({ mediaType, data })),
      });
      if (drafts.length === 0) throw new Error('Không thấy tài khoản hay thông tin bí mật nào trong nội dung này');
      if (drafts.length === 1) {
        onEdit(drafts[0]);
        return;
      }
      setFound(drafts);
      setPicked(drafts.map(() => true));
      setText('');
      setImages([]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const count = picked.filter(Boolean).length;

  return (
    <Modal title="Dán tin nhắn" icon="sparkle" onClose={onClose}>
      {found ? (
        <div className="stack">
          <p className="muted small">Claude tìm thấy {found.length} mục. Kiểm tra trước khi thêm.</p>
          <div className="group">
            {found.map((d, i) => (
              <div className="row ai-row" key={i}>
                <input
                  type="checkbox"
                  aria-label={`Chọn ${d.title}`}
                  checked={picked[i]}
                  onChange={(e) => setPicked(picked.map((p, j) => (j === i ? e.target.checked : p)))}
                />
                <Avatar title={d.title} icon={d.type} size={34} />
                <div className="row-main">
                  <div className="row-value">
                    <strong>{d.title}</strong>
                  </div>
                  <div className="pill-row">
                    <span className="tag">{TYPE_LABEL[d.type]}</span>
                    {d.username && <span className="tag">{d.username}</span>}
                    {d.password && (
                      <span className="tag">
                        <Icon name="lock" size={12} /> mật khẩu
                      </span>
                    )}
                    {d.otp && (
                      <span className="tag">
                        <Icon name="clock" size={12} /> OTP
                      </span>
                    )}
                    {d.fields.length > 0 && <span className="tag">+{d.fields.length} trường</span>}
                  </div>
                </div>
                <button type="button" onClick={() => onEdit(d)} aria-label={`Sửa ${d.title}`} data-tip="Mở để sửa rồi lưu">
                  <Icon name="edit" />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="primary"
            disabled={!count || busy}
            onClick={() => {
              setBusy(true);
              void onAddAll(found.filter((_, i) => picked[i])).finally(() => setBusy(false));
            }}
          >
            <Icon name="plus" /> Thêm {count} mục
          </button>
        </div>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <div className="field">
            <div className="label-row">
              <label htmlFor="ai-text">Tin nhắn có thông tin tài khoản</label>
              <InfoTip text="Dán nguyên tin nhắn Slack, Zalo, email… Có thể dán cả ảnh chụp màn hình (Ctrl/⌘+V). Claude tách thành tên, tên đăng nhập, mật khẩu, OTP, địa chỉ web. Bạn xem lại trước khi lưu." />
            </div>
            <textarea
              id="ai-text"
              rows={7}
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'Ví dụ:\nacc AWS prod: theo / Abc@123456\nMFA secret: JBSWY3DPEHPK3PXP\nlink: https://123456789012.signin.aws.amazon.com/console'}
            />
          </div>
          {images.length > 0 && (
            <div className="thumbs ai-thumbs">
              {images.map((img, i) => (
                <div className="thumb" key={img.url}>
                  <img src={img.url} alt={`Ảnh dán ${i + 1}`} />
                  <button type="button" className="iconbtn thumb-x" aria-label="Bỏ ảnh" onClick={() => setImages(images.filter((_, j) => j !== i))}>
                    <Icon name="x" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {!hasKey && (
            <SecretInput
              label="Claude API key"
              hint="Lấy ở console.anthropic.com → API Keys. Key được lưu trong vault (đã mã hoá) và đồng bộ cùng vault."
              value={key}
              onChange={setKey}
              placeholder="sk-ant-…"
              mono
            />
          )}
          <p className="note">
            <Icon name="shield" />
            <span>Nội dung dán vào được gửi tới Claude (Anthropic) để tách thông tin. Chỉ gửi khi bạn bấm nút.</span>
          </p>
          {error && (
            <p className="error" role="alert">
              <Icon name="alert" />
              <span>{error}</span>
            </p>
          )}
          <button className="primary" disabled={busy || (!text.trim() && !images.length) || (!hasKey && !key.trim())}>
            <Icon name="sparkle" /> {busy ? 'Claude đang đọc…' : 'Tách bằng Claude'}
          </button>
        </form>
      )}
    </Modal>
  );
}
