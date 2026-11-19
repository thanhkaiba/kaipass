/**
 * Content script: runs in every web page and frame. It adds the KaiPass button to login fields,
 * shows the list of matching logins, and a suggestion card on login pages.
 *
 * It holds no secrets of its own. It asks the background worker for the logins that match this
 * frame (titles and usernames only) and, once the user clicks one, for that login's credentials.
 * Everything it draws lives in a closed shadow root so the page cannot read or restyle it, and it
 * only acts on real (trusted) clicks and key presses.
 */
import { defaultGen, generatePassword } from '../lib/generator';
import { emailsIn, saysEmailCode } from '../lib/mailOtp';
import { fillPage } from './fill';
import type { FillReply, MailOtpReply, Request, SavePromptReply, StateReply, SuggestItem } from './match';

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

  type FieldRole = 'username' | 'password' | 'otp' | 'newpassword';

  // ---- fields that set a new password (sign-up, change or reset password) ----

  const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const NEW_WORDS = /new|moi($|[^a-z])|create|choose/;
  const CONFIRM_WORDS = /confirm|repeat|retype|again|verify|re-?enter|nhap.?lai|xac.?nhan|pass(word)?.?2/;
  const CURRENT_WORDS = /current|old|existing|hien.?tai|(^|[^a-z])cu($|[^a-z])/;
  const SIGNUP_WORDS = /sign.?up|register|registration|create.?account|new.?account|join|dang.?ky|tao.?tai.?khoan|reset.?pass|change.?pass|doi.?mat.?khau|dat.?lai/;

  /** Whether a form with a single password box is for making an account or a new password. */
  function looksLikeSignup(el: HTMLInputElement): boolean {
    const form = el.form;
    const labels = form
      ? Array.from(form.querySelectorAll<HTMLElement>('button, input[type=submit], [role=button]')).map((b) => `${b.textContent ?? ''} ${(b as HTMLInputElement).value ?? ''}`)
      : [];
    return SIGNUP_WORDS.test(fold([form?.getAttribute('action') ?? '', form?.id ?? '', form?.className ?? '', form?.getAttribute('name') ?? '', location.pathname, ...labels].join(' ')));
  }

  /**
   * The boxes a newly generated password belongs in (the new password and its confirmation), given
   * one of them. Empty when `el` is a box for a password the user already has.
   */
  function newPasswordFields(el: HTMLInputElement): HTMLInputElement[] {
    if (kind(el) !== 'password') return [];
    const h = (i: HTMLInputElement) => fold(hint(i));
    const all = Array.from((el.form ?? document).querySelectorAll<HTMLInputElement>('input[type=password]')).filter(
      (i) => visible(i) && !i.disabled && !i.readOnly && i.autocomplete !== 'one-time-code' && !OTP_WORDS.test(hint(i)),
    );
    const isCurrent = (i: HTMLInputElement) => i.autocomplete === 'current-password' || CURRENT_WORDS.test(h(i));
    const isNew = (i: HTMLInputElement) => i.autocomplete === 'new-password' || NEW_WORDS.test(h(i));
    const isConfirm = (i: HTMLInputElement) => CONFIRM_WORDS.test(h(i));
    let fresh: HTMLInputElement[];
    if (all.length === 1) {
      fresh = !isCurrent(all[0]) && (isNew(all[0]) || looksLikeSignup(all[0])) ? all : [];
    } else if (all.length === 2) {
      const [a, b] = all;
      if (isCurrent(a)) fresh = [b];
      else if (isConfirm(b) || isNew(a)) fresh = all; // password + confirmation
      else if (isNew(b)) fresh = [b]; // current + new
      else fresh = all;
    } else {
      // Usually: current, new, confirmation.
      fresh = all.some(isCurrent) || !isNew(all[0]) ? all.filter((i, n) => !isCurrent(i) && (n > 0 || isNew(i))) : all;
    }
    return fresh.includes(el) ? fresh : [];
  }

  function roleOf(el: EventTarget | null): FieldRole | null {
    if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly || !visible(el)) return null;
    const h = hint(el);
    if (el.autocomplete === 'one-time-code' || ((textLike(el) || kind(el) === 'password') && OTP_WORDS.test(h) && !USER_WORDS.test(h))) {
      return 'otp';
    }
    if (kind(el) === 'password') {
      if (newPasswordFields(el).length) return 'newpassword';
      return el.autocomplete === 'new-password' ? null : 'password';
    }
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
  .toast, .save, .mail { position: fixed; top: 12px; right: 12px; width: 320px; display: none; padding: 10px; border-radius: 12px;
    background: #fff; color: #1b2030; border: 1px solid #d9dee8; box-shadow: 0 10px 28px rgb(0 0 0 / 22%); }
  /* Sign-in suggestions sit at the top centre, where the eye already is; save prompts stay in the corner. */
  .toast, .mail { right: auto; left: 50%; transform: translateX(-50%); width: 340px; max-width: calc(100vw - 24px); }
  .toast.corner, .mail.corner { left: auto; right: 12px; transform: none; }
  .mail .code { font: 600 20px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 0.08em; }
  .mail .wait { display: flex; align-items: center; gap: 8px; padding: 4px 8px 8px; color: #5d667a; }
  .mail .spin { width: 14px; height: 14px; flex: none; border-radius: 50%; border: 2px solid #c9d2e3; border-top-color: #2f6bff; animation: kp-spin 0.8s linear infinite; }
  @keyframes kp-spin { to { transform: rotate(360deg); } }
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
  .gen { display: flex; align-items: center; gap: 6px; margin: 0 4px 8px; padding: 8px 6px 8px 10px; border-radius: 8px; background: #eef1f6; }
  .gen .pw { flex: 1; min-width: 0; font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; user-select: all; }
  .gen .again { flex: none; width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: #5d667a; font-size: 16px; line-height: 1; }
  .gen .again:hover { background: #dfe5ef; }
  .wide { display: block; width: calc(100% - 8px); margin: 0 4px 4px; padding: 9px 12px; border: 0; border-radius: 8px; background: #2f6bff; color: #fff; font-weight: 600; }
  .avatar.brand { font-size: 12px; box-shadow: inset 0 0 0 1px rgb(127 127 127 / 18%); }
  .avatar.brand svg { width: 17px; height: 17px; display: block; }
  .text { display: flex; flex-direction: column; min-width: 0; }
  .title, .user { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title { font-weight: 600; }
  .user { font-size: 12px; color: #5d667a; }
  .note { padding: 8px; color: #5d667a; }
  .action { margin: 4px 8px 6px; padding: 7px 12px; border: 0; border-radius: 8px; background: #2f6bff; color: #fff; font-weight: 600; }
  .x { margin-left: auto; width: 26px; height: 26px; border: 0; border-radius: 6px; background: transparent; color: #5d667a; font-size: 18px; line-height: 1; }
  .x:hover { background: #eef1f6; }
  .toast .list { max-height: 340px; overflow: auto; }
  .more { width: 100%; margin-top: 4px; padding: 8px; border: 0; border-radius: 8px; background: transparent; color: #2f6bff; font-weight: 600; }
  .more:hover { background: #e9f0ff; }
  .who { margin: 0 4px 10px; padding: 8px 10px; border-radius: 8px; background: #eef1f6; }
  .who .user { font-size: 13px; }
  .buttons { display: flex; gap: 6px; flex-wrap: wrap; padding: 0 4px 2px; }
  .buttons .action { margin: 0; }
  .ghost { padding: 7px 12px; border: 1px solid #d9dee8; border-radius: 8px; background: transparent; color: #1b2030; }
  .link { padding: 7px 4px; border: 0; background: transparent; color: #5d667a; font-size: 12px; }
  @media (prefers-color-scheme: dark) {
    .panel, .toast, .save, .mail { background: #1b1f2a; color: #e8ebf2; border-color: #323a4c; }
    .ghost { color: #e8ebf2 !important; border-color: #323a4c !important; }
    .who { background: #242a38 !important; }
    .row:hover, .row:focus-visible { background: #1f2d4a; }
    .avatar:not(.brand) { background: #242a38; color: #6a9cf5; }
    .gen { background: #242a38; }
    .gen .again { color: #9aa3b8; }
    .gen .again:hover { background: #323a4c; }
    .user, .note, .head .sub, .x { color: #9aa3b8; }
    .x:hover { background: #242a38; }
  }
</style>
<button class="badge" part="badge" title="KaiPass" aria-label="KaiPass"></button>
<div class="panel" role="listbox" aria-label="KaiPass"></div>
<div class="toast" role="dialog" aria-label="KaiPass"></div>
<div class="save" role="dialog" aria-label="Lưu vào KaiPass"></div>
<div class="mail" role="dialog" aria-label="Mã từ email"></div>`;
  const LOGO = `<svg viewBox="0 0 512 512" aria-hidden="true"><rect x="116" y="126" width="280" height="260" rx="36" fill="none" stroke="#fff" stroke-width="34"/><circle cx="256" cy="256" r="58" fill="none" stroke="#fff" stroke-width="34"/></svg>`;
  const badge = root.querySelector<HTMLButtonElement>('.badge')!;
  const panel = root.querySelector<HTMLDivElement>('.panel')!;
  const toast = root.querySelector<HTMLDivElement>('.toast')!;
  const mailCard = root.querySelector<HTMLDivElement>('.mail')!;
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
    const avatar = el('span', 'avatar', item.brand?.path ? undefined : item.brand?.letter ?? (item.title.trim()[0] || '?').toUpperCase());
    if (item.brand) {
      avatar.classList.add('brand');
      avatar.style.background = item.brand.bg;
      avatar.style.color = item.brand.ink;
      if (item.brand.path) {
        // Built from our own bundled data with DOM calls, never from page text or innerHTML.
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'currentColor');
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', item.brand.path);
        svg.append(path);
        avatar.append(svg);
      }
    }
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
      // The browser's own saved-password list always opens below the field and is drawn above
      // the page, so ours goes above the field whenever there is room.
      const above = r.top - panel.offsetHeight - 6;
      const below = r.bottom + 6;
      const top = above >= 4 ? above : below;
      panel.dataset.side = above >= 4 ? 'above' : 'below';
      panel.style.left = `${Math.max(4, Math.min(r.left, innerWidth - panel.offsetWidth - 4))}px`;
      panel.style.top = `${top}px`;
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

  const here = () => location.hostname.replace(/^www\./, '').toLowerCase();
  const SUBMIT_WORDS = /log ?in|sign ?in|continue|next|submit|verify|confirm|dang nhap|tiep|xac nhan|gui/;
  const labelOf = (b: HTMLElement) => fold(`${b.textContent ?? ''} ${(b as HTMLInputElement).value ?? ''} ${b.getAttribute('aria-label') ?? ''}`);
  const pressable = (b: HTMLElement) => visible(b) && !(b as HTMLButtonElement).disabled && b.getAttribute('aria-disabled') !== 'true';

  /** Presses the button that sends the form `input` is in, the way the user would. */
  function submitFrom(input: HTMLInputElement) {
    if (!input.isConnected) return;
    const form = input.form;
    if (form) {
      const buttons = Array.from(form.querySelectorAll<HTMLElement>('button[type=submit], button:not([type]), input[type=submit]')).filter(pressable);
      const button = buttons.find((b) => SUBMIT_WORDS.test(labelOf(b))) ?? (buttons.length === 1 ? buttons[0] : undefined);
      if (button) button.click();
      else if (buttons.length === 0 && typeof form.requestSubmit === 'function') form.requestSubmit();
      else buttons[0]?.click();
      return;
    }
    // No <form>: the closest box around the field that has a button reading like "sign in".
    let box: HTMLElement | null = input.parentElement;
    for (let depth = 0; box && depth < 5; depth++, box = box.parentElement) {
      const button = Array.from(box.querySelectorAll<HTMLElement>('button, input[type=submit], input[type=button], [role=button]')).filter(pressable).find((b) => SUBMIT_WORDS.test(labelOf(b)));
      if (button) return button.click();
    }
  }

  /** After a fill: sign in for the user, unless the form still waits for something they must type. */
  function submitSoon(done: { username: boolean; password: boolean; otp: boolean }, near: HTMLInputElement | null) {
    if (!state?.prefs.autoSubmit || !(done.username || done.password || done.otp)) return;
    setTimeout(() => {
      const scope: ParentNode = near?.form ?? document;
      const inputs = Array.from(scope.querySelectorAll('input')).filter((i) => visible(i) && !i.disabled);
      // A password or code box left empty means there is nothing to send yet.
      if (inputs.some((i) => !i.value && (roleOf(i) === 'password' || (done.otp && roleOf(i) === 'otp')))) return;
      const anchor = (done.otp ? inputs.find((i) => roleOf(i) === 'otp') : undefined) ?? inputs.find((i) => roleOf(i) === 'password') ?? inputs.find((i) => roleOf(i) === 'username') ?? near;
      if (anchor) submitFrom(anchor);
    }, 350); // lets the page's own scripts notice the new values first
  }

  /** null until asked: whether a sign-in the user started is being carried through this tab. */
  let flowOn: boolean | null = null;
  const stepDone = { password: false, otp: false };

  async function fill(id: string) {
    const target = field;
    const reply = await ask<FillReply>({ type: 'fill', id });
    if (!reply?.ok) return;
    target?.focus();
    const done = fillPage({
      host: here(),
      username: reply.username ?? '',
      password: reply.password ?? '',
      otp: reply.otp ?? '',
      scopeToFocused: !!target,
    });
    panel.style.display = 'none';
    toast.style.display = 'none';
    if (state?.prefs.autoSubmit) {
      flowOn = true;
      stepDone.password ||= done.password;
      stepDone.otp ||= done.otp;
      void ask({ type: 'flowStep', ...done });
      submitSoon(done, target);
    }
  }

  /**
   * The user picked a login a moment ago (here or on the page before) and the sign-in now shows
   * its next step: fill the password, or the code, and carry on. Each step happens once.
   */
  let continuing = false;
  async function maybeContinue(): Promise<boolean> {
    if (continuing || flowOn === false) return false;
    const empty = (role: FieldRole) => Array.from(document.querySelectorAll('input')).find((i) => roleOf(i) === role && !i.value) ?? null;
    // A code the site emailed is not the authenticator's: that one comes from the mailbox (below).
    const otpBox = stepDone.otp || pageSaysEmailCode() ? null : empty('otp');
    const pwBox = stepDone.password ? null : empty('password');
    const want = otpBox ? 'otp' : pwBox ? 'password' : null;
    if (!want) return false;
    continuing = true;
    try {
      if (flowOn === null) flowOn = !!(await refresh())?.flow;
      if (!flowOn) return false;
      stepDone[want] = true;
      const reply = await ask<FillReply>({ type: 'flow', want });
      if (!reply?.ok) return false;
      if (!state) await refresh();
      const done = fillPage({
        host: here(),
        username: want === 'password' ? (reply.username ?? '') : '',
        password: want === 'password' ? (reply.password ?? '') : '',
        otp: reply.otp ?? '',
      });
      stepDone.otp ||= done.otp;
      toastShown = true;
      toast.style.display = 'none';
      submitSoon(done, want === 'otp' ? otpBox : pwBox);
      return done.password || done.otp;
    } finally {
      continuing = false;
    }
  }

  const put = (input: HTMLInputElement, value: string) => {
    // Frameworks such as React watch the native setter, not plain assignment.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  /** Puts a generated password in the new-password box and its confirmation, then offers to save it. */
  function useGenerated(value: string) {
    const target = field;
    if (!target) return;
    const boxes = newPasswordFields(target);
    for (const b of boxes.length ? boxes : [target]) put(b, value);
    panel.style.display = 'none';
    // Ask to save straight away, so the password cannot be lost if the page moves on. Submitting
    // the form later asks again only if it was not saved (or the username was typed afterwards).
    const username = usernameNear(target, target.form ?? document);
    void ask<SavePromptReply>({ type: 'captured', username, password: value }).then((reply) => {
      if (reply?.prompt) showSaveCard(reply);
    });
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
    if (role === 'newpassword' && !s.locked) {
      // A box for a new password: offer a strong one instead of the saved logins.
      let value = generatePassword(defaultGen);
      const box = el('div', 'gen');
      const shown = el('span', 'pw', value);
      const again = el('button', 'again', '↻');
      again.setAttribute('aria-label', 'Tạo mật khẩu khác');
      again.title = 'Tạo mật khẩu khác';
      onTrusted(again, () => {
        value = generatePassword(defaultGen);
        shown.textContent = value;
      });
      box.append(shown, again);
      const use = el('button', 'wide', 'Dùng mật khẩu mạnh này');
      onTrusted(use, () => useGenerated(value));
      panel.append(el('div', 'note', 'KaiPass tạo mật khẩu mới cho bạn:'), box, use);
    } else if (s.locked) {
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

  /**
   * Top centre is where the eye is, but never on top of the page's own boxes and buttons: a card
   * that would cover one moves to the corner.
   */
  function dodge(card: HTMLElement) {
    card.classList.remove('corner');
    const c = card.getBoundingClientRect();
    const covers = Array.from(document.querySelectorAll<HTMLElement>('input, button, select, textarea, [role=button]')).some((n) => {
      if (!visible(n)) return false;
      const r = n.getBoundingClientRect();
      return r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top;
    });
    card.classList.toggle('corner', covers);
  }

  // ---- suggestion card (top frame only) ----

  let toastShown = false;
  async function maybeToast() {
    if (!isTop || toastShown || !hasLoginFields()) return;
    // A sign-up or change-password page is not the place to suggest signing in.
    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[type=password]')).filter(visible);
    if (boxes.length && boxes.every((b) => roleOf(b) === 'newpassword')) return;
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
    const list = el('div', 'list');
    const addRow = (item: SuggestItem) =>
      list.append(
        itemRow(item, () => {
          const first = passwordFields()[0] ?? Array.from(document.querySelectorAll('input')).find((i) => roleOf(i));
          field = first ?? null;
          void fill(item.id);
        }),
      );
    const SHOWN = 4;
    s.items.slice(0, SHOWN).forEach(addRow);
    toast.append(list);
    if (s.items.length > SHOWN) {
      const more = el('button', 'more', `Xem thêm ${s.items.length - SHOWN} tài khoản`);
      onTrusted(more, () => {
        s.items.slice(SHOWN).forEach(addRow);
        more.remove();
      });
      toast.append(more);
    }
    mount();
    toast.style.display = 'block';
    dodge(toast);
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
          const wantsNew = roleOf(target) === 'newpassword' && !(target as HTMLInputElement).value;
          if (state && !state.locked && (state.items.length > 0 || wantsNew)) void openPanel();
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

  // ---- a code the site sent by email, read from a linked mailbox ----

  const pageText = () => (document.body?.innerText ?? '').slice(0, 8000);
  const pageSaysEmailCode = () => saysEmailCode(pageText());
  const emptyOtpBox = () => Array.from(document.querySelectorAll('input')).find((i) => roleOf(i) === 'otp' && !i.value) ?? null;

  function mailHead(sub: string) {
    const head = el('div', 'head');
    const logo = el('span', 'logo');
    logo.innerHTML = LOGO;
    const title = el('span', 'grow');
    title.append(el('div', '', 'Mã từ email'), el('div', 'sub', sub));
    const close = el('button', 'x', '×');
    close.setAttribute('aria-label', 'Đóng');
    onTrusted(close, () => {
      mailStopped = true;
      mailCard.style.display = 'none';
    });
    head.append(logo, title, close);
    return head;
  }

  const showMail = (...nodes: Node[]) => {
    mailCard.replaceChildren(...nodes);
    toast.style.display = 'none';
    toastShown = true;
    mount();
    mailCard.style.display = 'block';
    dodge(mailCard);
  };

  function useMailCode(code: string, id: string | undefined, box: HTMLInputElement | null) {
    const done = fillPage({ host: here(), username: '', password: '', otp: code });
    if (id && done.otp) void ask({ type: 'mailUsed', id });
    mailCard.style.display = 'none';
    mailStopped = true;
    submitSoon(done, box);
  }

  let mailRunning = false;
  let mailStopped = false;
  /**
   * The page has a code box and says the code was emailed: ask the background worker, which looks
   * in a linked mailbox only if this sign-in uses that address. Waits for the message to arrive.
   */
  async function maybeMailCode() {
    if (mailRunning || mailStopped || !isTop) return;
    if (!emptyOtpBox() || !pageSaysEmailCode()) return;
    mailRunning = true;
    // The message may have been sent a moment before this page appeared.
    const since = Date.now() - 90_000;
    const seen = emailsIn(pageText());
    try {
      for (let tries = 0; tries < 40 && !mailStopped; tries++) {
        const box = emptyOtpBox();
        if (!box) break; // the user typed it, or the page moved on
        const reply = await ask<MailOtpReply>({ type: 'mailOtp', since, seen });
        if (!reply || reply.status === 'none') break;
        if (reply.status === 'found' && reply.code) {
          if (!state) await refresh();
          if (reply.auto && state?.prefs.autoSubmit) {
            useMailCode(reply.code, reply.id, box);
            break;
          }
          const row = el('button', 'row');
          row.type = 'button';
          const text = el('span', 'text');
          text.append(el('span', 'code', reply.code), el('span', 'user', `${reply.from || 'Email'} · bấm để điền`));
          row.append(text);
          const { code, id } = reply;
          onTrusted(row, () => useMailCode(code, id, emptyOtpBox()));
          showMail(mailHead(reply.email ?? ''), row);
          break;
        }
        if (reply.status === 'auth' && reply.email) {
          const again = el('button', 'action', 'Đăng nhập lại Gmail');
          const email = reply.email;
          onTrusted(again, () => {
            mailCard.style.display = 'none';
            void ask({ type: 'mailAuth', email }).then(() => {
              mailRunning = false;
              mailStopped = false;
              void maybeMailCode();
            });
          });
          showMail(mailHead(reply.email), el('div', 'note', 'KaiPass cần bạn đăng nhập lại Gmail để đọc mã.'), again);
          return; // waits for the click; mailRunning stays set
        }
        if (reply.status === 'error') {
          showMail(mailHead(reply.email ?? ''), el('div', 'note', reply.error || 'Không đọc được hộp thư'));
          break;
        }
        const wait = el('div', 'wait');
        wait.append(el('span', 'spin'), el('span', '', 'Đang chờ thư có mã…'));
        showMail(mailHead(reply.email ?? ''), wait);
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (mailCard.querySelector('.wait')) mailCard.style.display = 'none'; // gave up waiting
    } finally {
      if (!mailCard.querySelector('.action')) mailRunning = false;
      mailStopped = true; // one look per page
    }
  }

  /** Carry on a sign-in already under way; otherwise offer the saved logins. */
  const onPageChange = async () => {
    if (!(await maybeContinue())) await maybeToast();
    void maybeMailCode();
  };

  // Login forms often appear after the page loads (single-page apps, modals).
  let pending: ReturnType<typeof setTimeout> | undefined;
  new MutationObserver(() => {
    clearTimeout(pending);
    pending = setTimeout(() => void onPageChange(), 400);
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (isTop) {
    void ask<SavePromptReply>({ type: 'pendingSave' }).then((reply) => {
      if (reply?.prompt) showSaveCard(reply);
      else void onPageChange();
    });
  } else {
    void onPageChange();
  }
})();
