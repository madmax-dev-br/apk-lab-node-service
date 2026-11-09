import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, parseClients } from '../../services/queue/app.mjs';
import { startFakeRunner } from '../helpers/fake-runner.mjs';
import { tempDir, EMPTY_ZIP, silent } from '../helpers/env.mjs';

const ALICE = 'alice-token-123', BOB = 'bob-token-12345';
function settings(runners, over = {}) {
  return { host: '127.0.0.1', port: 0, clients: parseClients(`alice:${ALICE},bob:${BOB}`), authDisabled: false, corsOrigins: [], runners: runners.map((r, i) => ({ id: `runner-${i + 1}`, url: r.url, token: r.token })),
    maxPerClient: 2, maxQueuedPerClient: 50, maxAttempts: 3, maxApkBytes: 10 * 1024 * 1024, apkUrlHosts: [], jobTimeoutMs: 30000, leaseMaxMs: 60000, leaseIdleMs: 60000, retentionMs: 3600000,
    healthIntervalMs: 200, dataDir: tempDir('queue'), store: 'memory', storeFile: '', pluginsAllowed: false, logLevel: 'silent', ...over };
}
async function start(runnerOptions = [{}], over = {}) {
  const runners = []; for (const options of runnerOptions) runners.push(await startFakeRunner(options));
  const queue = await createQueue(settings(runners, over), { log: silent }); const address = await queue.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const api = async (method, path, { token = ALICE, json, body, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { 'content-type': 'application/json' } : {}), ...headers }, body: json ? JSON.stringify(json) : body });
    const type = response.headers.get('content-type') ?? ''; return { status: response.status, body: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()), headers: response.headers };
  };
  const submit = (job, token = ALICE) => api('POST', '/jobs', { token, json: { apkBase64: EMPTY_ZIP.toString('base64'), ...job } });
  const until = async (id, states, token = ALICE, kind = 'jobs') => { for (let i = 0; i < 200; i++) { const r = await api('GET', `/${kind}/${id}`, { token }); if (states.includes(r.body.state)) return r.body; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`${id} never reached ${states}`); };
  return { queue, runners, api, submit, until, close: async () => { await queue.close({ keepData: false }); for (const runner of runners) await runner.close(); } };
}

test('a job runs its steps on a runner and keeps step outputs and artifacts', async () => {
  const t = await start();
  try {
    const submitted = await t.submit({ steps: [{ type: 'launch' }, { type: 'wait', selector: { text: 'Olá' } }, { type: 'tap', selector: { testTag: 'ok' } }, { type: 'screenshot', name: 'tela' }, { type: 'layoutBounds' }], collect: { logcat: true } });
    assert.equal(submitted.status, 202); assert.equal(submitted.body.state, 'queued');
    const done = await t.until(submitted.body.id, ['succeeded', 'failed']);
    assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
    assert.deepEqual(done.result.steps.map(step => [step.type, step.ok]), [['launch', true], ['wait', true], ['tap', true], ['screenshot', true], ['layoutBounds', true]]);
    assert.deepEqual(done.result.artifacts.map(a => a.name), ['tela.png', 'step-5.layout-bounds.json', 'logcat.json']);
    const png = await t.api('GET', done.result.artifacts[0].url); assert.equal(png.status, 200); assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal(t.runners[0].state.sessions.size, 0, 'the runner session is closed at the end');
    assert.equal((await t.api('GET', `/jobs/${submitted.body.id}`, { token: BOB })).status, 404, 'another client cannot see the job');
  } finally { await t.close(); }
});

test('auth and validation: missing token, unknown keys, bad steps, plugins disabled, apkUrl not allowed', async () => {
  const t = await start();
  try {
    assert.equal((await t.api('GET', '/jobs', { token: null })).status, 401);
    assert.equal((await t.api('GET', '/jobs', { token: 'wrong-token-1' })).status, 401);
    assert.equal((await t.api('GET', '/health', { token: null })).status, 200);
    assert.match((await t.submit({ stepz: [] })).body.error.message, /unknown keys stepz/);
    assert.match((await t.submit({ steps: [{ type: 'teleport' }] })).body.error.message, /steps\[0\]\.type/);
    assert.match((await t.submit({ steps: [{ type: 'wait' }] })).body.error.message, /needs a selector/);
    assert.match((await t.submit({ steps: [{ type: 'tap', selector: { tag: 'x' } }] })).body.error.message, /unknown keys tag/);
    assert.match((await t.submit({ steps: [{ type: 'statics' }] })).body.error.message, /\(statics\) needs className/);
    assert.match((await t.submit({ steps: [{ type: 'staticField', className: 'a.B', path: { x: 1 } }] })).body.error.message, /\(staticField\) needs path/);
    assert.match((await t.submit({ steps: [{ type: 'classes', match: '' }] })).body.error.message, /\(classes\) needs match/);
    assert.match((await t.submit({ steps: [{ type: 'referrers' }] })).body.error.message, /\(referrers\) needs a handle/);
    assert.equal((await t.submit({ steps: [{ type: 'plugins', plugins: [{ code: '1' }], seconds: 1 }] })).status, 403);
    assert.equal((await t.submit({ config: { plugins: [{ code: '1' }] } })).status, 403);
    assert.equal((await t.submit({ priority: 12 })).status, 400);
    const url = await t.api('POST', '/jobs', { json: { apkUrl: 'https://example.invalid/app.apk' } }); assert.equal(url.status, 403); assert.equal(url.body.error.code, 'apk-url-not-allowed');
    assert.equal((await t.api('POST', '/jobs', { json: { apkBase64: Buffer.from('not a zip').toString('base64') } })).status, 400);
  } finally { await t.close(); }
});

