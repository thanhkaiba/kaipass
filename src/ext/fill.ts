export interface FillRequest {
  /** Host of the tab the user asked to fill. Frames on other sites are left alone. */
  host: string;
  username: string;
  password: string;
  /** Current one-time code, or '' */
  otp: string;
  /** Only fill the form that holds the focused field (used by the in-page suggestion list). */
  scopeToFocused?: boolean;
}

export interface FillResult {
  username: boolean;
  password: boolean;
  otp: boolean;
}

/**
 * Runs inside the web page (injected with chrome.scripting), so it must not reference anything
 * outside its own body.
 */
export function fillPage(req: FillRequest): FillResult {
  const done: FillResult = { username: false, password: false, otp: false };
  const here = location.hostname.replace(/^www\./, '').toLowerCase();
  if (here !== req.host && !here.endsWith(`.${req.host}`) && !req.host.endsWith(`.${here}`)) return done;

  const usable = (el: HTMLInputElement): boolean => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      box.width > 0 &&
      box.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      !el.disabled &&
      !el.readOnly
    );
  };

  const put = (el: HTMLInputElement, value: string): void => {
    el.focus();
    // Frameworks such as React watch the native setter, not plain assignment.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const hint = (el: HTMLInputElement): string =>
    [el.name, el.id, el.autocomplete, el.placeholder, el.getAttribute('aria-label') ?? '']
      .join(' ')
      .toLowerCase();

  const kind = (el: HTMLInputElement): string => (el.getAttribute('type') ?? 'text').toLowerCase();
  const textLike = (el: HTMLInputElement): boolean => ['text', 'email', 'tel', 'number'].includes(kind(el));
  const otpWords = /otp|totp|2fa|mfa|one-?time|verif|authenticator|security.?code|passcode|token|(^|[^a-z])code/;
  const userWords = /user|email|e-mail|login|account|identifier|phone|(^|[^a-z])id($|[^a-z])/;
  const isOtp = (el: HTMLInputElement): boolean =>
    el.autocomplete === 'one-time-code' ||
    ((textLike(el) || kind(el) === 'password') && otpWords.test(hint(el)) && !userWords.test(hint(el)));

  const focused = document.activeElement;
  const scope =
    req.scopeToFocused && focused instanceof HTMLInputElement && focused.form ? focused.form : document;
  const inputs = Array.from(scope.querySelectorAll('input')).filter(usable);

  // Password: the first field that is not a "choose a new password" box or a code box.
  const passwordField = inputs.find(
    (el) => kind(el) === 'password' && el.autocomplete !== 'new-password' && !isOtp(el),
  );
  if (passwordField && req.password) {
    put(passwordField, req.password);
    done.password = true;
  }

  // Username: the text box just before the password, or, on a username-only step, the one that
  // says it wants a username.
  if (req.username) {
    const candidates = inputs.filter((el) => textLike(el) && kind(el) !== 'number' && !isOtp(el));
    let userField: HTMLInputElement | undefined;
    if (passwordField) {
      const scope = passwordField.form;
      userField = candidates
        .filter((el) => (scope ? el.form === scope : true))
        .filter((el) => !!(el.compareDocumentPosition(passwordField) & Node.DOCUMENT_POSITION_FOLLOWING))
        .pop();
    } else {
      userField = candidates.find(
        (el) => el.autocomplete === 'username' || el.autocomplete === 'email' || kind(el) === 'email' || userWords.test(hint(el)),
      );
    }
    if (userField) {
      put(userField, req.username);
      done.username = true;
    }
  }

  // One-time code: a single code box, or one box per digit.
  if (req.otp) {
    const codeBoxes = inputs.filter(isOtp);
    const digitBoxes = inputs.filter((el) => el.maxLength === 1 && (textLike(el) || kind(el) === 'password'));
    if (digitBoxes.length === req.otp.length) {
      digitBoxes.forEach((el, i) => put(el, req.otp[i]));
      done.otp = true;
    } else if (codeBoxes.length > 0) {
      put(codeBoxes[0], req.otp);
      done.otp = true;
    }
  }

  if (passwordField && done.password) passwordField.focus();
  return done;
}
