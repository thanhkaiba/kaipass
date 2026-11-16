import { useEffect, useState } from 'react';
import { defaultIconSvg } from './bits';
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

export function LookSettings() {
  const pack = useIconPack();
  const [accent, setAcc] = useState(getAccent);
  return (
    <>
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
