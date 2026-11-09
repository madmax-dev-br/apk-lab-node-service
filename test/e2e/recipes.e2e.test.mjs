// The documentation cookbook (docs/index.html, "Receitas"), run with the Node client (examples/apk-lab-client.mjs) against a local runner and queue and the
// lab's synthetic APKs. The probe APK asks for http://localhost:8000/net-probe/hello.json when "Load" is tapped, so the recipes' example URL is that one here.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { apkPath, apkSkip, tempDir, silent } from '../helpers/env.mjs';
import { RunnerClient, QueueClient } from '../../examples/apk-lab-client.mjs';

const NET = 'net-probe.apk', COMPOSE = 'compose-approvals-debug.apk', DEEPLINK = 'deeplink-probe.apk', LOCATION = 'permissions-probe.apk';
const skip = apkSkip(NET, COMPOSE, DEEPLINK, LOCATION);
const URL_PERFIL = 'http://localhost:8000/net-probe/hello.json';
let r, queue, runner, queueClient, helpers;
before(async () => {
  if (skip) return;
  helpers = await import('../helpers/runner.mjs');
  r = await helpers.startRunner({ pluginsAllowed: true, maxSessions: 3 });
  runner = new RunnerClient({ url: r.base, token: r.token });
  const { createQueue, parseClients } = await import('../../services/queue/app.mjs');
  queue = await createQueue({ host: '127.0.0.1', port: 0, clients: parseClients('equipe:equipe-token-1'), authDisabled: false, corsOrigins: [], runners: [{ id: 'runner-1', url: r.base, token: r.token }], maxPerClient: 2, maxQueuedPerClient: 10, maxAttempts: 2,
    maxApkBytes: 64 * 1024 * 1024, apkUrlHosts: [], jobTimeoutMs: 120000, leaseMaxMs: 120000, leaseIdleMs: 60000, retentionMs: 3600000, healthIntervalMs: 500, dataDir: tempDir('recipes'), store: 'memory', pluginsAllowed: true }, { log: silent });
  queueClient = new QueueClient({ url: `http://127.0.0.1:${(await queue.listen()).port}`, token: 'equipe-token-1' });
});
after(async () => { await queue?.close({ keepData: false }); await r?.close(); });
const apk = name => readFile(apkPath(name));

test('receita 1: sessão já criada com um endpoint mockado; o log de rede marca o mock', { skip, timeout: 60000 }, async () => {
  const session = await runner.createSession(await apk(NET), { launch: true, endpointMocks: [{ name: 'perfil', method: 'GET', url: URL_PERFIL, status: 200, headers: [{ name: 'Content-Type', value: 'application/json' }], body: '{"nome":"Maria","plano":"pro"}' }] });
  try {
    await session.tap({ selector: { text: 'Load' } });
    await session.wait({ textContains: '"plano":"pro"' });
    const { requests } = await session.network();
    assert.equal(requests[0].mockLabel, 'perfil'); assert.equal(requests[0].status, 200); assert.ok(requests[0].mockId);
  } finally { await session.close(); }
});

test('receita 2: mock por padrão de caminho com status 500 e atraso de 2 s', { skip, timeout: 60000 }, async () => {
  const session = await runner.createSession(await apk(NET), { launch: true, endpointMocks: [{ name: 'erro lento', method: 'GET', url: '/net-probe/*', query: 'ignore', status: 500, reason: 'Internal Server Error', body: '{"erro":"indisponível"}', delayMs: 2000 }] });
  try {
    const started = Date.now();
    await session.tap({ selector: { text: 'Load' } });
    await session.wait({ textContains: 'HTTP 500' }, { timeoutMs: 15000 });
    assert.ok(Date.now() - started >= 1900, 'the delay applies');
  } finally { await session.close(); }
});