test('priority and capacity: one runner slot serves the higher priority first; per-client limit holds', async () => {
  const t = await start([{ capacity: 1, stepDelayMs: 150 }], { maxPerClient: 1 });
  try {
    const first = await t.submit({ steps: [{ type: 'launch' }] });
    await t.until(first.body.id, ['running', 'assigned']);
    const low = await t.submit({ priority: 1, steps: [{ type: 'launch' }] }, BOB), high = await t.submit({ priority: 9, steps: [{ type: 'launch' }] }, BOB);
    const queued = await t.api('GET', `/jobs/${high.body.id}`, { token: BOB }); assert.equal(queued.body.position, 1);
    const doneHigh = await t.until(high.body.id, ['succeeded'], BOB), doneLow = await t.until(low.body.id, ['succeeded'], BOB);
    assert.ok(doneHigh.startedAt < doneLow.startedAt, 'priority 9 started before priority 1');
    assert.equal(t.runners[0].state.maxConcurrent, 1, 'never more sessions than the runner capacity');
  } finally { await t.close(); }
});

test('fairness: with 2 slots and maxPerClient 1, two clients run side by side', async () => {
  const t = await start([{ capacity: 2, stepDelayMs: 200 }], { maxPerClient: 1 });
  try {
    const a1 = await t.submit({ steps: [{ type: 'launch' }] }), a2 = await t.submit({ steps: [{ type: 'launch' }] }), b1 = await t.submit({ steps: [{ type: 'launch' }] }, BOB);
    await t.until(b1.body.id, ['running', 'succeeded'], BOB);
    const a2now = await t.api('GET', `/jobs/${a2.body.id}`); assert.equal(a2now.body.state, 'queued', 'alice already holds her one slot');
    await t.until(a1.body.id, ['succeeded']); await t.until(a2.body.id, ['succeeded']);
  } finally { await t.close(); }
});

test('retries after runner failures, then fails when attempts run out; step failures do not retry', async () => {
  const t = await start([{ failCreates: 1 }]);
  try {
    const job = await t.submit({ steps: [{ type: 'launch' }] });
    const done = await t.until(job.body.id, ['succeeded', 'failed']);
    assert.equal(done.state, 'succeeded'); assert.equal(done.attempts, 2);
    t.runners[0].state.failCreates = 10;
    const doomed = await t.submit({ steps: [{ type: 'launch' }], maxAttempts: 2 });
    const failed = await t.until(doomed.body.id, ['failed']); assert.equal(failed.attempts, 2); assert.equal(failed.error.status, 500);
    t.runners[0].state.failCreates = 0; t.runners[0].state.waitFails = true;
    const stepFail = await t.submit({ steps: [{ type: 'launch' }, { type: 'wait', selector: { text: 'x' } }, { type: 'tap', selector: { text: 'x' } }] });
    const result = await t.until(stepFail.body.id, ['failed']);
    assert.equal(result.attempts, 1); assert.equal(result.error.code, 'wait-timeout'); assert.equal(result.result.steps.length, 2, 'stops at the failed step');
    const tolerant = await t.submit({ steps: [{ type: 'wait', selector: { text: 'x' }, continueOnError: true }, { type: 'launch' }] });
    assert.equal((await t.until(tolerant.body.id, ['succeeded', 'failed'])).state, 'succeeded');
  } finally { await t.close(); }
});

