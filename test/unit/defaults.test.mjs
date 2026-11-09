// Session defaults equal to the site's, the memory budget a server gets for memory "automatic", the private-network guard and the raster settings. No VM, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { deviceMemoryFor, memoryReport, workerHeapMb } from '../../services/runner/memory.mjs';
import { sessionDefaults, withDefaults, validateConfig, missingApisMode, RASTER_SCALE_STEPS, deviceForVM } from '../../services/runner/config.mjs';
import { privateAddressKind, assertPublicHost, createGuardedFetch, PRIVATE_NETWORK_CODE } from '../../services/runner/net-guard.mjs';
import { runnerSettingsFromEnv, appDataDirFromEnv, allowedHostsFromEnv } from '../../services/runner/app.mjs';
import { Session } from '../../services/runner/session.mjs';
import { REPO_ROOT } from '../../lib/runtime-dir.mjs';
import { runtime, runtimeSkip } from '../helpers/env.mjs';

const GiB = 1024 ** 3;
// The lab's rule (runtime/memory-budget.js memoryBudget), for the tests that run without the runtime; the runtime's own function is checked against it below.
const labBudget = ({ deviceMemory = null, override = null } = {}) => {
  const budgetMiB = override ? override : Number.isFinite(deviceMemory) && deviceMemory > 0 ? Math.min(1024, Math.max(96, Math.round(deviceMemory * 128))) : 400;
  return { budgetMiB, maxHeapObjects: Math.min(2097152, Math.max(65536, Math.floor(budgetMiB * 1048576 / 1600))), source: override ? 'configured' : deviceMemory ? `navigator.deviceMemory=${deviceMemory}` : 'default' };
};

test('navigator.deviceMemory as Chrome reports it: GiB rounded down to a power of two, clamped to [0.25, 8]', () => {
  const cases = [[0.1 * GiB, 0.25], [0.3 * GiB, 0.25], [0.6 * GiB, 0.5], [1 * GiB, 1], [3.8 * GiB, 2], [4 * GiB, 4], [7.7 * GiB, 4], [8 * GiB, 8], [15.5 * GiB, 8], [16 * GiB, 8], [64 * GiB, 8], [512 * GiB, 8]];
  for (const [bytes, expected] of cases) assert.equal(deviceMemoryFor(bytes), expected, `${bytes / GiB} GiB`);
  assert.equal(deviceMemoryFor(0), null); assert.equal(deviceMemoryFor(NaN), null);
});

test('memory budget of a session: deviceMemory 8 gives the site\'s 1024 MiB / 671,088 objects; a memoryMiB step wins; the Worker heap follows', async () => {
  const budget = runtime.ok ? (await import(path.join(runtime.dir, 'runtime/memory-budget.js'))).memoryBudget : labBudget;
  assert.deepEqual(memoryReport(budget, { memoryMiB: 0, deviceMemory: 8 }), { budgetMiB: 1024, maxHeapObjects: 671088, source: 'navigator.deviceMemory=8', deviceMemory: 8 });
  assert.equal(memoryReport(budget, { memoryMiB: 0, deviceMemory: 4 }).maxHeapObjects, 335544);
  assert.equal(memoryReport(budget, { memoryMiB: 0, deviceMemory: null }).maxHeapObjects, 262144, 'no deviceMemory: the lab\'s Node default');
  const configured = memoryReport(budget, { memoryMiB: 2048, deviceMemory: 8 }); assert.equal(configured.budgetMiB, 2048); assert.equal(configured.source, 'configured'); assert.equal(configured.deviceMemory, null);
  const limits = { vmHeapMb: 2048, vmHeapMaxMb: 6144 };
  assert.equal(workerHeapMb(1024, limits), 3072, 'a 1024 MiB budget gets a 3 GiB Worker heap');
  assert.equal(workerHeapMb(400, limits), 2048); assert.equal(workerHeapMb(4096, limits), 6144, 'bounded by RUNNER_VM_HEAP_MAX_MB');
});

