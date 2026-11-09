// "Tela pronta" and "Recriar / Reabrir" without a VM: request validation, the ready flip events and waits of a session fed with snapshots, and the queue steps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadModeFrom, readyFlagFrom, readyQueryFrom, screenReadyOut, SERVICE_PLUGIN_TEMPLATES } from '../../services/runner/readiness.mjs';
import { Session } from '../../services/runner/session.mjs';
import { validateSteps, STEP_TYPES } from '../../services/queue/steps.mjs';

const ACTIVITY = 'dev.example.probe.MainActivity';
const snapshotWith = (ready, extra = {}) => ({ activityName: ACTIVITY, views: [], screenReady: { ready, activity: ACTIVITY, readySince: ready ? Date.now() : null, settledForMs: ready ? 320 : 0, quietMs: 300, waitingFor: ready ? [] : ['quadro pendente (animação, transição ou recomposição)'], fragments: [{ className: 'dev.example.probe.ListFragment', state: ready ? 7 : 5, hidden: false, ready }] }, ...extra });
const fakeSession = () => new Session({ id: 'unit', bundle: { info: { revision: 'unit', dir: '.' }, flattenViews: () => [], buildLayoutBoundsElements: () => [] }, painter: null, limits: {}, policy: {} });

test('reload mode: recreate by default, reopen, anything else refused', () => {
  assert.equal(reloadModeFrom({}), 'recreate');
  assert.equal(reloadModeFrom(undefined), 'recreate');
  assert.equal(reloadModeFrom({ mode: 'reopen' }), 'reopen');
  assert.throws(() => reloadModeFrom({ mode: 'restart' }), error => error.status === 400 && /recreate/.test(error.message));
  assert.throws(() => reloadModeFrom({ mode: 'recreate', keep: true }), /unknown keys keep/);
  assert.throws(() => reloadModeFrom([]), error => error.status === 400);
});

test('ready flag and screenshot query options', () => {
  assert.equal(readyFlagFrom(undefined), false); assert.equal(readyFlagFrom(true), true);
  assert.throws(() => readyFlagFrom('yes'), /must be a boolean/);
  assert.deepEqual(readyQueryFrom(new URLSearchParams('')), { waitReady: false, readyTimeoutMs: 15000 });
  assert.deepEqual(readyQueryFrom(new URLSearchParams('waitReady=1&readyTimeoutMs=2500')), { waitReady: true, readyTimeoutMs: 2500 });
  assert.deepEqual(readyQueryFrom(new URLSearchParams('waitReady=true&readyTimeoutMs=999999')), { waitReady: true, readyTimeoutMs: 120000 });
  assert.throws(() => readyQueryFrom(new URLSearchParams('waitReady=1&readyTimeoutMs=soon')), error => error.status === 400);
  assert.equal(screenReadyOut(null), null);
  assert.deepEqual(screenReadyOut(snapshotWith(true)).fragments, [{ className: 'dev.example.probe.ListFragment', state: 7, hidden: false, ready: true }]);
});

test('a session emits one ready event per flip and wait { ready } resolves on the flip', async () => {
  const session = fakeSession(), events = [];
  session.on('event', (name, data) => { if (name === 'ready') events.push(data.ready); });
  session.setSnapshot(snapshotWith(false));
  assert.deepEqual(events, [], 'not ready at first is not a flip');
  const waiting = session.waitFor(null, { ready: true, timeoutMs: 2000 });
  setTimeout(() => session.setSnapshot(snapshotWith(true)), 50);
  const result = await waiting;
  assert.equal(result.element, null); assert.equal(result.screenReady.ready, true); assert.ok(result.waitedMs >= 40);
  session.setSnapshot(snapshotWith(true)); session.setSnapshot(snapshotWith(false)); session.setSnapshot(snapshotWith(true));
  assert.deepEqual(events, [true, false, true]);
  const readiness = session.readiness();
  assert.equal(readiness.current, false, 'no VM: the flag is not current'); assert.equal(readiness.ready, false); assert.equal(readiness.screenReady.ready, true); assert.equal(readiness.activity, ACTIVITY);
  assert.equal(session.describe().screenReady, true);
});

test('wait { ready } times out with 408 and the reasons it still waits for; a wait needs a selector or ready', async () => {
  const session = fakeSession();
  session.setSnapshot(snapshotWith(false));
  await assert.rejects(session.waitReady({ timeoutMs: 80 }), error => error.status === 408 && error.code === 'ready-timeout' && /quadro pendente/.test(error.message) && error.details.waitingFor.length === 1);
  assert.throws(() => session.waitFor(null, {}), error => error.status === 400);
  assert.throws(() => session.reload('restart'), error => error.status === 400);
});

test('queue steps: reload, waitReady, wait { ready } and screenshot { waitReady } validate', () => {
  assert.ok(STEP_TYPES.includes('reload') && STEP_TYPES.includes('waitReady'));
  const steps = [{ type: 'launch' }, { type: 'reload' }, { type: 'reload', mode: 'reopen' }, { type: 'waitReady', timeoutMs: 20000 }, { type: 'wait', ready: true }, { type: 'wait', ready: true, selector: { text: 'Olá' } }, { type: 'screenshot', waitReady: true }];
  assert.deepEqual(validateSteps(steps), steps);
  assert.throws(() => validateSteps([{ type: 'reload', mode: 'restart' }]), /mode must be "recreate" or "reopen"/);
  assert.throws(() => validateSteps([{ type: 'wait' }]), /needs a selector, ready: true, or both/);
  assert.throws(() => validateSteps([{ type: 'wait', ready: 'yes' }]), /ready must be a boolean/);
  assert.throws(() => validateSteps([{ type: 'waitReady', selector: { text: 'x' } }]), /unknown keys selector/);
  assert.throws(() => validateSteps([{ type: 'screenshot', waitReady: 1 }]), /waitReady must be a boolean/);
  assert.throws(() => validateSteps([{ type: 'waitReady', timeoutMs: 999999 }]), /timeoutMs/);
});

test('the "Print na tela pronta" plugin template listens to ready and takes a screenshot', () => {
  const template = SERVICE_PLUGIN_TEMPLATES.find(item => item.name === 'Print na tela pronta');
  assert.ok(template); assert.match(template.code, /lab\.on\('ready'/); assert.match(template.code, /lab\.screenshot\(/); assert.match(template.code, /lab\.ui\.image\(/);
  assert.doesNotThrow(() => new Function('lab', `return (async () => {\n${template.code}\n})`), 'the template is valid JavaScript');
});
