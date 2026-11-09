// The runner: an HTTP API that loads APKs into APK Web Lab VM sessions (one worker_threads Worker per session) and exposes every lab feature.
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Router, HttpError, badRequest, notFound, readBody, readJSON, parseMultipart, sendBytes, openSSE, tokenMatches, presentedToken, createHttpServer, parseOrigins, env, envInt, envBool } from '../../lib/http.mjs';
import { loadBundle } from './bundle.mjs';
import { createScreenPainter } from './screen.mjs';
import { rasterBytes, rasterStats } from './rasters.mjs';
import { validateConfig, withDefaults, sessionDefaults } from './config.mjs';
import { hostDeviceMemory, memoryReport, workerHeapMb } from './memory.mjs';
import { REPO_ROOT } from '../../lib/runtime-dir.mjs';
import { Session, publicSnapshot, inventorySummary } from './session.mjs';
import { reloadModeFrom, readyFlagFrom, readyQueryFrom, screenReadyOut, SERVICE_PLUGIN_TEMPLATES } from './readiness.mjs';

export const VERSION = '0.1.0';
const MiB = 1024 * 1024;
/** RUNNER_APP_DATA_DIR: unset = data/app-data next to the service (created on demand, gitignored), "off" = no persistence, else that directory. */
export const appDataDirFromEnv = value => value === undefined || value === null || value === '' ? path.join(REPO_ROOT, 'data', 'app-data') : /^(off|none|0|false)$/i.test(value) ? '' : value;
/** RUNNER_ALLOWED_HOSTS: the operator's cap on the hosts a session may allow. Default "*" (every public host; private ones need RUNNER_ALLOW_PRIVATE_NETWORK); "none" = mocks only. */
export const allowedHostsFromEnv = value => /^\s*none\s*$/i.test(String(value ?? '')) ? [] : String(value ?? '*').split(/[\s,]+/).map(item => item.trim().toLowerCase()).filter(Boolean);

/** Runner settings from the environment (README, "Variáveis de ambiente"). */
export function runnerSettingsFromEnv() {
  return {
    host: env('RUNNER_HOST', '127.0.0.1'), port: envInt('RUNNER_PORT', 8081, 0, 65535),
    token: env('RUNNER_TOKEN', ''), authDisabled: env('RUNNER_AUTH', '') === 'off',
    corsOrigins: parseOrigins(env('RUNNER_CORS_ORIGINS', '')),
    maxSessions: envInt('RUNNER_MAX_SESSIONS', 2, 1, 256), maxApkBytes: envInt('RUNNER_MAX_APK_MB', 200, 1, 1024) * MiB,
    idleTimeoutMs: envInt('RUNNER_IDLE_TIMEOUT_S', 600, 10) * 1000, maxSessionMs: envInt('RUNNER_SESSION_MAX_S', 3600, 30) * 1000,
    vmHeapMb: envInt('RUNNER_VM_HEAP_MB', 2048, 256, 65536), vmHeapMaxMb: envInt('RUNNER_VM_HEAP_MAX_MB', 6144, 256, 65536), maxMemoryMiB: envInt('RUNNER_MAX_MEMORY_MIB', 2048, 0, 4096),
    minFreeMb: envInt('RUNNER_MIN_FREE_MB', 0, 0), loadTimeoutMs: envInt('RUNNER_LOAD_TIMEOUT_S', 120, 5) * 1000, operationTimeoutMs: envInt('RUNNER_OPERATION_TIMEOUT_S', 45, 5) * 1000,
    allowedHosts: allowedHostsFromEnv(env('RUNNER_ALLOWED_HOSTS', '*')), allowPrivateNetwork: envBool('RUNNER_ALLOW_PRIVATE_NETWORK', false),
    pluginsAllowed: envBool('RUNNER_ALLOW_PLUGINS', false), maxPlugins: envInt('RUNNER_PLUGIN_MAX', 4, 0, 32), pluginHeapMb: envInt('RUNNER_PLUGIN_HEAP_MB', 64, 16, 1024),
    pluginBusySeconds: envInt('RUNNER_PLUGIN_BUSY_S', 5, 1, 600), pluginMaxRunSeconds: envInt('RUNNER_PLUGIN_MAX_RUN_S', 0, 0), maxPluginCodeBytes: envInt('RUNNER_PLUGIN_MAX_CODE_KB', 256, 1, 4096) * 1024,
    appDataDir: appDataDirFromEnv(env('RUNNER_APP_DATA_DIR', '')), runtimeDir: env('APK_LAB_RUNTIME_DIR', undefined), logLevel: env('RUNNER_LOG', 'info'),
  };
}

