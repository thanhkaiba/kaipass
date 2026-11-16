import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Item, Vault } from '../lib/vault';
import { downloadBytes, formatSize, Icon, IconButton, Modal } from './bits';

type Kind = 'image' | 'pdf' | 'text';

const IMAGE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};
const TEXT = new Set(['txt', 'md', 'csv', 'json', 'log', 'xml', 'yml', 'yaml', 'pem', 'key', 'pub', 'asc', 'ini', 'conf', 'env']);
const TEXT_LIMIT = 512 * 1024;

function ext(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** What we can show inside the app; null means download only. */
export function previewKind(name: string): Kind | null {
  const e = ext(name);
  if (IMAGE[e]) return 'image';
  if (e === 'pdf') return 'pdf';
  if (TEXT.has(e)) return 'text';
  return null;
}

function mime(name: string): string {
  const e = ext(name);
  return IMAGE[e] ?? (e === 'pdf' ? 'application/pdf' : 'application/octet-stream');
}

/**
 * Object URLs for the decrypted bytes of an item's images and PDFs, revoked when the item changes
 * or the view closes, so decrypted files do not linger in memory.
 */
function useFileUrls(item: Item, vault: Vault): Map<string, string> {
  const key = item.attachments.map((a) => `${a.name}:${a.size}`).join('|');
  const urls = useMemo(() => {
    const out = new Map<string, string>();
    for (const a of item.attachments) {
      const kind = previewKind(a.name);
      if (kind !== 'image' && kind !== 'pdf') continue;
      const data = vault.attachment(item.id, a.name);
      if (data) out.set(a.name, URL.createObjectURL(new Blob([data as BlobPart], { type: mime(a.name) })));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, key, vault]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  return urls;
}

function Viewer({
  item,
  vault,
  urls,
  names,
  start,
  onClose,
}: {
  item: Item;
  vault: Vault;
  urls: Map<string, string>;
  names: string[];
  start: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(start);
  const name = names[index];
  const kind = previewKind(name);
  const step = useCallback(
    (by: number) => setIndex((i) => (i + by + names.length) % names.length),
    [names.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  const text = useMemo(() => {
    if (kind !== 'text') return '';
    const data = vault.attachment(item.id, name);
    if (!data) return '';
    const shown = data.byteLength > TEXT_LIMIT ? data.subarray(0, TEXT_LIMIT) : data;
    return new TextDecoder().decode(shown) + (data.byteLength > TEXT_LIMIT ? '\n\n… (file dài, chỉ hiện phần đầu)' : '');
  }, [kind, vault, item.id, name]);

  const download = () => {
    const data = vault.attachment(item.id, name);
    if (data) downloadBytes(name, data as BlobPart, mime(name));
  };

  return (
    <Modal title={name} icon={kind === 'pdf' ? 'pdf' : kind === 'image' ? 'image' : 'note'} onClose={onClose} wide>
      <div className="viewer" data-testid="viewer">
        {kind === 'image' && <img src={urls.get(name)} alt={name} data-testid="viewer-image" />}
        {kind === 'pdf' && (
          <iframe src={urls.get(name)} title={name} data-testid="viewer-pdf" />
        )}
        {kind === 'text' && <pre className="mono">{text}</pre>}
      </div>
      <div className="viewer-bar">
        {names.length > 1 && (
          <>
            <IconButton icon="back" label="File trước" onClick={() => step(-1)} />
            <span className="muted small">
              {index + 1} / {names.length}
            </span>
            <IconButton icon="back" label="File sau" className="flip" onClick={() => step(1)} />
          </>
        )}
        <span className="grow" />
        {kind === 'pdf' && (
          <a className="iconbtn" href={urls.get(name)} target="_blank" rel="noopener" data-tip="Mở trong tab mới" aria-label="Mở trong tab mới">
            <Icon name="external" />
          </a>
        )}
        <IconButton icon="download" label="Tải về" onClick={download} />
      </div>
    </Modal>
  );
}

export function Attachments({
  item,
  vault,
  onRemove,
}: {
  item: Item;
  vault: Vault;
  onRemove: (name: string) => void;
}) {
  const urls = useFileUrls(item, vault);
  const viewable = item.attachments.map((a) => a.name).filter((n) => previewKind(n));
  const images = item.attachments.filter((a) => previewKind(a.name) === 'image' && urls.has(a.name));
  const [open, setOpen] = useState<number | null>(null);
  const show = (name: string) => setOpen(viewable.indexOf(name));

  return (
    <>
      {images.length > 0 && (
        <div className="thumbs">
          {images.map((a) => (
            <button
              type="button"
              key={a.name}
              className="thumb"
              onClick={() => show(a.name)}
              title={a.name}
              aria-label={`Xem ${a.name}`}
            >
              <img src={urls.get(a.name)} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {item.attachments.map((a) => {
        const kind = previewKind(a.name);
        return (
          <div className="row" key={a.name}>
            <span className="file-icon">
              <Icon name={kind === 'image' ? 'image' : kind === 'pdf' ? 'pdf' : 'note'} />
            </span>
            <div className="row-main">
              {kind ? (
                <button type="button" className="link file-name" onClick={() => show(a.name)}>
                  {a.name}
                </button>
              ) : (
                <div className="row-value">{a.name}</div>
              )}
              <div className="muted small">{formatSize(a.size)}</div>
            </div>
            <div className="row-actions">
              <IconButton
                icon="download"
                label={`Tải ${a.name}`}
                tip="Tải về"
                onClick={() => {
                  const data = vault.attachment(item.id, a.name);
                  if (data) downloadBytes(a.name, data as BlobPart, mime(a.name));
                }}
              />
              {!item.trashed && <IconButton icon="x" tone="danger" label={`Gỡ ${a.name}`} tip="Gỡ file" onClick={() => onRemove(a.name)} />}
            </div>
          </div>
        );
      })}
      {open !== null && open >= 0 && (
        <Viewer item={item} vault={vault} urls={urls} names={viewable} start={open} onClose={() => setOpen(null)} />
      )}
    </>
  );
}
