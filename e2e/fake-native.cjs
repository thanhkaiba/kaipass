// A stand-in for the Android app's native side (WebHostActivity.kt), for tests in a desktop browser.
/** Stands in for WebHostActivity.kt. State lives here, so it survives page reloads. */
function fakeNative() {
  const n = {
    calls: [],
    index: null,
    indexClears: 0,
    bio: null,
    bioFails: false,
    autofill: false,
    copies: [],
    files: [],
    pendingSave: null,
    /** Several logins waiting, as the app's list holds them; `pendingSave` is a one-off. */
    pendingQueue: [],
    saveDone: [],
  };
  n.handle = (method, args) => {
    n.calls.push(method);
    const info = () => ({ platform: 'android', version: '0.1.0', sdk: 35, package: 'io.github.thanhkaiba.kaipass', sha1: 'DC:A5:E3:99', autofill: { supported: true, enabled: n.autofill }, bio: { available: true, enrolled: !!n.bio } });
    switch (method) {
      case 'hello':
      case 'info':
        return info();
      case 'googleToken':
        return { token: 'fake-token', expiresIn: 3300 };
      case 'bioEnroll':
        n.bio = args.password;
        return true;
      case 'bioUnlock':
        if (!n.bio || n.bioFails) throw new Error('Đã huỷ');
        return { password: n.bio };
      case 'bioDisable':
        n.bio = null;
        return true;
      case 'copy':
        n.copies.push(args);
        return true;
      case 'saveFile':
        n.files.push(args);
        return { saved: true };
      case 'setFillIndex':
        n.index = args;
        return true;
      case 'clearFillIndex':
        n.index = null;
        n.indexClears++;
        return true;
      case 'touch':
        return true;
      case 'openAutofillSettings':
        n.autofill = true;
        return true;
      case 'pendingSave':
        return n.pendingQueue[0] ?? n.pendingSave;
      case 'saveDone':
        n.saveDone.push(args);
        n.pendingSave = null;
        n.pendingQueue = n.pendingQueue.filter((p) => p.id !== args.id);
        return true;
      default:
        throw new Error(`Không hỗ trợ: ${method}`);
    }
  };
  return n;
}

// Mirrors what addWebMessageListener injects: an object with postMessage() and onmessage.
const BRIDGE = `
window.KaiPassNative = {
  onmessage: null,
  postMessage(raw) {
    const { id } = JSON.parse(raw);
    window.__nativeCall(raw).then((res) => this.onmessage && this.onmessage({ data: JSON.stringify({ id, ...res }) }));
  },
};
window.__emit = (event, data) => window.KaiPassNative.onmessage({ data: JSON.stringify({ event, data: data || {} }) });
`;


module.exports = { fakeNative, BRIDGE };
