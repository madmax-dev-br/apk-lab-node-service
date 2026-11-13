// Pieces of the screen, end to end on the synthetic Compose example: a plugin sent through the API that returns one component (its data and a PNG of just it,
// with padding, and a box of the window), the REST forms (?rect= on screenshot.png, padding on an element, POST /screenshot-pieces) and the queue step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { apkPath, apkSkip, tempDir, silent } from '../helpers/env.mjs';

const COMPOSE = 'compose-approvals-debug.apk';
const skip = apkSkip(COMPOSE);

const PLUGIN = `
  const [busca] = await lab.find({ testTag: 'search' });
  lab.ui.kv({ key: busca.key, kind: busca.kind, largura: Math.round(busca.size.width), altura: Math.round(busca.size.height), esquerda: busca.bounds.left, topo: busca.bounds.top }, { id: 'dados' });
  lab.ui.image(await lab.capture({ testTag: 'search' }, { padding: 8 }), { id: 'componente', caption: 'Campo de busca' });
  lab.ui.image(await lab.screenshot({ bounds: { left: 0, top: 0, right: 200, bottom: 100 } }), { id: 'retangulo', caption: 'Retângulo' });
`;

test('a plugin sent through the API returns one component: its bounds and a PNG of just it (padding included), and a box of the window', { skip, timeout: 120000 }, async () => {
  const { startRunner, pngSize } = await import('../helpers/runner.mjs');
  const r = await startRunner({ pluginsAllowed: true });
  try {
    const created = await r.create(await readFile(apkPath(COMPOSE)), { launch: true }); assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.session.id;
    assert.equal((await r.api('POST', `/sessions/${id}/wait`, { json: { ready: true, timeoutMs: 30000 } })).body.ready, true);
    const put = await r.api('PUT', `/sessions/${id}/plugins`, { json: [{ id: 'componente', name: 'Um componente', code: PLUGIN }] }); assert.equal(put.status, 200, JSON.stringify(put.body));
    let out; for (let i = 0; i < 120; i++) { out = (await r.api('GET', `/sessions/${id}/plugins/componente`)).body; if (out?.blocks?.filter(b => b.kind === 'image').length >= 2 || out?.errorCount) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.equal(out.errorCount ?? 0, 0, JSON.stringify(out.errors));
    const data = Object.fromEntries(out.blocks.find(block => block.id === 'dados').entries);
    const element = (await r.api('GET', `/sessions/${id}/elements?testTag=search`)).body.elements[0];
    assert.equal(data.key, element.key, 'the plugin found the component REST finds');
    const width = element.bounds.right - element.bounds.left, height = element.bounds.bottom - element.bounds.top;
    const images = Object.fromEntries((await Promise.all(out.blocks.map(async (block, index) => block.kind !== 'image' ? null : [block.id, pngSize((await r.api('GET', `/sessions/${id}/plugins/componente/blocks/${index}/image`)).body)]))).filter(Boolean));
    assert.deepEqual(images.componente, { width: width + 16, height: height + 16 }, 'the component with 8 dp of padding on each side');
    assert.deepEqual(images.retangulo, { width: 200, height: 100 }, 'lab.screenshot({ bounds }) cuts that box of the window, not the whole screen');
  } finally { await r.close(); }
});

test('REST pieces: screenshot.png?rect=, padding on an element, and several pieces from one painting (a missing one answers on its own)', { skip, timeout: 120000 }, async () => {
  const { startRunner, pngSize } = await import('../helpers/runner.mjs');
  const r = await startRunner();
  try {
    const created = await r.create(await readFile(apkPath(COMPOSE)), { launch: true }); const id = created.body.session.id;
    await r.api('POST', `/sessions/${id}/wait`, { json: { ready: true, timeoutMs: 30000 } });
    const rect = await r.api('GET', `/sessions/${id}/screenshot.png?rect=0,0,200,100`); assert.equal(rect.status, 200);
    assert.deepEqual(pngSize(rect.body), { width: 200, height: 100 });
    const offset = JSON.parse(rect.headers.get('x-screen-bounds')); assert.equal(offset.right - offset.left, 200, 'x-screen-bounds: the box on the painted screen');
    assert.equal((await r.api('GET', `/sessions/${id}/screenshot.png?rect=10,10,5,5`)).status, 400);
    assert.equal((await r.api('GET', `/sessions/${id}/screenshot.png?rect=5000,5000,5100,5100`)).status, 422, 'a box outside the screen');
    const element = (await r.api('GET', `/sessions/${id}/elements?testTag=search`)).body.elements[0];
    const width = element.bounds.right - element.bounds.left, height = element.bounds.bottom - element.bounds.top;
    assert.deepEqual(pngSize((await r.api('GET', `/sessions/${id}/elements/${encodeURIComponent(element.key)}/screenshot.png?padding=4`)).body), { width: width + 8, height: height + 8 });
    const started = performance.now();
    const pieces = await r.api('POST', `/sessions/${id}/screenshot-pieces`, { json: { padding: 2, pieces: [{ selector: { testTag: 'search' } }, { key: element.key, padding: 0 }, { rect: [10, 10, 110, 60] }, { rect: [0, 0, 100, 50] }, { selector: { testTag: 'not-on-screen' } }] } });
    const ms = Math.round(performance.now() - started);
    assert.equal(pieces.status, 200, JSON.stringify(pieces.body));
    const [bySelector, byKey, byRect, atCorner, missing] = pieces.body.pieces;
    assert.equal(bySelector.element.key, element.key); assert.deepEqual([bySelector.width, bySelector.height], [width + 4, height + 4]);
    assert.deepEqual(pngSize(Buffer.from(bySelector.pngBase64, 'base64')), { width: width + 4, height: height + 4 });
    assert.deepEqual([byKey.kind, byKey.width, byKey.height], ['key', width, height], 'a piece\'s own padding wins');
    assert.deepEqual([byRect.kind, byRect.width, byRect.height], ['rect', 104, 54]);
    assert.deepEqual([atCorner.width, atCorner.height], [102, 52], 'padding stops at the edge of the screen');
    assert.equal(missing.error.code, 'element-not-found'); assert.equal(missing.pngBase64, undefined);
    assert.equal((await r.api('POST', `/sessions/${id}/screenshot-pieces`, { json: { pieces: [] } })).status, 400);
    console.log(`five pieces from one painting in ${ms} ms`);
  } finally { await r.close(); }
});

test('queue: a screenshotPieces step stores one artifact per piece; a screenshot step takes rect', { skip, timeout: 180000 }, async () => {
  const { startRunner, pngSize } = await import('../helpers/runner.mjs');
  const { createQueue, parseClients } = await import('../../services/queue/app.mjs');
  const runner = await startRunner();
  const queue = await createQueue({ host: '127.0.0.1', port: 0, clients: parseClients('equipe:equipe-token-1'), authDisabled: false, corsOrigins: [], runners: [{ id: 'runner-1', url: runner.base, token: runner.token }],
    maxPerClient: 1, maxQueuedPerClient: 10, maxAttempts: 1, maxApkBytes: 64 * 1024 * 1024, apkUrlHosts: [], jobTimeoutMs: 120000, leaseMaxMs: 120000, leaseIdleMs: 60000, retentionMs: 3600000,
    healthIntervalMs: 500, dataDir: tempDir('pieces-e2e'), store: 'memory', pluginsAllowed: false }, { log: silent });
  const address = await queue.listen(), base = `http://127.0.0.1:${address.port}`, auth = { authorization: 'Bearer equipe-token-1' };
  try {
    const form = new FormData();
    form.append('apk', new Blob([await readFile(apkPath(COMPOSE))]), 'app.apk');
    form.append('job', JSON.stringify({ steps: [{ type: 'launch' }, { type: 'waitReady' }, { type: 'screenshot', name: 'canto', rect: '0,0,120,60' },
      { type: 'screenshotPieces', name: 'partes', pieces: [{ selector: { testTag: 'search' } }, { rect: [0, 0, 50, 50] }, { selector: { testTag: 'not-on-screen' } }] }] }));
    const submitted = await (await fetch(`${base}/jobs`, { method: 'POST', headers: auth, body: form })).json();
    let job; for (let i = 0; i < 600; i++) { job = await (await fetch(`${base}/jobs/${submitted.id}`, { headers: auth })).json(); if (['succeeded', 'failed'].includes(job.state)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.equal(job.state, 'succeeded', JSON.stringify(job.error ?? job.result?.steps));
    assert.deepEqual(job.result.artifacts.map(a => a.name), ['canto.png', 'partes.piece-0.png', 'partes.piece-1.png']);
    const bytes = async name => Buffer.from(await (await fetch(base + job.result.artifacts.find(a => a.name === name).url, { headers: auth })).arrayBuffer());
    assert.deepEqual(pngSize(await bytes('canto.png')), { width: 120, height: 60 });
    assert.deepEqual(pngSize(await bytes('partes.piece-1.png')), { width: 50, height: 50 });
    const output = job.result.steps.find(step => step.type === 'screenshotPieces').output;
    assert.equal(output.pieces[2].error.code, 'element-not-found'); assert.equal(output.pieces[0].artifact, 'partes.piece-0.png');
  } finally { await queue.close({ keepData: false }); await runner.close(); }
});
