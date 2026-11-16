import { useCallback, useEffect, useMemo, useState } from 'react';
import { currentTab, fillTab, matchesPage, openInTab, pageScore, touch, type PageTab } from '../ext/browser';
import { isExtension, isPopup } from '../lib/platform';
import { autoLockMinutes } from '../lib/prefs';
import type { Session, SyncStatus } from '../lib/session';
import type { Item, ItemDraft, ItemType } from '../lib/vault';
import { Avatar, Brand, copyText, errorText, Icon, IconButton, useToast } from './bits';
import { ItemEditor } from './ItemEditor';
import { ItemView } from './ItemView';
import { pushRecovery } from '../lib/recovery';
import { cleanupExpiredShares, sharedToDraft, takeIncoming } from '../lib/share';
import type { OtpAccount } from '../lib/qr';
import { AiPasteDialog } from './AiPaste';
import { QrScanDialog } from './QrScan';
import { Settings } from './Settings';
import { ImportShareDialog } from './Share';
import { blankDraft, TYPE_LABEL, TYPES } from './types';

type Filter =
  | { k: 'all' }
  | { k: 'fav' }
  | { k: 'type'; type: ItemType }
  | { k: 'folder'; id: string }
  | { k: 'trash' };

const SYNC_LABEL: Record<SyncStatus, string> = {
  local: 'Chỉ trên máy này',
  synced: 'Đã đồng bộ',
  syncing: 'Đang đồng bộ…',
  pending: 'Chờ đồng bộ',
  auth: 'Cần đăng nhập Google',
  offline: 'Ngoại tuyến',
  error: 'Lỗi đồng bộ',
};

const SYNC_TIP: Record<SyncStatus, string> = {
  local: 'Vault chỉ lưu trên thiết bị này. Chuyển lên Google Drive trong Cài đặt.',
  synced: 'Đã đồng bộ với Google Drive. Bấm để đồng bộ lại.',
  syncing: 'Đang đồng bộ với Google Drive',
  pending: 'Có thay đổi chưa lên Drive. Bấm để đồng bộ ngay.',
  auth: 'Phiên Google đã hết. Bấm để đăng nhập lại.',
  offline: 'Không kết nối được. Thay đổi sẽ lên Drive khi có mạng.',
  error: 'Lỗi đồng bộ. Bấm để thử lại.',
};

function matches(item: Item, filter: Filter): boolean {
  if (filter.k === 'trash') return item.trashed;
  if (item.trashed) return false;
  switch (filter.k) {
    case 'fav':
      return item.favorite;
    case 'type':
      return item.type === filter.type;
    case 'folder':
      return item.folderId === filter.id;
    default:
      return true;
  }
}

