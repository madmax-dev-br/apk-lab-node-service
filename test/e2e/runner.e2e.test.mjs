// End to end on a real runner with the lab's synthetic test APKs (APK_LAB_TEST_APK_DIR) and the runtime (APK_LAB_RUNTIME_DIR or vendor/apk-lab).
// No external network: the HTTP the APKs make is answered by endpoint mocks or by a local server through a host redirect.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { apkPath, apkSkip } from '../helpers/env.mjs';

const COMPOSE = 'compose-approvals-debug.apk', NET = 'net-probe.apk', XML = 'kotlin-counter.apk', DEEPLINK = 'deeplink-probe.apk';
const skip = apkSkip(COMPOSE, NET, XML, DEEPLINK);
let r, helpers; const timings = {};
before(async () => { if (skip) return; helpers = await import('../helpers/runner.mjs'); r = await helpers.startRunner({ pluginsAllowed: true, maxSessions: 3 }); });
after(async () => { await r?.close(); if (Object.keys(timings).length) console.log(`timings ${JSON.stringify(timings)}`); });
const apk = name => readFile(apkPath(name));

test('Compose app: launch, wait, tap by testTag, type, layout bounds, screenshots, inspection', { skip, timeout: 120000 }, async () => {
  const form = new FormData(); form.append('apk', new Blob([await apk(COMPOSE)]), 'app.apk'); form.append('config', JSON.stringify({ launch: true }));
  const started = Date.now(), created = await r.api('POST', '/sessions', { body: form });
  assert.equal(created.status, 201, JSON.stringify(created.body)); timings.composeCreateAndLaunchMs = Date.now() - started; timings.composeLoadMs = created.body.session.metrics.loadMs; timings.composeLaunchMs = created.body.session.metrics.launchMs;
  const id = created.body.session.id; assert.equal(created.body.session.state, 'running'); assert.match(created.body.snapshot.activity, /MainActivity$/);
  try {
    const waited = await r.api('POST', `/sessions/${id}/wait`, { json: { selector: { text: 'Pedidos da equipe' }, timeoutMs: 10000 } });
    assert.equal(waited.status, 200); assert.equal(waited.body.element.kind, 'compose');
    const tap = await r.api('POST', `/sessions/${id}/tap`, { json: { selector: { testTag: 'filter-Pendentes' } } });
    assert.equal(tap.status, 200); assert.equal(tap.body.via, 'semantics');
    const typed = await r.api('POST', `/sessions/${id}/type`, { json: { selector: { testTag: 'search' }, text: 'Monitor' } });
    assert.equal(typed.status, 200);
    assert.equal((await r.api('POST', `/sessions/${id}/wait`, { json: { selector: { testTag: 'search', text: 'Monitor' }, timeoutMs: 5000 } })).status, 200);
    const missing = await r.api('POST', `/sessions/${id}/wait`, { json: { selector: { text: 'nunca aparece' }, timeoutMs: 300 } });
    assert.equal(missing.status, 408); assert.equal(missing.body.error.code, 'wait-timeout');
    const bounds = await r.api('GET', `/sessions/${id}/layout-bounds`);
    const search = bounds.body.elements.find(element => element.testTag === 'search');
    assert.ok(search, 'the search field is a layout-bounds element'); assert.ok(search.actions.includes('SetText')); assert.ok(bounds.body.elements.some(element => element.nameSource === 'composable' || element.nameSource === 'layout'));
    let t = Date.now(); const shot = await r.api('GET', `/sessions/${id}/screenshot.png`); timings.screenshotMs = Date.now() - t;
    assert.equal(shot.status, 200); assert.deepEqual(helpers.pngSize(shot.body), { width: 411, height: 914 });
    const scaled = await r.api('GET', `/sessions/${id}/screenshot.png?scale=2`); assert.deepEqual(helpers.pngSize(scaled.body), { width: 822, height: 1828 });
    const button = bounds.body.elements.find(element => element.testTag === 'new-order');
    t = Date.now(); const crop = await r.api('GET', `/sessions/${id}/elements/${encodeURIComponent(button.key)}/screenshot.png`); timings.elementScreenshotMs = Date.now() - t;
    assert.deepEqual(helpers.pngSize(crop.body), { width: Math.ceil(button.screenBounds.right) - Math.floor(button.screenBounds.left), height: Math.ceil(button.screenBounds.bottom) - Math.floor(button.screenBounds.top) });
    const tree = await r.api('GET', `/sessions/${id}/compose-tree`); assert.ok(tree.body.totalNodes > 10);
    const models = await r.api('GET', `/sessions/${id}/view-models`); assert.ok(Array.isArray(models.body) && models.body.length > 0);
    const appModel = models.body.find(model => !model.library) ?? models.body[0];
    const inspected = await r.api('POST', `/sessions/${id}/inspect`, { json: { handle: appModel.handle, options: { depth: 1 } } }); assert.equal(inspected.status, 200); assert.equal(inspected.body.$type, appModel.className);
    assert.equal((await r.api('POST', `/sessions/${id}/inspect`, { json: { handle: 'h1.zz' } })).status, 410);
    const back = await r.api('POST', `/sessions/${id}/back`); assert.equal(back.status, 200);
    const diag = await r.api('GET', `/sessions/${id}/diagnostic`); assert.match(diag.body.screenState, /Estado da tela/);
  } finally { await r.api('DELETE', `/sessions/${id}`); }
});