test('receitas 3 e 4: redirecionar host para um servidor local; allow list vazia e offline recusam', { skip, timeout: 60000 }, async () => {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"origem":"servidor de homologação local"}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const session = await runner.createSession(await apk(NET), { launch: true, network: { allowedHosts: ['127.0.0.1'], hostMap: [{ from: 'localhost:8000', to: `http://127.0.0.1:${server.address().port}` }] } });
  try {
    await session.tap({ selector: { text: 'Load' } });
    await session.wait({ textContains: 'homologação local' });
    await session.updateConfig({ network: { hostMap: [], allowedHosts: [] } });
    await session.tap({ selector: { text: 'Load' } });
    await session.wait({ textContains: 'homologação local' }, { gone: true });
    let { requests } = await session.network(); assert.equal(requests.at(-1).outcome, 'refused-by-allowlist');
    await session.updateConfig({ network: { offline: true } });
    await session.tap({ selector: { text: 'Load' } }); await new Promise(resolve => setTimeout(resolve, 300));
    ({ requests } = await session.network()); assert.equal(requests.at(-1).outcome, 'offline');
  } finally { await session.close(); await new Promise(resolve => server.close(resolve)); }
});

test('receitas 5 a 8: permissões com localização, retorno de método, Activity ignorada, dispositivo ao vivo', { skip, timeout: 60000 }, async () => {
  const session = await runner.createSession(await apk(LOCATION), { launch: true, permissions: { states: { 'android.permission.ACCESS_FINE_LOCATION': 'allow' }, location: { enabled: true, latitude: -22.9068, longitude: -43.1729, accuracy: 5 } } });
  try {
    assert.equal((await session.config()).permissions.location.latitude, -22.9068);
    const live = await session.updateConfig({ methodOverrides: [{ method: 'dev.exemplo.Flags.novoCheckout(): boolean', value: 'true' }], ignoredActivities: ['.OnboardingActivity'], device: { orientation: 'landscape', locale: 'en-US', darkTheme: true } });
    const byKey = Object.fromEntries(live.applied.map(entry => [entry.key, entry]));
    assert.equal(byKey.methodOverrides.statuses[0].state, 'missing', 'a method the APK does not define is reported, never faked');
    assert.equal(byKey.ignoredActivities.statuses[0].state, 'missing');
    assert.ok(byKey.device.outcome.changed > 0);
    const snapshot = await session.snapshot(); assert.equal(snapshot.systemBars.orientation, 'landscape');
  } finally { await session.close(); }
});

test('receitas 9, 12 e 14: deep link, SSE de eventos, captura de um elemento', { skip, timeout: 60000 }, async () => {
  const session = await runner.createSession(await apk(DEEPLINK), { launch: true }), events = [];
  const stream = session.streamEvents(event => events.push(event.event));
  try {
    const { deepLink } = await session.intent({ action: 'android.intent.action.VIEW', data: 'myprobe://item/42' });
    assert.equal(deepLink.ok, true);
    const { element } = await session.wait({ textContains: 'myprobe://item/42' });
    const png = await session.elementScreenshot(element.key); assert.ok(helpers.pngSize(png).width > 0);
    await new Promise(resolve => setTimeout(resolve, 200)); assert.ok(events.includes('snapshot'));
  } finally { stream.stop(); await session.close(); }
});

