// An in-process stand-in for the runner API, for queue tests without a VM. Behaviour knobs: capacity, failCreates (N first creates answer 500),
// stepDelayMs, waitFails (wait answers 408), and a log of every call.
import { createServer } from 'node:http';

const PNG_1x1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

export async function startFakeRunner({ capacity = 1, failCreates = 0, stepDelayMs = 0, token = 'runner-token', waitFails = false } = {}) {
  const state = { capacity, failCreates, stepDelayMs, waitFails, sessions: new Map(), calls: [], created: 0, maxConcurrent: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks), send = (status, value, type = 'application/json') => { const data = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)); res.writeHead(status, { 'content-type': type, 'content-length': data.length }); res.end(data); };
    state.calls.push(`${req.method} ${url.pathname}`);
    if (url.pathname === '/health') return send(200, { ok: true, available: Math.max(0, state.capacity - state.sessions.size), maxSessions: state.capacity, pluginsAllowed: true, runtimeRevision: 'fake' });
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: { code: 'unauthorized', message: 'no' } });
    if (req.method === 'POST' && url.pathname === '/sessions') {
      if (state.failCreates > 0) { state.failCreates--; return send(500, { error: { code: 'internal', message: 'boom' } }); }
      if (state.sessions.size >= state.capacity) return send(503, { error: { code: 'at-capacity', message: 'full' } });
      const id = `s${++state.created}`, config = JSON.parse(Buffer.from(String(req.headers['x-apk-config'] ?? 'e30'), 'base64url').toString('utf8'));
      state.sessions.set(id, { config, apkBytes: body.length }); state.maxConcurrent = Math.max(state.maxConcurrent, state.sessions.size);
      return send(201, { session: { id, packageName: 'dev.example.fake', metrics: { loadMs: 1, launchMs: null }, runtimeRevision: 'fake' } });
    }
    const m = /^\/sessions\/([^/]+)(\/.*)?$/.exec(url.pathname); if (!m) return send(404, { error: { code: 'not-found', message: url.pathname } });
    const [, id, rest = ''] = m, session = state.sessions.get(id); if (!session) return send(404, { error: { code: 'not-found', message: `no session ${id}` } });
    if (req.method === 'DELETE' && !rest) { state.sessions.delete(id); return send(200, { closed: true }); }
    if (state.stepDelayMs) await new Promise(resolve => setTimeout(resolve, state.stepDelayMs));
    if (rest === '/screenshot.png' || /\/elements\/.+\/screenshot\.png/.test(rest)) return send(200, PNG_1x1, 'image/png');
    if (rest === '/wait' && state.waitFails) return send(408, { error: { code: 'wait-timeout', message: 'timed out' } });
    if (rest === '/launch') return send(200, { launchMs: 5, snapshot: { activity: 'dev.example.fake.Main' } });
    if (rest === '/wait') return send(200, { element: { key: 'c:1:2' }, waitedMs: 1 });
    if (rest === '/tap' || rest === '/type' || rest === '/back' || rest === '/scroll') return send(200, { via: 'semantics', snapshot: { activity: 'dev.example.fake.Main' } });
    if (rest === '/layout-bounds') return send(200, { activity: 'dev.example.fake.Main', elements: [{ key: 'c:1:2', name: 'x' }] });
    if (rest === '/logcat') return send(200, { lines: [{ seq: 1, tag: 'T', message: 'm' }], total: 1 });
    if (rest === '/network') return send(200, { requests: [], total: 0 });
    if (rest === '/echo') return send(200, { method: req.method, query: url.search, body: body.toString('utf8') });
    return send(200, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, token, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }) };
}
