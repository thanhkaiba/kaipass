/**
 * Content script: runs in every web page and frame. It adds the KaiPass button to login fields,
 * shows the list of matching logins, and a suggestion card on login pages.
 *
 * It holds no secrets of its own. It asks the background worker for the logins that match this
 * frame (titles and usernames only) and, once the user clicks one, for that login's credentials.
 * Everything it draws lives in a closed shadow root so the page cannot read or restyle it, and it
 * only acts on real (trusted) clicks and key presses.
 */
import { fillPage } from './fill';
import type { FillReply, Request, SavePromptReply, StateReply, SuggestItem } from './match';

declare const __KAIPASS_TEST__: boolean;

(() => {
  if ((window as unknown as { __kaipass?: boolean }).__kaipass) return;
  (window as unknown as { __kaipass?: boolean }).__kaipass = true;
  const isTop = window === window.top;

  const ask = async <T>(req: Request): Promise<T | undefined> => {
    try {
      return (await chrome.runtime.sendMessage(req)) as T;
    } catch {
      return undefined; // extension reloaded or removed; stay quiet
    }
  };

  // ---- recognising login fields ----

  const OTP_WORDS = /otp|totp|2fa|mfa|one-?time|verif|authenticator|security.?code|passcode|(^|[^a-z])code/;
  const USER_WORDS = /user|email|e-mail|login|account|identifier|(^|[^a-z])id($|[^a-z])/;
  const kind = (el: HTMLInputElement) => (el.getAttribute('type') ?? 'text').toLowerCase();
  const textLike = (el: HTMLInputElement) => ['text', 'email', 'tel', 'number', ''].includes(kind(el));
  const hint = (el: HTMLInputElement) =>
    [el.name, el.id, el.autocomplete, el.placeholder, el.getAttribute('aria-label') ?? ''].join(' ').toLowerCase();
  const visible = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return r.width > 20 && r.height > 10 && getComputedStyle(el).visibility !== 'hidden';
  };
  const passwordFields = () =>
    Array.from(document.querySelectorAll<HTMLInputElement>('input[type=password]')).filter(
      (el) => visible(el) && el.autocomplete !== 'new-password',
    );

  type FieldRole = 'username' | 'password' | 'otp';

  function roleOf(el: EventTarget | null): FieldRole | null {
    if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly || !visible(el)) return null;
    const h = hint(el);
    if (el.autocomplete === 'one-time-code' || ((textLike(el) || kind(el) === 'password') && OTP_WORDS.test(h) && !USER_WORDS.test(h))) {
      return 'otp';
    }
    if (kind(el) === 'password') return el.autocomplete === 'new-password' ? null : 'password';
    if (!textLike(el)) return null;
    if (el.autocomplete === 'username') return 'username';
    if (USER_WORDS.test(h) || kind(el) === 'email') {
      // A username box counts when the page also asks for a password, or on a short sign-in step.
      const formInputs = el.form ? el.form.querySelectorAll('input:not([type=hidden])').length : 99;
      if (passwordFields().length > 0 || formInputs <= 3) return 'username';
    }
    return null;
  }

  const hasLoginFields = () =>
    passwordFields().length > 0 ||
    Array.from(document.querySelectorAll('input')).some((el) => roleOf(el) !== null);

  // ---- drawing ----

  const host = document.createElement('kaipass-ui');
  host.setAttribute(
    'style',
    'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important;',
  );
  const root = host.attachShadow({ mode: __KAIPASS_TEST__ ? 'open' : 'closed' });
  root.innerHTML = `
<style>
  :host { color-scheme: light dark; }
  * { box-sizing: border-box; font: 14px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  .badge { position: fixed; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px;
    background: #2f6bff; display: none; cursor: pointer; box-shadow: 0 1px 3px rgb(0 0 0 / 30%); }
  .badge svg { width: 100%; height: 100%; display: block; }
  .panel { position: fixed; display: none; min-width: 260px; max-width: 360px; max-height: 320px; overflow: auto;
    padding: 6px; border-radius: 10px; background: #fff; color: #1b2030; border: 1px solid #d9dee8;
    box-shadow: 0 10px 28px rgb(0 0 0 / 22%); }
  .toast, .save { position: fixed; top: 12px; right: 12px; width: 320px; display: none; padding: 10px; border-radius: 12px;
    background: #fff; color: #1b2030; border: 1px solid #d9dee8; box-shadow: 0 10px 28px rgb(0 0 0 / 22%); }
  .head { display: flex; align-items: center; gap: 8px; padding: 2px 4px 8px; font-weight: 600; }
  .head .logo { width: 20px; height: 20px; border-radius: 5px; background: #2f6bff; flex: none; }
  .head .logo svg { width: 20px; height: 20px; display: block; }
  .head .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .head .sub { font-weight: 400; color: #5d667a; font-size: 12px; }
  button { cursor: pointer; }
  .row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px; border: 0; border-radius: 8px;
    background: transparent; color: inherit; text-align: left; }
  .row:hover, .row:focus-visible { background: #e9f0ff; outline: none; }
  .avatar { width: 30px; height: 30px; flex: none; display: grid; place-items: center; border-radius: 8px;
    background: #eef1f6; color: #2f6bff; font-weight: 700; }
  .text { display: flex; flex-direction: column; min-width: 0; }
  .title, .user { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title { font-weight: 600; }
  .user { font-size: 12px; color: #5d667a; }
  .note { padding: 8px; color: #5d667a; }
  .action { margin: 4px 8px 6px; padding: 7px 12px; border: 0; border-radius: 8px; background: #2f6bff; color: #fff; font-weight: 600; }
  .x { margin-left: auto; width: 26px; height: 26px; border: 0; border-radius: 6px; background: transparent; color: #5d667a; font-size: 18px; line-height: 1; }
  .x:hover { background: #eef1f6; }
  .who { margin: 0 4px 10px; padding: 8px 10px; border-radius: 8px; background: #eef1f6; }
  .who .user { font-size: 13px; }
  .buttons { display: flex; gap: 6px; flex-wrap: wrap; padding: 0 4px 2px; }
  .buttons .action { margin: 0; }
  .ghost { padding: 7px 12px; border: 1px solid #d9dee8; border-radius: 8px; background: transparent; color: #1b2030; }
  .link { padding: 7px 4px; border: 0; background: transparent; color: #5d667a; font-size: 12px; }
  @media (prefers-color-scheme: dark) {
    .panel, .toast, .save { background: #1b1f2a; color: #e8ebf2; border-color: #323a4c; }
    .ghost { color: #e8ebf2 !important; border-color: #323a4c !important; }
    .who { background: #242a38 !important; }
    .row:hover, .row:focus-visible { background: #1f2d4a; }
    .avatar { background: #242a38; color: #6a9cf5; }
    .user, .note, .head .sub, .x { color: #9aa3b8; }
    .x:hover { background: #242a38; }
  }
</style>
<button class="badge" part="badge" title="KaiPass" aria-label="KaiPass"></button>
<div class="panel" role="listbox" aria-label="KaiPass"></div>
<div class="toast" role="dialog" aria-label="KaiPass"></div>
<div class="save" role="dialog" aria-label="Lưu vào KaiPass"></div>`;
  const LOGO = `<svg viewBox="0 0 512 512" aria-hidden="true"><rect x="116" y="126" width="280" height="260" rx="36" fill="none" stroke="#fff" stroke-width="34"/><circle cx="256" cy="256" r="58" fill="none" stroke="#fff" stroke-width="34"/></svg>`;
  const badge = root.querySelector<HTMLButtonElement>('.badge')!;
  const panel = root.querySelector<HTMLDivElement>('.panel')!;
  const toast = root.querySelector<HTMLDivElement>('.toast')!;
  const saveCard = root.querySelector<HTMLDivElement>('.save')!;
  badge.innerHTML = LOGO;
  let mounted = false;
  const mount = () => {
    if (!mounted || !host.isConnected) {
      document.documentElement.appendChild(host);
      mounted = true;
    }
  };

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
    const e = document.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  /** Runs only for real user input, never for events a page script made up. */
  const onTrusted = (target: HTMLElement, fn: () => void) =>
    target.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.isTrusted) fn();
    });

  function itemRow(item: SuggestItem, onPick: () => void): HTMLButtonElement {
    const row = el('button', 'row');
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.dataset.id = item.id;
    const avatar = el('span', 'avatar', (item.title.trim()[0] || '?').toUpperCase());
    const text = el('span', 'text');
    text.append(el('span', 'title', item.title || '(không tên)'), el('span', 'user', item.username || (item.hasOtp ? 'Mã OTP' : '')));
    row.append(avatar, text);
    onTrusted(row, onPick);
    return row;
  }

  // ---- state ----

  let field: HTMLInputElement | null = null;
  let state: StateReply | undefined;

  const refresh = async () => {
    state = await ask<StateReply>({ type: 'state' });
    return state;
  };

  const place = () => {
    if (!field || !field.isConnected || !visible(field)) return hideField();
    const r = field.getBoundingClientRect();
    const size = Math.min(24, Math.max(16, r.height - 8));
    badge.style.width = badge.style.height = `${size}px`;
    badge.style.left = `${r.right - size - 6}px`;
    badge.style.top = `${r.top + (r.height - size) / 2}px`;
    if (panel.style.display === 'block') {
      const below = r.bottom + 4;
      const fits = below + panel.offsetHeight < innerHeight || r.top < panel.offsetHeight;
      panel.style.left = `${Math.max(4, Math.min(r.left, innerWidth - panel.offsetWidth - 4))}px`;
      panel.style.top = `${fits ? below : r.top - panel.offsetHeight - 4}px`;
      panel.style.minWidth = `${Math.max(260, r.width)}px`;
    }
  };

  let ticker: ReturnType<typeof setInterval> | undefined;
  function showField(input: HTMLInputElement) {
    if (state && !state.prefs.icon) return;
    field = input;
    mount();
    badge.style.display = 'block';
    place();
    clearInterval(ticker);
    ticker = setInterval(place, 200); // follows layout changes the page makes
  }

  function hideField() {
    field = null;
    badge.style.display = 'none';
    panel.style.display = 'none';
    clearInterval(ticker);
  }

  async function fill(id: string) {
    const target = field;
    const reply = await ask<FillReply>({ type: 'fill', id });
    if (!reply?.ok) return;
    target?.focus();
    fillPage({
      host: location.hostname.replace(/^www\./, '').toLowerCase(),
      username: reply.username ?? '',
      password: reply.password ?? '',
      otp: reply.otp ?? '',
      scopeToFocused: !!target,
    });
    panel.style.display = 'none';
    toast.style.display = 'none';
  }

  async function openPanel() {
    if (!field) return;
    const s = await refresh();
    if (!s || !field) return;
    panel.replaceChildren();
    const head = el('div', 'head');
    const logo = el('span', 'logo');
    logo.innerHTML = LOGO;
    head.append(logo, el('span', 'grow', 'KaiPass'));
    panel.append(head);
    const role = roleOf(field);
    const items = role === 'otp' ? s.items.filter((i) => i.hasOtp) : s.items;
    if (s.locked) {
      panel.append(el('div', 'note', 'KaiPass đang khoá.'));
      const b = el('button', 'action', 'Mở khoá');
      onTrusted(b, () => void ask({ type: 'open' }));
      panel.append(b);
    } else if (items.length === 0) {
      panel.append(el('div', 'note', `Chưa có đăng nhập nào lưu cho ${s.host || 'trang này'}.`));
      const b = el('button', 'action', 'Mở KaiPass');
      onTrusted(b, () => void ask({ type: 'open' }));
      panel.append(b);
    } else {
      for (const item of items) panel.append(itemRow(item, () => void fill(item.id)));
    }
    mount();
    panel.style.display = 'block';
    place();
  }

  // ---- suggestion card (top frame only) ----

  let toastShown = false;
  async function maybeToast() {
    if (!isTop || toastShown || !hasLoginFields()) return;
    const s = await refresh();
    if (!s || s.locked || !s.prefs.toast || s.items.length === 0 || toastShown) return;
    toastShown = true;
    toast.replaceChildren();
    const head = el('div', 'head');
    const logo = el('span', 'logo');
    logo.innerHTML = LOGO;
    const title = el('span', 'grow');
    title.append(el('div', '', 'Đăng nhập bằng KaiPass'), el('div', 'sub', s.host));
    const close = el('button', 'x', '×');
    close.setAttribute('aria-label', 'Đóng');
    onTrusted(close, () => (toast.style.display = 'none'));
    head.append(logo, title, close);
    toast.append(head);
    for (const item of s.items.slice(0, 4)) {
      toast.append(
        itemRow(item, () => {
          const first = passwordFields()[0] ?? Array.from(document.querySelectorAll('input')).find((i) => roleOf(i));
          field = first ?? null;
          void fill(item.id);
        }),
      );
    }
    mount();
    toast.style.display = 'block';
  }

  // ---- offering to save what the user typed ----

  function showSaveCard(reply: SavePromptReply) {
    if (!isTop || !reply.prompt) return;
    toastShown = true;
    toast.style.display = 'none';
    saveCard.replaceChildren();
    const head = el('div', 'head');
    const logo = el('span', 'logo');
    logo.innerHTML = LOGO;
    const title = el('span', 'grow');
    title.append(
      el('div', '', reply.prompt === 'update' ? 'Cập nhật mật khẩu trong KaiPass?' : 'Lưu đăng nhập vào KaiPass?'),
      el('div', 'sub', reply.host ?? ''),
    );
    const close = el('button', 'x', '×');
    close.setAttribute('aria-label', 'Đóng');
    head.append(logo, title, close);
    const who = el('div', 'who');
    who.append(el('div', 'title', reply.username || '(không có tên đăng nhập)'), el('div', 'user', '••••••••••'));
    const buttons = el('div', 'buttons');
    const save = el('button', 'action', reply.prompt === 'update' ? 'Cập nhật' : 'Lưu');
    const later = el('button', 'ghost', 'Để sau');
    const never = el('button', 'link', 'Không bao giờ cho trang này');
    buttons.append(save, later, never);
    saveCard.append(head, who, buttons);
    const answer = (action: 'save' | 'dismiss' | 'never') => {
      saveCard.style.display = 'none';
      void ask({ type: 'saveAnswer', action });
    };
    onTrusted(save, () => answer('save'));
    onTrusted(later, () => answer('dismiss'));
    onTrusted(close, () => answer('dismiss'));
    onTrusted(never, () => answer('never'));
    mount();
    saveCard.style.display = 'block';
  }

  const usernameNear = (pw: HTMLInputElement | null, scope: ParentNode): string => {
    const fields = Array.from(scope.querySelectorAll('input')).filter((i) => roleOf(i) === 'username' && i.value);
    if (!pw) return fields[0]?.value ?? '';
    const before = fields.filter((i) => !!(i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING));
    return (before.pop() ?? fields[0])?.value ?? '';
  };

  /** Picks the password being set (sign-up, change) or used (sign-in) in a form. */
  function choosePassword(scope: ParentNode): HTMLInputElement | null {
    const all = Array.from(scope.querySelectorAll<HTMLInputElement>('input[type=password]')).filter(
      (i) => i.value && !OTP_WORDS.test(hint(i)),
    );
    if (!all.length) return null;
    const fresh = all.filter((i) => i.autocomplete === 'new-password');
    if (fresh.length) return fresh[0];
    if (all.length === 3) return all[1]; // current, new, confirm
    if (all.length === 2 && all[0].value !== all[1].value) return all[1]; // current, new
    return all[0];
  }

  let lastCapture = '';
  function capture(from: EventTarget | null) {
    const node = from instanceof Element ? from : null;
    const scope: ParentNode = (node?.closest('form') as HTMLFormElement | null) ?? document;
    const pw = choosePassword(scope) ?? (scope === document ? null : choosePassword(document));
    const username = usernameNear(pw, pw?.form ?? scope);
    if (!pw) {
      if (username) void ask({ type: 'sawUsername', username });
      return;
    }
    const key = `${username}\u0000${pw.value}`;
    if (key === lastCapture) return;
    lastCapture = key;
    void ask<SavePromptReply>({ type: 'captured', username, password: pw.value }).then((reply) => {
      // If the page stays (single-page apps), ask here; if it navigates, the next page asks.
      if (reply?.prompt) setTimeout(() => document.visibilityState === 'visible' && showSaveCard(reply), 900);
    });
  }

  document.addEventListener('submit', (e) => e.isTrusted && capture(e.target), true);
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return;
      const target = e.composedPath()[0];
      if (!(target instanceof Element) || e.composedPath().includes(host)) return;
      const button = target.closest<HTMLElement>('button, input[type=submit], input[type=button], [role=button]');
      if (!button) return;
      // Only buttons that look like they send the form, not "show password" toggles and the like.
      const label = `${button.textContent ?? ''} ${(button as HTMLInputElement).value ?? ''} ${button.getAttribute('aria-label') ?? ''}`;
      const submits =
        (button instanceof HTMLButtonElement && button.type === 'submit' && !!button.form) ||
        (button instanceof HTMLInputElement && button.type === 'submit') ||
        /log ?in|sign ?in|sign ?up|register|continue|next|submit|create|save|đăng nhập|đăng ký|tiếp|lưu|xác nhận/i.test(label);
      if (submits) capture(button);
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.isTrusted && e.key === 'Enter' && e.composedPath()[0] instanceof HTMLInputElement) capture(e.composedPath()[0]);
    },
    true,
  );

  // ---- events ----

  document.addEventListener(
    'focusin',
    (e) => {
      const target = e.composedPath()[0];
      if (target === host) return;
      const role = roleOf(target);
      if (role) {
        if (field !== target) panel.style.display = 'none';
        void refresh().then(() => showField(target as HTMLInputElement));
      }
    },
    true,
  );

  document.addEventListener(
    'focusout',
    () => {
      setTimeout(() => {
        const active = document.activeElement;
        if (active !== host && active !== field) hideField();
      }, 150);
    },
    true,
  );

  // Clicking into a login field opens the list, like a browser's own suggestions.
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!e.isTrusted || e.composedPath()[0] === host) return;
      const target = e.composedPath()[0];
      if (roleOf(target)) {
        void refresh().then(() => {
          showField(target as HTMLInputElement);
          if (state && !state.locked && state.items.length > 0) void openPanel();
        });
      } else if (!e.composedPath().includes(host)) {
        panel.style.display = 'none';
      }
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted) return;
      if (e.key === 'Escape') panel.style.display = 'none';
      if (e.key === 'ArrowDown' && field && e.composedPath()[0] === field && panel.style.display !== 'block') {
        e.preventDefault();
        void openPanel();
      }
    },
    true,
  );

  onTrusted(badge, () => {
    if (panel.style.display === 'block') panel.style.display = 'none';
    else void openPanel();
  });
  // Keep the field focused while the user presses our button.
  badge.addEventListener('mousedown', (e) => e.preventDefault());
  panel.addEventListener('mousedown', (e) => e.preventDefault());

  addEventListener('scroll', place, { capture: true, passive: true });
  addEventListener('resize', place, { passive: true });

  // Login forms often appear after the page loads (single-page apps, modals).
  let pending: ReturnType<typeof setTimeout> | undefined;
  new MutationObserver(() => {
    clearTimeout(pending);
    pending = setTimeout(() => void maybeToast(), 400);
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (isTop) {
    void ask<SavePromptReply>({ type: 'pendingSave' }).then((reply) => {
      if (reply?.prompt) showSaveCard(reply);
      else void maybeToast();
    });
  } else {
    void maybeToast();
  }
})();
