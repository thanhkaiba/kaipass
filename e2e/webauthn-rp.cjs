// A small relying party for tests: a page that creates and uses passkeys with the plain browser
// API, and a server side that checks every answer with a real WebAuthn library.
const { randomBytes } = require('node:crypto');

const b64 = (b) => Buffer.from(b).toString('base64url');

/** The page a site would have: three buttons and the result in #out. */
const PAGE = `<h1>Passkey test site</h1>
<input id="user" autocomplete="username webauthn" placeholder="Email">
<button id="create" style="margin-top:260px;display:block">Create a passkey</button>
<button id="signin">Sign in with a passkey</button>
<button id="quiet">Passkey autofill</button>
<pre id="out"></pre>
<script>
  const dec = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const enc = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  const out = (t) => (document.getElementById('out').textContent = t);
  const send = async (path, body) => (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  document.getElementById('create').onclick = async () => {
    out('…');
    try {
      const o = await (await fetch('/pk/register-options')).json();
      const c = await navigator.credentials.create({ publicKey: { ...o, challenge: dec(o.challenge), user: { ...o.user, id: dec(o.user.id) }, excludeCredentials: o.excludeCredentials.map((x) => ({ ...x, id: dec(x.id) })) } });
      const r = await send('/pk/register', { id: c.id, rawId: enc(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(), response: { clientDataJSON: enc(c.response.clientDataJSON), attestationObject: enc(c.response.attestationObject), transports: c.response.getTransports() } });
      out(JSON.stringify({ ...r, isPublicKeyCredential: c instanceof PublicKeyCredential, isAttestation: c.response instanceof AuthenticatorAttestationResponse, json: typeof c.toJSON().response.attestationObject }));
    } catch (e) { out('error: ' + e.name); }
  };
  const signIn = (mediation) => async () => {
    out('…');
    try {
      const o = await (await fetch('/pk/login-options')).json();
      const c = await navigator.credentials.get({ mediation, publicKey: { ...o, challenge: dec(o.challenge) } });
      const r = await send('/pk/login', { id: c.id, rawId: enc(c.rawId), type: c.type, clientExtensionResults: {}, response: { clientDataJSON: enc(c.response.clientDataJSON), authenticatorData: enc(c.response.authenticatorData), signature: enc(c.response.signature), userHandle: c.response.userHandle ? enc(c.response.userHandle) : undefined } });
      out(JSON.stringify({ ...r, isAssertion: c.response instanceof AuthenticatorAssertionResponse }));
    } catch (e) { out('error: ' + e.name); }
  };
  document.getElementById('signin').onclick = signIn(undefined);
  document.getElementById('quiet').onclick = signIn('conditional');
</script>`;

function relyingParty({ origin, rpID }) {
  const rp = { credentials: new Map(), challenge: '', user: { id: b64('user-1'), name: 'alice@example.com', displayName: 'Alice' } };
  let lib;
  const server = async () => (lib ??= await import('@simplewebauthn/server'));

  /** Answers /pk/* requests; returns false for anything else. */
  rp.handle = async (req, res) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/pk/')) return false;
    const json = (body) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    let body = '';
    if (req.method === 'POST') for await (const chunk of req) body += chunk;
    try {
      if (path === '/pk/register-options') {
        rp.challenge = b64(randomBytes(32));
        return json({
          challenge: rp.challenge,
          rp: { id: rpID, name: 'Passkey Test' },
          user: rp.user,
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
          attestation: 'none',
          extensions: { credProps: true },
          excludeCredentials: [...rp.credentials.keys()].map((id) => ({ type: 'public-key', id })),
        });
      }
      if (path === '/pk/register') {
        const response = JSON.parse(body);
        const v = await (await server()).verifyRegistrationResponse({ response, expectedChallenge: rp.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false });
        if (v.verified) rp.credentials.set(v.registrationInfo.credential.id, v.registrationInfo.credential);
        return json({ registered: v.verified, backedUp: v.registrationInfo?.credentialBackedUp, userVerified: v.registrationInfo?.userVerified });
      }
      if (path === '/pk/login-options') {
        rp.challenge = b64(randomBytes(32));
        return json({ challenge: rp.challenge, rpId: rpID, userVerification: 'preferred' });
      }
      if (path === '/pk/login') {
        const response = JSON.parse(body);
        const credential = rp.credentials.get(response.id);
        if (!credential) return json({ signedIn: false, why: 'unknown credential' });
        const v = await (await server()).verifyAuthenticationResponse({ response, expectedChallenge: rp.challenge, expectedOrigin: origin, expectedRPID: rpID, credential, requireUserVerification: false });
        return json({ signedIn: v.verified, user: response.response.userHandle ? Buffer.from(response.response.userHandle, 'base64url').toString() : '' });
      }
    } catch (e) {
      return json({ registered: false, signedIn: false, why: String(e.message || e) });
    }
    res.writeHead(404).end();
    return true;
  };
  return rp;
}

module.exports = { relyingParty, PASSKEY_PAGE: PAGE };