test('session defaults are the site\'s: missing APIs "primitives", every host allowed, app data kept; server exceptions raster "full"', () => {
  const defaults = sessionDefaults({ allowedHosts: ['*'] });
  assert.equal(defaults.missingApis, 'primitives'); assert.deepEqual(defaults.network, { allowedHosts: ['*'], hostMap: [], proxyUrl: '' });
  assert.deepEqual(defaults.appData, { keep: true, clear: false }); assert.equal(defaults.strictCrash, false); assert.equal(defaults.eventSeconds, 0); assert.equal(defaults.memoryMiB, 0);
  assert.equal(defaults.raster, 'full'); assert.equal(defaults.rasterScale, 0.5); assert.equal(defaults.rasterNavigation, true); assert.equal(defaults.logcat, 'on-demand');
  assert.deepEqual(sessionDefaults({ allowedHosts: ['api.example.test'] }).network.allowedHosts, ['api.example.test'], 'a narrower operator cap becomes the default list');
  assert.deepEqual(sessionDefaults({ allowedHosts: [] }).network.allowedHosts, []);
  const merged = withDefaults({ network: { hostMap: [{ from: 'a.test', to: 'b.test' }] }, appData: { clear: true }, missingApis: 'strict' }, { allowedHosts: ['*'] });
  assert.deepEqual(merged.network.allowedHosts, ['*']); assert.equal(merged.network.hostMap.length, 1); assert.deepEqual(merged.appData, { keep: true, clear: true }); assert.equal(merged.missingApis, 'strict');
  assert.equal(missingApisMode(undefined), 'primitives'); assert.equal(missingApisMode('strict'), 'off');
});

test('runner settings from the environment: RUNNER_ALLOWED_HOSTS "*", private network refused, app data in data/app-data', () => {
  const saved = { ...process.env };
  try {
    for (const name of ['RUNNER_ALLOWED_HOSTS', 'RUNNER_ALLOW_PRIVATE_NETWORK', 'RUNNER_APP_DATA_DIR']) delete process.env[name];
    const settings = runnerSettingsFromEnv();
    assert.deepEqual(settings.allowedHosts, ['*']); assert.equal(settings.allowPrivateNetwork, false); assert.equal(settings.appDataDir, path.join(REPO_ROOT, 'data', 'app-data'));
    process.env.RUNNER_ALLOW_PRIVATE_NETWORK = '1'; process.env.RUNNER_APP_DATA_DIR = 'off'; process.env.RUNNER_ALLOWED_HOSTS = 'api.example.test, *.cdn.example.test';
    const custom = runnerSettingsFromEnv();
    assert.equal(custom.allowPrivateNetwork, true); assert.equal(custom.appDataDir, ''); assert.deepEqual(custom.allowedHosts, ['api.example.test', '*.cdn.example.test']);
    assert.deepEqual(allowedHostsFromEnv('none'), []); assert.equal(appDataDirFromEnv('/srv/app-data'), '/srv/app-data');
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});

test('private-network guard: loopback, RFC 1918, link-local (cloud metadata), unique local and unspecified addresses are refused', async () => {
  const refused = { '127.0.0.1': 'loopback', '127.8.9.10': 'loopback', '10.0.0.5': 'private', '172.16.0.1': 'private', '172.31.255.255': 'private', '192.168.1.20': 'private', '169.254.169.254': 'link-local',
    '0.0.0.0': 'unspecified', '::1': 'loopback', '[::1]': 'loopback', '::': 'unspecified', 'fd12:3456::1': 'private', 'fc00::1': 'private', 'fe80::1%en0': 'link-local', '::ffff:10.1.2.3': 'private', '::ffff:7f00:1': 'loopback' };
  for (const [address, kind] of Object.entries(refused)) assert.equal(privateAddressKind(address), kind, address);
  for (const address of ['8.8.8.8', '172.32.0.1', '192.169.0.1', '100.64.0.1', '2001:db8::1', '2606:4700::1111', 'not-an-ip']) assert.equal(privateAddressKind(address), null, address);
  // a host name is resolved first (every address): one private answer is enough to refuse
  const lookup = async host => ({ 'loopback.example.test': [{ address: '127.0.0.1', family: 4 }], 'mixed.example.test': [{ address: '93.184.216.34', family: 4 }, { address: '10.9.8.7', family: 4 }], 'public.example.test': [{ address: '93.184.216.34', family: 4 }] })[host] ?? Promise.reject(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }));
  await assert.rejects(assertPublicHost('loopback.example.test', { lookup }), error => error.code === PRIVATE_NETWORK_CODE && /RUNNER_ALLOW_PRIVATE_NETWORK/.test(error.message) && /127\.0\.0\.1/.test(error.message));
  await assert.rejects(assertPublicHost('mixed.example.test', { lookup }), { code: PRIVATE_NETWORK_CODE });
  await assert.rejects(assertPublicHost('missing.example.test', { lookup }), { code: 'ENOTFOUND' });
  assert.deepEqual(await assertPublicHost('public.example.test', { lookup }), ['93.184.216.34']);
  await assert.rejects(assertPublicHost('169.254.169.254', { lookup }), { code: PRIVATE_NETWORK_CODE });
});

