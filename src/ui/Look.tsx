import { useEffect, useState } from 'react';
import { Avatar, defaultIconSvg } from './bits';
import { setFavicons, setLogos, useBrandPrefs, type FaviconSource } from './brands';
import { LogoAssist } from './LogoAssist';
import { Setting, Switch } from './Settings';
import type { Session } from '../lib/session';
import { ACCENTS, EMOJI, getAccent, loadPack, PACKS, setAccent, setPack, useIconPack, type PackId } from './iconPack';

const PREVIEW = ['lock', 'key', 'star', 'card', 'cloud', 'sparkle'];

/** Shows a pack's own icons whatever pack is active, so the choices can be compared. */
function Preview({ id }: { id: PackId }) {
  const [icons, setIcons] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    void loadPack(id).then(setIcons);
  }, [id]);
  return (
    <span className="pack-icons" aria-hidden="true">
      {PREVIEW.map((n) =>
        id === 'emoji' ? (
          <span key={n} className="icon icon-emoji">
            {EMOJI[n]}
          </span>
        ) : id === 'kaipass' ? (
          <DefaultIcon key={n} name={n} />
        ) : icons ? (
          <span key={n} className="icon icon-raw" dangerouslySetInnerHTML={{ __html: icons[n] }} />
        ) : (
          <span key={n} className="icon" />
        ),
      )}
    </span>
  );
}

/** The built-in drawing, even while another pack is active. */
function DefaultIcon({ name }: { name: string }) {
  return <span className="icon icon-raw" dangerouslySetInnerHTML={{ __html: defaultIconSvg(name) }} />;
}

const SAMPLES: [string, string][] = [
  ['Google', 'accounts.google.com'],
  ['GitHub', 'github.com'],
  ['Apple', 'appleid.apple.com'],
  ['Shopee', 'shopee.vn'],
  ['Zalo', 'id.zalo.me'],
  ['Linear', 'linear.app'],
];

const FAVICON_INFO: Record<FaviconSource, string> = {
  off: 'Không tải gì từ mạng. Mục không có logo sẵn hiện chữ cái đầu.',
  site: 'Lấy icon thẳng từ chính trang của mục. Mỗi trang chỉ biết bạn đã tải icon của nó, nhưng mạng bạn dùng (wifi, nhà mạng) thấy được danh sách tên trang.',
  ddg: 'Nhanh, đủ icon hơn. DuckDuckGo sẽ thấy danh sách tên trang trong vault (không thấy tài khoản hay mật khẩu).',
};

function BrandSettings({ session, onOpenAi }: { session: Session; onOpenAi: () => void }) {
  const { logos, favicons } = useBrandPrefs();
  return (
    <div className="stack">
      <h3>Logo trang web</h3>
      <Setting
        icon="star"
        on={logos}
        title="Logo các trang nổi tiếng"
        info="Có sẵn hơn 200 trang (Google, GitHub, Apple, Shopee, Zalo, ngân hàng…), nhận theo địa chỉ web hoặc tên mục. Không cần mạng."
        sub={
          <span className="brand-preview">
            {SAMPLES.map(([t, u]) => (
              <Avatar key={t} title={t} icon="login" url={u} size={26} />
            ))}
          </span>
        }
      >
        <Switch label="Logo các trang nổi tiếng" checked={logos} onChange={setLogos} />
      </Setting>
      <Setting icon="cloud" on={favicons !== 'off'} title="Tải icon cho các trang khác" info={FAVICON_INFO[favicons]}>
        <select
          aria-label="Tải icon cho các trang khác"
          value={favicons}
          style={{ width: 'auto' }}
          onChange={(e) => setFavicons(e.target.value as FaviconSource)}
        >
          <option value="off">Tắt</option>
          <option value="site">Từ chính trang web</option>
          <option value="ddg">Qua DuckDuckGo</option>
        </select>
      </Setting>
      <LogoAssist session={session} onOpenAi={onOpenAi} />
    </div>
  );
}

export function LookSettings({ session, onOpenAi }: { session: Session; onOpenAi: () => void }) {
  const pack = useIconPack();
  const [accent, setAcc] = useState(getAccent);
  return (
    <>
      <BrandSettings session={session} onOpenAi={onOpenAi} />
      <div className="stack">
        <h3>Bộ icon</h3>
        <div className="packs" role="radiogroup" aria-label="Bộ icon">
          {PACKS.map((p) => (
            <button
              type="button"
              key={p.id}
              className="pack"
              aria-pressed={pack.id === p.id}
              aria-label={`Bộ icon ${p.label}`}
              data-tip={p.credit}
              onClick={() => void setPack(p.id)}
            >
              <Preview id={p.id} />
              <span className="pack-name">
                <strong>{p.label}</strong>
                <small>{p.note}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="stack">
        <h3>Màu chủ đạo</h3>
        <div className="swatches" role="radiogroup" aria-label="Màu chủ đạo">
          {ACCENTS.map((a) => (
            <button
              type="button"
              key={a.id}
              className="swatch"
              style={{ background: a.color }}
              aria-pressed={accent === a.id}
              aria-label={a.label}
              data-tip={a.label}
              onClick={() => {
                setAccent(a.id);
                setAcc(a.id);
              }}
            />
          ))}
        </div>
      </div>
    </>
  );
}
