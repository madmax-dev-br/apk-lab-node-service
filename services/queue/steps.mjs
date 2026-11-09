// Declarative job steps: validation (before a job is accepted) and execution against a runner session.
import { HttpError, badRequest } from '../../lib/http.mjs';

export const MAX_STEPS = 200;
export const RELOAD_MODES = ['recreate', 'reopen'];
const READY_TIMEOUT_MS = 15000;
const SELECTOR_KEYS = ['key', 'testTag', 'text', 'textContains', 'contentDescription', 'androidId', 'viewId', 'kind', 'clickable', 'index'];
const STEP_FIELDS = {
  launch: ['activity'],
  intent: ['intent'],
  wait: ['selector', 'timeoutMs', 'gone', 'ready'],
  waitReady: [],
  reload: ['mode'],
  tap: ['selector', 'x', 'y', 'longPress'],
  type: ['selector', 'text', 'append'],
  scroll: ['selector', 'x', 'y', 'dx', 'dy'],
  back: [],
  sleep: ['ms'],
  screenshot: ['name', 'scale', 'selector', 'key', 'systemBars', 'waitReady'],
  layoutBounds: ['names', 'name'],
  snapshot: [],
  elements: ['selector'],
  viewModels: [],
  viewModelField: ['viewModel', 'path', 'options'],
  inspect: ['handle', 'options'],
  field: ['handle', 'path', 'options'],
  composeTree: ['maxNodes'],
  classes: ['match', 'limit', 'initialized'],
  statics: ['className', 'options'],
  staticField: ['className', 'path', 'options'],
  instances: ['className', 'subclasses', 'limit', 'after', 'maxPages'],
  referrers: ['handle', 'limit', 'after', 'maxPages'],
  config: ['config'],
  logcat: ['level', 'tag', 'contains', 'limit'],
  network: ['limit'],
  plugins: ['plugins', 'seconds'],
  diagnostic: [],
  screenState: [],
};
export const STEP_TYPES = Object.keys(STEP_FIELDS);
const COMMON = ['type', 'name', 'continueOnError', 'timeoutMs'];

