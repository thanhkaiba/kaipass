import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { defaultGen, generatePassword, type GenOptions } from '../lib/generator';
import { parseOtp, secondsLeft, totp } from '../lib/totp';
import { EMOJI, useIconPack } from './iconPack';

// ---- icons ----

const PATHS: Record<string, string> = {
  copy: 'M9 9h10v11H9zM5 15V4h10',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10.6 10.6 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 4M6.5 6.6C3.7 8.5 2 12 2 12s4 7 10 7a9.7 9.7 0 004.3-1',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z',
  plus: 'M12 5v14M5 12h14',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 017 0v3',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z',
  trash: 'M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM16 16l4.5 4.5',
  back: 'M15 5l-7 7 7 7',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  refresh: 'M20 12a8 8 0 11-2.6-5.9M20 4v4.5h-4.5',
  login: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  card: 'M3 6h18v12H3zM3 10h18M7 15h4',
  identity: 'M3 5h18v14H3zM8.5 10a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6zM14 10h4M14 14h4',
  note: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h7',
  folder: 'M3 6h6l2 2h10v11H3z',
  download: 'M12 4v11M7 10.5l5 5 5-5M5 20h14',
  upload: 'M12 16V5M7 9.5l5-5 5 5M5 20h14',
  clip: 'M20 11.5l-8 8a5 5 0 01-7-7l8.5-8.5a3.5 3.5 0 015 5L10 17.5a2 2 0 01-2.9-2.9l7.4-7.4',
  menu: 'M4 6h16M4 12h16M4 18h16',
  x: 'M6 6l12 12M18 6L6 18',
  all: 'M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z',
  dice: 'M5 5h14v14H5zM9 9h.01M15 9h.01M12 12h.01M9 15h.01M15 15h.01',
  restore: 'M4 12a8 8 0 102.6-5.9M4 4v4.5h4.5',
  finger: 'M12 11v3a6 6 0 01-1.5 4M8.5 8.5A5 5 0 0117 12v1.5M7 12a5 5 0 01.4-2M15 16.5a9 9 0 01-1 3.5M5 15.5c.6-1 1-2.2 1-3.5a6 6 0 013-5.2M12 4a8 8 0 018 8v1M9 19.5c1-1.3 1.7-3 2-4.5',
  share: 'M8.5 12a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM20.5 5.5a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM20.5 18.5a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM8.3 10.9l7.4-4.2M8.3 13.1l7.4 4.2',
  image: 'M4 5h16v14H4zM4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 18M15.5 9.5h.01',
  pdf: 'M6 3h9l4 4v14H6zM15 3v4h4M9 13h1.5a1.5 1.5 0 010 3H9v-3zm0 3v2M14 13v5M14 13h2.5M14 15.5h2',
  cloud: 'M7 18h10a4 4 0 00.5-8 6 6 0 00-11.4 1.5A3.3 3.3 0 007 18z',
  device: 'M4 5h16v11H4zM9 20h6M12 16v4',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z',
  key: 'M14.5 9.5a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM13.2 12.7L20 19.5M17 16.5l2-2M15 14.5l1.5-1.5',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8h.01',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  alert: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  sparkle: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2M14 18h2v2M18 18h2v2h-2zM7 7h.01M17 7h.01M7 17h.01',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 100-7 3.5 3.5 0 000 7z',
  puzzle: 'M10 4a2 2 0 014 0v2h4v4h-2a2 2 0 000 4h2v4h-4v-2a2 2 0 00-4 0v2H6v-4h2a2 2 0 000-4H6V6h4z',
};

