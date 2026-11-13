// The session defaults equal to the site's, end to end: memory budget from navigator.deviceMemory, Tela pronta, every public host allowed with private targets
// refused (RUNNER_ALLOW_PRIVATE_NETWORK), endpoint mocks with no network config, progressive raster settings and a reload. Synthetic APKs, local servers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { apkPath, apkSkip } from '../helpers/env.mjs';
import { deviceMemoryFor, machineMemoryBytes } from '../../services/runner/memory.mjs';

const COMPOSE = 'compose-approvals-debug.apk', NET = 'net-probe.apk';
const skip = apkSkip(COMPOSE, NET);
const apk = name => readFile(apkPath(name));
const expectedObjects = { 8: 671088, 4: 335544, 2: 167772, 1: 83886 }[deviceMemoryFor(machineMemoryBytes())];
const localServer = async () => {
  const server = createServer((req, res) => { server.hits = (server.hits ?? 0) + 1; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: `servidor local ${req.url}` })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server;
};

test('default session: the site\'s memory budget, defaults in the config, Tela pronta, progressive raster settings and a reload', { skip, timeout: 180000 }, async () => {
  const helpers = await import('../helpers/runner.mjs');
  const r = await helpers.startRunner({ allowPrivateNetwork: false });
  try {
    const health = await r.api('GET', '/health', { token: null });
    assert.equal(health.body.memory.maxHeapObjects, expectedObjects, JSON.stringify(health.body.memory)); assert.deepEqual(health.body.network, { allowedHosts: ['*'], allowPrivateNetwork: false });
    const created = await r.create(await apk(COMPOSE), { launch: true }); assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.session.id;
    try {
      const { memory } = created.body.session;
      assert.equal(memory.maxHeapObjects, expectedObjects); if (expectedObjects === 671088) { assert.equal(memory.budgetMiB, 1024); assert.equal(memory.workerHeapMb, 3072); }
      assert.equal(created.body.config.missingApis, 'primitives'); assert.deepEqual(created.body.config.network.allowedHosts, ['*']); assert.equal(created.body.config.raster, 'full'); assert.deepEqual(created.body.config.appData, { keep: true, clear: false });
      const ready = await r.api('POST', `/sessions/${id}/wait`, { json: { ready: true, timeoutMs: 30000 } }); assert.equal(ready.status, 200, JSON.stringify(ready.body)); assert.equal(ready.body.ready, true);
      // The default engine is the site's: the WebAssembly core with its default memory; its health is the core's (no object limit), not the JavaScript VM's
      assert.equal(created.body.config.engine, 'wasm'); assert.deepEqual(created.body.config.coreMemory, { heapMiB: 512, metaMiB: 512, threads: 1000 }); assert.equal(memory.engine, 'wasm');
      const health0 = (await r.api('GET', `/sessions/${id}/snapshot`)).body.vmHealth;
      assert.equal(health0.engine, 'wasm', JSON.stringify(health0)); assert.equal(health0.limit, null); assert.equal(health0.core.threadCapacity, 1000, 'the core got the thread capacity the session reports'); assert.ok(health0.core.metaBytes > 0);
      // engine "js": the JavaScript VM, whose object limit is the budget the session reports
      const onJs = await r.create(await apk(COMPOSE), { launch: true, engine: 'js' }); assert.equal(onJs.status, 201, JSON.stringify(onJs.body));
      try { assert.equal(onJs.body.session.memory.engine, 'js'); const jsHealth = (await r.api('GET', `/sessions/${onJs.body.session.id}/snapshot`)).body.vmHealth; assert.equal(jsHealth.engine, 'js'); assert.equal(jsHealth.limit, expectedObjects, 'the VM got the limit the session reports'); }
      finally { await r.api('DELETE', `/sessions/${onJs.body.session.id}`); }
      const reloaded = await r.api('POST', `/sessions/${id}/reload`, { json: { mode: 'recreate' } }); assert.equal(reloaded.status, 200, JSON.stringify(reloaded.body)); assert.match(reloaded.body.snapshot.activity, /MainActivity$/);
      assert.equal((await r.api('POST', `/sessions/${id}/wait`, { json: { ready: true, timeoutMs: 30000 } })).body.ready, true);
      const reopened = await r.api('POST', `/sessions/${id}/reload`, { json: { mode: 'reopen' } }); assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    } finally { await r.api('DELETE', `/sessions/${id}`); }

    // raster "progressive" with rasterScale 0.25: the Worker uses the scale, a screenshot after Tela pronta is still full size; rasterScale applies live
    const progressive = await r.create(await apk(COMPOSE), { launch: true, raster: 'progressive', rasterScale: 0.25, rasterNavigation: true }); assert.equal(progressive.status, 201, JSON.stringify(progressive.body));
    const pid = progressive.body.session.id;
    try {
      await r.api('POST', `/sessions/${pid}/tap`, { json: { selector: { testTag: 'filter-Pendentes' } } });
      const full = await r.api('GET', `/sessions/${pid}/snapshot?full=1`); assert.equal(full.body.vmHealth.motionRaster.scale, 0.25); assert.equal(full.body.vmHealth.motionRaster.enabled, true);
      const shot = await r.api('GET', `/sessions/${pid}/screenshot.png?waitReady=1`); assert.equal(shot.status, 200);
      assert.deepEqual(helpers.pngSize(shot.body), { width: 411, height: 914 }); assert.equal(JSON.parse(shot.headers.get('x-screen-ready')).ready, true);
      const live = await r.api('PATCH', `/sessions/${pid}/config`, { json: { rasterScale: 0.75, rasterNavigation: false } }); assert.equal(live.status, 200, JSON.stringify(live.body));
      assert.deepEqual(live.body.applied.find(item => item.key === 'raster').raster, { scale: 0.75, enabled: true, navigation: false, settled: 1 });
      await r.api('POST', `/sessions/${pid}/tap`, { json: { selector: { testTag: 'filter-Todos' } } });
      assert.equal((await r.api('GET', `/sessions/${pid}/snapshot?full=1`)).body.vmHealth.motionRaster.scale, 0.75);
      assert.equal((await r.api('PATCH', `/sessions/${pid}/config`, { json: { rasterScale: 0.3 } })).status, 400);
    } finally { await r.api('DELETE', `/sessions/${pid}`); }
  } finally { await r.close(); }
});

