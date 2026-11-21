/**
 * Runs in the web page's own JavaScript world, before the page's scripts: it stands in front of
 * `navigator.credentials.create/get` so that KaiPass can offer to keep, or to use, a passkey.
 *
 * It holds no secrets and decides nothing. It passes the site's request to KaiPass's content
 * script (which works out where it really is, asks the user in KaiPass's own UI, and talks to the
 * vault) and turns the answer into the objects the page expects. Whenever KaiPass has nothing to
 * offer, or the user prefers another device, the browser's own passkey handling runs untouched.
 *
 * A page can see and tamper with everything in here; that gains it nothing, because every answer
 * comes from the content script after a real click in KaiPass's closed UI, signed for the frame's
 * true origin.
 */
(() => {
  const w = window as unknown as { __kaipassPk?: boolean };
  if (w.__kaipassPk || typeof PublicKeyCredential === 'undefined' || !navigator.credentials || location.origin === 'null') return;
  w.__kaipassPk = true;

  const TAG = 'kaipass-pk';
  const native = {
    create: navigator.credentials.create.bind(navigator.credentials),
    get: navigator.credentials.get.bind(navigator.credentials),
    uvpaa: PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.bind(PublicKeyCredential),
    conditional: PublicKeyCredential.isConditionalMediationAvailable?.bind(PublicKeyCredential),
  };

  const b64 = (v: BufferSource): string => {
    const u = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const buf = (s: string): ArrayBuffer => {
    const t = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  };

  // ---- talking to the content script ----

  type Reply = { action: 'native' | 'abort' | 'exists' | 'done'; result?: Record<string, string> } | { yes: boolean };
  let seq = 0;
  const waiting = new Map<number, (r: Reply) => void>();
  let ready = false;
  let onReady: () => void = () => {};
  const whenReady = new Promise<void>((r) => (onReady = r));
  window.addEventListener('message', (e) => {
    const d = e.data as { tag?: string; dir?: string; type?: string; id?: number; reply?: Reply } | null;
    if (e.source !== window || !d || d.tag !== TAG || d.dir !== 'in') return;
    if (d.type === 'ready') {
      ready = true;
      onReady();
    } else if (d.id !== undefined && d.reply) {
      waiting.get(d.id)?.(d.reply);
      waiting.delete(d.id);
    }
  });

  const post = (id: number, type: string, payload: unknown) => window.postMessage({ tag: TAG, dir: 'out', id, type, payload }, location.origin);

  /** Asks KaiPass; answers "native" when KaiPass is not there (yet) to answer. */
  async function ask(type: string, payload: unknown, signal?: AbortSignal | null): Promise<Reply> {
    if (!ready) await Promise.race([whenReady, new Promise((r) => setTimeout(r, 1500))]);
    if (!ready) return { action: 'native' };
    const id = ++seq;
    return new Promise<Reply>((resolve) => {
      waiting.set(id, resolve);
      signal?.addEventListener('abort', () => {
        if (!waiting.delete(id)) return;
        post(id, 'cancel', null);
        resolve({ action: 'abort' });
      });
      post(id, type, payload);
    });
  }

  // ---- the objects a page expects back ----

  const own = (o: object, props: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(props)) Object.defineProperty(o, k, { value: v, enumerable: true, configurable: true });
    return o;
  };

  function credential(id: string, response: object, json: Record<string, unknown>, extensions: Record<string, unknown>): PublicKeyCredential {
    const c = own(Object.create(PublicKeyCredential.prototype) as object, {
      id,
      rawId: buf(id),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response,
      getClientExtensionResults: () => extensions,
      toJSON: () => ({ id, rawId: id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: extensions, response: json }),
    });
    return c as PublicKeyCredential;
  }

  const notAllowed = () => new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError');

  // ---- create ----

  navigator.credentials.create = async function (options?: CredentialCreationOptions): Promise<Credential | null> {
    const pk = options?.publicKey;
    if (!pk || options?.signal?.aborted) return native.create(options);
    let reply: Reply;
    try {
      reply = await ask(
        'create',
        {
          rpId: pk.rp?.id ?? '',
          rpName: pk.rp?.name ?? '',
          user: { id: b64(pk.user.id), name: pk.user.name ?? '', displayName: pk.user.displayName ?? '' },
          challenge: b64(pk.challenge),
          algs: (pk.pubKeyCredParams ?? []).map((p) => p.alg),
          exclude: (pk.excludeCredentials ?? []).map((c) => b64(c.id)),
          // A site that insists on a hardware key or on a statement of the device model is not for us.
          attachment: pk.authenticatorSelection?.authenticatorAttachment ?? '',
          attestation: pk.attestation ?? 'none',
        },
        options?.signal,
      );
    } catch {
      return native.create(options);
    }
    if (!('action' in reply) || reply.action === 'native') return native.create(options);
    if (reply.action === 'abort') throw options?.signal?.aborted ? new DOMException('Aborted', 'AbortError') : notAllowed();
    if (reply.action === 'exists') throw new DOMException('The user attempted to register an authenticator that contains one of the credentials already registered with the relying party.', 'InvalidStateError');
    const r = reply.result!;
    const response = own(Object.create(AuthenticatorAttestationResponse.prototype) as object, {
      clientDataJSON: buf(r.clientDataJSON),
      attestationObject: buf(r.attestationObject),
      getTransports: () => ['internal', 'hybrid'],
      getAuthenticatorData: () => buf(r.authenticatorData),
      getPublicKey: () => buf(r.publicKey),
      getPublicKeyAlgorithm: () => -7,
    });
    const wantsProps = !!(pk.extensions as { credProps?: boolean } | undefined)?.credProps;
    return credential(
      r.credentialId,
      response,
      { clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject, authenticatorData: r.authenticatorData, publicKey: r.publicKey, publicKeyAlgorithm: -7, transports: ['internal', 'hybrid'] },
      wantsProps ? { credProps: { rk: true } } : {},
    );
  };

  // ---- get ----

  navigator.credentials.get = async function (options?: CredentialRequestOptions): Promise<Credential | null> {
    const pk = options?.publicKey;
    if (!pk || options?.signal?.aborted) return native.get(options);
    const conditional = (options as { mediation?: string }).mediation === 'conditional';
    const request = { rpId: pk.rpId ?? '', challenge: b64(pk.challenge), allow: (pk.allowCredentials ?? []).map((c) => b64(c.id)), conditional };

    const finish = (reply: Reply): Credential => {
      const r = (reply as { result: Record<string, string> }).result;
      const response = own(Object.create(AuthenticatorAssertionResponse.prototype) as object, {
        clientDataJSON: buf(r.clientDataJSON),
        authenticatorData: buf(r.authenticatorData),
        signature: buf(r.signature),
        userHandle: r.userHandle ? buf(r.userHandle) : null,
      });
      return credential(r.credentialId, response, { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature, userHandle: r.userHandle || undefined }, {});
    };

    if (conditional) {
      // "Passkey autofill": the browser waits quietly for the user to choose one. KaiPass waits
      // alongside; whichever the user picks first wins and the other is called off.
      const stop = new AbortController();
      options?.signal?.addEventListener('abort', () => stop.abort(options.signal!.reason));
      const DECLINED = Symbol('declined');
      const browser = native.get({ ...options, signal: stop.signal }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const ours = ask('get', request, stop.signal).then((reply) => ('action' in reply && reply.action === 'done' ? finish(reply) : DECLINED));
      const first = await Promise.race([browser, ours.then((mine) => ({ mine }))]);
      const settle = async (b: { value: Credential | null } | { error: unknown }) => {
        if ('error' in b) throw b.error;
        return b.value;
      };
      if ('mine' in first) {
        if (first.mine === DECLINED) return settle(await browser); // KaiPass has nothing here: the browser's answer stands
        stop.abort();
        return first.mine as Credential;
      }
      if ('value' in first) return first.value;
      // The browser gave up first; KaiPass may still be showing its passkeys.
      const mine = await ours;
      if (mine === DECLINED) throw first.error;
      return mine as Credential;
    }

    let reply: Reply;
    try {
      reply = await ask('get', request, options?.signal);
    } catch {
      return native.get(options);
    }
    if (!('action' in reply) || reply.action === 'native') return native.get(options);
    if (reply.action !== 'done') throw options?.signal?.aborted ? new DOMException('Aborted', 'AbortError') : notAllowed();
    return finish(reply);
  };

  // ---- "can this device do passkeys?" ----
  // With KaiPass keeping passkeys the answer is yes, even on a computer without a fingerprint reader.

  const kaipassOn = async () => {
    try {
      const r = await ask('available', null);
      return 'yes' in r && r.yes;
    } catch {
      return false;
    }
  };
  if (native.uvpaa) PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => (await kaipassOn()) || native.uvpaa!();
  if (native.conditional) PublicKeyCredential.isConditionalMediationAvailable = async () => (await kaipassOn()) || native.conditional!();
})();