export function Icon({ name, filled, size }: { name: string; filled?: boolean; size?: number }) {
  const pack = useIconPack();
  const style = size ? { width: size, height: size, fontSize: size * 0.9 } : undefined;
  if (pack.id === 'emoji' && EMOJI[name]) {
    return (
      <span className="icon icon-emoji" aria-hidden="true" style={style}>
        {EMOJI[name]}
      </span>
    );
  }
  const raw = pack.icons?.[name];
  if (raw) {
    // Markup from the icon packages bundled with the app, never from user data.
    return <span className={`icon icon-raw${filled ? ' filled' : ''}`} aria-hidden="true" style={style} dangerouslySetInnerHTML={{ __html: raw }} />;
  }
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The built-in drawing of an icon as SVG markup (used to preview it while another pack is on). */
export function defaultIconSvg(name: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${PATHS[name] ?? ''}"/></svg>`;
}

/** An icon-only button. Its label is announced to screen readers and shown as a tooltip. */
export function IconButton({
  icon,
  label,
  onClick,
  tone,
  filled,
  pressed,
  disabled,
  tip = label,
  className = '',
}: {
  icon: string;
  label: string;
  onClick?: () => void;
  tone?: 'danger' | 'accent' | 'star';
  filled?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  tip?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`iconbtn${tone ? ` tone-${tone}` : ''}${className ? ` ${className}` : ''}`}
      aria-label={label}
      aria-pressed={pressed}
      data-tip={tip}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={icon} filled={filled} />
    </button>
  );
}

/** A small ⓘ that shows an explanation on hover or focus, instead of a paragraph of text. */
export function InfoTip({ text }: { text: string }) {
  return (
    <span className="infotip" tabIndex={0} data-tip={text}>
      <Icon name="info" />
      <span className="sr-only">{text}</span>
    </span>
  );
}

// ---- tooltips ----

/**
 * One floating tooltip for the whole app. Any element with `data-tip` gets it on hover or keyboard
 * focus. It lives at the top level so scrolling panels and dialogs never clip it.
 */
function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; below: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const current = useRef<Element | null>(null);

  useEffect(() => {
    const show = (el: Element) => {
      const text = el.getAttribute('data-tip');
      if (!text) return;
      current.current = el;
      const r = el.getBoundingClientRect();
      const below = r.top < 48;
      setTip({ text, x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below });
    };
    const hide = () => {
      current.current = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = (e.target as Element | null)?.closest?.('[data-tip]');
      if (el && el !== current.current) show(el);
      else if (!el && current.current) hide();
    };
    const focus = (e: FocusEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-tip]');
      if (el && (e.target as Element).matches(':focus-visible')) show(el);
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide);
    window.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('pointerover', over);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('pointerdown', hide);
      window.removeEventListener('scroll', hide, true);
    };
  }, []);

  // Keep the bubble inside the window.
  useEffect(() => {
    const el = box.current;
    if (!el || !tip) return;
    const w = el.offsetWidth;
    const left = Math.max(8, Math.min(tip.x - w / 2, innerWidth - w - 8));
    el.style.left = `${left}px`;
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={box}
      className={`tooltip${tip.below ? ' below' : ''}`}
      role="tooltip"
      style={{ top: tip.y, left: tip.x }}
    >
      {tip.text}
    </div>
  );
}

// ---- toast ----

const ToastCtx = createContext<(msg: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((m: string) => {
    setMsg(m);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(''), 3000);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <TooltipLayer />
      {msg && (
        <div className="toast" role="status">
          <Icon name="check" />
          <span>{msg}</span>
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ---- clipboard ----

let clearTimer: ReturnType<typeof setTimeout> | undefined;

export async function copyText(text: string, secret: boolean): Promise<void> {
  await navigator.clipboard.writeText(text);
  clearTimeout(clearTimer);
  if (secret) {
    // Best effort: browsers only allow this while the app still has focus.
    clearTimer = setTimeout(() => void navigator.clipboard.writeText('').catch(() => {}), 30_000);
  }
}

export function CopyBtn({ value, secret, what }: { value: string; secret?: boolean; what: string }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`iconbtn${done ? ' tone-ok' : ''}`}
      aria-label={`Copy ${what}`}
      data-tip={secret ? `Copy ${what} · tự xoá sau 30 giây` : `Copy ${what}`}
      onClick={() =>
        copyText(value, !!secret).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
            toast(`Đã copy ${what}`);
          },
          () => toast('Trình duyệt không cho copy'),
        )
      }
    >
      <Icon name={done ? 'check' : 'copy'} />
    </button>
  );
}

