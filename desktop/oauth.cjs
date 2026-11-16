/**
 * Google sign-in for the desktop app. Google refuses its sign-in page inside an app's own window,
 * so this follows Google's flow for installed apps: open the system browser, receive the answer on
 * a one-shot local address (127.0.0.1), and exchange it for tokens (with PKCE). The refresh token
 * lets the app get new access tokens quietly from then on.
 *
 * No Electron in here, so it can be tested with plain Node.
 */
const crypto = require('node:crypto');
const http = require('node:http');

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const DONE_PAGE = (ok, text) => `<!doctype html><html lang="vi"><meta charset="utf-8"><title>KaiPass</title>
<body style="font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#f4f6fb;color:#121826">
<div style="text-align:center;padding:32px;background:#fff;border-radius:18px;box-shadow:0 18px 40px -12px rgb(16 24 40/.28)">
<div style="font-size:40px">${ok ? '✅' : '⚠️'}</div><h1 style="font-size:20px">${text}</h1>
<p style="color:#667085">Bạn có thể đóng tab này và quay lại KaiPass.</p></div></body></html>`;

class OAuthError extends Error {}

async function tokenRequest(endpoints, params) {
  let res;
  try {
    res = await fetch(endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  } catch {
    throw new OAuthError('Không kết nối được tới Google (kiểm tra mạng)');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = body.error || `HTTP ${res.status}`;
    const e = new OAuthError(
      code === 'invalid_grant'
        ? 'Phiên đăng nhập Google đã hết hạn hoặc bị thu hồi, hãy đăng nhập lại'
        : code === 'invalid_client'
          ? 'Google không nhận Client ID / secret này (cần client loại "Desktop app")'
          : `Google báo lỗi: ${body.error_description || code}`,
    );
    e.code = code;
    throw e;
  }
  return body;
}

/**
 * Runs the whole sign-in. `open(url)` shows the address in the user's browser.
 * Resolves with { accessToken, expiresIn, refreshToken }.
 */
function signIn({ clientId, clientSecret, open, endpoints, timeoutMs = 5 * 60_000 }) {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(18));

  return new Promise((resolve, reject) => {
    let redirect = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Let the browser's reply go out before the server closes.
      setTimeout(() => server.close(), 200);
      fn(value);
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const html = (ok, text) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(DONE_PAGE(ok, text));
      };
      // Only the answer to the request this app just made counts.
      if (url.searchParams.get('state') !== state) {
        html(false, 'Yêu cầu đăng nhập không khớp');
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error || !code) {
        html(false, 'Chưa đăng nhập được');
        finish(reject, new OAuthError(error === 'access_denied' ? 'Bạn chưa cấp quyền Google Drive cho KaiPass' : `Google báo lỗi: ${error || 'không có mã'}`));
        return;
      }
      tokenRequest(endpoints, {
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirect,
      }).then(
        (t) => {
          if (!String(t.scope || SCOPE).split(' ').includes(SCOPE)) {
            html(false, 'Chưa cấp quyền Google Drive');
            finish(reject, new OAuthError('Bạn chưa tích quyền Google Drive cho KaiPass'));
            return;
          }
          html(true, 'Đã đăng nhập Google');
          finish(resolve, { accessToken: t.access_token, expiresIn: Number(t.expires_in) || 3600, refreshToken: t.refresh_token || '' });
        },
        (e) => {
          html(false, 'Chưa đăng nhập được');
          finish(reject, e);
        },
      );
    });
    const timer = setTimeout(() => finish(reject, new OAuthError('Hết thời gian chờ đăng nhập Google')), timeoutMs);
    server.on('error', (e) => finish(reject, e));
    // Loopback only, on a port the system picks.
    server.listen(0, '127.0.0.1', () => {
      redirect = `http://127.0.0.1:${server.address().port}`;
      const query = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: 'code',
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        prompt: 'consent',
      });
      Promise.resolve(open(`${endpoints.auth}?${query}`)).catch((e) => finish(reject, e));
    });
  });
}

async function refresh({ clientId, clientSecret, refreshToken, endpoints }) {
  const t = await tokenRequest(endpoints, {
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  return { accessToken: t.access_token, expiresIn: Number(t.expires_in) || 3600 };
}

/** Reads the JSON file Google Cloud offers for a "Desktop app" client. */
function parseClientFile(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new OAuthError('File này không phải file JSON của Google');
  }
  if (j.web) throw new OAuthError('Đây là client loại "Web application". Hãy tạo client loại "Desktop app".');
  const c = j.installed || j;
  const clientId = c.client_id || c.clientId;
  const clientSecret = c.client_secret || c.clientSecret || '';
  if (!clientId || !/\.apps\.googleusercontent\.com$/.test(clientId)) throw new OAuthError('Không thấy Client ID trong file');
  if (!clientSecret) throw new OAuthError('File không có client secret. Đây có phải client loại "Desktop app" không?');
  return { clientId, clientSecret };
}

const GOOGLE = { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token' };

module.exports = { signIn, refresh, parseClientFile, OAuthError, GOOGLE, SCOPE };
