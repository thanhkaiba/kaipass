// An in-memory stand-in for the Google Drive REST API, used as a Playwright route handler.
function fakeDrive() {
  const state = { file: null, rev: 0, down: false, uploads: 0 };
  const meta = () => ({ id: 'file1', headRevisionId: `rev${state.rev}`, modifiedTime: 'x', trashed: false });
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const handler = async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (state.down) return route.abort('internetdisconnected');
    if (req.headers().authorization !== 'Bearer fake-token') return json(route, { error: {} }, 401);
    const upload = url.pathname.startsWith('/upload/');
    if (upload && req.method() === 'POST') {
      const body = req.postDataBuffer();
      const marker = Buffer.from('\r\n\r\n');
      const start = body.indexOf(marker, body.indexOf(marker) + 4) + 4;
      state.file = body.subarray(start, body.lastIndexOf(Buffer.from('\r\n--')));
      state.rev++;
      state.uploads++;
      return json(route, meta());
    }
    if (upload && req.method() === 'PATCH') {
      state.file = req.postDataBuffer();
      state.rev++;
      state.uploads++;
      return json(route, meta());
    }
    if (url.pathname.endsWith('/files')) return json(route, { files: state.file ? [meta()] : [] });
    if (!state.file) return json(route, { error: { message: 'not found' } }, 404);
    if (url.searchParams.get('alt') === 'media') {
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: state.file });
    }
    return json(route, meta());
  };
  return { state, handler };
}

module.exports = { fakeDrive };
