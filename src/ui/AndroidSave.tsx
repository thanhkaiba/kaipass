/**
 * Android: a login the user typed into an app or web page, handed over by the autofill service.
 * Offers to save it as a new login or to update the matching one's password.
 */
import { useEffect, useState } from 'react';
import { native, onNative, type PendingSave } from '../lib/android';
import { addressesOf, appOf } from '../lib/androidIndex';
import { hostOf } from '../ext/match';
import type { Session } from '../lib/session';
import type { Item, ItemDraft } from '../lib/vault';
import { Avatar, errorText, Icon, Modal, SecretInput, TextInput, useToast } from './bits';

/** Logins saved for this page or app, best first. */
export function matchingLogins(items: Item[], p: PendingSave): Item[] {
  const domain = p.domain?.replace(/^www\./, '').toLowerCase() ?? '';
  const score = (i: Item) => {
    let best = 0;
    for (const u of addressesOf(i)) {
      if (!domain) {
        if (appOf(u) === p.package) best = Math.max(best, 3);
        continue;
      }
      const h = hostOf(u);
      if (!h) continue;
      if (h === domain) best = Math.max(best, 3);
      else if (domain.endsWith(`.${h}`) || h.endsWith(`.${domain}`)) best = Math.max(best, 2);
    }
    return best;
  };
  return items
    .filter((i) => !i.trashed && i.type === 'login')
    .map((i) => [i, score(i)] as const)
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([i]) => i);
}

export function AndroidSave({ session }: { session: Session }) {
  const toast = useToast();
  const [pending, setPending] = useState<PendingSave | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  // Bumped after each answer, to pick up the next login waiting (there can be several).
  const [round, setRound] = useState(0);

  useEffect(() => {
    const check = () =>
      void native<PendingSave | null>('pendingSave')
        .then((p) => {
          setPending(p);
          if (p) {
            setUsername(p.username);
            setPassword(p.password);
            setError('');
          }
        })
        .catch(() => {});
    check();
    const offs = [onNative('pendingSave', check), onNative('resume', check)];
    return () => offs.forEach((off) => off());
  }, [round]);

  if (!pending) return null;
  const where = pending.domain ?? pending.appLabel;
  const matches = matchingLogins(session.vault.items(), pending);
  const same = matches.find((i) => i.username === username) ?? (matches.length === 1 && !matches[0].username ? matches[0] : undefined);
  const unchanged = same?.password === password;

  const finish = (saved: boolean) => {
    setPending(null);
    void native('saveDone', { id: pending.id, saved })
      .catch(() => {})
      .then(() => setRound((r) => r + 1));
  };

  const save = async () => {
    try {
      const draft: ItemDraft = same
        ? { ...same, password, username: same.username || username }
        : {
            type: 'login',
            title: pending.domain ?? pending.appLabel,
            username,
            password,
            url: pending.domain ? `https://${pending.domain}` : `androidapp://${pending.package}`,
            notes: '',
            otp: '',
            fields: [],
            tags: [],
            favorite: false,
            folderId: '',
          };
      session.vault.upsert(draft);
      await session.commit();
      toast(same ? 'Đã cập nhật mật khẩu' : 'Đã lưu đăng nhập');
      finish(true);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <Modal title={same ? 'Cập nhật mật khẩu?' : 'Lưu đăng nhập?'} icon="key" onClose={() => finish(false)}>
      <div className="stack">
        <div className="save-where">
          <Avatar title={same?.title ?? where} icon="login" url={pending.domain ? `https://${pending.domain}` : ''} id={same?.id} size={40} />
          <div>
            <strong>{same ? same.title : where}</strong>
            <div className="muted small">{pending.domain ? pending.domain : `App ${pending.appLabel}`}</div>
          </div>
        </div>
        <TextInput label="Tên đăng nhập" value={username} onChange={setUsername} />
        <SecretInput label="Mật khẩu" value={password} onChange={setPassword} />
        {pending.generated && !unchanged && (
          <p className="note">
            <Icon name="dice" />
            <span>KaiPass đã tạo mật khẩu này và điền vào {where}. Lưu lại để không bị mất.</span>
          </p>
        )}
        {unchanged && <p className="muted small">Mật khẩu này đã được lưu rồi.</p>}
        {error && (
          <p className="error" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </p>
        )}
        <div className="row-buttons">
          <button type="button" className="primary" disabled={!password || unchanged} onClick={() => void save()}>
            {same ? 'Cập nhật' : 'Lưu'}
          </button>
          <button type="button" onClick={() => finish(false)}>
            Không lưu
          </button>
        </div>
      </div>
    </Modal>
  );
}