function subtitle(item: Item): string {
  if (item.username) return item.username;
  const shown = item.fields.find((f) => !f.secret && f.value);
  if (shown) return shown.value;
  if (item.url) return item.url.replace(/^https?:\/\//, '');
  return TYPE_LABEL[item.type];
}

export function Main({
  session,
  onLock,
  onReplace,
}: {
  session: Session;
  onLock: (s: Session) => void;
  onReplace: (s: Session) => void;
}) {
  const toast = useToast();
  const vault = session.vault;
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useState<Filter>({ k: 'all' });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<ItemDraft | null>(null);
  const [pane, setPane] = useState<'nav' | 'list' | 'detail'>('list');
  const [settings, setSettings] = useState(false);
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState<PageTab | undefined>();
  const [importing, setImporting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [pasting, setPasting] = useState(false);

  // An item someone shared, brought over from the link page ("Lưu vào KaiPass").
  useEffect(() => {
    const incoming = takeIncoming();
    if (incoming) {
      setDraft(sharedToDraft(incoming));
      setPane('detail');
    }
    if (session.drive) {
      void cleanupExpiredShares(session.drive).catch(() => {});
      void pushRecovery(session.drive).catch(() => {});
    }
  }, [session]);

  useEffect(() => session.subscribe(() => setTick((t) => t + 1)), [session]);

  // In the extension popup: find out which page we were opened on.
  useEffect(() => {
    currentTab().then(setTab, () => {});
  }, []);

  // Sync when the app comes back to the foreground or the network returns.
  useEffect(() => {
    const kick = () => document.visibilityState === 'visible' && void session.sync();
    document.addEventListener('visibilitychange', kick);
    window.addEventListener('online', kick);
    return () => {
      document.removeEventListener('visibilitychange', kick);
      window.removeEventListener('online', kick);
    };
  }, [session]);

  // Lock after a period without any input.
  useEffect(() => {
    const minutes = autoLockMinutes();
    if (!minutes) return;
    let timer = setTimeout(() => onLock(session), minutes * 60_000);
    let touched = 0;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => onLock(session), minutes * 60_000);
      // The extension popup does not live long enough to run that timer, so it also keeps a deadline.
      if (isExtension && Date.now() - touched > 10_000) {
        touched = Date.now();
        void touch(minutes);
      }
    };
    reset();
    window.addEventListener('pointerdown', reset);
    window.addEventListener('keydown', reset);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', reset);
      window.removeEventListener('keydown', reset);
    };
  }, [session, onLock, settings]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => vault.items(), [vault, tick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const folders = useMemo(() => vault.folders(), [vault, tick]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((i) => matches(i, filter))
      .filter(
        (i) =>
          !q ||
          [i.title, i.username, i.url, i.notes, i.folderName, ...i.tags, ...i.fields.filter((f) => !f.secret).map((f) => f.value)]
            .join('\n')
            .toLowerCase()
            .includes(q),
      )
      .sort((a, b) => a.title.localeCompare(b.title, 'vi'));
  }, [items, filter, query]);

  const current = selected ? items.find((i) => i.id === selected) : undefined;
  const count = (f: Filter) => items.filter((i) => matches(i, f)).length;

  const change = useCallback(
    async (fn: () => void | Promise<void>) => {
      try {
        await fn();
        await session.commit();
      } catch (e) {
        toast(errorText(e));
      }
    },
    [session, toast],
  );

  const pick = (f: Filter) => {
    setFilter(f);
    setPane('list');
  };

  const startNew = (type: ItemType) => {
    setAdding(false);
    setDraft(blankDraft(type, filter.k === 'folder' ? filter.id : ''));
    setPane('detail');
  };

  /** Adds every account of a Google Authenticator export as a login with its OTP. */
  const importMany = (accounts: OtpAccount[]) =>
    change(() => {
      for (const a of accounts) {
        vault.upsert({
          ...blankDraft('login', filter.k === 'folder' ? filter.id : ''),
          title: a.issuer || a.account || 'OTP',
          username: a.account,
          otp: a.uri,
        });
      }
    }).then(() => {
      setDraft(null);
      toast(`Đã thêm ${accounts.length} tài khoản có mã OTP`);
    });

  const save = async (d: ItemDraft) => {
    const id = vault.upsert(d);
    await session.commit();
    setDraft(null);
    setSelected(id);
    toast('Đã lưu');
  };

  const suggestions = useMemo(() => {
    if (!tab) return [];
    return items
      .map((i) => ({ i, score: pageScore(i, tab.host) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.i.title.localeCompare(b.i.title, 'vi'))
      .map((x) => x.i);
  }, [items, tab]);

  const fill = async (item: Item) => {
    if (!tab) return;
    try {
      const r = await fillTab(tab, item);
      if (!r.username && !r.password && !r.otp) {
        toast('Không tìm thấy ô đăng nhập trên trang này');
      } else if (r.code && !r.otp) {
        // The page has no code box yet (two-step logins ask for it on the next screen).
        const copied = await copyText(r.code, true).then(
          () => true,
          () => false,
        );
        toast(copied ? 'Đã điền. Mã OTP đã được copy để dán ở bước sau' : 'Đã điền. Mở lại KaiPass ở bước sau để điền mã OTP');
        setTimeout(() => window.close(), 1500);
      } else {
        toast('Đã điền');
        setTimeout(() => window.close(), 400);
      }
    } catch (e) {
      toast(`Không điền được: ${errorText(e)}`);
    }
  };

  const addFolder = () => {
    const name = window.prompt('Tên thư mục mới')?.trim();
    if (name) void change(() => pick({ k: 'folder', id: vault.createFolder(name) }));
  };

  const activeFolder = filter.k === 'folder' ? folders.find((f) => f.id === filter.id) : undefined;
  const heading =
    filter.k === 'all'
      ? 'Tất cả'
      : filter.k === 'fav'
        ? 'Yêu thích'
        : filter.k === 'type'
          ? TYPE_LABEL[filter.type]
          : filter.k === 'trash'
            ? 'Thùng rác'
            : (activeFolder?.name ?? 'Thư mục');

  const navItem = (f: Filter, icon: string, label: string, depth = 0) => {
    const active = JSON.stringify(f) === JSON.stringify(filter);
    const n = count(f);
    return (
      <button
        type="button"
        key={JSON.stringify(f)}
        className={`nav-item${active ? ' active' : ''}`}
        style={depth ? { paddingLeft: 10 + depth * 14 } : undefined}
        onClick={() => pick(f)}
      >
        <Icon name={icon} filled={icon === 'star' && active} />
        <span className="grow">{label}</span>
        {n > 0 && <span className="count">{n}</span>}
      </button>
    );
  };

  const open = (i: Item) => {
    setSelected(i.id);
    setDraft(null);
    setPane('detail');
  };

  const itemButton = (i: Item, active: boolean) => (
    <button type="button" className={`item${active ? ' active' : ''}`} onClick={() => open(i)}>
      <Avatar title={i.title} icon={i.type} />
      <span className="item-text">
        <span className="item-title">{i.title || '(không tên)'}</span>
        <span className="item-sub">{subtitle(i)}</span>
      </span>
      {i.favorite && (
        <span className="fav">
          <Icon name="star" filled />
        </span>
      )}
    </button>
  );

  return (
    <div className={`app pane-${pane}`}>
      <nav className="sidebar" aria-label="Bộ lọc">
        <div className="step-head">
          <Brand small />
          <span className="grow" />
          <IconButton icon="x" label="Đóng" className="only-narrow" onClick={() => setPane('list')} />
        </div>
        {navItem({ k: 'all' }, 'all', 'Tất cả')}
        {navItem({ k: 'fav' }, 'star', 'Yêu thích')}
        <div className="nav-title">Loại</div>
        {TYPES.map((t) => navItem({ k: 'type', type: t }, t, TYPE_LABEL[t]))}
        <div className="nav-title">
          Thư mục
          <IconButton icon="plus" label="Thêm thư mục" onClick={addFolder} />
        </div>
        {folders.map((f) => navItem({ k: 'folder', id: f.id }, 'folder', f.name, f.depth))}
        <div className="nav-gap" />
        {navItem({ k: 'trash' }, 'trash', 'Thùng rác')}
        <div className="grow" />
        <div className="side-foot">
          <button
            type="button"
            className={`sync sync-${session.status}`}
            data-tip={session.error || SYNC_TIP[session.status]}
            data-testid="sync-status"
            data-status={session.status}
            onClick={() => void session.sync(true)}
            disabled={session.status === 'local' || session.status === 'syncing'}
          >
            <span className="dot" />
            <span>{SYNC_LABEL[session.status]}</span>
          </button>
          <IconButton icon="settings" label="Cài đặt" onClick={() => setSettings(true)} />
          <IconButton icon="lock" label="Khoá" onClick={() => onLock(session)} />
        </div>
      </nav>

      <section className="list" aria-label="Danh sách">
        <div className="list-head">
          <IconButton icon="menu" label="Mở bộ lọc" className="only-narrow" onClick={() => setPane('nav')} />
          <div className="search">
            <Icon name="search" />
            <input
              type="search"
              placeholder="Tìm kiếm"
              aria-label="Tìm kiếm"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {isPopup && <IconButton icon="external" label="Mở trong tab" onClick={openInTab} />}
          <div className="menu-wrap">
            <button
              type="button"
              className="primary add-btn"
              onClick={() => setAdding(!adding)}
              aria-expanded={adding}
              aria-label="Thêm"
              data-tip="Thêm mục mới"
            >
              <Icon name="plus" />
            </button>
            {adding && (
              <div className="menu" role="menu">
                {TYPES.map((t) => (
                  <button type="button" role="menuitem" key={t} onClick={() => startNew(t)}>
                    <Icon name={t} /> {TYPE_LABEL[t]}
                  </button>
                ))}
                <hr />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAdding(false);
                    setPasting(true);
                  }}
                >
                  <Icon name="sparkle" /> Dán tin nhắn (Claude)…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAdding(false);
                    setScanning(true);
                  }}
                >
                  <Icon name="qr" /> Quét mã QR (OTP)…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAdding(false);
                    setImporting(true);
                  }}
                >
                  <Icon name="link" /> Từ link chia sẻ…
                </button>
              </div>
            )}
          </div>
        </div>

        {tab && !query && (
          <div className="suggest" data-testid="suggestions">
            <div className="suggest-title">
              <Icon name="login" /> {tab.host}
            </div>
            {suggestions.length === 0 && <p className="muted small">Chưa có đăng nhập cho trang này</p>}
            {suggestions.map((i) => (
              <div className="suggest-row" key={i.id}>
                {itemButton(i, false)}
                <button type="button" className="primary" onClick={() => void fill(i)} aria-label={`Điền ${i.title}`} data-tip="Điền vào trang">
                  Điền
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="list-title">
          <h2>{heading}</h2>
          <span className="count">{visible.length}</span>
          <span className="grow" />
          {activeFolder && (
            <>
              <IconButton
                icon="edit"
                label="Đổi tên thư mục"
                onClick={() => {
                  const name = window.prompt('Tên mới', activeFolder.name)?.trim();
                  if (name) void change(() => vault.renameFolder(activeFolder.id, name));
                }}
              />
              <IconButton
                icon="trash"
                tone="danger"
                label="Xoá thư mục"
                tip="Xoá thư mục (giữ lại các mục bên trong)"
                onClick={() => {
                  if (!window.confirm(`Xoá thư mục "${activeFolder.name}"? Các mục bên trong được giữ lại, chuyển ra ngoài.`)) return;
                  void change(() => vault.deleteFolder(activeFolder.id));
                  setFilter({ k: 'all' });
                }}
              />
            </>
          )}
          {filter.k === 'trash' && visible.length > 0 && (
            <IconButton
              icon="trash"
              tone="danger"
              label="Dọn thùng rác"
              tip="Xoá hẳn mọi thứ trong thùng rác"
              onClick={() =>
                window.confirm('Xoá hẳn mọi thứ trong thùng rác? Không khôi phục được.') && void change(() => vault.emptyBin())
              }
            />
          )}
        </div>

        {session.error && (
          <p className="error banner" role="alert">
            <Icon name="alert" />
            <span>{session.error}</span>
          </p>
        )}

        <ul className="items">
          {visible.map((i) => (
            <li key={i.id}>{itemButton(i, i.id === selected && !draft)}</li>
          ))}
        </ul>
        {visible.length === 0 && (
          <div className="empty">
            <span className="empty-icon">
              <Icon name={query ? 'search' : items.length === 0 ? 'key' : filter.k === 'trash' ? 'trash' : 'all'} />
            </span>
            <p className="small">
              {query ? 'Không tìm thấy' : items.length === 0 ? 'Vault đang trống' : 'Không có mục nào'}
            </p>
            {items.length === 0 && !query && (
              <button type="button" className="primary" onClick={() => setAdding(true)}>
                <Icon name="plus" /> Thêm mục đầu tiên
              </button>
            )}
          </div>
        )}
      </section>

      <main className="detail-pane">
        {draft ? (
          <ItemEditor
            key={draft.id ?? `new-${draft.type}`}
            initial={draft}
            folders={folders}
            onSave={save}
            onImportMany={importMany}
            onCancel={() => {
              setDraft(null);
              if (!current) setPane('list');
            }}
          />
        ) : current ? (
          <ItemView
            key={current.id}
            item={current}
            vault={vault}
            drive={session.drive}
            change={change}
            onEdit={() => setDraft(current)}
            onBack={() => setPane('list')}
            onFill={tab && matchesPage(current, tab.host) ? () => void fill(current) : undefined}
          />
        ) : (
          <div className="empty">
            <span className="empty-icon">
              <Icon name="key" />
            </span>
            <p className="small">Chọn một mục</p>
          </div>
        )}
      </main>

      {pasting && (
        <AiPasteDialog
          vault={vault}
          onClose={() => setPasting(false)}
          onSaveKey={(key) => change(() => vault.setSetting('anthropicKey', key))}
          onEdit={(d) => {
            setPasting(false);
            setDraft({ ...d, folderId: filter.k === 'folder' ? filter.id : '' });
            setPane('detail');
          }}
          onAddAll={async (drafts) => {
            await change(() => {
              for (const d of drafts) vault.upsert({ ...d, folderId: filter.k === 'folder' ? filter.id : '' });
            });
            setPasting(false);
            toast(`Đã thêm ${drafts.length} mục`);
          }}
        />
      )}

      {scanning && (
        <QrScanDialog
          onClose={() => setScanning(false)}
          onFound={(result, page) => {
            setScanning(false);
            if (result.accounts.length > 1) return importMany(result.accounts);
            const a = result.accounts[0];
            setDraft({
              ...blankDraft('login', filter.k === 'folder' ? filter.id : ''),
              title: a.issuer || a.account || page?.host || '',
              username: a.account,
              otp: a.uri,
              url: page ? `https://${page.host}` : '',
            });
            setPane('detail');
          }}
        />
      )}

      {importing && (
        <ImportShareDialog
          onClose={() => setImporting(false)}
          onUse={(shared) => {
            setImporting(false);
            setDraft(sharedToDraft(shared));
            setPane('detail');
          }}
        />
      )}

      {settings && (
        <Settings session={session} onClose={() => setSettings(false)} onReplace={onReplace} />
      )}
    </div>
  );
}