test('guarded fetch refuses before connecting, follows redirects hop by hop, and RUNNER_ALLOW_PRIVATE_NETWORK lets everything through', async () => {
  const calls = [];
  const fake = async (input, init) => { calls.push({ url: String(input), redirect: init?.redirect, method: init?.method ?? 'GET' });
    if (String(input) === 'https://public.example.test/go') return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    if (String(input) === 'https://public.example.test/next') return new Response(null, { status: 303, headers: { location: '/done' } });
    return new Response('ok', { status: 200 }); };
  const lookup = async host => host === 'public.example.test' ? [{ address: '93.184.216.34', family: 4 }] : host === 'localhost' ? [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }] : [];
  const guarded = createGuardedFetch(fake, { lookup });
  for (const url of ['http://127.0.0.1:8080/', 'http://10.0.0.1/', 'http://192.168.0.10/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]:9000/', 'http://localhost:3000/']) {
    await assert.rejects(guarded(url, { redirect: 'manual' }), { code: PRIVATE_NETWORK_CODE }, url);
  }
  assert.equal(calls.length, 0, 'nothing was sent to a refused target');
  assert.equal((await guarded('https://public.example.test/x', { redirect: 'manual' })).status, 200);
  await assert.rejects(guarded('https://public.example.test/go'), { code: PRIVATE_NETWORK_CODE }, 'a followed redirect to the metadata address is refused');
  const followed = await guarded('https://public.example.test/next', { method: 'POST', body: 'x' });
  assert.equal(followed.status, 200); assert.equal(followed.url, 'https://public.example.test/done'); assert.equal(calls.at(-1).method, 'GET');
  assert.ok(calls.every(call => call.redirect === 'manual'));
  const open = createGuardedFetch(fake, { allowPrivate: true, lookup });
  assert.equal(open, fake); assert.equal((await open('http://127.0.0.1:8080/')).status, 200);
});

test('raster settings: rasterScale steps and rasterNavigation validated; applied live through the raster-settings side message', async () => {
  assert.deepEqual(RASTER_SCALE_STEPS, [1, 0.75, 0.5, 0.35, 0.25]);
  if (runtime.ok) assert.deepEqual((await import(path.join(runtime.dir, 'runtime/motion-raster.js'))).MOTION_SCALE_STEPS, RASTER_SCALE_STEPS, 'same steps as the bundle');
  const v = input => validateConfig(input, { modules: {}, policy: { allowedHosts: ['*'] } }, { partial: true });
  assert.deepEqual(v({ raster: 'progressive', rasterScale: 0.25, rasterNavigation: false }), { raster: 'progressive', rasterScale: 0.25, rasterNavigation: false });
  for (const bad of [{ rasterScale: 0.3 }, { rasterScale: '0.5' }, { rasterScale: 0 }, { rasterNavigation: 'yes' }, { raster: 'half' }]) assert.throws(() => v(bad), { status: 400 }, JSON.stringify(bad));
  assert.equal(deviceForVM({}, { sanitizeSettings: () => ({ raster: { motionScale: 0.5 }, location: {}, layoutBounds: false, memoryMiB: 0, eventSeconds: 0 }) }).raster, undefined, 'raster settings never travel as a device change');
  const sent = [];
  const session = new Session({ bundle: { memoryBudget: labBudget, info: { revision: 'test', dir: '.' } }, painter: null, limits: { vmHeapMb: 2048, vmHeapMaxMb: 6144 }, policy: {}, deviceMemory: 8 });
  session.client = { worker: {}, setRasterSettings: async settings => { sent.push(settings); return { scale: settings.scale, enabled: true, navigation: settings.navigation }; } }; session.state = 'running';
  session.config = withDefaults({ raster: 'progressive' }, { allowedHosts: ['*'] });
  const result = await session.updateConfig({ rasterScale: 0.25 });
  assert.deepEqual(sent, [{ scale: 0.25, navigation: true }]); assert.deepEqual(result.applied, [{ key: 'raster', raster: { scale: 0.25, enabled: true, navigation: true } }]); assert.deepEqual(result.restartRequired, []);
  await session.updateConfig({ rasterNavigation: false }); assert.deepEqual(sent[1], { scale: 0.25, navigation: false }, 'the other setting is kept');
  assert.deepEqual((await session.updateConfig({ raster: 'full' })).restartRequired, ['raster']);
  assert.deepEqual(session.memoryFor(), { budgetMiB: 1024, maxHeapObjects: 671088, source: 'navigator.deviceMemory=8', deviceMemory: 8 });
});

test('the bundle\'s own memoryBudget matches the rule the tests assume', { skip: runtimeSkip }, async () => {
  const { memoryBudget } = await import(path.join(runtime.dir, 'runtime/memory-budget.js'));
  for (const deviceMemory of [0.25, 0.5, 1, 2, 4, 8, null]) assert.deepEqual(memoryBudget({ deviceMemory }).maxHeapObjects, labBudget({ deviceMemory }).maxHeapObjects, String(deviceMemory));
});