function checkSelector(selector, where) {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) throw badRequest(`${where}.selector must be an object`);
  const unknown = Object.keys(selector).filter(key => !SELECTOR_KEYS.includes(key)); if (unknown.length) throw badRequest(`${where}.selector: unknown keys ${unknown.join(', ')}`);
}
/** Validates the steps of a job submission; returns them unchanged (or throws a 400 naming the step). */
export function validateSteps(steps, { pluginsAllowed = true } = {}) {
  if (steps === undefined) return [];
  if (!Array.isArray(steps)) throw badRequest('steps must be an array');
  if (steps.length > MAX_STEPS) throw badRequest(`at most ${MAX_STEPS} steps`);
  const names = new Set();
  steps.forEach((step, index) => {
    const where = `steps[${index}]`;
    if (!step || typeof step !== 'object' || !STEP_FIELDS[step.type]) throw badRequest(`${where}.type must be one of ${STEP_TYPES.join(', ')}`);
    const unknown = Object.keys(step).filter(key => !COMMON.includes(key) && !STEP_FIELDS[step.type].includes(key)); if (unknown.length) throw badRequest(`${where} (${step.type}): unknown keys ${unknown.join(', ')}`);
    if (step.name !== undefined) { if (typeof step.name !== 'string' || !/^[\w.-]{1,64}$/.test(step.name) || names.has(step.name)) throw badRequest(`${where}.name must be unique, 1-64 of [A-Za-z0-9_.-]`); names.add(step.name); }
    if (step.selector !== undefined) checkSelector(step.selector, where);
    if (step.ready !== undefined && typeof step.ready !== 'boolean') throw badRequest(`${where}.ready must be a boolean`);
    if (step.waitReady !== undefined && typeof step.waitReady !== 'boolean') throw badRequest(`${where}.waitReady must be a boolean`);
    if (step.type === 'wait' && !step.selector && step.ready !== true) throw badRequest(`${where} (wait) needs a selector, ready: true, or both`);
    if (step.type === 'type' && !step.selector) throw badRequest(`${where} (type) needs a selector`);
    if (step.type === 'reload' && step.mode !== undefined && !RELOAD_MODES.includes(step.mode)) throw badRequest(`${where} (reload): mode must be ${RELOAD_MODES.map(m => `"${m}"`).join(' or ')}`);
    if (step.type === 'tap' && !step.selector && !(Number.isFinite(step.x) && Number.isFinite(step.y))) throw badRequest(`${where} (tap) needs a selector or x/y`);
    if (step.type === 'type' && typeof step.text !== 'string') throw badRequest(`${where} (type) needs text`);
    if (step.type === 'sleep' && !(Number.isFinite(step.ms) && step.ms >= 0 && step.ms <= 60000)) throw badRequest(`${where} (sleep) needs ms between 0 and 60000`);
    if (step.timeoutMs !== undefined && !(Number.isFinite(step.timeoutMs) && step.timeoutMs > 0 && step.timeoutMs <= 120000)) throw badRequest(`${where}.timeoutMs must be 1..120000`);
    if (step.type === 'viewModelField' && (typeof step.viewModel !== 'string' || !(typeof step.path === 'string' || Array.isArray(step.path)))) throw badRequest(`${where} (viewModelField) needs viewModel (class name or suffix) and path`);
    if (['inspect', 'field', 'referrers'].includes(step.type) && typeof step.handle !== 'string') throw badRequest(`${where} (${step.type}) needs a handle`);
    if (['statics', 'staticField', 'instances'].includes(step.type) && typeof step.className !== 'string') throw badRequest(`${where} (${step.type}) needs className`);
    if (step.type === 'staticField' && !(typeof step.path === 'string' || (Array.isArray(step.path) && step.path.every(part => typeof part === 'string' || typeof part === 'number')))) throw badRequest(`${where} (staticField) needs path (string or array)`);
    if (step.type === 'classes' && (typeof step.match !== 'string' || !step.match)) throw badRequest(`${where} (classes) needs match`);
    if (step.type === 'plugins') {
      if (!pluginsAllowed) throw new HttpError(403, 'plugins-disabled', `${where}: plugins are disabled on this queue (QUEUE_ALLOW_PLUGINS) or its runners`);
      if (!Array.isArray(step.plugins) || !step.plugins.length) throw badRequest(`${where} (plugins) needs a plugins list`);
      if (!(Number.isFinite(step.seconds) && step.seconds >= 0 && step.seconds <= 300)) throw badRequest(`${where} (plugins) needs seconds between 0 and 300`);
    }
    if (step.type === 'config' && (!step.config || typeof step.config !== 'object')) throw badRequest(`${where} (config) needs a config object`);
    if (step.type === 'intent' && (!step.intent || typeof step.intent !== 'object')) throw badRequest(`${where} (intent) needs an intent object`);
  });
  return steps;
}

const pick = (object, keys) => Object.fromEntries(keys.filter(key => object[key] !== undefined).map(key => [key, object[key]]));
const sleep = (ms, signal) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true }); });

/**
 * Runs one step on `runner` session `sessionId`. Returns { output, artifacts: [{ name, type, bytes: Buffer }] }.
 * Errors propagate (RunnerError for runner failures: their `infrastructure` flag decides a retry).
 */
