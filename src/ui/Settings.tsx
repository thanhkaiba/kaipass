import { useEffect, useRef, useState, type ReactNode } from 'react';
import { openInTab, remember } from '../ext/browser';
import { defaultInlinePrefs, INLINE_PREFS_KEY, type InlinePrefs } from '../ext/match';
import { bioEnrolled, bioSupported, disableBio, enrollBio } from '../lib/bio';
import { Drive, preloadGoogle } from '../lib/drive';
import { importOnePux, type ImportResult } from '../lib/onepux';
import { isExtension, isPopup } from '../lib/platform';
import { autoLockMinutes, setAutoLockMinutes } from '../lib/prefs';
import { recoveryEnabled, removeRecovery, resealRecovery, setUpRecovery } from '../lib/recovery';
const kitLib = () => import('../lib/recoveryKit');
import { type Session } from '../lib/session';
import {
  CopyBtn,
  downloadBytes,
  errorText,
  Icon,
  IconButton,
  InfoTip,
  passwordProblem,
  PasswordPrompt,
  SecretInput,
  TextInput,
  useToast,
} from './bits';
import { WipeSection } from './Forgot';
import { LookSettings } from './Look';
import { needsClientId, RedirectHint, rememberClientId, savedClientId } from './Setup';

export type Tab = 'security' | 'data' | 'web' | 'ai' | 'look' | 'device';

