import test from 'node:test';
import assert from 'node:assert/strict';
import { Router, parseMultipart, tokenMatches, createHttpServer, HttpError, parseOrigins, readBody } from '../../lib/http.mjs';

test('router: params, wildcard, 405 and 404', () => {
  const router = new Router().add('GET', '/sessions/:id/elements/:key/screenshot.png', () => 1).add('POST', '/leases/:id/session/*', () => 2);
  assert.deepEqual(router.match('GET', '/sessions/abc/elements/c%3A1%3A2/screenshot.png').params, { id: 'abc', key: 'c:1:2' });
  assert.deepEqual(router.match('POST', '/leases/L1/session/tap').params, { id: 'L1', '*': 'tap' });
  assert.deepEqual(router.match('POST', '/leases/L1/session').params, { id: 'L1', '*': '' });
  assert.throws(() => router.match('DELETE', '/leases/L1/session/x'), error => error.status === 405);
  assert.equal(router.match('GET', '/nothing'), null);
});

test('multipart: file and JSON parts', () => {
  const boundary = 'XyZ', body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="apk"; filename="a.apk"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.from([0x50, 0x4b, 0, 1, 13, 10]),
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="config"\r\n\r\n{"launch":true}\r\n--${boundary}--\r\n`)]);
  const parts = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
  assert.deepEqual([...parts.get('apk').data], [0x50, 0x4b, 0, 1, 13, 10]); assert.equal(parts.get('apk').filename, 'a.apk');
  assert.deepEqual(JSON.parse(parts.get('config').data), { launch: true });
  assert.throws(() => parseMultipart(body, 'multipart/form-data'), /boundary/);
});

test('tokens compare in constant time and reject empty values', () => {
  assert.equal(tokenMatches('secret-1', 'secret-1'), true);
  assert.equal(tokenMatches('secret-2', 'secret-1'), false);
  assert.equal(tokenMatches('', ''), false); assert.equal(tokenMatches(null, 'x'), false);
});

test('parseOrigins keeps only exact origins or *', () => {
  assert.deepEqual(parseOrigins('https://a.example, http://localhost:5173 *, ftp://x, https://b.example/path'), ['https://a.example', 'http://localhost:5173', '*']);
});

async function serve(options) {
  const server = createHttpServer(options); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

test('server: auth, public routes, CORS preflight and errors as JSON', async () => {
  const router = new Router()
    .add('GET', '/health', () => ({ ok: true }), { public: true })
    .add('GET', '/secret', ({ principal }) => ({ principal }))
    .add('POST', '/upload', async ({ req }) => ({ bytes: (await readBody(req, 10)).length }))
    .add('GET', '/boom', () => { throw new Error('internal detail'); });
  const authenticate = async req => { if (req.headers.authorization !== 'Bearer ok') throw new HttpError(401, 'unauthorized', 'no'); return 'me'; };
  const s = await serve({ router, authenticate, corsOrigins: ['https://app.example'] });
  try {
    assert.equal((await fetch(`${s.url}/health`)).status, 200);
    const denied = await fetch(`${s.url}/secret`); assert.equal(denied.status, 401); assert.equal((await denied.json()).error.code, 'unauthorized');
    assert.deepEqual(await (await fetch(`${s.url}/secret`, { headers: { authorization: 'Bearer ok' } })).json(), { principal: 'me' });
    const preflight = await fetch(`${s.url}/secret`, { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.example'); assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/);
    const other = await fetch(`${s.url}/secret`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    assert.equal(other.status, 403);
    const simple = await fetch(`${s.url}/health`, { headers: { origin: 'https://evil.example' } }); assert.equal(simple.headers.get('access-control-allow-origin'), null);
    const big = await fetch(`${s.url}/upload`, { method: 'POST', headers: { authorization: 'Bearer ok' }, body: 'x'.repeat(100) }); assert.equal(big.status, 413);
    const boom = await fetch(`${s.url}/boom`, { headers: { authorization: 'Bearer ok' } }); assert.equal(boom.status, 500); assert.equal((await boom.json()).error.message, 'Internal error', 'internal details are not leaked');
    assert.equal((await fetch(`${s.url}/health`, { method: 'DELETE' })).status, 405);
  } finally { await s.close(); }
});
