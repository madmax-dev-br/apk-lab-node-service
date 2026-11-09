// Runner API checks that need the runtime but no APK: auth, CORS, health, config validation and the operator's policies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeSkip, EMPTY_ZIP } from '../helpers/env.mjs';

test('runner API: auth, health, CORS, validation and policies', { skip: runtimeSkip, timeout: 60000 }, async () => {
  const { startRunner } = await import('../helpers/runner.mjs');
  const r = await startRunner({ corsOrigins: ['https://painel.exemplo.com'], maxSessions: 1, allowedHosts: ['127.0.0.1'] });   // an operator cap narrower than the default "*"
  try {
    const health = await r.api('GET', '/health', { token: null });
    assert.equal(health.status, 200); assert.equal(health.body.available, 1); assert.equal(health.body.pluginsAllowed, false); assert.match(health.body.runtimeRevision, /^[0-9a-f]{12}$/);
    assert.ok(health.body.memory.maxHeapObjects >= 65536 && health.body.memory.budgetMiB > 0, JSON.stringify(health.body.memory)); assert.deepEqual(health.body.network, { allowedHosts: ['127.0.0.1'], allowPrivateNetwork: false });
    assert.equal((await r.api('GET', '/sessions', { token: null })).status, 401);
    assert.equal((await r.api('GET', '/sessions', { token: 'nope' })).status, 401);
    assert.deepEqual((await r.api('GET', '/sessions')).body, []);
    const preflight = await r.api('OPTIONS', '/sessions', { token: null, headers: { origin: 'https://painel.exemplo.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type, x-apk-config' } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://painel.exemplo.com');
    assert.equal((await r.api('OPTIONS', '/sessions', { token: null, headers: { origin: 'https://outro.exemplo.com', 'access-control-request-method': 'POST' } })).status, 403);
    assert.equal((await r.api('GET', '/sessions', { headers: { origin: 'https://painel.exemplo.com' } })).headers.get('access-control-allow-origin'), 'https://painel.exemplo.com');

    assert.equal((await r.create(Buffer.from('not an apk'))).status, 400);
    const cases = [
      [{ lauch: true }, 400, /unknown keys lauch/],
      [{ device: { screen: 'tv-8k' } }, 400, /config\.device\.screen/],
      [{ network: { allowedHosts: ['api.exemplo.com'] } }, 403, /RUNNER_ALLOWED_HOSTS/],
      [{ network: { allowedHosts: ['*'] } }, 403, /RUNNER_ALLOWED_HOSTS/],
      [{ network: { hostMap: [{ from: 'api.exemplo.com', to: 'staging.exemplo.com' }] } }, 403, /target/],
      [{ endpointMocks: [{ method: 'FETCH', url: '/x' }] }, 400, /endpointMocks\[0\]/],
      [{ methodOverrides: [{ method: 'not a method', value: '1' }] }, 400, /methodOverrides\[0\]/],
      [{ eventSeconds: 7 }, 400, /eventSeconds/],
      [{ permissions: { states: { 'android.permission.CAMERA': 'maybe' } } }, 400, /permissions/],
      [{ plugins: [{ code: 'lab.ui.text(1)' }] }, 403, /RUNNER_ALLOW_PLUGINS/],
    ];
    for (const [config, status, message] of cases) { const response = await r.create(EMPTY_ZIP, config); assert.equal(response.status, status, JSON.stringify(config)); assert.match(response.body.error.message, message); }
    const accepted = await r.create(EMPTY_ZIP, { network: { allowedHosts: ['127.0.0.1'], hostMap: [{ from: 'api.exemplo.com', to: 'http://127.0.0.1:9999' }] }, endpointMocks: [{ method: 'GET', url: 'https://api.exemplo.com/v1/perfil', status: 200, body: '{}' }] });
    assert.equal(accepted.status, 422, 'a valid config reaches the VM, which refuses an empty archive'); assert.equal(accepted.body.error.code, 'vm-error');
    assert.equal((await r.api('GET', '/sessions')).body.length, 0, 'a failed load frees its slot');
  } finally { await r.close(); }
});
