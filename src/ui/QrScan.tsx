import { useEffect, useRef, useState } from 'react';
import { captureTab, currentTab, type PageTab } from '../ext/browser';
import { isPopup } from '../lib/platform';
import type { QrResult } from '../lib/qr';

const qrLib = () => import('../lib/qr');
import { errorText, Icon, Modal } from './bits';

/**
 * Adds a two-factor code from its QR code. Computers rarely have a camera pointed at the screen,
 * so the main ways in are: read the browser tab that shows the code (extension), paste a
 * screenshot, or pick an image file. The camera is offered when the device has one.
 */
export function QrScanDialog({
  onFound,
  onClose,
}: {
  onFound: (result: QrResult, page?: PageTab) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<PageTab | undefined>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [hasCamera, setHasCamera] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  const accept = async (text: string | null, page?: PageTab) => {
    if (!text) throw new Error('Không thấy mã QR. Hãy để mã QR hiện rõ, không bị che hay quá nhỏ.');
    const result = (await qrLib()).otpFromQrText(text);
    if (result.accounts.length === 0) throw new Error('Mã QR không có tài khoản nào dùng được');
    done.current = true;
    onFound(result, page);
  };

  const run = async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  };

  const fromBlob = (blob: Blob) => run('image', async () => accept(await (await qrLib()).readQrImage(blob)));

  useEffect(() => {
    currentTab().then(setTab, () => {});
    void navigator.mediaDevices
      ?.enumerateDevices?.()
      .then((d) => setHasCamera(!isPopup && d.some((x) => x.kind === 'videoinput')), () => {});
    // A screenshot pasted anywhere while this is open.
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      const blob = item?.getAsFile();
      if (blob) {
        e.preventDefault();
        void fromBlob(blob);
      } else {
        const text = e.clipboardData?.getData('text') ?? '';
        if (/^otpauth(-migration)?:\/\//i.test(text.trim())) {
          e.preventDefault();
          void run('image', () => accept(text));
        }
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live camera: look for a code a few times a second.
  useEffect(() => {
    if (!cameraOn) return;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let alive = true;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!alive || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        timer = setInterval(async () => {
          if (!video.current || done.current) return;
          const text = await (await qrLib()).readQrImage(video.current);
          if (text && !done.current) await accept(text).catch((e) => setError(errorText(e)));
        }, 350);
      } catch (e) {
        setError(`Không mở được camera: ${errorText(e)}`);
        setCameraOn(false);
      }
    })();
    return () => {
      alive = false;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOn]);

  return (
    <Modal title="Quét mã QR" icon="qr" onClose={onClose}>
      <div className="scan-options">
        {tab && (
          <button
            type="button"
            className="scan-option primary-option"
            disabled={!!busy}
            onClick={() => void run('tab', async () => accept(await (await qrLib()).readQrImage(await captureTab(tab)), tab))}
          >
            <Icon name="device" />
            <span>
              <strong>{busy === 'tab' ? 'Đang tìm…' : 'Quét trên trang đang mở'}</strong>
              <small>{tab.host}</small>
            </span>
          </button>
        )}
        <div
          className="paste-zone"
          tabIndex={0}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
            if (f) void fromBlob(f);
          }}
        >
          <Icon name="image" />
          <strong>Dán ảnh chụp màn hình</strong>
          <small>
            <kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'}</kbd> + <kbd>V</kbd> hoặc kéo ảnh vào đây
          </small>
        </div>
        <div className="scan-row">
          {!isPopup && (
            <>
              <input
                ref={file}
                type="file"
                accept="image/*"
                className="sr-only"
                aria-label="Chọn ảnh có mã QR"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void fromBlob(f);
                  e.target.value = '';
                }}
              />
              <button type="button" onClick={() => file.current?.click()} disabled={!!busy}>
                <Icon name="upload" /> Chọn ảnh
              </button>
            </>
          )}
          {hasCamera && (
            <button type="button" onClick={() => setCameraOn(!cameraOn)} aria-pressed={cameraOn}>
              <Icon name="camera" /> {cameraOn ? 'Tắt camera' : 'Camera'}
            </button>
          )}
        </div>
        {cameraOn && <video ref={video} className="scan-video" muted playsInline />}
      </div>
      {busy === 'image' && <p className="muted small">Đang đọc ảnh…</p>}
      {error && (
        <p className="error" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
    </Modal>
  );
}