// ---- dialogs and inputs ----

export function Modal({
  title,
  icon,
  onClose,
  children,
  wide,
}: {
  title: string;
  icon?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          {icon && (
            <span className="modal-icon">
              <Icon name={icon} />
            </span>
          )}
          <h2>{title}</h2>
          <IconButton icon="x" label="Đóng" onClick={onClose} />
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function Label({ id, label, hint, hidden }: { id: string; label: string; hint?: string; hidden?: boolean }) {
  return (
    <div className={hidden ? 'sr-only' : 'label-row'}>
      <label htmlFor={id}>{label}</label>
      {hint && !hidden && <InfoTip text={hint} />}
    </div>
  );
}

export function SecretInput(props: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  hint?: string;
  /** Keep the label for screen readers only; show the placeholder instead. */
  hideLabel?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  autoComplete?: string;
  mono?: boolean;
  extra?: ReactNode;
}) {
  const [show, setShow] = useState(false);
  const id = useId();
  return (
    <div className="field">
      <Label id={id} label={props.label} hint={props.hint} hidden={props.hideLabel} />
      <div className="input-wrap">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          className={props.mono ? 'mono' : undefined}
          value={props.value}
          placeholder={props.placeholder}
          autoFocus={props.autoFocus}
          autoComplete={props.autoComplete ?? 'off'}
          autoCapitalize="off"
          spellCheck={false}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <div className="input-actions">
          <IconButton icon={show ? 'eyeOff' : 'eye'} label={show ? 'Ẩn' : 'Hiện'} onClick={() => setShow(!show)} />
          {props.extra}
        </div>
      </div>
    </div>
  );
}

export function TextInput(props: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  hint?: string;
  hideLabel?: boolean;
  type?: string;
  autoFocus?: boolean;
  placeholder?: string;
  mono?: boolean;
}) {
  const id = useId();
  return (
    <div className="field">
      <Label id={id} label={props.label} hint={props.hint} hidden={props.hideLabel} />
      <input
        id={id}
        type={props.type ?? 'text'}
        className={props.mono ? 'mono' : undefined}
        value={props.value}
        autoFocus={props.autoFocus}
        placeholder={props.placeholder}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  );
}

/** Asks for the master password again before a sensitive change. */
export function PasswordPrompt({
  title,
  icon,
  action,
  check,
  onDone,
  onClose,
}: {
  title: string;
  icon?: string;
  action: string;
  /** Throws with a message when the password is wrong or the work fails. */
  check: (password: string) => Promise<void>;
  onDone?: () => void;
  onClose: () => void;
}) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title={title} icon={icon} onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await check(pw);
            onDone?.();
          } catch (err) {
            setError(errorText(err));
            setBusy(false);
          }
        }}
      >
        <SecretInput label="Xác nhận master password" value={pw} onChange={setPw} autoFocus autoComplete="current-password" />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy || !pw}>
          {busy ? 'Đang xử lý…' : action}
        </button>
      </form>
    </Modal>
  );
}

// ---- avatars ----

const HUES = [214, 262, 330, 12, 34, 152, 188, 290];

/** A coloured tile with the item's first letter, so lists are easy to scan. */
export function Avatar({ title, icon, size = 36 }: { title: string; icon: string; size?: number }) {
  const letter = (title.trim()[0] ?? '').toUpperCase();
  let h = 0;
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = HUES[h % HUES.length];
  return (
    <span className="avatar" style={{ width: size, height: size, ['--hue' as string]: hue }} aria-hidden="true">
      {letter && /[\p{L}\p{N}]/u.test(letter) ? letter : <Icon name={icon} />}
    </span>
  );
}