test('network defaults: a mocked endpoint answers with no network config; a private target is refused unless RUNNER_ALLOW_PRIVATE_NETWORK=1', { skip, timeout: 180000 }, async () => {
  const helpers = await import('../helpers/runner.mjs'), server = await localServer(), port = server.address().port;
  const mock = { name: 'perfil', method: 'GET', url: 'http://localhost:8000/net-probe/hello.json', status: 200, headers: [{ name: 'Content-Type', value: 'application/json' }], body: '{"message":"resposta do mock"}' };
  const redirect = { network: { hostMap: [{ from: 'localhost:8000', to: `127.0.0.1:${port}` }] } };
  const saved = process.env.RUNNER_ALLOW_PRIVATE_NETWORK;
  try {
    delete process.env.RUNNER_ALLOW_PRIVATE_NETWORK;
    const r = await helpers.startRunner();
    try {
      const mocked = await r.create(await apk(NET), { launch: true, endpointMocks: [mock] }); const id = mocked.body.session.id;
      try {
        await r.api('POST', `/sessions/${id}/tap`, { json: { selector: { text: 'Load' } } });
        assert.equal((await r.api('POST', `/sessions/${id}/wait`, { json: { selector: { textContains: 'resposta do mock' }, timeoutMs: 15000 } })).status, 200);
      } finally { await r.api('DELETE', `/sessions/${id}`); }
      for (const config of [redirect, {}]) {   // through a host redirect to 127.0.0.1, and straight to localhost:8000 (the server's own loopback)
        const refused = await r.create(await apk(NET), { launch: true, ...config }); const rid = refused.body.session.id;
        try {
          await r.api('POST', `/sessions/${rid}/tap`, { json: { selector: { text: 'Load' } } });
          let row; for (let i = 0; i < 100 && !row; i++) { row = (await r.api('GET', `/sessions/${rid}/network`)).body.requests.find(entry => entry.complete); if (!row) await new Promise(resolve => setTimeout(resolve, 100)); }
          assert.ok(row, 'the request reached the network log'); assert.equal(row.status, null);
          assert.match(row.failure?.message ?? '', /RUNNER_ALLOW_PRIVATE_NETWORK/, JSON.stringify(row));
        } finally { await r.api('DELETE', `/sessions/${rid}`); }
      }
      assert.equal(server.hits ?? 0, 0, 'nothing reached the local server');
    } finally { await r.close(); }

    process.env.RUNNER_ALLOW_PRIVATE_NETWORK = '1';
    const open = await helpers.startRunner();
    try {
      assert.equal((await open.api('GET', '/health', { token: null })).body.network.allowPrivateNetwork, true);
      const allowed = await open.create(await apk(NET), { launch: true, ...redirect }); const aid = allowed.body.session.id;
      try {
        await open.api('POST', `/sessions/${aid}/tap`, { json: { selector: { text: 'Load' } } });
        assert.equal((await open.api('POST', `/sessions/${aid}/wait`, { json: { selector: { textContains: 'servidor local /net-probe/hello.json' }, timeoutMs: 15000 } })).status, 200);
        assert.ok(server.hits >= 1);
      } finally { await open.api('DELETE', `/sessions/${aid}`); }
    } finally { await open.close(); }
  } finally {
    if (saved === undefined) delete process.env.RUNNER_ALLOW_PRIVATE_NETWORK; else process.env.RUNNER_ALLOW_PRIVATE_NETWORK = saved;
    await new Promise(resolve => server.close(resolve));
  }
});
