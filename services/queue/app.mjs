// The queue: accepts jobs (an APK, a session config and declarative steps) and interactive lease requests from authenticated clients, schedules them on the
// registered runners (priorities, per-client fairness, runner capacity, retries) and keeps results for a retention period.
import { mkdirSync, rmSync } from 'node:fs';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Router, HttpError, badRequest, notFound, readBody, readJSON, parseMultipart, sendBytes, openSSE, tokenMatches, presentedToken, createHttpServer, parseOrigins, env, envInt, envBool } from '../../lib/http.mjs';
import { pickNext, pickRunner, queuePositions, retryDecision, leaseExpired, FINAL_STATES, ACTIVE_STATES, PRIORITY_MIN, PRIORITY_MAX, DEFAULT_PRIORITY } from './scheduler.mjs';
import { MemoryStore, JsonFileStore, persistable } from './store.mjs';
import { parseRunnerList, RunnerClient, RunnerError } from './runners.mjs';
import { validateSteps, runStep } from './steps.mjs';

export const VERSION = '0.1.0';
const MiB = 1024 * 1024;

export function queueSettingsFromEnv() {
  return {
    host: env('QUEUE_HOST', '127.0.0.1'), port: envInt('QUEUE_PORT', 8080, 0, 65535),
    clients: parseClients(env('QUEUE_CLIENTS', '')), authDisabled: env('QUEUE_AUTH', '') === 'off',
    corsOrigins: parseOrigins(env('QUEUE_CORS_ORIGINS', '')),
    runners: parseRunnerList(env('QUEUE_RUNNERS', ''), env('QUEUE_RUNNER_TOKEN', '')),
    maxPerClient: envInt('QUEUE_MAX_PER_CLIENT', 2, 1, 1000), maxQueuedPerClient: envInt('QUEUE_MAX_QUEUED_PER_CLIENT', 50, 1, 100000), maxAttempts: envInt('QUEUE_MAX_ATTEMPTS', 3, 1, 10),
    maxApkBytes: envInt('QUEUE_MAX_APK_MB', 200, 1, 1024) * MiB, apkUrlHosts: String(env('QUEUE_APK_URL_HOSTS', '')).split(/[\s,]+/).map(item => item.trim().toLowerCase()).filter(Boolean),
    jobTimeoutMs: envInt('QUEUE_JOB_TIMEOUT_S', 900, 10) * 1000, leaseMaxMs: envInt('QUEUE_LEASE_MAX_S', 1800, 30) * 1000, leaseIdleMs: envInt('QUEUE_LEASE_IDLE_S', 300, 10) * 1000,
    retentionMs: envInt('QUEUE_RESULT_TTL_S', 86400, 60) * 1000, healthIntervalMs: envInt('QUEUE_HEALTH_INTERVAL_S', 5, 1) * 1000,
    dataDir: path.resolve(env('QUEUE_DATA_DIR', './data/queue')), store: env('QUEUE_STORE', 'memory'), storeFile: env('QUEUE_STORE_FILE', ''),
    pluginsAllowed: envBool('QUEUE_ALLOW_PLUGINS', false), logLevel: env('QUEUE_LOG', 'info'),
  };
}
/** "alice:token1:3, bob:token2" -> Map(token -> { id, maxConcurrent }) (maxConcurrent optional). */
export function parseClients(text) {
  const out = new Map();
  for (const item of String(text ?? '').split(/[\s,]+/).map(value => value.trim()).filter(Boolean)) {
    const [id, token, max] = item.split(':');
    if (!/^[\w.-]{1,64}$/.test(id ?? '') || !token || token.length < 8) throw new Error(`QUEUE_CLIENTS entry must be "<client-id>:<token of 8+ chars>[:<max concurrent>]": ${id ?? item}`);
    out.set(token, { id, maxConcurrent: max ? Math.max(1, Number(max) || 1) : null });
  }
  return out;
}