function Setting({
  icon,
  on,
  title,
  info,
  sub,
  children,
}: {
  icon: string;
  on?: boolean;
  title: string;
  info?: string;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="setting">
      <span className={`setting-icon${on ? ' on' : ''}`}>
        <Icon name={icon} />
      </span>
      <div className="setting-text">
        <strong>
          {title}
          {info && <InfoTip text={info} />}
        </strong>
        {sub && <div className="small">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function Switch({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Settings({
  session,
  onClose,
  onReplace,
  initialTab = 'security',
}: {
  session: Session;
  onClose: () => void;
  onReplace: (s: Session) => void;
  initialTab?: Tab;
}) {
  const toast = useToast();
  const { vault, meta } = session;
  const [tab, setTab] = useState<Tab>(initialTab);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [clientId, setClientId] = useState(savedClientId);
  const [changing, setChanging] = useState(false);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [lockMin, setLockMin] = useState(autoLockMinutes);
  const [inline, setInline] = useState<InlinePrefs>(defaultInlinePrefs);
  const [bio, setBio] = useState(false);
  const [bioOk, setBioOk] = useState(false);
  const [hasRecovery, setHasRecovery] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [keptKey, setKeptKey] = useState(false);
  const [prompt, setPrompt] = useState<'bio' | 'recovery' | null>(null);
  /** Whether Chrome's own password manager still offers to save passwords (undefined: unknown). */
  const [chromeSaves, setChromeSaves] = useState<boolean | undefined>();
  const pux = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void bioSupported().then(setBioOk);
    void bioEnrolled().then(setBio);
    void recoveryEnabled().then(setHasRecovery);
    if (isExtension) {
      void chrome.permissions.contains({ permissions: ['privacy'] }).then(async (has) => {
        if (!has) return setChromeSaves(true);
        const s = await chrome.privacy.services.passwordSavingEnabled.get({});
        setChromeSaves(s.value !== false);
      });
      void chrome.storage.local
        .get(INLINE_PREFS_KEY)
        .then((r) => setInline({ ...defaultInlinePrefs, ...(r[INLINE_PREFS_KEY] as Partial<InlinePrefs> | undefined) }));
    }
  }, []);

  useEffect(() => {
    if (meta.mode === 'local' && !isExtension) preloadGoogle().catch(() => {});
  }, [meta.mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !prompt && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, prompt]);

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

  const setInlinePref = (patch: Partial<InlinePrefs>) => {
    const next = { ...inline, ...patch };
    setInline(next);
    void chrome.storage.local.set({ [INLINE_PREFS_KEY]: next });
  };

  const importFile = (file: File | undefined) => {
    if (!file) return;
    void run('import', async () => {
      const result = await importOnePux(vault, new Uint8Array(await file.arrayBuffer()));
      await session.commit();
      setImported(result);
    });
  };

  const exportFile = () =>
    run('export', async () => {
      const day = new Date().toISOString().slice(0, 10);
      downloadBytes(`kaipass-${day}.kdbx`, await vault.save());
    });

  const connectDrive = () => {
    const id = clientId.trim();
    if (!id) return setError('Cần nhập Google OAuth Client ID');
    void run('drive', async () => {
      const drive = new Drive(id);
      await drive.signIn();
      rememberClientId(id);
      const next = await session.moveToDrive(drive);
      toast('Đã chuyển vault lên Google Drive');
      onClose();
      onReplace(next);
    });
  };

  const changePassword = () =>
    run('password', async () => {
      if (!(await vault.checkPassword(oldPw))) throw new Error('Master password hiện tại không đúng');
      const problem = passwordProblem(newPw, confirm);
      if (problem) throw new Error(problem);
      await vault.changePassword(newPw);
      await session.commit();
      await remember(newPw, autoLockMinutes());
      await resealRecovery(newPw, session.drive);
      if (bio) {
        await disableBio();
        setBio(false);
      }
      setOldPw('');
      setNewPw('');
      setConfirm('');
      setChanging(false);
      toast(bio ? 'Đã đổi master password. Hãy bật lại vân tay.' : 'Đã đổi master password');
    });

  const [kitName, setKitName] = useState('');
  const saveKit = async (key: string) => {
    const kit = await kitLib();
    setKitName(kit.kitFileName());
    downloadBytes(kit.kitFileName(), await kit.buildKit(key), 'text/html');
  };
  const printKit = async (key: string) => {
    const url = URL.createObjectURL(new Blob([await (await kitLib()).buildKit(key)], { type: 'text/html' }));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const checked = async (pw: string) => {
    if (!(await vault.checkPassword(pw))) throw new Error('Master password không đúng');
    return pw;
  };

  /** Asks Chrome to stop offering to save passwords, so only KaiPass asks. */
  const setChromeSaving = (offer: boolean) =>
    run('chrome', async () => {
      // Must be asked for from the click itself, before anything else is awaited.
      const granted = await chrome.permissions.request({ permissions: ['privacy'] });
      if (!granted) throw new Error('Cần cho phép quyền "privacy" để đổi cài đặt này của Chrome');
      await chrome.privacy.services.passwordSavingEnabled.set({ value: offer });
      const s = await chrome.privacy.services.passwordSavingEnabled.get({});
      if (s.levelOfControl !== 'controlled_by_this_extension' && s.value !== offer) {
        throw new Error('Cài đặt này đang bị chính sách của máy hoặc extension khác khoá');
      }
      setChromeSaves(s.value !== false);
      toast(offer ? 'Chrome sẽ hỏi lưu mật khẩu như cũ' : 'Chrome sẽ không hỏi lưu mật khẩu nữa');
    });

  const tabs: [Tab, string, string][] = [
    ['security', 'shield', 'Bảo mật'],
    ['data', 'folder', 'Dữ liệu'],
    ...(isExtension ? ([['web', 'puzzle', 'Gợi ý trên web']] as [Tab, string, string][]) : []),
    ['ai', 'sparkle', 'Claude AI'],
    ['look', 'image', 'Giao diện'],
    ['device', 'device', 'Thiết bị'],
  ];

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal" role="dialog" aria-modal="true" aria-label="Cài đặt">
        <header>
          <span className="modal-icon">
            <Icon name="settings" />
          </span>
          <h2>Cài đặt</h2>
          <IconButton icon="x" label="Đóng" onClick={onClose} />
        </header>
        <div className="modal-body">
          <div className="settings">
            <nav className="settings-tabs" aria-label="Mục cài đặt">
              {tabs.map(([id, icon, label]) => (
                <button
                  type="button"
                  key={id}
                  className={`nav-item${tab === id ? ' active' : ''}`}
                  aria-current={tab === id}
                  onClick={() => {
                    setTab(id);
                    setError('');
                  }}
                >
                  <Icon name={icon} />
                  <span className="grow">{label}</span>
                </button>
              ))}
            </nav>

            <div className="settings-body">
              {error && (
                <p className="error" role="alert">
                  <Icon name="alert" />
                  <span>{error}</span>
                </p>
              )}

              {tab === 'security' && (
                <>
                  <div className="group">
                    <Setting
                      icon="finger"
                      on={bio}
                      title="Vân tay / mật khẩu máy"
                      info="Mở khoá bằng Touch ID, Windows Hello, vân tay điện thoại hoặc PIN của máy. Chỉ áp dụng cho thiết bị này."
                      sub={bio ? 'Đang bật' : bioOk ? 'Tắt' : 'Thiết bị không hỗ trợ'}
                    >
                      {isPopup && !bio ? (
                        <button type="button" onClick={openInTab} data-tip="Hộp vân tay sẽ làm cửa sổ nhỏ đóng lại">
                          Bật trong tab
                        </button>
                      ) : (
                        <Switch
                          label="Vân tay / mật khẩu máy"
                          checked={bio}
                          disabled={!bio && !bioOk}
                          onChange={(on) => {
                            if (on) setPrompt('bio');
                            else
                              void disableBio().then(() => {
                                setBio(false);
                                toast('Đã tắt mở khoá bằng vân tay');
                              });
                          }}
                        />
                      )}
                    </Setting>

                    <Setting
                      icon="key"
                      on={hasRecovery}
                      title="Khoá khôi phục"
                      info="Cách duy nhất để mở lại vault khi quên master password. Ai có khoá này và quyền vào Drive (hoặc thiết bị) của bạn sẽ mở được vault."
                      sub={hasRecovery ? 'Đã tạo' : 'Chưa tạo'}
                    >
                      {hasRecovery && !newKey && (
                        <IconButton
                          icon="trash"
                          tone="danger"
                          label="Tắt khoá khôi phục"
                          onClick={() =>
                            window.confirm('Tắt khoá khôi phục? Quên master password sẽ không còn cách nào mở lại vault.') &&
                            void removeRecovery(session.drive).then(() => setHasRecovery(false))
                          }
                        />
                      )}
                      <button type="button" onClick={() => setPrompt('recovery')} disabled={!!busy}>
                        {hasRecovery ? 'Tạo khoá mới' : 'Tạo'}
                      </button>
                    </Setting>

                    {newKey && (
                      <div className="setting-panel">
                        <div
                          className="recovery-key"
                          data-testid="recovery-key"
                          ref={(el) => el?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
                        >
                          <p className="ok small">
                            <Icon name="download" />
                            <span>
                              Đã tải về <b>{kitName}</b>. Lúc quên master password, chỉ cần chọn file này (hoặc ảnh
                              chụp bản in) là mở được vault.
                            </span>
                          </p>
                          <p className="warn small">
                            <Icon name="alert" />
                            <span>Cất file ở nơi khác Google Drive chứa vault (USB, máy khác) hoặc in ra giấy.</span>
                          </p>
                          <div className="key-box">
                            <code className="key mono">
                              {/* Breaks only between the two halves, never inside a group. */}
                              <span>{newKey.slice(0, 18)}</span>
                              <span>{newKey.slice(18)}</span>
                            </code>
                            <CopyBtn value={newKey} secret what="khoá khôi phục" />
                          </div>
                          <div className="actions">
                            <button type="button" onClick={() => void saveKit(newKey)}>
                              <Icon name="download" /> Tải lại
                            </button>
                            <button type="button" onClick={() => void printKit(newKey)}>
                              <Icon name="external" /> Mở để in
                            </button>
                          </div>
                          <label className="check">
                            <input type="checkbox" checked={keptKey} onChange={(e) => setKeptKey(e.target.checked)} />
                            Tôi đã cất khoá này ở nơi an toàn
                          </label>
                          <button type="button" className="primary" disabled={!keptKey} onClick={() => setNewKey('')}>
                            Xong
                          </button>
                        </div>
                      </div>
                    )}

                    <Setting icon="lock" title="Master password">
                      <button type="button" onClick={() => setChanging(!changing)} aria-expanded={changing}>
                        Đổi
                      </button>
                    </Setting>
                    {changing && (
                      <div className="setting-panel">
                        <SecretInput label="Master password hiện tại" value={oldPw} onChange={setOldPw} autoComplete="current-password" autoFocus />
                        <SecretInput label="Master password mới" value={newPw} onChange={setNewPw} autoComplete="new-password" />
                        <SecretInput label="Nhập lại" value={confirm} onChange={setConfirm} autoComplete="new-password" />
                        <button type="button" className="primary" onClick={() => void changePassword()} disabled={!!busy || !oldPw || !newPw}>
                          {busy === 'password' ? 'Đang đổi…' : 'Đổi master password'}
                        </button>
                      </div>
                    )}

                    <Setting icon="clock" title="Tự khoá" info="Khoá vault khi không dùng trong khoảng thời gian này.">
                      <select
                        id="autolock"
                        aria-label="Khoá sau khi không dùng"
                        value={lockMin}
                        style={{ width: 'auto' }}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setLockMin(v);
                          setAutoLockMinutes(v);
                        }}
                      >
                        <option value={1}>1 phút</option>
                        <option value={5}>5 phút</option>
                        <option value={10}>10 phút</option>
                        <option value={30}>30 phút</option>
                        <option value={0}>Không</option>
                      </select>
                    </Setting>
                  </div>
                </>
              )}

              {tab === 'data' && (
                <>
                  {isPopup && (
                    <p className="note">
                      <Icon name="info" />
                      <span>
                        Cửa sổ nhỏ đóng khi chọn file.{' '}
                        <button type="button" className="link" onClick={openInTab}>
                          Mở KaiPass trong tab
                        </button>
                      </span>
                    </p>
                  )}
                  <div className="group">
                    {meta.mode === 'drive' ? (
                      <Setting
                        icon="cloud"
                        on
                        title="Google Drive"
                        info="Vault đồng bộ với file kaipass.kdbx trên Google Drive của bạn."
                        sub={meta.lastSync ? `Đồng bộ lúc ${new Date(meta.lastSync).toLocaleString('vi-VN')}` : 'Chưa đồng bộ'}
                      >
                        <IconButton
                          icon="refresh"
                          label="Đồng bộ ngay"
                          onClick={() => void session.sync(true)}
                          disabled={session.status === 'syncing'}
                        />
                      </Setting>
                    ) : (
                      <>
                        <Setting icon="device" title="Chỉ trên thiết bị này" info="Chuyển lên Google Drive để dùng trên máy khác và điện thoại.">
                          <button type="button" onClick={connectDrive} disabled={!!busy}>
                            <Icon name="cloud" /> {busy === 'drive' ? 'Đang kết nối…' : 'Chuyển lên Google Drive'}
                          </button>
                        </Setting>
                        {(needsClientId || isExtension) && (
                          <div className="setting-panel">
                            {needsClientId && (
                              <TextInput
                                label="Google OAuth Client ID"
                                value={clientId}
                                onChange={setClientId}
                                placeholder="1234567890-abc.apps.googleusercontent.com"
                                mono
                              />
                            )}
                            <RedirectHint />
                          </div>
                        )}
                      </>
                    )}

                    <Setting
                      icon="upload"
                      title="Nhập từ 1Password"
                      info="Trong app 1Password trên máy tính: File → Export → định dạng 1PUX. Nhập xong nhớ xoá file đó (nó chứa mật khẩu chưa mã hoá)."
                    >
                      <input
                        ref={pux}
                        type="file"
                        accept=".1pux"
                        aria-label="File .1pux"
                        className="sr-only"
                        disabled={!!busy}
                        onChange={(e) => {
                          importFile(e.target.files?.[0]);
                          e.target.value = '';
                        }}
                      />
                      <button type="button" onClick={() => pux.current?.click()} disabled={!!busy}>
                        {busy === 'import' ? 'Đang nhập…' : 'Chọn file .1pux'}
                      </button>
                    </Setting>
                    {imported && (
                      <div className="setting-panel">
                        <div className="ok" role="status">
                          <Icon name="check" />
                          <span>
                            Đã nhập {imported.items} mục và {imported.attachments} file đính kèm.
                            {imported.skipped.length > 0 && (
                              <>
                                {' '}
                                Bỏ qua {imported.skipped.length} mục lỗi:
                                <ul>
                                  {imported.skipped.map((s) => (
                                    <li key={s}>{s}</li>
                                  ))}
                                </ul>
                              </>
                            )}
                          </span>
                        </div>
                      </div>
                    )}

                    <Setting icon="download" title="Sao lưu" info="File .kdbx vẫn được mã hoá bằng master password, mở được bằng KeePassXC, KeePassium, KeePassDX.">
                      <button type="button" onClick={() => void exportFile()} disabled={!!busy} aria-label="Tải file .kdbx">
                        Tải .kdbx
                      </button>
                    </Setting>
                  </div>
                </>
              )}

              {tab === 'web' && (
                <div className="group">
                  <Setting icon="key" title="Biểu tượng trong ô đăng nhập" info="Hiện biểu tượng KaiPass và danh sách tài khoản khi bấm vào ô đăng nhập.">
                    <Switch label="Biểu tượng trong ô đăng nhập" checked={inline.icon} onChange={(v) => setInlinePref({ icon: v })} />
                  </Setting>
                  <Setting icon="sparkle" title="Thẻ gợi ý góc trên" info="Hiện thẻ gợi ý tài khoản ở góc trên khi trang có ô đăng nhập.">
                    <Switch label="Thẻ gợi ý góc trên" checked={inline.toast} onChange={(v) => setInlinePref({ toast: v })} />
                  </Setting>
                  <Setting
                    icon="login"
                    title="Chrome hỏi lưu mật khẩu"
                    info="Tắt để chỉ KaiPass hỏi lưu. Danh sách mật khẩu Chrome đã lưu vẫn hiện dưới ô nhập: extension không ẩn được nó. Muốn hết hẳn, xoá các mật khẩu đó trong trình quản lý mật khẩu của Chrome."
                    sub={chromeSaves === false ? 'Đã tắt, chỉ KaiPass hỏi' : 'Đang bật'}
                  >
                    <Switch
                      label="Chrome hỏi lưu mật khẩu"
                      checked={chromeSaves !== false}
                      disabled={chromeSaves === undefined || busy === 'chrome'}
                      onChange={(v) => void setChromeSaving(v)}
                    />
                  </Setting>
                  <Setting icon="key" title="Mật khẩu đã lưu trong Chrome" info="Mở trang mật khẩu của Chrome để xoá những mật khẩu đã có trong KaiPass, cho danh sách của Chrome thôi hiện dưới ô nhập. Lưu ý: mật khẩu đồng bộ với tài khoản Google sẽ bị xoá ở mọi máy.">
                    <IconButton
                      icon="external"
                      label="Mở trang mật khẩu của Chrome"
                      onClick={() => void chrome.tabs.create({ url: 'chrome://password-manager/passwords' })}
                    />
                  </Setting>
                </div>
              )}

              {tab === 'ai' && (
                <AiSettings
                  apiKey={vault.getSetting('anthropicKey')}
                  model={vault.getSetting('aiModel') || 'claude-opus-5-5'}
                  onSave={async (k, v) => {
                    vault.setSetting(k, v);
                    await session.commit();
                  }}
                />
              )}

              {tab === 'look' && <LookSettings />}

              {tab === 'device' && (
                <WipeSection
                  mode={meta.mode}
                  onWiped={() => {
                    session.close();
                    window.location.reload();
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {prompt === 'bio' && (
        <PasswordPrompt
          title="Bật vân tay / mật khẩu máy"
          icon="finger"
          action="Bật"
          onClose={() => setPrompt(null)}
          check={async (pw) => {
            await enrollBio(await checked(pw));
            setBio(true);
            setPrompt(null);
            toast('Đã bật mở khoá bằng vân tay / mật khẩu máy');
          }}
        />
      )}
      {prompt === 'recovery' && (
        <PasswordPrompt
          title={hasRecovery ? 'Tạo khoá khôi phục mới' : 'Tạo khoá khôi phục'}
          icon="key"
          action="Tạo khoá"
          onClose={() => setPrompt(null)}
          check={async (pw) => {
            if (hasRecovery && !window.confirm('Khoá cũ sẽ không dùng được nữa. Tiếp tục?')) return;
            const key = await setUpRecovery(await checked(pw), session.drive);
            setNewKey(key);
            // Saved straight away, so nobody has to copy 30 characters by hand.
            await saveKit(key);
            setKeptKey(false);
            setHasRecovery(true);
            setPrompt(null);
          }}
        />
      )}
    </div>
  );
}

const AI_MODEL_OPTIONS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 · chính xác nhất' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 · nhanh, rẻ hơn' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 · rẻ nhất' },
];

function AiSettings({
  apiKey,
  model,
  onSave,
}: {
  apiKey: string;
  model: string;
  onSave: (key: 'anthropicKey' | 'aiModel', value: string) => Promise<void>;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(!apiKey);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const { checkKey } = await import('../lib/ai');
      await checkKey(key.trim());
      await onSave('anthropicKey', key.trim());
      setKey('');
      setEditing(false);
      toast('Đã lưu Claude API key');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="group">
        <Setting
          icon="key"
          on={!!apiKey}
          title="Claude API key"
          info="Dùng cho tính năng Dán tin nhắn. Key được lưu trong vault (đã mã hoá) và đồng bộ cùng vault. Lấy key ở console.anthropic.com → API Keys."
          sub={apiKey ? `${apiKey.slice(0, 10)}…${apiKey.slice(-4)}` : 'Chưa có'}
        >
          {apiKey && !editing && (
            <>
              <IconButton
                icon="trash"
                tone="danger"
                label="Xoá API key"
                onClick={() => void onSave('anthropicKey', '').then(() => setEditing(true))}
              />
              <button type="button" onClick={() => setEditing(true)}>
                Đổi
              </button>
            </>
          )}
        </Setting>
        {editing && (
          <div className="setting-panel">
            <SecretInput label="API key" hideLabel placeholder="sk-ant-…" value={key} onChange={setKey} mono autoFocus={!apiKey} />
            {error && (
              <p className="error" role="alert">
                <Icon name="alert" />
                <span>{error}</span>
              </p>
            )}
            <button type="button" className="primary" disabled={busy || !key.trim()} onClick={() => void save()}>
              {busy ? 'Đang kiểm tra…' : 'Kiểm tra và lưu'}
            </button>
          </div>
        )}
        <Setting icon="sparkle" title="Mô hình" info="Opus chính xác nhất. Sonnet và Haiku rẻ hơn, thường đủ cho việc tách tin nhắn.">
          <select
            aria-label="Mô hình Claude"
            value={model}
            style={{ width: 'auto' }}
            onChange={(e) => void onSave('aiModel', e.target.value)}
          >
            {AI_MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Setting>
      </div>
      <p className="note">
        <Icon name="shield" />
        <span>Chỉ nội dung bạn dán vào hộp "Dán tin nhắn" được gửi tới Anthropic, và chỉ khi bạn bấm nút. Vault không bao giờ được gửi đi.</span>
      </p>
    </>
  );
}