/** Headers of a screenshot: notes of the painter, image size and, after ?waitReady=1, how long it waited for "Tela pronta". */
const shotHeaders = shot => ({ 'x-screenshot-notes': JSON.stringify(shot.notes), 'x-image-size': `${shot.width}x${shot.height}`, ...(shot.ready ? { 'x-screen-ready': JSON.stringify({ ready: !!shot.ready.screenReady?.ready, waitedMs: shot.ready.waitedMs, activity: shot.ready.screenReady?.activity ?? null }) } : {}) });
const bool = (value, fallback) => value === null || value === undefined ? fallback : /^(1|true|yes|on)$/i.test(value);
const isPath = path => path === undefined || typeof path === 'string' || (Array.isArray(path) && path.length <= 32 && path.every(part => typeof part === 'string' || typeof part === 'number'));
const num = (value, fallback, min, max) => { if (value === null || value === undefined || value === '') return fallback; const n = Number(value); if (!Number.isFinite(n)) throw badRequest(`not a number: ${value}`); return Math.min(max, Math.max(min, n)); };
const selectorFrom = body => {
  const source = body?.selector ?? (body?.key !== undefined ? { key: body.key } : null);
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const allowed = ['key', 'testTag', 'text', 'textContains', 'contentDescription', 'androidId', 'viewId', 'kind', 'clickable', 'index'];
  const unknown = Object.keys(source).filter(key => !allowed.includes(key)); if (unknown.length) throw badRequest(`selector: unknown keys ${unknown.join(', ')}`);
  for (const [key, value] of Object.entries(source)) if (typeof value === 'string' && value.length > 2000) throw badRequest(`selector.${key} too long`);
  return source;
};
const selectorFromQuery = url => { const out = {}; for (const key of ['key', 'testTag', 'text', 'textContains', 'contentDescription', 'androidId', 'viewId', 'kind']) { const value = url.searchParams.get(key); if (value !== null) out[key] = value; } return Object.keys(out).length ? out : null; };
const intentFrom = body => {
  const allowed = ['action', 'data', 'category', 'extras', 'type', 'component'];
  if (!body || typeof body !== 'object') throw badRequest('intent body must be an object');
  const unknown = Object.keys(body).filter(key => !allowed.includes(key)); if (unknown.length) throw badRequest(`intent: unknown keys ${unknown.join(', ')}`);
  if (JSON.stringify(body).length > 64 * 1024) throw badRequest('intent larger than 64 KiB');
  return body;
};

