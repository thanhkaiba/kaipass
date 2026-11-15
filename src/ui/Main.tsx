import { useCallback, useEffect, useMemo, useState } from 'react';
import { currentTab, fillTab, matchesPage, openInTab, touch, type PageTab } from '../ext/browser';
import { isExtension, isPopup } from '../lib/platform';
import { autoLockMinutes } from '../lib/prefs';
import type { Session, SyncStatus } from '../lib/session';
import type { Item, ItemDraft, ItemType } from '../lib/vault';
import { copyText, errorText, Icon, useToast } from './bits';
import { ItemEditor } from './ItemEditor';
import { ItemView } from './ItemView';
import { Settings } from './Settings';
import { blankDraft, TYPE_LABEL, TYPES } from './types';

type Filter =
  | { k: 'all' }
  | { k: 'fav' }
  | { k: 'type'; type: ItemType }
  | { k: 'folder'; id: string }
  | { k: 'trash' };

const SYNC_LABEL: Record<SyncStatus, string> = {
  local: 'Chỉ trên thiết bị này',
  synced: 'Đã đồng bộ',
  syncing: 'Đang đồng bộ…',
  pending: 'Chờ đồng bộ',
  auth: 'Đăng nhập Google để đồng bộ',
  offline: 'Ngoại tuyến',
  error: 'Lỗi đồng bộ, bấm để thử lại',
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

  const save = async (d: ItemDraft) => {
    const id = vault.upsert(d);
    await session.commit();
    setDraft(null);
    setSelected(id);
    toast('Đã lưu');
  };

  const suggestions = useMemo(
    () => (tab ? items.filter((i) => matchesPage(i, tab.host)) : []),
    [items, tab],
  );

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
    return (
      <button
        type="button"
        key={JSON.stringify(f)}
        className={`nav-item${active ? ' active' : ''}`}
        style={depth ? { paddingLeft: 12 + depth * 14 } : undefined}
        onClick={() => pick(f)}
      >
        <Icon name={icon} />
        <span className="grow">{label}</span>
        <span className="count">{count(f)}</span>
      </button>
    );
  };

  return (
    <div className={`app pane-${pane}`}>
      <nav className="sidebar" aria-label="Bộ lọc">
        <div className="brand small-brand">
          <img src="./icon.svg" alt="" />
          <strong>KaiPass</strong>
          <button type="button" className="iconbtn only-narrow push" onClick={() => setPane('list')} aria-label="Đóng">
            <Icon name="x" />
          </button>
        </div>
        {navItem({ k: 'all' }, 'all', 'Tất cả')}
        {navItem({ k: 'fav' }, 'star', 'Yêu thích')}
        <div className="nav-title">Loại</div>
        {TYPES.map((t) => navItem({ k: 'type', type: t }, t, TYPE_LABEL[t]))}
        <div className="nav-title">
          Thư mục
          <button type="button" className="iconbtn" onClick={addFolder} title="Thêm thư mục" aria-label="Thêm thư mục">
            <Icon name="plus" />
          </button>
        </div>
        {folders.map((f) => navItem({ k: 'folder', id: f.id }, 'folder', f.name, f.depth))}
        <div className="nav-gap" />
        {navItem({ k: 'trash' }, 'trash', 'Thùng rác')}
        <div className="grow" />
        <button
          type="button"
          className={`sync sync-${session.status}`}
          title={session.error || SYNC_LABEL[session.status]}
          data-testid="sync-status"
          data-status={session.status}
          onClick={() => void session.sync(true)}
          disabled={session.status === 'local' || session.status === 'syncing'}
        >
          <span className="dot" />
          {SYNC_LABEL[session.status]}
        </button>
        <button type="button" className="nav-item" onClick={() => setSettings(true)}>
          <Icon name="settings" />
          <span className="grow">Cài đặt</span>
        </button>
        <button type="button" className="nav-item" onClick={() => onLock(session)}>
          <Icon name="lock" />
          <span className="grow">Khoá</span>
        </button>
      </nav>

      <section className="list" aria-label="Danh sách">
        <div className="list-head">
          <button type="button" className="iconbtn only-narrow" onClick={() => setPane('nav')} aria-label="Mở bộ lọc">
            <Icon name="menu" />
          </button>
          <div className="search">
            <Icon name="search" />
            <input
              type="search"
              placeholder={`Tìm trong ${heading.toLowerCase()}`}
              aria-label="Tìm kiếm"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {isPopup && (
            <button type="button" className="iconbtn" onClick={openInTab} title="Mở trong tab" aria-label="Mở trong tab">
              <Icon name="external" />
            </button>
          )}
          <div className="menu-wrap">
            <button type="button" className="primary" onClick={() => setAdding(!adding)} aria-expanded={adding}>
              <Icon name="plus" /> Thêm
            </button>
            {adding && (
              <div className="menu" role="menu">
                {TYPES.map((t) => (
                  <button type="button" role="menuitem" key={t} onClick={() => startNew(t)}>
                    <Icon name={t} /> {TYPE_LABEL[t]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {tab && !query && (
          <div className="suggest" data-testid="suggestions">
            <div className="suggest-title">Cho trang {tab.host}</div>
            {suggestions.length === 0 && <p className="muted small">Chưa có đăng nhập nào lưu cho trang này.</p>}
            {suggestions.map((i) => (
              <div className="suggest-row" key={i.id}>
                <button
                  type="button"
                  className="item"
                  onClick={() => {
                    setSelected(i.id);
                    setDraft(null);
                    setPane('detail');
                  }}
                >
                  <span className="avatar">
                    <Icon name={i.type} />
                  </span>
                  <span className="item-text">
                    <span className="item-title">{i.title || '(không tên)'}</span>
                    <span className="item-sub">{subtitle(i)}</span>
                  </span>
                </button>
                <button type="button" className="primary" onClick={() => void fill(i)} aria-label={`Điền ${i.title}`}>
                  Điền
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="list-title">
          <h2>{heading}</h2>
          <span className="muted small">{visible.length} mục</span>
          <span className="grow" />
          {activeFolder && (
            <>
              <button
                type="button"
                className="link"
                onClick={() => {
                  const name = window.prompt('Tên mới', activeFolder.name)?.trim();
                  if (name) void change(() => vault.renameFolder(activeFolder.id, name));
                }}
              >
                Đổi tên
              </button>
              <button
                type="button"
                className="link danger"
                onClick={() => {
                  if (!window.confirm(`Xoá thư mục "${activeFolder.name}"? Các mục bên trong được giữ lại, chuyển ra ngoài.`)) return;
                  void change(() => vault.deleteFolder(activeFolder.id));
                  setFilter({ k: 'all' });
                }}
              >
                Xoá
              </button>
            </>
          )}
          {filter.k === 'trash' && visible.length > 0 && (
            <button
              type="button"
              className="link danger"
              onClick={() =>
                window.confirm('Xoá hẳn mọi thứ trong thùng rác? Không khôi phục được.') &&
                void change(() => vault.emptyBin())
              }
            >
              Dọn thùng rác
            </button>
          )}
        </div>

        {session.error && (
          <p className="error banner" role="alert">
            {session.error}
          </p>
        )}

        <ul className="items">
          {visible.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                className={`item${i.id === selected && !draft ? ' active' : ''}`}
                onClick={() => {
                  setSelected(i.id);
                  setDraft(null);
                  setPane('detail');
                }}
              >
                <span className={`avatar t-${i.type}`}>
                  <Icon name={i.type} />
                </span>
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
            </li>
          ))}
        </ul>
        {visible.length === 0 && (
          <p className="empty muted">
            {query ? 'Không tìm thấy mục nào khớp.' : items.length === 0 ? 'Vault đang trống. Bấm "Thêm", hoặc vào Cài đặt để nhập từ 1Password.' : 'Không có mục nào ở đây.'}
          </p>
        )}
      </section>

      <main className="detail-pane">
        {draft ? (
          <ItemEditor
            key={draft.id ?? `new-${draft.type}`}
            initial={draft}
            folders={folders}
            onSave={save}
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
            change={change}
            onEdit={() => setDraft(current)}
            onBack={() => setPane('list')}
            onFill={tab && matchesPage(current, tab.host) ? () => void fill(current) : undefined}
          />
        ) : (
          <div className="empty muted">
            <img src="./icon.svg" alt="" />
            <p>Chọn một mục để xem chi tiết.</p>
          </div>
        )}
      </main>

      {settings && (
        <Settings session={session} onClose={() => setSettings(false)} onReplace={onReplace} />
      )}
    </div>
  );
}
