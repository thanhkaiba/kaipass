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

// ---- icons ----

const PATHS: Record<string, string> = {
  copy: 'M9 9h10v11H9zM5 15V4h10',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10.6 10.6 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 4M6.5 6.6C3.7 8.5 2 12 2 12s4 7 10 7a9.7 9.7 0 004.3-1',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z',
  plus: 'M12 5v14M5 12h14',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 017 0v3',
  settings: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 4.5v5M8 14.5v5',
  trash: 'M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM16 16l4.5 4.5',
  back: 'M15 5l-7 7 7 7',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  refresh: 'M20 12a8 8 0 11-2.6-5.9M20 4v4.5h-4.5',
  login: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.500 5.600 12 3z',
  card: 'M3 6h18v12H3zM3 10h18M7 15h4',
  identity: 'M3 5h18v14H3zM8.500 10a1.800 1.800 0 100 3.600 1.800 1.800 0 000-3.600zM14 10h4M14 14h4',
  note: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h7',
  folder: 'M3 6h6l2 2h10v11H3z',
  download: 'M12 4v11M7 10.500l5 5 5-5M5 20h14',
  clip: 'M20 11.500l-8 8a5 5 0 01-7-7l8.500-8.500a3.500 3.500 0 015 5L10 17.500a2 2 0 01-2.900-2.900l7.400-7.400',
  menu: 'M4 6h16M4 12h16M4 18h16',
  x: 'M6 6l12 12M18 6L6 18',
  all: 'M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z',
  dice: 'M5 5h14v14H5zM9 9h.01M15 9h.01M12 12h.01M9 15h.01M15 15h.01',
  restore: 'M4 12a8 8 0 102.600-5.900M4 4v4.500h4.500',
  image: 'M4 5h16v14H4zM4 16l4.500-4.500 3.500 3.500 2.500-2.500L20 18M15.500 9.500h.010',
  pdf: 'M6 3h9l4 4v14H6zM15 3v4h4M9 13h1.500a1.500 1.500 0 010 3H9v-3zm0 3v2M14 13v5M14 13h2.500M14 15.500h2',
};

export function Icon({ name, filled }: { name: string; filled?: boolean }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
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

// ---- toast ----

const ToastCtx = createContext<(msg: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((m: string) => {
    setMsg(m);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(''), 3500);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && (
        <div className="toast" role="status">
          {msg}
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
  return (
    <button
      type="button"
      className="iconbtn"
      title={`Copy ${what}`}
      aria-label={`Copy ${what}`}
      onClick={() =>
        copyText(value, !!secret).then(
          () => toast(secret ? `Đã copy ${what} (tự xoá sau 30 giây)` : `Đã copy ${what}`),
          () => toast('Trình duyệt không cho copy'),
        )
      }
    >
      <Icon name="copy" />
    </button>
  );
}

// ---- form pieces ----

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
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
          <h2>{title}</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Đóng">
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function SecretInput(props: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  autoFocus?: boolean;
  autoComplete?: string;
  mono?: boolean;
  extra?: ReactNode;
}) {
  const [show, setShow] = useState(false);
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <div className="inputrow">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          className={props.mono ? 'mono' : undefined}
          value={props.value}
          autoFocus={props.autoFocus}
          autoComplete={props.autoComplete ?? 'off'}
          autoCapitalize="off"
          spellCheck={false}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <button
          type="button"
          className="iconbtn"
          onClick={() => setShow(!show)}
          aria-label={show ? 'Ẩn' : 'Hiện'}
          title={show ? 'Ẩn' : 'Hiện'}
        >
          <Icon name={show ? 'eyeOff' : 'eye'} />
        </button>
        {props.extra}
      </div>
    </div>
  );
}

export function TextInput(props: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  type?: string;
  autoFocus?: boolean;
  placeholder?: string;
  mono?: boolean;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
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
  return (
    <span className="otp">
      <span className="mono otp-code" data-testid="otp-code">
        {pretty}
      </span>
      <span className={`otp-left${state.left <= 5 ? ' low' : ''}`} title="Số giây còn lại">
        {state.left}s
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
  const toggles: [keyof GenOptions, string][] = [
    ['upper', 'A-Z'],
    ['lower', 'a-z'],
    ['digits', '0-9'],
    ['symbols', '!@#'],
  ];
  return (
    <div className="generator">
      <div className="gen-value mono" data-testid="gen-value">
        {value}
      </div>
      <div className="gen-row">
        <label>
          Độ dài {opts.length}
          <input
            type="range"
            min={8}
            max={64}
            value={opts.length}
            onChange={(e) => update({ length: Number(e.target.value) })}
          />
        </label>
        {toggles.map(([key, label]) => (
          <label key={key} className="check">
            <input
              type="checkbox"
              checked={opts[key] as boolean}
              onChange={(e) => update({ [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
      </div>
      <div className="actions">
        <button type="button" onClick={() => setValue(generatePassword(opts))}>
          <Icon name="refresh" /> Tạo lại
        </button>
        <CopyBtn value={value} secret what="mật khẩu" />
        <button type="button" className="primary" onClick={() => onUse(value)}>
          Dùng mật khẩu này
        </button>
      </div>
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