export async function createQueue(settings = queueSettingsFromEnv(), { log = () => {}, fetchImpl = globalThis.fetch } = {}) {
  if (!settings.authDisabled && !settings.clients.size) throw new Error('QUEUE_CLIENTS is required (or QUEUE_AUTH=off for local, single-user use)');
  const apkDir = path.join(settings.dataDir, 'apks'), artifactDir = path.join(settings.dataDir, 'artifacts');
  mkdirSync(apkDir, { recursive: true }); mkdirSync(artifactDir, { recursive: true });
  const store = settings.store === 'file' ? new JsonFileStore(settings.storeFile || path.join(settings.dataDir, 'queue.json')) : new MemoryStore();
  const runners = settings.runners.map(spec => new RunnerClient(spec));
  const runnerById = id => runners.find(runner => runner.id === id) ?? null;
  const items = new Map(), events = new EventEmitter(); events.setMaxListeners(1000);
  let seq = 0, closed = false, dispatching = false;
  const clientLimits = new Map([...settings.clients.values()].filter(client => client.maxConcurrent).map(client => [client.id, client.maxConcurrent]));

  // restore: finished items stay (until retention); items that were running when the queue stopped go back to the queue (or fail when out of attempts)
  for (const item of await store.load()) {
    item.seq = ++seq;
    if (ACTIVE_STATES.has(item.state)) {
      if (item.runnerId && item.sessionId) runnerById(item.runnerId)?.deleteSession(item.sessionId);
      if (item.kind === 'lease') finish(item, 'expired', { error: { code: 'queue-restarted', message: 'The queue restarted while the lease was active' } }, false);
      else if (item.attempts < (item.maxAttempts ?? settings.maxAttempts)) Object.assign(item, { state: 'queued', runnerId: null, sessionId: null });
      else finish(item, 'failed', { error: { code: 'queue-restarted', message: 'The queue restarted while the job ran (no attempts left)' } }, false);
    }
    items.set(item.id, item);
  }

  const save = item => { item.updatedAt = Date.now(); store.save(item); };
  const emit = (item, type, data = {}) => { const event = { type, at: new Date().toISOString(), state: item.state, ...data }; (item.events ??= []).push(event); if (item.events.length > 500) item.events.splice(0, item.events.length - 500); events.emit(item.id, event); };
  function finish(item, state, extra = {}, persist = true) {
    Object.assign(item, { state, finishedAt: Date.now(), ...extra });
    // the slot is free once the runner closed the session: ask that runner for its capacity right away and dispatch, instead of waiting for the periodic health check
    if (item.runnerId && item.sessionId) { const runner = runnerById(item.runnerId); runner?.deleteSession(item.sessionId).finally(() => runner.health().finally(() => setImmediate(dispatch))); }
    item.sessionId = null;
    if (persist) { emit(item, state, extra.error ? { error: extra.error } : {}); save(item); }
    item.abort = null;
    setImmediate(dispatch);
  }

  // ---- runners: health ---------------------------------------------------------------------------------------------------------------------------------------------
  const healthLoop = async () => { await Promise.all(runners.map(runner => runner.health())); dispatch(); };
  const healthTimer = setInterval(healthLoop, settings.healthIntervalMs); healthTimer.unref();
  await healthLoop();

  // ---- dispatch ------------------------------------------------------------------------------------------------------------------------------------------------------
  function dispatch() {
    if (closed || dispatching) return; dispatching = true;
    try {
      while (true) {
        const list = [...items.values()];
        const item = pickNext(list, { maxPerClient: settings.maxPerClient, clientLimits }); if (!item) break;
        const runner = pickRunner(runners); if (!runner) break;
        runner.assignedSinceHealth++; runner.lastAssignedAt = Date.now();
        Object.assign(item, { state: 'assigned', runnerId: runner.id, assignedAt: Date.now() });
        if (item.kind === 'job') item.attempts++;
        emit(item, 'assigned', { runner: runner.id, attempt: item.attempts }); save(item);
        (item.kind === 'job' ? runJob(item, runner) : startLease(item, runner)).catch(error => log('error', `${item.kind} ${item.id}: ${error?.stack ?? error}`));
      }
    } finally { dispatching = false; }
  }
  const retryTimer = setInterval(() => { dispatch(); sweep(); }, 1000); retryTimer.unref();

  function failOrRetry(item, error) {
    const failure = error instanceof RunnerError ? error : { infrastructure: false };
    const decision = item.state === 'cancelled' ? { retry: false } : retryDecision(item, failure, { maxAttempts: settings.maxAttempts });
    if (item.runnerId && item.sessionId) runnerById(item.runnerId)?.deleteSession(item.sessionId);
    if (decision.retry) {
      if (!decision.countAttempt && item.kind === 'job') item.attempts = Math.max(0, item.attempts - 1);
      if (failure.capacity) { const runner = runnerById(item.runnerId); if (runner) runner.available = 0; }
      Object.assign(item, { state: 'queued', runnerId: null, sessionId: null, notBefore: Date.now() + (decision.delayMs ?? 0), lastError: errorOut(error) });
      emit(item, 'retry', { error: errorOut(error), attempt: item.attempts, inMs: decision.delayMs }); save(item); return;
    }
    if (item.state !== 'cancelled') finish(item, 'failed', { error: errorOut(error) });
  }

  // ---- jobs ---------------------------------------------------------------------------------------------------------------------------------------------------------
  async function runJob(item, runner) {
    const abort = item.abort = new AbortController(), timer = setTimeout(() => abort.abort(new Error('job-timeout')), item.timeoutMs ?? settings.jobTimeoutMs); timer.unref?.();
    try {
      const apk = await readFile(path.join(apkDir, `${item.apk.sha256}.apk`));
      const created = await runner.createSession(apk, item.config, { signal: abort.signal });
      item.sessionId = created.session.id; item.state = 'running'; item.startedAt ??= Date.now();
      item.result = { steps: [], artifacts: [], session: { packageName: created.session.packageName, loadMs: created.session.metrics?.loadMs ?? null, launchMs: created.session.metrics?.launchMs ?? null, runner: runner.id, runtimeRevision: created.session.runtimeRevision } };
      emit(item, 'running', { session: item.result.session }); save(item);
      let failed = null;
      for (const [index, step] of item.steps.entries()) {
        if (abort.signal.aborted) throw abort.signal.reason ?? new Error('cancelled');
        const started = Date.now(), record = { index, type: step.type, name: step.name ?? null };
        emit(item, 'step-started', { index, step: step.type });
        try {
          const { output, artifacts = [] } = await runStep(step, { runner, sessionId: item.sessionId, signal: abort.signal, index });
          for (const artifact of artifacts) item.result.artifacts.push(await storeArtifact(item, artifact));
          Object.assign(record, { ok: true, ms: Date.now() - started, output });
        } catch (error) {
          if (error instanceof RunnerError && error.infrastructure) throw error;   // the runner or the VM failed: retry the whole job elsewhere
          Object.assign(record, { ok: false, ms: Date.now() - started, error: errorOut(error) });
          if (!step.continueOnError) failed = record;
        }
        item.result.steps.push(record); emit(item, 'step-finished', { index, ok: record.ok, ms: record.ms, error: record.error }); save(item);
        if (failed) break;
      }
      for (const [what, path_] of [['logcat', '/logcat?limit=5000'], ['network', '/network?limit=2000']]) {
        if (!item.collect?.[what] || !item.sessionId) continue;
        try { const data = await runner.session(item.sessionId, 'GET', path_, undefined, { signal: abort.signal }); item.result.artifacts.push(await storeArtifact(item, { name: `${what}.json`, type: 'application/json', bytes: Buffer.from(JSON.stringify(data, null, 2)) })); } catch (error) { item.result.collectErrors = [...(item.result.collectErrors ?? []), { what, error: errorOut(error) }]; }
      }
      if (failed) finish(item, 'failed', { error: { code: failed.error?.code ?? 'step-failed', message: `step ${failed.index} (${failed.type}) failed: ${failed.error?.message}`, step: failed.index } });
      else finish(item, 'succeeded');
    } catch (error) {
      if (item.state === 'cancelled') return;
      if (abort.signal.reason?.message === 'job-timeout') { finish(item, 'failed', { error: { code: 'job-timeout', message: `The job exceeded ${Math.round((item.timeoutMs ?? settings.jobTimeoutMs) / 1000)} s` } }); return; }
      failOrRetry(item, error);
    } finally { clearTimeout(timer); }
  }
  async function storeArtifact(item, { name, type, bytes }) {
    const safe = name.replace(/[^\w.-]/g, '_').slice(0, 120), dir = path.join(artifactDir, item.id); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, safe), bytes);
    return { name: safe, type, bytes: bytes.length, url: `/jobs/${item.id}/artifacts/${encodeURIComponent(safe)}` };
  }

  // ---- leases -------------------------------------------------------------------------------------------------------------------------------------------------------
  async function startLease(item, runner) {
    try {
      const apk = await readFile(path.join(apkDir, `${item.apk.sha256}.apk`));
      const created = await runner.createSession(apk, item.config);
      if (item.state === 'cancelled') { runner.deleteSession(created.session.id); return; }
      const now = Date.now();
      Object.assign(item, { sessionId: created.session.id, state: 'active', startedAt: now, lastUsedAt: now, expiresAt: now + Math.min(item.durationMs ?? settings.leaseMaxMs, settings.leaseMaxMs), session: created.session });
      emit(item, 'active', { session: created.session, expiresAt: new Date(item.expiresAt).toISOString() }); save(item);
    } catch (error) { failOrRetry(item, error); }
  }
  function sweep() {
    const now = Date.now();
    for (const item of items.values()) {
      if (item.kind === 'lease') { const reason = leaseExpired(item, now, { idleMs: settings.leaseIdleMs }); if (reason) finish(item, 'expired', { error: { code: `lease-${reason}`, message: `Lease ended (${reason})` } }); }
      if (item.state === 'queued' && item.kind === 'lease' && item.waitUntil && now > item.waitUntil) finish(item, 'expired', { error: { code: 'lease-wait-timeout', message: 'No runner became free in time' } });
      if (FINAL_STATES.has(item.state) && now - (item.finishedAt ?? now) > settings.retentionMs) {
        items.delete(item.id); store.remove(item.id); rm(path.join(artifactDir, item.id), { recursive: true, force: true }).catch(() => {});
        if (![...items.values()].some(other => other.apk?.sha256 === item.apk?.sha256)) rm(path.join(apkDir, `${item.apk?.sha256}.apk`), { force: true }).catch(() => {});
      }
    }
  }

  // ---- submissions ---------------------------------------------------------------------------------------------------------------------------------------------------
  async function apkFrom(req, url, client) {
    const type = String(req.headers['content-type'] ?? ''); let apk = null, spec = null;
    if (/^multipart\/form-data/i.test(type)) {
      const parts = parseMultipart(await readBody(req, settings.maxApkBytes + 4 * MiB), type);
      apk = parts.get('apk')?.data ?? null; const json = parts.get('job') ?? parts.get('lease') ?? parts.get('spec');
      if (json) { try { spec = JSON.parse(json.data.toString('utf8')); } catch { throw badRequest('job part is not JSON'); } }
    } else if (/^application\/json/i.test(type)) {
      spec = await readJSON(req, settings.maxApkBytes * 1.4 + MiB);
      if (typeof spec.apkBase64 === 'string') apk = Buffer.from(spec.apkBase64, 'base64');
    } else if (/^application\/(octet-stream|vnd\.android\.package-archive)/i.test(type)) {
      apk = await readBody(req, settings.maxApkBytes); const header = req.headers['x-job'] ?? url.searchParams.get('job');
      if (header) { try { spec = JSON.parse(header.startsWith('{') ? header : Buffer.from(header, 'base64url').toString('utf8')); } catch { throw badRequest('X-Job must be JSON or base64url JSON'); } }
    } else throw new HttpError(415, 'unsupported-media-type', 'Send multipart/form-data (apk + job), application/json (apkBase64 or apkUrl) or the APK as application/octet-stream with an X-Job header');
    spec ??= {};
    if (!apk && spec.apkUrl) apk = await fetchApk(spec.apkUrl);
    if (!apk?.length) throw badRequest('No APK: send it as a file, apkBase64 or apkUrl');
    if (apk.length > settings.maxApkBytes) throw new HttpError(413, 'too-large', `APK larger than ${settings.maxApkBytes / MiB} MiB`);
    if (!(apk[0] === 0x50 && apk[1] === 0x4b)) throw badRequest('The APK is not a ZIP file');
    const sha256 = createHash('sha256').update(apk).digest('hex'); await writeFile(path.join(apkDir, `${sha256}.apk`), apk);
    return { apk: { sha256, bytes: apk.length }, spec };
  }
  async function fetchApk(text) {
    let target; try { target = new URL(text); } catch { throw badRequest('apkUrl is not a URL'); }
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && settings.apkUrlHosts.includes(target.host.toLowerCase()))) throw badRequest('apkUrl must be https (http only for hosts listed in QUEUE_APK_URL_HOSTS)');
    if (!settings.apkUrlHosts.some(host => host === '*' || host === target.host.toLowerCase() || host === target.hostname.toLowerCase())) throw new HttpError(403, 'apk-url-not-allowed', `apkUrl host ${target.host} is not in QUEUE_APK_URL_HOSTS`);
    const response = await fetchImpl(target, { redirect: 'error', signal: AbortSignal.timeout(120000) }).catch(error => { throw new HttpError(502, 'apk-fetch-failed', `Could not fetch apkUrl: ${error.message}`); });
    if (!response.ok) throw new HttpError(502, 'apk-fetch-failed', `apkUrl answered ${response.status}`);
    if (Number(response.headers.get('content-length')) > settings.maxApkBytes) throw new HttpError(413, 'too-large', 'apkUrl content larger than QUEUE_MAX_APK_MB');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > settings.maxApkBytes) throw new HttpError(413, 'too-large', 'apkUrl content larger than QUEUE_MAX_APK_MB'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  const validConfig = config => { if (config === undefined) return {}; if (!config || typeof config !== 'object' || Array.isArray(config)) throw badRequest('config must be an object (the runner session config)'); if (JSON.stringify(config).length > 8 * MiB) throw badRequest('config larger than 8 MiB'); if (config.plugins?.length && !settings.pluginsAllowed) throw new HttpError(403, 'plugins-disabled', 'Plugins are disabled on this queue (QUEUE_ALLOW_PLUGINS)'); return config; };
  const priorityOf = value => { if (value === undefined) return DEFAULT_PRIORITY; const n = Number(value); if (!Number.isInteger(n) || n < PRIORITY_MIN || n > PRIORITY_MAX) throw badRequest(`priority must be an integer ${PRIORITY_MIN}..${PRIORITY_MAX}`); return n; };
  const checkQueued = client => { const queued = [...items.values()].filter(item => item.clientId === client.id && item.state === 'queued').length; if (queued >= settings.maxQueuedPerClient) throw Object.assign(new HttpError(429, 'queue-full', `At most ${settings.maxQueuedPerClient} queued items per client`), { retryAfter: 10 }); };
  function newItem(kind, client, apk, spec, extra) {
    const now = Date.now();
    const item = { id: randomUUID(), kind, clientId: client.id, state: 'queued', priority: priorityOf(spec.priority), createdAt: now, enqueuedAt: now, seq: ++seq, attempts: 0, maxAttempts: Math.min(settings.maxAttempts, Math.max(1, Number(spec.maxAttempts ?? settings.maxAttempts) || 1)),
      apk, config: validConfig(spec.config), label: typeof spec.label === 'string' ? spec.label.slice(0, 200) : null, events: [], ...extra };
    items.set(item.id, item); emit(item, 'queued'); save(item); setImmediate(dispatch);
    return item;
  }

  // ---- HTTP ------------------------------------------------------------------------------------------------------------------------------------------------------------
  const router = new Router();
  const authenticate = async (req, url) => {
    if (settings.authDisabled) return { id: req.headers['x-client-id'] ? String(req.headers['x-client-id']).replace(/[^\w.-]/g, '').slice(0, 64) || 'local' : 'local' };
    const token = presentedToken(req, url);
    for (const [known, client] of settings.clients) if (tokenMatches(token, known)) return client;
    throw new HttpError(401, 'unauthorized', 'Missing or invalid bearer token');
  };
  const own = (id, client, kind) => { const item = items.get(id); if (!item || item.clientId !== client.id || (kind && item.kind !== kind)) throw notFound(`No ${kind ?? 'item'} ${id}`); return item; };
  const view = item => {
    const positions = item.state === 'queued' ? queuePositions([...items.values()]) : null;
    const { abort, events: itemEvents, apk, seq: s, ...rest } = item; void abort; void s;
    return { ...persistable(rest), apk: { sha256: apk?.sha256, bytes: apk?.bytes }, position: positions?.get(item.id) ?? null, eventsCount: itemEvents?.length ?? 0 };
  };

  router.add('GET', '/health', () => ({ ok: true, service: 'apk-lab-queue', version: VERSION, runners: runners.map(r => ({ id: r.id, healthy: r.healthy, available: r.available })), queued: [...items.values()].filter(i => i.state === 'queued').length }), { public: true });
  router.add('GET', '/runners', () => runners.map(runner => runner.describe()));
  router.add('GET', '/stats', ({ principal }) => {
    const mine = [...items.values()].filter(item => item.clientId === principal.id), count = state => mine.filter(item => item.state === state).length;
    return { client: principal.id, maxConcurrent: clientLimits.get(principal.id) ?? settings.maxPerClient, queued: count('queued'), running: mine.filter(item => ACTIVE_STATES.has(item.state)).length, succeeded: count('succeeded'), failed: count('failed'), runners: runners.map(runner => runner.describe()) };
  });

  router.add('POST', '/jobs', async ({ req, url, principal }) => {
    checkQueued(principal);
    const { apk, spec } = await apkFrom(req, url, principal);
    const allowed = ['config', 'steps', 'priority', 'timeoutMs', 'collect', 'label', 'maxAttempts', 'apkUrl', 'apkBase64'];
    const unknown = Object.keys(spec).filter(key => !allowed.includes(key)); if (unknown.length) throw badRequest(`job: unknown keys ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`);
    const steps = validateSteps(spec.steps ?? [{ type: 'launch' }], { pluginsAllowed: settings.pluginsAllowed });
    const timeoutMs = spec.timeoutMs === undefined ? settings.jobTimeoutMs : Math.min(settings.jobTimeoutMs, Math.max(1000, Number(spec.timeoutMs) || settings.jobTimeoutMs));
    const collect = { logcat: spec.collect?.logcat === true, network: spec.collect?.network === true };
    const item = newItem('job', principal, apk, spec, { steps, timeoutMs, collect, result: null });
    return view(item);
  }, { status: 202 });
  router.add('GET', '/jobs', ({ principal, url }) => { const state = url.searchParams.get('state'); return [...items.values()].filter(item => item.kind === 'job' && item.clientId === principal.id && (!state || item.state === state)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 500).map(view); });
  router.add('GET', '/jobs/:id', ({ params, principal }) => view(own(params.id, principal, 'job')));
  router.add('GET', '/jobs/:id/events', ({ params, principal, req, res, url }) => streamEvents(own(params.id, principal, 'job'), req, res, url));
  router.add('DELETE', '/jobs/:id', ({ params, principal }) => cancel(own(params.id, principal, 'job')));
  router.add('POST', '/jobs/:id/cancel', ({ params, principal }) => cancel(own(params.id, principal, 'job')));
  router.add('GET', '/jobs/:id/artifacts/:name', async ({ params, principal, res }) => {
    const item = own(params.id, principal, 'job'), artifact = item.result?.artifacts?.find(a => a.name === params.name); if (!artifact) throw notFound(`No artifact ${params.name}`);
    sendBytes(res, 200, artifact.type, await readFile(path.join(artifactDir, item.id, artifact.name)), { 'content-disposition': `attachment; filename="${artifact.name}"` });
  });

  router.add('POST', '/leases', async ({ req, url, principal }) => {
    checkQueued(principal);
    const { apk, spec } = await apkFrom(req, url, principal);
    const allowed = ['config', 'priority', 'durationSeconds', 'waitSeconds', 'label', 'apkUrl', 'apkBase64'];
    const unknown = Object.keys(spec).filter(key => !allowed.includes(key)); if (unknown.length) throw badRequest(`lease: unknown keys ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`);
    const durationMs = Math.min(settings.leaseMaxMs, Math.max(30000, (Number(spec.durationSeconds) || settings.leaseMaxMs / 1000) * 1000));
    const waitUntil = spec.waitSeconds ? Date.now() + Math.min(3600, Math.max(1, Number(spec.waitSeconds))) * 1000 : null;
    return view(newItem('lease', principal, apk, spec, { durationMs, waitUntil, maxAttempts: 1 }));
  }, { status: 202 });
  router.add('GET', '/leases', ({ principal }) => [...items.values()].filter(item => item.kind === 'lease' && item.clientId === principal.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 500).map(view));
  router.add('GET', '/leases/:id', ({ params, principal }) => view(own(params.id, principal, 'lease')));
  router.add('GET', '/leases/:id/events', ({ params, principal, req, res, url }) => streamEvents(own(params.id, principal, 'lease'), req, res, url));
  router.add('DELETE', '/leases/:id', ({ params, principal }) => cancel(own(params.id, principal, 'lease')));
  router.add('POST', '/leases/:id/extend', async ({ params, principal, req }) => {
    const item = own(params.id, principal, 'lease'); if (item.state !== 'active') throw new HttpError(409, 'not-active', `Lease is ${item.state}`);
    const seconds = Number((await readJSON(req)).seconds ?? 300); item.expiresAt = Math.min(item.startedAt + settings.leaseMaxMs, Date.now() + Math.max(30, Math.min(settings.leaseMaxMs / 1000, seconds)) * 1000); save(item);
    return { expiresAt: new Date(item.expiresAt).toISOString() };
  });
  // The lease holder's proxy to its runner session: /leases/:id/session/<runner session path> -> runner /sessions/<sid>/<path>
  for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
    router.add(method, '/leases/:id/session/*', proxy);
  }
  async function proxy({ req, res, url, params, principal }) {
    const item = own(params.id, principal, 'lease');
    if (item.state !== 'active') throw new HttpError(409, 'not-active', `Lease is ${item.state}${item.state === 'queued' ? ` (position ${queuePositions([...items.values()]).get(item.id) ?? '?'})` : ''}`);
    item.lastUsedAt = Date.now();
    const rest = params['*'] ? `/${params['*']}` : '';
    if (/(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\/i.test(rest)) throw badRequest('Invalid session path');
    if (req.method === 'DELETE' && !rest) return cancel(item);
    const runner = runnerById(item.runnerId), search = new URLSearchParams(url.search); search.delete('access_token');
    const target = `/sessions/${encodeURIComponent(item.sessionId)}${rest}${search.size ? `?${search}` : ''}`;
    const headers = {}; for (const name of ['content-type', 'accept', 'last-event-id']) if (req.headers[name]) headers[name] = req.headers[name];
    const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method);
    const response = await runner.request(req.method, target, { raw: true, headers, body: hasBody ? Readable.toWeb(req) : undefined, timeoutMs: /\/stream$|\/events$/.test(rest) ? 24 * 3600 * 1000 : 180000 });
    const out = {}; for (const name of ['content-type', 'content-length', 'x-screenshot-notes', 'x-image-size', 'retry-after', 'cache-control']) { const value = response.headers.get(name); if (value) out[name] = value; }
    res.writeHead(response.status, out);
    if (!response.body) { res.end(); return; }
    const stream = Readable.fromWeb(response.body); req.on('close', () => stream.destroy()); stream.on('error', () => res.end()); stream.pipe(res);
  }

  function cancel(item) {
    if (FINAL_STATES.has(item.state)) return view(item);
    item.abort?.abort(new Error('cancelled'));
    finish(item, item.kind === 'lease' && item.state === 'active' ? 'released' : 'cancelled');
    return view(item);
  }
  function streamEvents(item, req, res, url) {
    const sse = openSSE(req, res), last = Number(req.headers['last-event-id'] ?? url.searchParams.get('since') ?? -1);
    (item.events ?? []).forEach((event, index) => { if (index > last) sse.send(event.type, event, index); });
    if (FINAL_STATES.has(item.state)) { sse.send('end', { state: item.state }); sse.close(); return; }
    const onEvent = event => { sse.send(event.type, event, item.events.length - 1); if (FINAL_STATES.has(event.state) && FINAL_STATES.has(event.type)) { sse.send('end', { state: event.state }); sse.close(); } };
    events.on(item.id, onEvent); req.on('close', () => events.off(item.id, onEvent));
  }

  const server = createHttpServer({ router, corsOrigins: settings.corsOrigins, authenticate, log });
  return {
    server, settings, items, runners, dispatch,
    listen() { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(settings.port, settings.host, () => { server.off('error', reject); resolve(server.address()); }); }); },
    async close({ keepData = true } = {}) {
      closed = true; clearInterval(healthTimer); clearInterval(retryTimer);
      for (const item of items.values()) if (item.kind === 'lease' && item.state === 'active') finish(item, 'expired', { error: { code: 'queue-shutdown', message: 'The queue shut down' } });
      for (const item of items.values()) item.abort?.abort(new Error('queue-shutdown'));
      await store.flush(); await new Promise(resolve => server.close(() => resolve())); server.closeAllConnections?.();
      if (!keepData) rmSync(settings.dataDir, { recursive: true, force: true });
    },
  };
}
const errorOut = error => ({ code: error?.code ?? 'error', message: String(error?.message ?? error).slice(0, 4000), ...(error?.status ? { status: error.status } : {}), ...(error?.body?.error?.details ? { details: error.body.error.details } : error?.details ? { details: error.details } : {}) });