test('receita 13: plugin no servidor observa um campo de ViewModel', { skip, timeout: 60000 }, async () => {
  const session = await runner.createSession(await apk(COMPOSE), { launch: true });
  try {
    await session.setPlugins([{ id: 'orcamento', name: 'Orçamento', code: `
      const [vm] = (await lab.viewModels()).filter(model => !model.library);
      lab.ui.text(vm.className, { id: 'classe' });
      lab.watch(vm.handle, 'budget.value', (valor, anterior) => lab.ui.kv({ valor, anterior: anterior ?? '—' }, { id: 'budget' }), { intervalMs: 250 });` }]);
    let output; for (let i = 0; i < 80; i++) { output = await session.plugin('orcamento'); if (output.blocks.some(block => block.id === 'budget') || output.status === 'erro') break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.notEqual(output.status, 'erro', JSON.stringify(output.errors));
    assert.equal(Object.fromEntries(output.blocks.find(block => block.id === 'budget').entries).valor, '300000');
  } finally { await session.close(); }
});

test('receitas 10 e 11: job na fila com passos e resultados; lease interativo', { skip, timeout: 120000 }, async () => {
  const job = await queueClient.submitJob(await apk(COMPOSE), { label: 'busca', steps: [
    { type: 'launch' }, { type: 'wait', selector: { text: 'Pedidos da equipe' } }, { type: 'tap', selector: { testTag: 'filter-Pendentes' } },
    { type: 'type', selector: { testTag: 'search' }, text: 'Monitor' }, { type: 'screenshot', name: 'resultado' }, { type: 'layoutBounds', name: 'limites' },
    { type: 'viewModelField', viewModel: 'ExpenseModel', path: 'reviewer.value' } ] });
  const done = await queueClient.waitJob(job.id, { intervalMs: 200 });
  assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
  assert.equal(done.result.steps.at(-1).output.value, 'Ana Silva');
  assert.ok(helpers.pngSize(await queueClient.artifact(done, 'resultado.png')));
  const { session, release } = await queueClient.lease(await apk(NET), { config: { launch: true, endpointMocks: [{ method: 'GET', url: URL_PERFIL, body: 'pelo lease' }] } });
  await session.tap({ selector: { text: 'Load' } }); await session.wait({ textContains: 'pelo lease' });
  assert.equal((await release()).state, 'released');
});

test('receita 16: recarregar a tela — recreate mantém o ViewModel, reopen cria outro e carrega de novo', { skip, timeout: 90000 }, async () => {
  const session = await runner.createSession(await apk(COMPOSE), { launch: true });
  try {
    await session.waitReady();
    const antes = (await session.viewModels()).find(m => !m.library);
    const recreated = await session.reload('recreate'); assert.equal(recreated.mode, 'recreate');
    assert.equal((await session.viewModels()).find(m => !m.library).handle, antes.handle);
    await session.updateConfig({ endpointMocks: [{ method: 'GET', url: '/v1/pedidos', body: '[]' }] });
    await session.reload('reopen');
    assert.notEqual((await session.viewModels()).find(m => !m.library).handle, antes.handle);
    const pronta = await session.waitReady(); assert.equal(pronta.ready, true);
  } finally { await session.close(); }
});

test('receita 17: esperar a tela ficar pronta e tirar o print (sessão com mock e job na fila)', { skip, timeout: 120000 }, async () => {
  const mocks = [{ method: 'GET', url: URL_PERFIL, status: 200, headers: [{ name: 'Content-Type', value: 'application/json' }], body: '{"nome":"Maria"}' }];
  const session = await runner.createSession(await apk(NET), { endpointMocks: mocks });
  const flips = [];
  const stream = session.streamReady(e => flips.push(e.ready));
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    await session.launch();
    const waited = await session.waitReady({ timeoutMs: 15000 }); assert.equal(waited.ready, true);
    assert.equal((await session.ready()).ready, true);
    assert.ok(helpers.pngSize(await session.screenshot({ waitReady: true })));
    await session.tap({ selector: { text: 'Load' } });
    const both = await session.wait({ textContains: 'Maria' }, { ready: true, timeoutMs: 15000 }); assert.equal(both.ready, true); assert.ok(both.element);
    for (let i = 0; i < 50 && !flips.includes(true); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(flips.includes(true), 'the ready flip reached the events stream');
    await assert.rejects(session.wait(null, { timeoutMs: 100 }), error => error.status === 400);
  } finally { stream.stop(); await session.close(); }

  const job = await queueClient.submitJob(await apk(NET), { config: { endpointMocks: [{ method: 'GET', url: URL_PERFIL, body: '{"nome":"Maria"}' }] }, steps: [
    { type: 'launch' }, { type: 'waitReady', timeoutMs: 15000 }, { type: 'screenshot', name: 'pronta', waitReady: true },
    { type: 'reload', mode: 'reopen' }, { type: 'tap', selector: { text: 'Load' } }, { type: 'wait', ready: true, selector: { textContains: 'Maria' } }, { type: 'screenshot', name: 'reaberta', waitReady: true } ] });
  const done = await queueClient.waitJob(job.id, { intervalMs: 200 });
  assert.equal(done.state, 'succeeded', JSON.stringify(done.error ?? done.result?.steps));
  assert.deepEqual(done.result.artifacts.map(a => a.name), ['pronta.png', 'reaberta.png']);
  assert.ok(helpers.pngSize(await queueClient.artifact(done, 'pronta.png')));
});
