// End to end: "Tela pronta" (snapshot.screenReady) and "Recriar / Reabrir" on a real runner with the lab's synthetic Compose example, a queued job that uses them,
// and a server-side plugin that waits for the ready screen (needs the runtime and APK_LAB_TEST_APK_DIR). No external network.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { apkPath, apkSkip, tempDir, silent } from '../helpers/env.mjs';

const COMPOSE = 'compose-approvals-debug.apk';
const skip = apkSkip(COMPOSE);
let r, helpers;
before(async () => { if (skip) return; helpers = await import('../helpers/runner.mjs'); r = await helpers.startRunner({ pluginsAllowed: true, maxSessions: 2 }); });
after(async () => { await r?.close(); });
const apk = () => readFile(apkPath(COMPOSE));
const appViewModel = async id => { const models = (await r.api('GET', `/sessions/${id}/view-models`)).body; return models.find(model => !model.library) ?? null; };

test('GET ready turns true after launch, the ready SSE event fires, wait { ready } and screenshot?waitReady=1 work', { skip, timeout: 120000 }, async () => {
  const created = await r.create(await apk(), {}); assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.session.id;
  try {
    const before = await r.api('GET', `/sessions/${id}/ready`);
    assert.equal(before.status, 200); assert.equal(before.body.ready, false); assert.equal(before.body.screenReady, null, 'no screen before launch');
    const events = await fetch(`${r.base}/sessions/${id}/events`, { headers: { authorization: `Bearer ${r.token}` } });
    const flips = helpers.readEvents(events, { until: list => list.some(e => e.event === 'ready' && e.data.ready === true), timeoutMs: 20000 });
    const launched = await r.api('POST', `/sessions/${id}/launch`, { json: {} }); assert.equal(launched.status, 200);
    assert.ok(launched.body.snapshot.screenReady, 'the launch summary carries screenReady');
    let ready; for (let i = 0; i < 100; i++) { ready = (await r.api('GET', `/sessions/${id}/ready`)).body; if (ready.ready) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.equal(ready.ready, true, JSON.stringify(ready)); assert.equal(ready.current, true); assert.match(ready.activity, /MainActivity$/); assert.deepEqual(ready.screenReady.waitingFor, []);
    const readyEvent = (await flips).find(e => e.event === 'ready' && e.data.ready === true);
    assert.ok(readyEvent, 'a ready event reaches the events stream'); assert.match(readyEvent.data.activity, /MainActivity$/);

    const waited = await r.api('POST', `/sessions/${id}/wait`, { json: { ready: true, timeoutMs: 15000 } });
    assert.equal(waited.status, 200, JSON.stringify(waited.body)); assert.equal(waited.body.ready, true); assert.equal(waited.body.element, null);
    const both = await r.api('POST', `/sessions/${id}/wait`, { json: { ready: true, selector: { text: 'Pedidos da equipe' }, timeoutMs: 15000 } });
    assert.equal(both.status, 200); assert.equal(both.body.element.kind, 'compose'); assert.equal(both.body.screenReady.ready, true);
    assert.equal((await r.api('POST', `/sessions/${id}/wait`, { json: { timeoutMs: 100 } })).status, 400);

    const shot = await r.api('GET', `/sessions/${id}/screenshot.png?waitReady=1&readyTimeoutMs=15000`);
    assert.equal(shot.status, 200); assert.deepEqual(helpers.pngSize(shot.body), { width: 411, height: 914 });
    assert.equal(JSON.parse(shot.headers.get('x-screen-ready')).ready, true);
    const button = (await r.api('GET', `/sessions/${id}/elements?testTag=new-order`)).body.elements[0];
    const crop = await r.api('GET', `/sessions/${id}/elements/${encodeURIComponent(button.key)}/screenshot.png?waitReady=1`);
    assert.equal(crop.status, 200); assert.ok(helpers.pngSize(crop.body));
  } finally { await r.api('DELETE', `/sessions/${id}`); }
});

test('reload: recreate keeps the Compose example\'s ViewModel, reopen gives a new one; the screen turns ready again', { skip, timeout: 120000 }, async () => {
  const created = await r.create(await apk(), { launch: true }); assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.session.id;
  try {
    assert.equal((await r.api('POST', `/sessions/${id}/wait`, { json: { ready: true, timeoutMs: 15000 } })).status, 200);
    const first = await appViewModel(id); assert.ok(first, 'the app has a ViewModel');
    const recreated = await r.api('POST', `/sessions/${id}/reload`, { json: { mode: 'recreate' } });
    assert.equal(recreated.status, 200, JSON.stringify(recreated.body)); assert.equal(recreated.body.mode, 'recreate'); assert.match(recreated.body.snapshot.activity, /MainActivity$/);
    const kept = await appViewModel(id);
    assert.equal(kept.handle, first.handle, 'recreate keeps the retained ViewModel'); assert.notEqual(kept.owner.handle, first.owner.handle, 'with a new Activity instance');
    assert.equal((await r.api('POST', `/sessions/${id}/wait`, { json: { ready: true, selector: { text: 'Pedidos da equipe' }, timeoutMs: 15000 } })).status, 200);
    const reopened = await r.api('POST', `/sessions/${id}/reload`, { json: { mode: 'reopen' } });
    assert.equal(reopened.status, 200); assert.equal(reopened.body.mode, 'reopen');
    const fresh = await appViewModel(id);
    assert.equal(fresh.className, first.className); assert.notEqual(fresh.handle, first.handle, 'reopen clears the ViewModelStore');
    assert.equal((await r.api('POST', `/sessions/${id}/wait`, { json: { ready: true, timeoutMs: 15000 } })).status, 200);
    const recreateDefault = await r.api('POST', `/sessions/${id}/reload`); assert.equal(recreateDefault.status, 200); assert.equal(recreateDefault.body.mode, 'recreate');
    assert.equal((await r.api('POST', `/sessions/${id}/reload`, { json: { mode: 'refresh' } })).status, 400);
  } finally { await r.api('DELETE', `/sessions/${id}`); }
});

test('a plugin that awaits lab.waitReady produces an image block; the "Print na tela pronta" template does too', { skip, timeout: 120000 }, async () => {
  const created = await r.create(await apk(), { launch: true }); assert.equal(created.status, 201);
  const id = created.body.session.id;
  try {
    const template = (await r.api('GET', '/plugin-templates')).body.find(item => item.name === 'Print na tela pronta');
    assert.ok(template, 'the service lists its template');
    const code = `const tela = await lab.waitReady({ timeoutMs: 15000 });
lab.ui.text(tela.ready.ready ? 'pronta' : 'não', { id: 'estado' });
lab.ui.image(await lab.screenshot({ maxWidth: 200 }), { id: 'print', caption: tela.activity });`;
    const put = await r.api('PUT', `/sessions/${id}/plugins`, { json: { plugins: [{ id: 'espera', name: 'Espera', code }, { id: 'modelo', name: template.name, code: template.code }] } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const wait = async pid => { let out; for (let i = 0; i < 150; i++) { out = (await r.api('GET', `/sessions/${id}/plugins/${pid}`)).body; if (out.blocks?.some(block => block.kind === 'image') || out.status === 'erro') break; await new Promise(resolve => setTimeout(resolve, 100)); } return out; };
    const plugin = await wait('espera');
    assert.notEqual(plugin.status, 'erro', JSON.stringify(plugin.errors));
    assert.equal(plugin.blocks.find(block => block.id === 'estado').text, 'pronta');
    const image = plugin.blocks.find(block => block.id === 'print'); assert.equal(image.kind, 'image'); assert.match(image.caption, /MainActivity$/);
    const png = await r.api('GET', `/sessions/${id}/${image.path}`); assert.ok(helpers.pngSize(png.body));
    const fromTemplate = await wait('modelo');
    assert.notEqual(fromTemplate.status, 'erro', JSON.stringify(fromTemplate.errors)); assert.ok(fromTemplate.blocks.some(block => block.kind === 'image' && /pronta #1/.test(block.caption)));
  } finally { await r.api('DELETE', `/sessions/${id}`); }
});

test('queue + runner: a job with reload, waitReady and screenshot { waitReady } succeeds', { skip, timeout: 180000 }, async () => {
  const { createQueue, parseClients } = await import('../../services/queue/app.mjs');
  const queue = await createQueue({ host: '127.0.0.1', port: 0, clients: parseClients('equipe:equipe-token-1'), authDisabled: false, corsOrigins: [], runners: [{ id: 'runner-1', url: r.base, token: r.token }],
    maxPerClient: 1, maxQueuedPerClient: 10, maxAttempts: 1, maxApkBytes: 64 * 1024 * 1024, apkUrlHosts: [], jobTimeoutMs: 150000, leaseMaxMs: 120000, leaseIdleMs: 60000, retentionMs: 3600000,
    healthIntervalMs: 500, dataDir: tempDir('ready-e2e'), store: 'memory', pluginsAllowed: false }, { log: silent });
  const base = `http://127.0.0.1:${(await queue.listen()).port}`, auth = { authorization: 'Bearer equipe-token-1' };
  try {
    const steps = [{ type: 'launch' }, { type: 'waitReady' }, { type: 'viewModels', name: 'antes' }, { type: 'reload', mode: 'recreate' }, { type: 'waitReady', timeoutMs: 20000 },
      { type: 'reload', mode: 'reopen' }, { type: 'wait', ready: true, selector: { text: 'Pedidos da equipe' } }, { type: 'screenshot', name: 'pronta', waitReady: true }];
    const submitted = await (await fetch(`${base}/jobs`, { method: 'POST', headers: { ...auth, 'content-type': 'application/octet-stream', 'x-job': JSON.stringify({ steps }) }, body: await apk() })).json();
    assert.equal(submitted.state, 'queued', JSON.stringify(submitted));
    let job; for (let i = 0; i < 1200; i++) { job = await (await fetch(`${base}/jobs/${submitted.id}`, { headers: auth })).json(); if (['succeeded', 'failed'].includes(job.state)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.equal(job.state, 'succeeded', JSON.stringify(job.error ?? job.result?.steps));
    const byName = Object.fromEntries(job.result.steps.map((step, index) => [step.name ?? `${step.type}-${index}`, step]));
    assert.equal(job.result.steps[1].output.ready, true); assert.equal(job.result.steps[3].output.mode, 'recreate'); assert.equal(job.result.steps[5].output.mode, 'reopen');
    assert.equal(job.result.steps[6].output.ready, true); assert.equal(byName.pronta.output.ready.ready, true);
    const png = Buffer.from(await (await fetch(base + job.result.artifacts.find(a => a.name === 'pronta.png').url, { headers: auth })).arrayBuffer());
    assert.deepEqual(helpers.pngSize(png), { width: 411, height: 914 });
  } finally { await queue.close({ keepData: false }); }
});