test('endpoint mock configured at creation answers the app; logcat SSE and the network log show it', { skip, timeout: 60000 }, async () => {
  const mock = { name: 'perfil', method: 'GET', url: 'http://localhost:8000/net-probe/hello.json', status: 200, headers: [{ name: 'Content-Type', value: 'application/json' }], body: '{"message":"resposta do mock"}' };
  const created = await r.create(await apk(NET), { launch: true, endpointMocks: [mock] }); assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.session.id;
  try {
    const stream = await fetch(`${r.base}/sessions/${id}/logcat/stream`, { headers: { authorization: `Bearer ${r.token}` } });
    const netStream = await fetch(`${r.base}/sessions/${id}/network/stream`, { headers: { authorization: `Bearer ${r.token}` } });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal((await r.api('POST', `/sessions/${id}/tap`, { json: { selector: { text: 'Load' } } })).body.via, 'click');
    const waited = await r.api('POST', `/sessions/${id}/wait`, { json: { selector: { textContains: 'resposta do mock' }, timeoutMs: 10000 } }); assert.equal(waited.status, 200);
    const logs = await helpers.readEvents(stream, { until: events => events.some(e => e.event === 'log' && /mock/i.test(e.data.message)) });
    assert.ok(logs.some(e => e.event === 'log' && e.data.tag === 'APKWebLab'), 'the mock hit reaches the logcat stream');
    const net = await helpers.readEvents(netStream, { until: events => events.some(e => e.data.complete) });
    assert.ok(net.some(e => e.data.mockId && e.data.status === 200));
    const page = await r.api('GET', `/sessions/${id}/network`); assert.equal(page.body.requests[0].mockLabel, 'perfil');
    const lines = await r.api('GET', `/sessions/${id}/logcat?tag=APKWebLab`); assert.ok(lines.body.lines.length >= 1);
    const live = await r.api('PATCH', `/sessions/${id}/config`, { json: { endpointMocks: [{ ...mock, status: 500, body: 'falhou', delayMs: 100 }] } });
    assert.equal(live.body.applied[0].key, 'endpointMocks');
    await r.api('POST', `/sessions/${id}/tap`, { json: { selector: { text: 'Load' } } });
    assert.equal((await r.api('POST', `/sessions/${id}/wait`, { json: { selector: { textContains: 'HTTP 500' }, timeoutMs: 10000 } })).status, 200);
  } finally { await r.api('DELETE', `/sessions/${id}`); }
});

test('host redirect sends the app to a local server; the allow list and offline refuse', { skip, timeout: 60000 }, async () => {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: `servidor local ${req.url}` })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const created = await r.create(await apk(NET), { launch: true, network: { allowedHosts: ['127.0.0.1'], hostMap: [{ from: 'localhost:8000', to: `127.0.0.1:${port}` }] } });
  const id = created.body.session.id;
  try {
    await r.api('POST', `/sessions/${id}/tap`, { json: { selector: { text: 'Load' } } });
    assert.equal((await r.api('POST', `/sessions/${id}/wait`, { json: { selector: { textContains: 'servidor local /net-probe/hello.json' }, timeoutMs: 10000 } })).status, 200);
    const net = await r.api('GET', `/sessions/${id}/network`); assert.ok(net.body.requests.some(row => row.mappedUrl?.includes(`127.0.0.1:${port}`)));
    await r.api('PATCH', `/sessions/${id}/config`, { json: { network: { offline: true } } });
    await r.api('POST', `/sessions/${id}/tap`, { json: { selector: { text: 'Load' } } });
    await r.api('POST', `/sessions/${id}/wait`, { json: { selector: { textContains: 'servidor local' }, gone: true, timeoutMs: 10000 } });
    const refused = await r.api('GET', `/sessions/${id}/network`); assert.ok(refused.body.requests.some(row => row.outcome === 'offline'), JSON.stringify(refused.body.requests.map(row => row.outcome)));
  } finally { await r.api('DELETE', `/sessions/${id}`); await new Promise(resolve => server.close(resolve)); }
});

