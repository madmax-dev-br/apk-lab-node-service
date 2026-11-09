// End to end: the queue in front of a real runner, a job with steps and an interactive lease (needs the runtime and the synthetic test APKs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { apkPath, apkSkip, tempDir, silent } from '../helpers/env.mjs';

const COMPOSE = 'compose-approvals-debug.apk', NET = 'net-probe.apk';
const skip = apkSkip(COMPOSE, NET);

test('queue + runner: a job with steps returns step outputs, screenshots and logs; a lease proxies the runner API', { skip, timeout: 180000 }, async () => {
  const { startRunner, pngSize } = await import('../helpers/runner.mjs');
  const { createQueue, parseClients } = await import('../../services/queue/app.mjs');
  const runner = await startRunner({ maxSessions: 2 });
  const queue = await createQueue({ host: '127.0.0.1', port: 0, clients: parseClients('equipe:equipe-token-1'), authDisabled: false, corsOrigins: [], runners: [{ id: 'runner-1', url: runner.base, token: runner.token }],
    maxPerClient: 2, maxQueuedPerClient: 10, maxAttempts: 2, maxApkBytes: 64 * 1024 * 1024, apkUrlHosts: [], jobTimeoutMs: 120000, leaseMaxMs: 120000, leaseIdleMs: 60000, retentionMs: 3600000,
    healthIntervalMs: 500, dataDir: tempDir('queue-e2e'), store: 'memory', pluginsAllowed: false }, { log: silent });
  const address = await queue.listen(), base = `http://127.0.0.1:${address.port}`, auth = { authorization: 'Bearer equipe-token-1' };
  const get = async path => (await fetch(base + path, { headers: auth })).json();
  try {
    const form = new FormData();
    form.append('apk', new Blob([await readFile(apkPath(COMPOSE))]), 'app.apk');
    form.append('job', JSON.stringify({ label: 'fluxo de busca', collect: { logcat: true, network: true }, steps: [
      { type: 'launch' }, { type: 'wait', selector: { text: 'Pedidos da equipe' } }, { type: 'tap', selector: { testTag: 'filter-Pendentes' } },
      { type: 'type', selector: { testTag: 'search' }, text: 'Monitor' }, { type: 'wait', selector: { testTag: 'search', text: 'Monitor' } },
      { type: 'screenshot', name: 'tela' }, { type: 'screenshot', name: 'botao', selector: { testTag: 'new-order' } }, { type: 'layoutBounds', name: 'limites' }, { type: 'viewModels' } ] }));
    const started = Date.now();
    const submitted = await (await fetch(`${base}/jobs`, { method: 'POST', headers: auth, body: form })).json();
    assert.equal(submitted.state, 'queued');
    let job; for (let i = 0; i < 600; i++) { job = await get(`/jobs/${submitted.id}`); if (['succeeded', 'failed'].includes(job.state)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    console.log(`queued job finished in ${Date.now() - started} ms (${job.result?.steps?.map(step => `${step.type} ${step.ms}ms`).join(', ')})`);
    assert.equal(job.state, 'succeeded', JSON.stringify(job.error ?? job.result?.steps));
    assert.deepEqual(job.result.artifacts.map(a => a.name), ['tela.png', 'botao.png', 'limites.layout-bounds.json', 'logcat.json', 'network.json']);
    const shot = Buffer.from(await (await fetch(base + job.result.artifacts[0].url, { headers: auth })).arrayBuffer());
    assert.deepEqual(pngSize(shot), { width: 411, height: 914 });
    const bounds = JSON.parse(Buffer.from(await (await fetch(base + job.result.artifacts[2].url, { headers: auth })).arrayBuffer()).toString('utf8'));
    assert.ok(bounds.elements.some(element => element.testTag === 'search'));

    const lease = await (await fetch(`${base}/leases`, { method: 'POST', headers: { ...auth, 'content-type': 'application/octet-stream', 'x-job': JSON.stringify({ config: { launch: true, endpointMocks: [{ method: 'GET', url: '/net-probe/hello.json', body: 'via lease' }] } }) }, body: await readFile(apkPath(NET)) })).json();
    let active; for (let i = 0; i < 300; i++) { active = await get(`/leases/${lease.id}`); if (active.state === 'active' || active.state === 'failed') break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.equal(active.state, 'active', JSON.stringify(active.error));
    const tap = await (await fetch(`${base}/leases/${lease.id}/session/tap`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ selector: { text: 'Load' } }) })).json();
    assert.equal(tap.via, 'click');
    const waited = await fetch(`${base}/leases/${lease.id}/session/wait`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ selector: { textContains: 'via lease' }, timeoutMs: 10000 }) });
    assert.equal(waited.status, 200);
    const png = Buffer.from(await (await fetch(`${base}/leases/${lease.id}/session/screenshot.png`, { headers: auth })).arrayBuffer()); assert.ok(pngSize(png));
    assert.equal((await (await fetch(`${base}/leases/${lease.id}`, { method: 'DELETE', headers: auth })).json()).state, 'released');
    for (let i = 0; i < 40 && runner.runner.sessions.size; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(runner.runner.sessions.size, 0, 'the runner sessions of the job and of the lease are closed');
  } finally { await queue.close({ keepData: false }); await runner.close(); }
});
