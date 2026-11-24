// The actions of a server plugin (services/runner/plugin-actions.mjs): they go through the session's queue, answer the site's shapes and error codes, and a refusal is not a VM failure of
// the session. No VM: a fake client answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../../services/runner/session.mjs';
import { createPluginActions, pluginMockId } from '../../services/runner/plugin-actions.mjs';

const PLUGIN = { id: 'p1', name: 'P' };
function setup({ reply = { invocation: { value: 5 }, snapshot: { activityName: 'a.B' } }, state = 'running', bundle = {} } = {}) {
  const calls = [], s = new Session({ bundle: { info: { revision: 'test', dir: '.' }, MAX_MOCKS: 2, validateMock: m => m.url ? { errors: [], mock: m } : { errors: [{ field: 'url', message: 'no url' }], mock: m }, ...bundle }, painter: null, limits: {}, policy: {}, deviceMemory: 8 });
  const client = { worker: {}, invokeMethod: async args => { calls.push(['invoke', args]); return reply; }, reloadActivity: async args => { calls.push(['reload', args]); return { activityName: 'a.C' }; },
    setEndpointMocks: async list => { if (client.failMocks) throw new Error('worker gone'); calls.push(['mocks', list.map(m => m.id)]); return []; } };
  Object.assign(s, { client, state, snapshot: state === 'running' ? { activityName: 'a.B' } : null });
  return { s, client, calls, actions: createPluginActions({ session: s, client, host: () => ({ query: async () => null }) }) };
}

test('invoke: the app method runs as an operation of the session and its snapshot becomes the screen', async () => {
  const { s, calls, actions } = setup();
  assert.deepEqual(await actions.invoke(PLUGIN, { className: 'a.M', method: 'm', args: [1], signature: '(I)I' }), { value: 5 });
  assert.deepEqual(calls[0], ['invoke', { handle: undefined, className: 'a.M', method: 'm', signature: '(I)I', args: [1] }]);
  assert.equal(s.snapshotSeq, 1); assert.equal(s.metrics.operations, 1); assert.equal(s.lastError, null);
});

test('invoke: a refused call and an exception of the app are errors of the plugin, not of the session', async () => {
  const refused = setup({ reply: { invocation: { error: { code: 'no-method', message: 'none' } } } });
  await assert.rejects(refused.actions.invoke(PLUGIN, { method: 'm' }), { code: 'no-method', message: 'none' });
  const thrown = setup({ reply: { invocation: { exception: { type: 'java.lang.IllegalStateException', message: 'x' } } } });
  await assert.rejects(thrown.actions.invoke(PLUGIN, { method: 'm' }), { code: 'exception', message: 'm threw java.lang.IllegalStateException: x' });
  assert.equal(thrown.s.lastError, null); assert.equal(refused.s.lastError, null);
});

test('an action waits for its turn (config.plugins starts before the launch) and needs a running app', async () => {
  const { s, actions, calls } = setup({ state: 'ready' });
  await assert.rejects(actions.invoke(PLUGIN, { method: 'm' }), { code: 'no-apk' }); assert.equal(calls.length, 0); assert.equal(s.lastError, null);
  let launched; const launch = s.op('launch', () => new Promise(resolve => { launched = () => { s.state = 'running'; s.snapshot = {}; resolve(); }; }));
  const invoke = actions.invoke(PLUGIN, { method: 'm' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 0, 'the launch is still running');
  launched(); await launch; assert.deepEqual(await invoke, { value: 5 });
});

test('actions of a session that loaded its APK again fail', async () => {
  const { s, actions } = setup(); s.client = { worker: {} };
  await assert.rejects(actions.invoke(PLUGIN, { method: 'm' }), { code: 'stopped' });
  await assert.rejects(actions.mock(PLUGIN, { url: 'https://a.example/x' }), { code: 'stopped' });
});

test('reload answers the mode and the Activity', async () => {
  const { actions, calls } = setup();
  assert.deepEqual(await actions.reload(PLUGIN, { mode: 'reopen' }), { mode: 'reopen', activity: 'a.C' });
  assert.deepEqual(await actions.reload(PLUGIN, { mode: 'other' }), { mode: 'recreate', activity: 'a.C' }); assert.deepEqual(calls.at(-1), ['reload', { mode: 'recreate' }]);
});

test('mock / unmock / mocks: one list with config.endpointMocks, a stable id per method and URL, the limit, concurrent calls kept', async () => {
  const { s, client, actions, calls } = setup();
  const [a, b] = await Promise.all([actions.mock(PLUGIN, { method: 'GET', url: 'https://a.example/x', status: 200 }), actions.mock(PLUGIN, { method: 'GET', url: 'https://a.example/y', status: 200 })]);
  assert.notEqual(a.id, b.id); assert.deepEqual(s.config.endpointMocks.map(m => m.id), [a.id, b.id]); assert.deepEqual(calls.at(-1), ['mocks', [a.id, b.id]]);
  assert.equal((await actions.mock(PLUGIN, { method: 'GET', url: 'https://a.example/x', status: 503 })).id, a.id); assert.equal(s.config.endpointMocks[0].status, 503);
  await assert.rejects(actions.mock(PLUGIN, { method: 'GET', url: 'https://a.example/z' }), { code: 'bad-args' });
  await assert.rejects(actions.mock(PLUGIN, { method: 'GET', url: '' }), { code: 'bad-args', message: 'no url' });
  assert.deepEqual(actions.mocks().map(m => [m.id, m.hits]), [[a.id, 0], [b.id, 0]]);
  client.failMocks = true; await assert.rejects(actions.unmock(PLUGIN, { id: a.id })); assert.equal(s.config.endpointMocks.length, 2, 'a list the VM did not take is not kept'); client.failMocks = false;
  assert.deepEqual(await actions.unmock(PLUGIN, { id: a.id }), { removed: true }); assert.deepEqual(await actions.unmock(PLUGIN, { id: a.id }), { removed: false });
  assert.ok(pluginMockId({ id: 'x'.repeat(60) }, { id: 'y'.repeat(60) }).length <= 40);
});

test('what needs a page has no action here, so the plugin host refuses it by name', () => {
  const { actions } = setup(); for (const name of ['modal', 'tab', 'frame', 'highlight', 'overlay', 'track']) assert.equal(actions[name], undefined, name);
  assert.equal(actions.scrollTo, undefined, 'without the runtime module');
  assert.equal(typeof setup({ bundle: { createLabScroll: () => ({}) } }).actions.scrollTo, 'function');
});