export async function createRunner(settings = runnerSettingsFromEnv(), { log = defaultLog(settings.logLevel) } = {}) {
  if (!settings.authDisabled && !settings.token) throw new Error('RUNNER_TOKEN is required (or RUNNER_AUTH=off for local, single-user use)');
  if (settings.authDisabled && !['127.0.0.1', '::1', 'localhost'].includes(settings.host)) log('warn', 'RUNNER_AUTH=off while listening on a non-loopback address: anyone who reaches this port can run code on this machine');
  const bundle = await loadBundle(settings.runtimeDir);
  const painter = createScreenPainter({ runtimeDir: bundle.info.dir, rasterBytes });
  const sessions = new Map();
  const policy = { allowedHosts: settings.allowedHosts, allowPrivateNetwork: settings.allowPrivateNetwork === true, pluginsAllowed: settings.pluginsAllowed, maxPlugins: settings.maxPlugins, maxPluginCodeBytes: settings.maxPluginCodeBytes, maxMemoryMiB: settings.maxMemoryMiB };
  const limits = { vmHeapMb: settings.vmHeapMb, vmHeapMaxMb: settings.vmHeapMaxMb, loadTimeoutMs: settings.loadTimeoutMs, operationTimeoutMs: settings.operationTimeoutMs,
    plugins: { heapMb: settings.pluginHeapMb, busySeconds: settings.pluginBusySeconds, maxRunSeconds: settings.pluginMaxRunSeconds } };
  let reserved = 0;
  const capacity = () => {
    const active = sessions.size + reserved, freeMb = Math.round(os.freemem() / MiB), memoryOk = !settings.minFreeMb || freeMb >= settings.minFreeMb;
    return { maxSessions: settings.maxSessions, activeSessions: sessions.size, reserved, available: memoryOk ? Math.max(0, settings.maxSessions - active) : 0, freeMemoryMb: freeMb, memoryOk };
  };
  const getSession = id => { const session = sessions.get(id); if (!session) throw notFound(`No session ${id}`); session.touch(); return session; };
  const closeSession = (session, reason) => { session.close(reason); sessions.delete(session.id); log('info', `session ${session.id} closed (${reason})`); };
  const appDataDirFor = principal => settings.appDataDir ? path.join(path.resolve(settings.appDataDir), createHash('sha256').update(String(principal?.namespace ?? 'default')).digest('hex').slice(0, 16)) : null;

  // ---- sweeper: idle and over-age sessions -----------------------------------------------------------------------------------------------------------------------------
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (session.streams > 0) session.touch();
      if (now - session.lastUsedAt > settings.idleTimeoutMs && !session.busyWith) closeSession(session, 'idle-timeout');
      else if (now - session.createdAt > settings.maxSessionMs) closeSession(session, 'max-age');
    }
  }, 5000);
  sweeper.unref();

  const router = new Router();
  const authenticate = async (req, url) => {
    if (settings.authDisabled) return { id: 'local', namespace: req.headers['x-client-id'] ? String(req.headers['x-client-id']).slice(0, 128) : 'default' };
    if (!tokenMatches(presentedToken(req, url), settings.token)) throw new HttpError(401, 'unauthorized', 'Missing or invalid bearer token');
    return { id: 'operator', namespace: req.headers['x-client-id'] ? String(req.headers['x-client-id']).slice(0, 128) : 'default' };
  };
  const json = async req => readJSON(req, 8 * MiB);
  const withStream = (session, req, res, setup) => {
    session.streams = (session.streams ?? 0) + 1;
    const sse = openSSE(req, res, { onClose: () => { session.streams--; cleanup?.(); } });
    const onClosed = () => sse.close(); session.once('closed', onClosed);
    const cleanup0 = setup(sse); const cleanup = () => { session.off('closed', onClosed); cleanup0?.(); };
  };

  // memory: the budget of a default session (memory "automatic": navigator.deviceMemory as Chrome reports it on this machine, see memory.mjs)
  const defaultMemory = () => { const memory = memoryReport(bundle.memoryBudget, { memoryMiB: 0, deviceMemory: hostDeviceMemory() }); return { ...memory, workerHeapMb: workerHeapMb(memory.budgetMiB, limits) }; };
  router.add('GET', '/health', () => ({ ok: true, service: 'apk-lab-runner', version: VERSION, runtimeRevision: bundle.info.revision, pluginsAllowed: settings.pluginsAllowed, ...capacity(),
    memory: defaultMemory(), network: { allowedHosts: settings.allowedHosts, allowPrivateNetwork: policy.allowPrivateNetwork }, appData: !!settings.appDataDir }), { public: true });
  router.add('GET', '/defaults', () => ({ config: sessionDefaults(policy), device: bundle.defaultDeviceSettings ? Object.fromEntries(Object.entries(bundle.defaultDeviceSettings()).filter(([key]) => !['network', 'memoryMiB', 'eventSeconds', 'location', 'raster', 'layoutBounds'].includes(key))) : null, memory: defaultMemory(), webview: false }));
  router.add('GET', '/', () => ({ service: 'apk-lab-runner', version: VERSION, docs: 'https://github.com/madmax-dev-br/apk-lab-node-service#readme' }), { public: true });
  router.add('GET', '/plugin-templates', () => [...bundle.PLUGIN_TEMPLATES, ...SERVICE_PLUGIN_TEMPLATES].map(t => ({ id: t.id, name: t.name, description: t.description, code: t.code })));
  router.add('GET', '/stats', () => ({ ...capacity(), rasters: rasterStats(), sessions: [...sessions.values()].map(s => s.describe()), memory: process.memoryUsage() }));

  // ---- sessions ----------------------------------------------------------------------------------------------------------------------------------------------------------
  router.add('POST', '/sessions', async ({ req, url, principal }) => {
    const cap = capacity();
    if (cap.available <= 0) throw Object.assign(new HttpError(503, 'at-capacity', `The runner is at capacity (${cap.activeSessions}/${cap.maxSessions} sessions${cap.memoryOk ? '' : ', low free memory'})`), { retryAfter: 5 });
    reserved++;
    let session;
    try {
      const type = String(req.headers['content-type'] ?? '');
      const body = await readBody(req, settings.maxApkBytes + 2 * MiB);
      let apk, rawConfig;
      if (/^multipart\/form-data/i.test(type)) {
        const parts = parseMultipart(body, type); apk = parts.get('apk')?.data;
        const configPart = parts.get('config'); if (configPart) { try { rawConfig = JSON.parse(configPart.data.toString('utf8')); } catch { throw badRequest('config part is not JSON'); } }
      } else if (/^application\/json/i.test(type)) {
        let parsed; try { parsed = JSON.parse(body.toString('utf8')); } catch { throw badRequest('Body is not valid JSON'); }
        if (typeof parsed.apkBase64 !== 'string') throw badRequest('JSON body needs apkBase64 (or send the APK as application/octet-stream / multipart)');
        apk = Buffer.from(parsed.apkBase64, 'base64'); rawConfig = parsed.config;
      } else {
        apk = body; const header = req.headers['x-apk-config'] ?? url.searchParams.get('config');
        if (header) { try { rawConfig = JSON.parse(/^[A-Za-z0-9_-]+={0,2}$/.test(header) && !header.startsWith('{') ? Buffer.from(header, 'base64url').toString('utf8') : header); } catch { throw badRequest('X-APK-Config must be JSON (or base64url JSON)'); } }
      }
      if (!apk?.length) throw badRequest('No APK in the request body');
      if (apk.length > settings.maxApkBytes) throw new HttpError(413, 'too-large', `APK larger than ${settings.maxApkBytes / MiB} MiB`);
      if (!(apk[0] === 0x50 && apk[1] === 0x4b)) throw badRequest('The body is not an APK (ZIP) file');
      const config = withDefaults(validateConfig(rawConfig ?? {}, { modules: bundle, policy }), policy);
      session = new Session({ owner: principal?.id, bundle, painter, limits, policy, appDataDir: appDataDirFor(principal), log });
      sessions.set(session.id, session); reserved--; reserved = Math.max(0, reserved);
      log('info', `session ${session.id} created (${apk.length} bytes)`);
      try { await session.load(apk, config); }
      catch (error) { const detail = error instanceof HttpError ? error : new HttpError(422, 'load-failed', String(error?.message ?? error)); closeSession(session, 'load-failed'); throw detail; }
      return { session: session.describe(), inventory: inventorySummary(session.inventory), config: session.config, snapshot: session.snapshot ? summary(session) : null };
    } finally { if (!session) reserved = Math.max(0, reserved - 1); }
  }, { status: 201 });
  router.add('GET', '/sessions', () => [...sessions.values()].map(s => s.describe()));
  router.add('GET', '/sessions/:id', ({ params }) => getSession(params.id).describe());
  router.add('DELETE', '/sessions/:id', ({ params }) => { const session = getSession(params.id); closeSession(session, 'deleted'); return { closed: true }; });
  router.add('GET', '/sessions/:id/inventory', ({ params }) => inventorySummary(getSession(params.id).inventory));
  router.add('GET', '/sessions/:id/config', ({ params }) => getSession(params.id).config);
  router.add('PATCH', '/sessions/:id/config', async ({ params, req }) => { const session = getSession(params.id); const partial = validateConfig(await json(req), { modules: bundle, policy }, { partial: true }); return session.updateConfig(partial); });
  router.add('POST', '/sessions/:id/restart', async ({ params, req }) => { const session = getSession(params.id); const body = await json(req); const partial = body?.config ? validateConfig(body.config, { modules: bundle, policy }, { partial: true }) : null; return { session: await session.restart(partial) }; });

  // ---- navigation and input ------------------------------------------------------------------------------------------------------------------------------------------
  const opResult = (session, extra = {}) => ({ ...extra, snapshot: summary(session) });
  router.add('POST', '/sessions/:id/launch', async ({ params, req }) => { const session = getSession(params.id), body = await json(req); if (body.activity !== undefined && (typeof body.activity !== 'string' || body.activity.length > 500)) throw badRequest('activity must be a class name'); await session.launch(body.activity); return opResult(session, { launchMs: session.metrics.launchMs }); });
  router.add('POST', '/sessions/:id/intent', async ({ params, req }) => { const session = getSession(params.id), { deepLink } = await session.intent(intentFrom(await json(req))); return opResult(session, { deepLink }); });
  router.add('POST', '/sessions/:id/back', async ({ params }) => { const session = getSession(params.id); await session.back(); return opResult(session); });
  // "Recriar" (mode recreate, the default: Activity.recreate(), saved state and retained ViewModels kept) or "Reabrir" (mode reopen: a fresh instance with the same Intent)
  router.add('POST', '/sessions/:id/reload', async ({ params, req }) => { const session = getSession(params.id), mode = reloadModeFrom(await json(req)); await session.reload(mode); return opResult(session, { mode }); });
  router.add('POST', '/sessions/:id/tap', async ({ params, req }) => {
    const session = getSession(params.id), body = await json(req), selector = selectorFrom(body), longPress = body.longPress === true;
    if (selector) { const { snapshot, element, ...rest } = await session.tapElement(selector, { longPress }); void snapshot; return opResult(session, { ...rest, element }); }
    if (!Number.isFinite(body.x) || !Number.isFinite(body.y)) throw badRequest('tap needs { x, y } (screen dp) or { selector } / { key }');
    const { snapshot, ...rest } = await session.tapAt(body.x, body.y, { longPressMs: longPress ? 700 : 0 }); void snapshot; return opResult(session, rest);
  });
  router.add('POST', '/sessions/:id/type', async ({ params, req }) => { const session = getSession(params.id), body = await json(req), selector = selectorFrom(body); if (!selector) throw badRequest('type needs a selector'); const { snapshot, ...rest } = await session.typeText(selector, body.text, { append: body.append === true }); void snapshot; return opResult(session, rest); });
  router.add('POST', '/sessions/:id/scroll', async ({ params, req }) => { const session = getSession(params.id), body = await json(req); const { snapshot, ...rest } = await session.scroll({ selector: selectorFrom(body), x: body.x, y: body.y, dx: Number(body.dx ?? 0), dy: Number(body.dy ?? 0) }); void snapshot; return opResult(session, rest); });
  router.add('POST', '/sessions/:id/input', async ({ params, req }) => {
    const session = getSession(params.id), body = await json(req), types = ['click', 'input', 'check', 'focus', 'press', 'scroll', 'scrollby', 'compose-action', 'pointer'];
    if (!types.includes(body.type)) throw badRequest(`type: one of ${types.join(', ')}`);
    const { type, ...payload } = body; await session.raw(type, payload); return opResult(session);
  });
  router.add('POST', '/sessions/:id/wait', async ({ params, req }) => {
    const session = getSession(params.id), body = await json(req), selector = selectorFrom(body), ready = readyFlagFrom(body.ready);
    if (!selector && !ready) throw badRequest('wait needs a selector, ready: true, or both');
    const timeoutMs = num(body.timeoutMs, ready && !selector ? 15000 : 10000, 0, 120000), { element, waitedMs, screenReady } = await session.waitFor(selector, { timeoutMs, gone: body.gone === true, ready });
    return { element, waitedMs, activity: session.snapshot?.activityName ?? null, ready: screenReady?.ready ?? null, screenReady };
  });

  // ---- reading the screen --------------------------------------------------------------------------------------------------------------------------------------------
  // "Tela pronta": the latest snapshot.screenReady and whether it is current (no operation in flight, VM running)
  router.add('GET', '/sessions/:id/ready', ({ params }) => getSession(params.id).readiness());
  router.add('GET', '/sessions/:id/snapshot', ({ params, url }) => { const session = getSession(params.id); if (url.searchParams.get('full') === '1') return publicSnapshot(session.snapshot, { trace: num(url.searchParams.get('trace'), 50, 0, 512) }); return summary(session); });
  router.add('GET', '/sessions/:id/layout-bounds', async ({ params, url }) => { const session = getSession(params.id); return { activity: session.snapshot?.activityName ?? null, elements: await session.layoutBounds({ names: bool(url.searchParams.get('names'), true) }) }; });
  router.add('GET', '/sessions/:id/elements', async ({ params, url }) => { const session = getSession(params.id), selector = selectorFromQuery(url); if (!session.snapshot) return { elements: [] }; return { elements: selector ? session.find(selector) : await session.layoutBounds({ names: false }) }; });
  router.add('GET', '/sessions/:id/compose-tree', async ({ params, url }) => getSession(params.id).composeTree({ maxNodes: num(url.searchParams.get('maxNodes'), 2000, 1, 4000) }));
  router.add('GET', '/sessions/:id/screen-state', async ({ params }) => (await getSession(params.id).screenState()) ?? { text: null });
  router.add('GET', '/sessions/:id/diagnostic', async ({ params }) => getSession(params.id).diagnostic());
  router.add('GET', '/sessions/:id/screenshot.png', async ({ params, url, res }) => {
    const shot = await getSession(params.id).screenshot({ scale: num(url.searchParams.get('scale'), 1, 0.1, 4), systemBars: bool(url.searchParams.get('systemBars'), true), ...readyQueryFrom(url.searchParams) });
    sendBytes(res, 200, 'image/png', shot.png, shotHeaders(shot));
  });
  router.add('GET', '/sessions/:id/elements/:key/screenshot.png', async ({ params, url, res }) => {
    const shot = await getSession(params.id).elementScreenshot(params.key, { scale: num(url.searchParams.get('scale'), 1, 0.1, 4), ...readyQueryFrom(url.searchParams) });
    sendBytes(res, 200, 'image/png', shot.png, shotHeaders(shot));
  });

  // ---- VM inspection (the plugin queries) --------------------------------------------------------------------------------------------------------------------------
  router.add('GET', '/sessions/:id/activity', async ({ params }) => (await getSession(params.id).pluginQuery('activity', {})).value);
  router.add('GET', '/sessions/:id/view-models', async ({ params }) => (await getSession(params.id).pluginQuery('viewModels', {})).value);
  router.add('GET', '/sessions/:id/fragments', async ({ params }) => (await getSession(params.id).pluginQuery('fragments', {})).value);
  router.add('POST', '/sessions/:id/inspect', async ({ params, req }) => { const body = await json(req); if (typeof body.handle !== 'string') throw badRequest('inspect needs { handle, options? }'); return (await getSession(params.id).pluginQuery('inspect', { handle: body.handle, options: body.options ?? {} })).value; });
  router.add('POST', '/sessions/:id/field', async ({ params, req }) => { const body = await json(req); if (typeof body.handle !== 'string' || !isPath(body.path)) throw badRequest('field needs { handle, path (string or array of strings), options? }'); return (await getSession(params.id).pluginQuery('field', { handle: body.handle, path: body.path ?? '', options: body.options ?? {} })).value; });
  // state outside the screen: static fields (a Kotlin object, a companion, a singleton, a dependency-injection container), classes by name, instances of a type, who holds an object
  router.add('GET', '/sessions/:id/classes', async ({ params, url }) => { const match = String(url.searchParams.get('match') ?? '').slice(0, 200); if (!match) throw badRequest('classes needs ?match=part of the name or /regex/'); return (await getSession(params.id).pluginQuery('classes', { match, limit: num(url.searchParams.get('limit'), 100, 1, 1000), initialized: bool(url.searchParams.get('initialized'), false) })).value; });
  router.add('POST', '/sessions/:id/statics', async ({ params, req }) => { const body = await json(req); if (typeof body.className !== 'string') throw badRequest('statics needs { className, options? }'); return (await getSession(params.id).pluginQuery('statics', { className: body.className, options: body.options ?? {} })).value; });
  router.add('POST', '/sessions/:id/static-field', async ({ params, req }) => { const body = await json(req); if (typeof body.className !== 'string' || !isPath(body.path)) throw badRequest('static-field needs { className, path (string or array of strings), options? }'); return (await getSession(params.id).pluginQuery('staticField', { className: body.className, path: body.path ?? '', options: body.options ?? {} })).value; });
  router.add('POST', '/sessions/:id/instances', async ({ params, req }) => { const body = await json(req); if (typeof body.className !== 'string') throw badRequest('instances needs { className, subclasses?, limit?, after?, maxPages? }'); return getSession(params.id).pagedQuery('instances', { className: body.className, subclasses: body.subclasses !== false }, body); });
  router.add('POST', '/sessions/:id/referrers', async ({ params, req }) => { const body = await json(req); if (typeof body.handle !== 'string') throw badRequest('referrers needs { handle, limit?, after?, maxPages? }'); return getSession(params.id).pagedQuery('referrers', { handle: body.handle }, body); });
  router.add('GET', '/sessions/:id/methods', async ({ params, url }) => getSession(params.id).searchMethods({ query: String(url.searchParams.get('query') ?? '').slice(0, 200) }));

  // ---- logs ----------------------------------------------------------------------------------------------------------------------------------------------------------
  router.add('GET', '/sessions/:id/logcat', async ({ params, url }) => getSession(params.id).readLogcat({ since: num(url.searchParams.get('since'), -1, -1, Number.MAX_SAFE_INTEGER), limit: num(url.searchParams.get('limit'), 500, 1, 5000), level: url.searchParams.get('level'), tag: url.searchParams.get('tag'), contains: url.searchParams.get('contains') }));
  router.add('GET', '/sessions/:id/logcat/stream', ({ params, req, res }) => {
    const session = getSession(params.id);
    withStream(session, req, res, sse => {
      const onLines = lines => { for (const line of lines) sse.send('log', line, line.seq); };
      session.on('logcat', onLines); session.logListeners++; session.syncLogcat();
      return () => { session.off('logcat', onLines); session.logListeners--; session.syncLogcat(); };
    });
  });
  router.add('GET', '/sessions/:id/network', ({ params, url }) => getSession(params.id).readNetlog({ since: num(url.searchParams.get('since'), -1, -1, Number.MAX_SAFE_INTEGER), limit: num(url.searchParams.get('limit'), 200, 1, 2000) }));
  router.add('GET', '/sessions/:id/network/stream', ({ params, req, res }) => {
    const session = getSession(params.id);
    withStream(session, req, res, sse => { const onRows = rows => { for (const row of rows) sse.send('request', row, row.seq); }; session.on('netlog', onRows); return () => session.off('netlog', onRows); });
  });
  router.add('GET', '/sessions/:id/events', ({ params, req, res }) => {
    const session = getSession(params.id);
    withStream(session, req, res, sse => { sse.send('session', session.describe()); const onEvent = (name, data) => sse.send(name, data); session.on('event', onEvent); return () => session.off('event', onEvent); });
  });

  // ---- permissions, app data -----------------------------------------------------------------------------------------------------------------------------------------
  router.add('GET', '/sessions/:id/permission-requests', ({ params }) => { const session = getSession(params.id); return { config: session.permissionConfig, pending: session.listPermissionRequests() }; });
  router.add('POST', '/sessions/:id/permission-requests/:rid', async ({ params, req }) => getSession(params.id).answerPermission(params.rid, (await json(req)).answer));
  router.add('POST', '/sessions/:id/app-data/clear', async ({ params }) => ({ appData: await getSession(params.id).clearAppData() }));

  // ---- plugins ---------------------------------------------------------------------------------------------------------------------------------------------------------
  const pluginsOf = session => { if (!session.plugins) throw new HttpError(409, 'vm-not-running', 'No VM in this session'); return session.plugins; };
  router.add('GET', '/sessions/:id/plugins', async ({ params, url }) => pluginsOf(getSession(params.id)).list({ inlineImages: url.searchParams.get('images') === 'inline' }));
  router.add('PUT', '/sessions/:id/plugins', async ({ params, req }) => { const session = getSession(params.id), body = await json(req); return { plugins: session.setPlugins(Array.isArray(body) ? body : body.plugins).map(p => ({ id: p.id, name: p.name, enabled: p.enabled })) }; });
  router.add('GET', '/sessions/:id/plugins/stream', ({ params, req, res }) => {
    const session = getSession(params.id);
    withStream(session, req, res, sse => {
      const pending = new Set(); let timer = null;
      const flush = async () => { timer = null; for (const id of pending) { pending.delete(id); const out = await session.plugins?.get(id).catch(() => null); if (out) sse.send('plugin', out); } };
      const onEvent = (name, data) => { if (name !== 'plugin') return; pending.add(data.id); timer ??= setTimeout(flush, 200); };
      session.on('event', onEvent); return () => { session.off('event', onEvent); clearTimeout(timer); };
    });
  });
  router.add('GET', '/sessions/:id/plugins/:pid', async ({ params, url }) => { const out = await pluginsOf(getSession(params.id)).get(params.pid, { inlineImages: url.searchParams.get('images') === 'inline' }); if (!out) throw notFound(`No plugin ${params.pid}`); return out; });
  router.add('POST', '/sessions/:id/plugins/:pid/stop', ({ params }) => { pluginsOf(getSession(params.id)).stop(params.pid); return { stopped: true }; });
  router.add('POST', '/sessions/:id/plugins/:pid/restart', ({ params }) => { if (!settings.pluginsAllowed) throw new HttpError(403, 'plugins-disabled', 'Plugins are disabled on this runner'); pluginsOf(getSession(params.id)).restart(params.pid); return { restarted: true }; });
  router.add('GET', '/sessions/:id/plugins/:pid/blocks/:index/image', async ({ params, res }) => { const image = await pluginsOf(getSession(params.id)).image(params.pid, Number(params.index)); if (!image) throw notFound('No such image block'); sendBytes(res, 200, image.type, image.bytes); });

  const server = createHttpServer({ router, corsOrigins: settings.corsOrigins, authenticate, log });
  return {
    server, settings, bundle, sessions, capacity,
    listen() { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(settings.port, settings.host, () => { server.off('error', reject); resolve(server.address()); }); }); },
    async close() { clearInterval(sweeper); for (const session of [...sessions.values()]) closeSession(session, 'shutdown'); await new Promise(resolve => server.close(() => resolve())); server.closeAllConnections?.(); },
  };
}