test('cancel: a queued job and a running job', async () => {
  const t = await start([{ capacity: 1, stepDelayMs: 300 }]);
  try {
    const running = await t.submit({ steps: [{ type: 'launch' }, { type: 'sleep', ms: 5000 }] }), queued = await t.submit({ steps: [{ type: 'launch' }] });
    await t.until(running.body.id, ['running']);
    assert.equal((await t.api('DELETE', `/jobs/${queued.body.id}`)).body.state, 'cancelled');
    assert.equal((await t.api('POST', `/jobs/${running.body.id}/cancel`)).body.state, 'cancelled');
    for (let i = 0; i < 40 && t.runners[0].state.sessions.size; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(t.runners[0].state.sessions.size, 0, 'the runner session of the cancelled job is closed');
  } finally { await t.close(); }
});

test('leases: the holder reaches its session through the proxy; other clients cannot; idle leases expire and free the runner', async () => {
  const t = await start([{ capacity: 1 }], { leaseIdleMs: 600 });
  try {
    const lease = await t.api('POST', '/leases', { json: { apkBase64: EMPTY_ZIP.toString('base64'), config: { launch: true } } });
    assert.equal(lease.status, 202);
    const active = await t.until(lease.body.id, ['active'], ALICE, 'leases');
    const echo = await t.api('POST', `/leases/${active.id}/session/echo?x=1`, { json: { a: 1 } });
    assert.equal(echo.status, 200); assert.equal(echo.body.query, '?x=1'); assert.deepEqual(JSON.parse(echo.body.body), { a: 1 });
    assert.equal((await t.api('GET', `/leases/${active.id}/session/echo`, { token: BOB })).status, 404);
    assert.equal((await t.api('GET', `/leases/${active.id}/session/..%2F..%2Fsessions`)).status, 400);
    const expired = await t.until(active.id, ['expired'], ALICE, 'leases');
    assert.equal(expired.error.code, 'lease-idle');
    for (let i = 0; i < 40 && t.runners[0].state.sessions.size; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(t.runners[0].state.sessions.size, 0);
    const second = await t.api('POST', '/leases', { json: { apkBase64: EMPTY_ZIP.toString('base64') } });
    await t.until(second.body.id, ['active'], ALICE, 'leases');
    assert.equal((await t.api('DELETE', `/leases/${second.body.id}`)).body.state, 'released');
  } finally { await t.close(); }
});

test('job progress as Server-Sent Events', async () => {
  const t = await start([{ stepDelayMs: 50 }]);
  try {
    const job = await t.submit({ steps: [{ type: 'launch' }, { type: 'back' }] });
    const response = await fetch(`http://127.0.0.1:${t.queue.server.address().port}/jobs/${job.body.id}/events`, { headers: { authorization: `Bearer ${ALICE}` } });
    const text = await response.text();
    for (const event of ['queued', 'assigned', 'running', 'step-started', 'step-finished', 'succeeded', 'end']) assert.match(text, new RegExp(`event: ${event}\\n`));
  } finally { await t.close(); }
});

test('JSON file store: queued jobs survive a restart', async () => {
  const dataDir = tempDir('store'), runner = await startFakeRunner({ capacity: 0 });
  try {
    const s = settings([runner], { dataDir, store: 'file' });
    let queue = await createQueue(s, { log: silent }); await queue.listen();
    const port = queue.server.address().port;
    const job = await (await fetch(`http://127.0.0.1:${port}/jobs`, { method: 'POST', headers: { authorization: `Bearer ${ALICE}`, 'content-type': 'application/json' }, body: JSON.stringify({ apkBase64: EMPTY_ZIP.toString('base64'), label: 'persisted' }) })).json();
    await queue.close();
    queue = await createQueue({ ...s, port: 0 }, { log: silent }); await queue.listen();
    const again = await (await fetch(`http://127.0.0.1:${queue.server.address().port}/jobs/${job.id}`, { headers: { authorization: `Bearer ${ALICE}` } })).json();
    assert.equal(again.state, 'queued'); assert.equal(again.label, 'persisted');
    await queue.close({ keepData: false });
  } finally { await runner.close(); }
});

test('reload, waitReady, wait { ready } and screenshot { waitReady } steps reach the runner endpoints', async () => {
  const t = await start();
  try {
    const submitted = await t.submit({ steps: [{ type: 'launch' }, { type: 'reload', mode: 'reopen' }, { type: 'waitReady', timeoutMs: 20000 }, { type: 'wait', ready: true, selector: { text: 'Olá' } }, { type: 'screenshot', name: 'pronta', waitReady: true }, { type: 'reload' }] });
    assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
    const done = await t.until(submitted.body.id, ['succeeded', 'failed']);
    assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
    const [, reopen, ready, wait, shot, recreate] = done.result.steps;
    assert.deepEqual(reopen.output, { mode: 'reopen', activity: 'dev.example.fake.Main', ready: false });
    assert.equal(ready.output.ready, true); assert.equal(wait.output.element.key, 'c:1:2');
    assert.deepEqual(shot.output.ready, { ready: true, waitedMs: 3, activity: 'dev.example.fake.Main' }); assert.equal(recreate.output.mode, 'recreate');
    const requests = t.runners[0].state.requests;
    const bodies = requests.filter(item => /\/(reload|wait)$/.test(item.path)).map(item => [item.path.split('/').pop(), JSON.parse(item.body)]);
    assert.deepEqual(bodies, [['reload', { mode: 'reopen' }], ['wait', { ready: true, timeoutMs: 20000 }], ['wait', { selector: { text: 'Olá' }, timeoutMs: 10000, gone: false, ready: true }], ['reload', { mode: 'recreate' }]]);
    assert.match(requests.find(item => item.path.endsWith('/screenshot.png')).search, /waitReady=1&readyTimeoutMs=15000/);
    assert.match((await t.submit({ steps: [{ type: 'reload', mode: 'refresh' }] })).body.error.message, /mode must be/);
    assert.match((await t.submit({ steps: [{ type: 'wait', gone: true }] })).body.error.message, /needs a selector, ready: true, or both/);
  } finally { await t.close(); }
});
