// An in-memory stand-in for the Google Drive REST API, used as a Playwright route handler.
// It holds one vault file ("file1") plus any share files the app creates.
function fakeDrive() {
  const state = {
    file: null,
    rev: 0,
    down: false,
    uploads: 0,
    /** id -> { body, expires, public } */
    shares: new Map(),
    /** Simulates a Google Workspace account that forbids public links. */
    blockPublic: false,
    lastShareReferrer: '',
    /** Other files the app keeps by name (the recovery record): name -> { id, body } */
    others: new Map(),
  };
  let nextShare = 1;
  const meta = () => ({ id: 'file1', headRevisionId: `rev${state.rev}`, modifiedTime: 'x', trashed: false });
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const otherId = (path) => /^\/(?:upload\/)?drive\/v3\/files\/(other-[A-Za-z0-9._-]+)$/.exec(path)?.[1];
  const otherById = (id) => [...state.others.values()].find((o) => o.id === id);
  const shareId = (path) => {
    const m = /^\/drive\/v3\/files\/(share[0-9]+)(\/permissions)?$/.exec(path);
    return m && { id: m[1], perms: !!m[2] };
  };

  const handler = async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (state.down) return route.abort('internetdisconnected');

    // Public read of a share: no sign-in, only an API key.
    const target = shareId(url.pathname);
    if (target && req.method() === 'GET' && url.searchParams.get('alt') === 'media' && !req.headers().authorization) {
      state.lastShareReferrer = req.headers().referer ?? '';
      const s = state.shares.get(target.id);
      if (!url.searchParams.get('key')) return json(route, { error: { message: 'API key missing' } }, 403);
      if (!s || !s.public) return json(route, { error: { message: 'File not found' } }, 404);
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: s.body });
    }

    if (req.headers().authorization !== 'Bearer fake-token') return json(route, { error: {} }, 401);
    const upload = url.pathname.startsWith('/upload/');
    if (upload && req.method() === 'POST') {
      const body = req.postDataBuffer();
      const marker = Buffer.from('\r\n\r\n');
      const metaStart = body.indexOf(marker) + 4;
      const metaEnd = body.indexOf(Buffer.from('\r\n--'), metaStart);
      const metadata = JSON.parse(body.subarray(metaStart, metaEnd).toString('utf8'));
      const start = body.indexOf(marker, metaEnd) + 4;
      const content = body.subarray(start, body.lastIndexOf(Buffer.from('\r\n--')));
      if (metadata.name && metadata.name !== 'kaipass.kdbx' && !metadata.appProperties?.kaipassShare) {
        const id = `other-${metadata.name}`;
        state.others.set(metadata.name, { id, body: Buffer.from(content) });
        return json(route, { id, headRevisionId: 'r1', modifiedTime: 'x', trashed: false });
      }
      if (metadata.appProperties?.kaipassShare) {
        const id = `share${nextShare++}`;
        state.shares.set(id, { body: Buffer.from(content), expires: Number(metadata.appProperties.expires), public: false });
        return json(route, { id });
      }
      state.file = content;
      state.rev++;
      state.uploads++;
      return json(route, meta());
    }
    const other = otherId(url.pathname);
    if (other) {
      const o = otherById(other);
      if (!o) return json(route, { error: { message: 'not found' } }, 404);
      if (req.method() === 'PATCH') {
        o.body = req.postDataBuffer();
        return json(route, { id: o.id, headRevisionId: 'r2', modifiedTime: 'x', trashed: false });
      }
      if (url.searchParams.get('alt') === 'media') return route.fulfill({ status: 200, contentType: 'application/json', body: o.body });
      return json(route, { id: o.id, headRevisionId: 'r1', modifiedTime: 'x', trashed: false });
    }
    if (upload && req.method() === 'PATCH') {
      state.file = req.postDataBuffer();
      state.rev++;
      state.uploads++;
      return json(route, meta());
    }
    if (target) {
      const s = state.shares.get(target.id);
      if (target.perms && req.method() === 'POST') {
        if (state.blockPublic) return json(route, { error: { message: 'Sharing is restricted by your organization' } }, 403);
        if (s) s.public = true;
        return json(route, { id: 'anyoneWithLink' });
      }
      if (req.method() === 'DELETE') {
        if (!s) return json(route, { error: { message: 'not found' } }, 404);
        state.shares.delete(target.id);
        return route.fulfill({ status: 204, body: '' });
      }
    }
    if (url.pathname.endsWith('/files')) {
      if ((url.searchParams.get('q') ?? '').includes('kaipassShare')) {
        return json(route, {
          files: [...state.shares].map(([id, s]) => ({ id, appProperties: { kaipassShare: '1', expires: String(s.expires) } })),
        });
      }
      const named = /name = '([^']+)'/.exec(url.searchParams.get('q') ?? '')?.[1];
      if (named && named !== 'kaipass.kdbx') {
        const o = state.others.get(named);
        return json(route, { files: o ? [{ id: o.id, headRevisionId: 'r1', modifiedTime: 'x', trashed: false }] : [] });
      }
      return json(route, { files: state.file ? [meta()] : [] });
    }
    if (!state.file) return json(route, { error: { message: 'not found' } }, 404);
    if (url.searchParams.get('alt') === 'media') {
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: state.file });
    }
    return json(route, meta());
  };
  return { state, handler };
}

module.exports = { fakeDrive };