/** What most clients want after an operation: the screen in a compact form (no rasters, no trace). */
export function summary(session) {
  const s = session.snapshot; if (!s) return null;
  const offset = session.contentOffset();
  const views = session.bundle.flattenViews(s).filter(v => v.bounds).map(v => ({ id: v.id, parentId: v.parentId, depth: v.depth, type: v.type, kind: v.kind, text: v.text, contentDescription: v.contentDescription, androidId: v.androidId, visible: v.visible, clickable: v.clickable, compose: v.compose, bounds: v.bounds, window: v.window }));
  return { seq: session.snapshotSeq, activity: s.activityName ?? null, closed: !!s.closed, canGoBack: !!s.canGoBack, navigation: s.navigation ?? null, systemBars: s.systemBars ?? null, contentOffset: offset,
    views, composeSemantics: s.composeSemantics ?? null, deepLink: s.deepLink ?? null, droppedEvent: s.droppedEvent ?? null, droppedComposeAction: s.droppedComposeAction ?? null,
    pendingEventDelay: s.pendingEventDelay ?? null, screenReady: screenReadyOut(s), vmHealth: s.vmHealth ? { liveObjects: s.vmHealth.liveObjects, limit: s.vmHealth.limit, collections: s.vmHealth.collections, oomCount: s.vmHealth.oomCount, lastEventMs: s.vmHealth.lastEventMs } : null,
    debugging: { methodOverrides: s.methodOverrides ?? [], endpointMocks: s.endpointMocks ?? [], hostMap: s.hostMap ?? [], ignoredActivities: s.ignoredActivities ?? [] } };
}

export function defaultLog(level = 'info') {
  const order = ['debug', 'info', 'warn', 'error'], min = Math.max(0, order.indexOf(level));
  return (lvl, message) => { if (order.indexOf(lvl) >= min && level !== 'silent') console[lvl === 'debug' ? 'log' : lvl](`[${new Date().toISOString()}] ${lvl} ${message}`); };
}