// ---- one-time codes ----

export function OtpCode({ uri }: { uri: string }) {
  const [state, setState] = useState<{ code: string; left: number; period: number } | { error: string }>({
    code: '······',
    left: 30,
    period: 30,
  });
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const cfg = parseOtp(uri);
        const code = await totp(cfg);
        if (alive) setState({ code, left: secondsLeft(cfg), period: cfg.period });
      } catch (e) {
        if (alive) setState({ error: e instanceof Error ? e.message : 'OTP lỗi' });
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [uri]);
  if ('error' in state) return <span className="muted">{state.error}</span>;
  const pretty = state.code.replace(/^(.{3})(.+)$/, '$1 $2');
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <span className="otp">
      <span className="mono otp-code" data-testid="otp-code">
        {pretty}
      </span>
      <span className={`otp-ring${state.left <= 5 ? ' low' : ''}`} data-tip={`Còn ${state.left} giây`}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r={r} className="track" />
          <circle cx="12" cy="12" r={r} className="bar" strokeDasharray={c} strokeDashoffset={c * (1 - state.left / state.period)} />
        </svg>
        <span>{state.left}</span>
      </span>
      <CopyBtn value={state.code} what="mã OTP" />
    </span>
  );
}

// ---- generator ----

export function Generator({ onUse }: { onUse: (password: string) => void }) {
  const [opts, setOpts] = useState<GenOptions>(defaultGen);
  const [value, setValue] = useState(() => generatePassword(defaultGen));
  const update = (patch: Partial<GenOptions>) => {
    const next = { ...opts, ...patch };
    setOpts(next);
    setValue(generatePassword(next));
  };
  const toggles: [keyof GenOptions, string, string][] = [
    ['upper', 'A-Z', 'Chữ hoa'],
    ['lower', 'a-z', 'Chữ thường'],
    ['digits', '0-9', 'Số'],
    ['symbols', '!@#', 'Ký tự đặc biệt'],
  ];
  return (
    <div className="generator">
      <div className="gen-top">
        <div className="gen-value mono" data-testid="gen-value">
          {value}
        </div>
        <IconButton icon="refresh" label="Tạo lại" onClick={() => setValue(generatePassword(opts))} />
        <CopyBtn value={value} secret what="mật khẩu" />
      </div>
      <div className="gen-row">
        <label className="gen-length" data-tip="Độ dài">
          <span className="mono">{opts.length}</span>
          <input
            type="range"
            min={8}
            max={64}
            value={opts.length}
            aria-label="Độ dài"
            onChange={(e) => update({ length: Number(e.target.value) })}
          />
        </label>
        <div className="chips">
          {toggles.map(([key, label, tip]) => (
            <button
              type="button"
              key={key}
              className={`chip${opts[key] ? ' on' : ''}`}
              aria-pressed={opts[key] as boolean}
              aria-label={tip}
              data-tip={tip}
              onClick={() => update({ [key]: !opts[key] })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <button type="button" className="primary" onClick={() => onUse(value)}>
        <Icon name="check" /> Dùng mật khẩu này
      </button>
    </div>
  );
}

// ---- misc ----

export function downloadBytes(name: string, bytes: BlobPart, mime = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** What we require of a master password; returns a complaint or ''. */
export function passwordProblem(pw: string, confirm: string): string {
  if (pw.length < 10) return 'Master password cần ít nhất 10 ký tự';
  if (pw !== confirm) return 'Hai lần nhập không khớp';
  return '';
}

export function Brand({ small }: { small?: boolean }) {
  return (
    <div className={`brand${small ? ' small' : ''}`}>
      <img src="./icon.svg" alt="" />
      <span>KaiPass</span>
    </div>
  );
}
