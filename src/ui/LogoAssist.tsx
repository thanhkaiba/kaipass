/**
 * "Find logos with Claude": lists the items that have no logo, asks Claude which service each one
 * belongs to (titles and site names only), and lets the user review the matches before they are
 * saved in the vault.
 */
import { useState } from 'react';
import { brandFor, hostOfUrl, HEX, LOGO_SETTING, parseOverrides, resolveOverride, type LogoOverride } from '../lib/brandMatch';
import type { Session } from '../lib/session';
import type { Item } from '../lib/vault';
import { Avatar, BrandTile, errorText, Icon, useToast } from './bits';
import { setLogoOverrides, useBrandPrefs } from './brands';
import { Setting } from './Settings';

type Suggestion = { item: Item; logo: LogoOverride; name: string };
type Result = { found: Suggestion[]; namedOnly: { item: Item; name: string }[]; unknown: Item[] };

export function LogoAssist({ session, onOpenAi }: { session: Session; onOpenAi: () => void }) {
  const toast = useToast();
  const { data, logos, overrides } = useBrandPrefs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const { vault } = session;
  if (!data || !logos) return null;

  const apiKey = vault.getSetting('anthropicKey');
  const model = vault.getSetting('aiModel') || 'claude-opus-5-5';
  const live = vault.items().filter((i) => !i.trashed);
  const missing = live.filter((i) => !resolveOverride(data, overrides[i.id]) && !brandFor(data, i.title, i.url));
  const assigned = Object.keys(overrides).filter((id) => live.some((i) => i.id === id)).length;

  const save = async (next: Record<string, LogoOverride>) => {
    vault.setSetting(LOGO_SETTING, Object.keys(next).length ? JSON.stringify(next) : '');
    setLogoOverrides(next);
    await session.commit();
  };

  const run = async () => {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const { suggestLogos } = await import('../lib/ai');
      const catalogue = Object.entries(data.brands).map(([id, b]) => ({ id, title: b[0] }));
      const answers = await suggestLogos({
        apiKey,
        model,
        items: missing.map((i) => ({ title: i.title, host: hostOfUrl(i.url) })),
        catalogue,
      });
      const byN = new Map(answers.map((a) => [a.n, a]));
      const res: Result = { found: [], namedOnly: [], unknown: [] };
      missing.forEach((item, n) => {
        const a = byN.get(n);
        const name = a?.name.trim() ?? '';
        let logo: LogoOverride | null = null;
        if (a?.brand && data.brands[a.brand]) logo = { b: a.brand };
        else if (a && name && HEX.test(a.color.replace('#', '')) && a.letter.trim())
          logo = { t: name, h: a.color.replace('#', '').toUpperCase(), l: a.letter.trim().slice(0, 3) };
        if (logo) res.found.push({ item, logo, name: name || data.brands[logo.b!]?.[0] || '' });
        else if (name) res.namedOnly.push({ item, name });
        else res.unknown.push(item);
      });
      setSkip(new Set());
      setResult(res);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!result) return;
    const next = { ...parseOverrides(vault.getSetting(LOGO_SETTING)) };
    const picked = result.found.filter((s) => !skip.has(s.item.id));
    for (const s of picked) next[s.item.id] = s.logo;
    try {
      await save(next);
      toast(`Đã gán logo cho ${picked.length} mục`);
      setResult(null);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <>
      <Setting
        icon="sparkle"
        title="Tìm logo bằng Claude"
        info="Claude đoán mỗi mục chưa có logo thuộc trang nào. Chỉ gửi tên mục và tên trang, không gửi tài khoản, mật khẩu hay ghi chú. Bạn duyệt trước khi lưu."
        sub={
          <>
            {missing.length ? `${missing.length} mục chưa có logo` : 'Mục nào cũng có logo'}
            {assigned > 0 && ` · ${assigned} mục do Claude gán`}
          </>
        }
      >
        {apiKey ? (
          <button type="button" disabled={busy || !missing.length} onClick={() => void run()}>
            {busy ? 'Đang hỏi Claude…' : 'Tìm'}
          </button>
        ) : (
          <button type="button" onClick={onOpenAi} data-tip="Cần Claude API key">
            Thêm API key
          </button>
        )}
      </Setting>
      {(missing.length > 0 || assigned > 0) && !result && (
        <div className="setting-panel logo-log">
          {missing.length > 0 && (
            <details>
              <summary>Danh sách mục chưa có logo</summary>
              <ul className="logo-list" aria-label="Mục chưa có logo">
                {missing.map((i) => (
                  <li key={i.id}>
                    <Avatar title={i.title} icon={i.type} size={24} />
                    <span className="grow">{i.title || '(không tên)'}</span>
                    <span className="muted mono">{hostOfUrl(i.url)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {assigned > 0 && (
            <button type="button" className="link" onClick={() => void save({}).then(() => toast('Đã gỡ logo do Claude gán'))}>
              Gỡ các logo do Claude gán
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
      {result && (
        <div className="setting-panel logo-log" aria-label="Kết quả tìm logo">
          {result.found.length ? (
            <ul className="logo-list">
              {result.found.map((s) => {
                const brand = resolveOverride(data, s.logo)!;
                const on = !skip.has(s.item.id);
                return (
                  <li key={s.item.id}>
                    <input
                      type="checkbox"
                      checked={on}
                      aria-label={`Gán logo ${s.name} cho ${s.item.title}`}
                      onChange={() => {
                        const n = new Set(skip);
                        if (on) n.add(s.item.id);
                        else n.delete(s.item.id);
                        setSkip(n);
                      }}
                    />
                    <BrandTile brand={brand} size={24} />
                    <span className="grow">{s.item.title || '(không tên)'}</span>
                    <span className="muted">{s.name}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">Claude không tìm thêm được logo nào.</p>
          )}
          {(result.namedOnly.length > 0 || result.unknown.length > 0) && (
            <details>
              <summary>
                Vẫn chưa có logo: {result.namedOnly.length + result.unknown.length} mục
              </summary>
              <ul className="logo-list" aria-label="Vẫn chưa có logo">
                {result.namedOnly.map(({ item, name }) => (
                  <li key={item.id}>
                    <span className="grow">{item.title}</span>
                    <span className="muted">{name}, không rõ màu</span>
                  </li>
                ))}
                {result.unknown.map((item) => (
                  <li key={item.id}>
                    <span className="grow">{item.title}</span>
                    <span className="muted">không nhận ra</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="row-buttons">
            {result.found.length > 0 && (
              <button type="button" className="primary" disabled={result.found.length === skip.size} onClick={() => void apply()}>
                Lưu {result.found.length - skip.size} logo
              </button>
            )}
            <button type="button" onClick={() => setResult(null)}>
              {result.found.length ? 'Bỏ qua' : 'Đóng'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