export async function runStep(step, { runner, sessionId, signal, index }) {
  const call = (method, path, body, timeoutMs) => runner.session(sessionId, method, path, body, { signal, timeoutMs: timeoutMs ?? Math.max(60000, (step.timeoutMs ?? 0) + 15000) });
  const label = step.name ?? `step-${index + 1}`;
  switch (step.type) {
    case 'launch': { const r = await call('POST', '/launch', pick(step, ['activity'])); return { output: { activity: r.snapshot?.activity ?? null, launchMs: r.launchMs } }; }
    case 'intent': { const r = await call('POST', '/intent', step.intent); return { output: { deepLink: r.deepLink, activity: r.snapshot?.activity ?? null } }; }
    case 'wait': { const r = await call('POST', '/wait', { ...(step.selector ? { selector: step.selector } : {}), timeoutMs: step.timeoutMs ?? (step.selector ? 10000 : READY_TIMEOUT_MS), gone: step.gone === true, ready: step.ready === true }); return { output: r }; }
    case 'waitReady': { const r = await call('POST', '/wait', { ready: true, timeoutMs: step.timeoutMs ?? READY_TIMEOUT_MS }); return { output: { waitedMs: r.waitedMs, activity: r.activity, ready: r.ready, screenReady: r.screenReady } }; }
    case 'reload': { const mode = step.mode ?? 'recreate', r = await call('POST', '/reload', { mode }); return { output: { mode, activity: r.snapshot?.activity ?? null, ready: r.snapshot?.screenReady?.ready ?? null } }; }
    case 'tap': { const r = await call('POST', '/tap', pick(step, ['selector', 'x', 'y', 'longPress'])); return { output: { via: r.via, element: r.element ? { key: r.element.key, name: r.element.name } : null, activity: r.snapshot?.activity ?? null } }; }
    case 'type': { const r = await call('POST', '/type', pick(step, ['selector', 'text', 'append'])); return { output: { via: r.via, element: r.element ? { key: r.element.key, name: r.element.name } : null } }; }
    case 'scroll': { const r = await call('POST', '/scroll', pick(step, ['selector', 'x', 'y', 'dx', 'dy'])); return { output: { via: r.via } }; }
    case 'back': { const r = await call('POST', '/back'); return { output: { activity: r.snapshot?.activity ?? null, closed: r.snapshot?.closed ?? null } }; }
    case 'sleep': await sleep(step.ms, signal); return { output: { sleptMs: step.ms } };
    case 'screenshot': {
      // waitReady: the runner waits for "Tela pronta" before painting (and, for a selector, before the element is looked up)
      const readyTimeoutMs = step.timeoutMs ?? READY_TIMEOUT_MS, ready = step.waitReady === true ? `&waitReady=1&readyTimeoutMs=${readyTimeoutMs}` : '';
      if (ready && step.selector && !step.key) await call('POST', '/wait', { ready: true, timeoutMs: readyTimeoutMs });
      let path = `/screenshot.png?scale=${encodeURIComponent(step.scale ?? 1)}&systemBars=${step.systemBars === false ? 0 : 1}${ready}`;
      if (step.key || step.selector) {
        const key = step.key ?? (await call('GET', `/elements?${new URLSearchParams(Object.entries(step.selector).map(([k, v]) => [k, String(v)]))}`)).elements?.[step.selector.index ?? 0]?.key;
        if (!key) throw new HttpError(404, 'element-not-found', `screenshot: no element matches ${JSON.stringify(step.selector)}`);
        path = `/elements/${encodeURIComponent(key)}/screenshot.png?scale=${encodeURIComponent(step.scale ?? 1)}${ready}`;
      }
      const shot = await runner.sessionBytes(sessionId, path, { signal, timeoutMs: Math.max(60000, readyTimeoutMs + 15000) });
      const name = `${label}.png`;
      return { output: { artifact: name, bytes: shot.bytes.length, notes: shot.notes ? JSON.parse(shot.notes) : null, ...(shot.ready ? { ready: JSON.parse(shot.ready) } : {}) }, artifacts: [{ name, type: 'image/png', bytes: shot.bytes }] };
    }
    case 'layoutBounds': { const r = await call('GET', `/layout-bounds?names=${step.names === false ? 0 : 1}`); return { output: { activity: r.activity, count: r.elements.length }, artifacts: [{ name: `${label}.layout-bounds.json`, type: 'application/json', bytes: Buffer.from(JSON.stringify(r, null, 2)) }] }; }
    case 'snapshot': { const r = await call('GET', '/snapshot'); return { output: { activity: r?.activity ?? null }, artifacts: [{ name: `${label}.snapshot.json`, type: 'application/json', bytes: Buffer.from(JSON.stringify(r, null, 2)) }] }; }
    case 'elements': { const r = await call('GET', `/elements?${new URLSearchParams(Object.entries(step.selector ?? {}).map(([k, v]) => [k, String(v)]))}`); return { output: r }; }
    case 'viewModels': return { output: await call('GET', '/view-models') };
    case 'viewModelField': {
      const models = await call('GET', '/view-models'), wanted = step.viewModel;
      const model = models.find(item => item.className === wanted) ?? models.find(item => item.className.endsWith(`.${wanted}`) || item.className.endsWith(`$${wanted}`)) ?? models.find(item => item.className.includes(wanted));
      if (!model) throw new HttpError(404, 'view-model-not-found', `No ViewModel matching ${wanted} on the screen (found: ${models.map(item => item.className).join(', ') || 'none'})`);
      return { output: { viewModel: model.className, handle: model.handle, path: step.path, value: await call('POST', '/field', { handle: model.handle, path: step.path, options: step.options ?? {} }) } };
    }
    case 'inspect': return { output: await call('POST', '/inspect', { handle: step.handle, options: step.options ?? {} }) };
    case 'field': return { output: await call('POST', '/field', { handle: step.handle, path: step.path ?? '', options: step.options ?? {} }) };
    case 'classes': return { output: await call('GET', `/classes?${new URLSearchParams({ match: String(step.match ?? ''), ...(step.limit !== undefined ? { limit: String(step.limit) } : {}), ...(step.initialized ? { initialized: '1' } : {}) })}`) };
    case 'statics': return { output: await call('POST', '/statics', { className: step.className, options: step.options ?? {} }) };
    case 'staticField': return { output: await call('POST', '/static-field', { className: step.className, path: step.path ?? '', options: step.options ?? {} }) };
    case 'instances': return { output: await call('POST', '/instances', pick(step, ['className', 'subclasses', 'limit', 'after', 'maxPages'])) };
    case 'referrers': return { output: await call('POST', '/referrers', pick(step, ['handle', 'limit', 'after', 'maxPages'])) };
    case 'composeTree': { const r = await call('GET', `/compose-tree?maxNodes=${step.maxNodes ?? 2000}`); return { output: { totalNodes: r?.totalNodes ?? 0 }, artifacts: [{ name: `${label}.compose-tree.json`, type: 'application/json', bytes: Buffer.from(JSON.stringify(r, null, 2)) }] }; }
    case 'config': return { output: await call('PATCH', '/config', step.config) };
    case 'logcat': { const query = new URLSearchParams(Object.entries(pick(step, ['level', 'tag', 'contains', 'limit'])).map(([k, v]) => [k, String(v)])); const r = await call('GET', `/logcat?${query}`); return { output: { lines: r.lines.length, total: r.total }, artifacts: [{ name: `${label}.logcat.json`, type: 'application/json', bytes: Buffer.from(JSON.stringify(r, null, 2)) }] }; }
    case 'network': { const r = await call('GET', `/network?limit=${step.limit ?? 2000}`); return { output: { requests: r.requests.length, total: r.total }, artifacts: [{ name: `${label}.network.json`, type: 'application/json', bytes: Buffer.from(JSON.stringify(r, null, 2)) }] }; }
    case 'plugins': {
      await call('PUT', '/plugins', { plugins: step.plugins });
      await sleep(step.seconds * 1000, signal);
      const out = await call('GET', '/plugins?images=inline'), artifacts = [];
      for (const plugin of out) for (const [blockIndex, block] of plugin.blocks.entries()) if (block.kind === 'image' && block.dataBase64) { const name = `${label}.${plugin.id}.${blockIndex}.png`; artifacts.push({ name, type: block.type, bytes: Buffer.from(block.dataBase64, 'base64') }); block.artifact = name; delete block.dataBase64; }
      return { output: out, artifacts };
    }
    case 'diagnostic': { const r = await call('GET', '/diagnostic'); return { output: { lastError: r.lastError, runtimeErrors: r.runtimeErrors?.length ?? 0 }, artifacts: [{ name: `${label}.diagnostic.json`, type: 'application/json', bytes: Buffer.from(JSON.stringify(r, null, 2)) }] }; }
    case 'screenState': return { output: await call('GET', '/screen-state') };
    default: throw badRequest(`unknown step ${step.type}`);
  }
}