test('XML Views: tap by text, live device change, deep link intent', { skip, timeout: 60000 }, async () => {
  const created = await r.create(await apk(XML), { launch: true, device: { darkTheme: false } }); const id = created.body.session.id;
  try {
    const before = (await r.api('GET', `/sessions/${id}/snapshot`)).body.views.find(view => view.kind === 'text').text;
    assert.equal((await r.api('POST', `/sessions/${id}/tap`, { json: { selector: { textContains: 'Incrementar' } } })).body.via, 'click');
    const after = (await r.api('GET', `/sessions/${id}/snapshot`)).body.views.find(view => view.kind === 'text').text;
    assert.equal(Number(after), Number(before) + 1);
    const button = (await r.api('GET', `/sessions/${id}/elements?textContains=Incrementar`)).body.elements[0];
    const center = { x: (button.screenBounds.left + button.screenBounds.right) / 2, y: (button.screenBounds.top + button.screenBounds.bottom) / 2 };
    assert.equal((await r.api('POST', `/sessions/${id}/tap`, { json: center })).body.via, 'click');
    assert.equal((await r.api('GET', `/sessions/${id}/snapshot`)).body.views.find(view => view.kind === 'text').text, String(Number(before) + 2));
    const rotated = await r.api('PATCH', `/sessions/${id}/config`, { json: { device: { orientation: 'landscape' } } }); assert.equal(rotated.status, 200);
    const shot = await r.api('GET', `/sessions/${id}/screenshot.png`), size = helpers.pngSize(shot.body); assert.ok(size.width > size.height, `landscape screenshot ${JSON.stringify(size)}`);
  } finally { await r.api('DELETE', `/sessions/${id}`); }
  const link = await r.create(await apk(DEEPLINK), { launch: true }); const linkId = link.body.session.id;
  try {
    const opened = await r.api('POST', `/sessions/${linkId}/intent`, { json: { action: 'android.intent.action.VIEW', data: 'myprobe://item/42' } });
    assert.equal(opened.status, 200); assert.equal(opened.body.deepLink.ok, true); assert.match(opened.body.snapshot.activity, /ItemActivity$/);
    assert.equal((await r.api('POST', `/sessions/${linkId}/wait`, { json: { selector: { textContains: 'myprobe://item/42' }, timeoutMs: 5000 } })).status, 200);
  } finally { await r.api('DELETE', `/sessions/${linkId}`); }
});

test('server-side plugin: lab API output, screenshot image block', { skip, timeout: 60000 }, async () => {
  const created = await r.create(await apk(COMPOSE), { launch: true }); const id = created.body.session.id;
  try {
    const code = `const activity = await lab.activity(); lab.ui.text(activity.className, { id: 'activity' });
      const models = await lab.viewModels(); lab.ui.kv({ viewModels: models.length }, { id: 'vms' });
      const bounds = await lab.layoutBounds({ names: false }); lab.ui.text(String(bounds.some(b => b.testTag === 'search')), { id: 'search' });
      lab.ui.image(await lab.screenshot({ maxWidth: 200 }), { id: 'shot', caption: 'tela' });`;
    const put = await r.api('PUT', `/sessions/${id}/plugins`, { json: { plugins: [{ id: 'inspector', name: 'Inspetor', code }] } }); assert.equal(put.status, 200, JSON.stringify(put.body));
    let plugin; for (let i = 0; i < 100; i++) { plugin = (await r.api('GET', `/sessions/${id}/plugins/inspector`)).body; if (plugin.blocks?.length >= 4 || plugin.status === 'erro') break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.notEqual(plugin.status, 'erro', JSON.stringify(plugin.errors));
    assert.match(plugin.blocks.find(block => block.id === 'activity').text, /MainActivity$/);
    assert.equal(plugin.blocks.find(block => block.id === 'search').text, 'true');
    const image = plugin.blocks.find(block => block.id === 'shot'); assert.equal(image.kind, 'image');
    const png = await r.api('GET', `/sessions/${id}/${image.path}`); assert.equal(helpers.pngSize(png.body).width, 200);
  } finally { await r.api('DELETE', `/sessions/${id}`); }
});
