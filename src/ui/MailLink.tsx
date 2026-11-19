/**
 * Settings → Gợi ý trên web → Mã từ email (extension only): linking a Gmail account so KaiPass can
 * read the one-time code a site has just emailed. The background worker does the linking, because
 * Google's window takes focus and would close the toolbar popup mid-way.
 */
import { useEffect, useState } from 'react';
import { errorText, Icon, IconButton, useToast } from './bits';
import { Setting } from './Settings';

interface LinkedMail {
  email: string;
  linkedAt: number;
}

const KEY = 'kaipass.mail';

export function MailLinkSettings() {
  const toast = useToast();
  const [linked, setLinked] = useState<LinkedMail[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = () => void chrome.storage.local.get(KEY).then((r) => setLinked((r[KEY] as LinkedMail[] | undefined) ?? []));
    load();
    // Linking finishes in the background worker, possibly after this page was reopened.
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => area === 'local' && changes[KEY] && load();
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const link = async () => {
    setBusy(true);
    setError('');
    try {
      const r = (await chrome.runtime.sendMessage({ type: 'mailLink' })) as { ok: boolean; error?: string; linked?: LinkedMail } | undefined;
      if (r && !r.ok) throw new Error(r.error || 'Chưa liên kết được');
      if (r?.linked) toast(`Đã liên kết ${r.linked.email}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <h3>Mã từ email</h3>
      <div className="group">
        <Setting
          icon="link"
          on={linked.length > 0}
          title="Liên kết Gmail"
          info="Khi bạn đăng nhập bằng địa chỉ đã liên kết và trang báo đã gửi mã qua email, KaiPass đọc mã trong thư vừa tới và điền giúp. KaiPass chỉ xem thư của vài phút gần nhất, đúng lúc đó, và không lưu nội dung thư. Google chỉ có quyền đọc cả hộp thư, không có quyền hẹp hơn."
          sub={linked.length ? `${linked.length} hộp thư đã liên kết` : 'Chưa liên kết'}
        >
          <button type="button" className={linked.length ? '' : 'primary'} disabled={busy} onClick={() => void link()}>
            {busy ? 'Đang chờ Google…' : linked.length ? 'Thêm' : 'Liên kết'}
          </button>
        </Setting>
        {linked.map((m) => (
          <div className="setting" key={m.email}>
            <span className="setting-icon on">
              <Icon name="check" />
            </span>
            <div className="setting-text">
              <strong className="wrap">{m.email}</strong>
              <div className="small">Liên kết {new Date(m.linkedAt).toLocaleDateString('vi-VN')}</div>
            </div>
            <IconButton
              icon="trash"
              tone="danger"
              label={`Bỏ liên kết ${m.email}`}
              onClick={() => void chrome.runtime.sendMessage({ type: 'mailUnlink', email: m.email }).then(() => toast('Đã bỏ liên kết'))}
            />
          </div>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
