// One APK session: the lab's VM Worker (runtime/apk-worker.js) in a worker_threads Worker, driven through the bundle's own APKWorkerClient, so every feature uses the
// exact Worker protocol of the site and the player. This class adds what a server needs around it: an operation queue, the last snapshot, logcat / network-log
// buffers for paged reads and SSE, element lookup, screenshots, permission dialogs, plugins, idle tracking and cleanup.
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { HttpError, badRequest } from '../../lib/http.mjs';
import { rasterHooks, isRasterKey } from './rasters.mjs';
import { deviceForVM, missingApisMode, RESTART_KEYS, validatePlugins } from './config.mjs';
import { createServerPluginHost } from './plugins.mjs';
import { screenReadyOut, READY_TIMEOUT_MS, RELOAD_MODES } from './readiness.mjs';
import { hostDeviceMemory, memoryReport, workerHeapMb } from './memory.mjs';

const VM_WORKER_URL = new URL('./vm-worker.mjs', import.meta.url);
const LOG_RING = 5000, NET_RING = 2000, MAX_QUEUED_OPERATIONS = 32, MAX_RUNTIME_ERRORS = 20;
const ACTION_DOWN = 0, ACTION_UP = 1, ACTION_SCROLL = 8;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const conflict = (code, message) => new HttpError(409, code, message);

/** A JSON-safe copy of a snapshot: rasters become { rasterId, width, height, kind } and the VM trace is cut. */
export function publicSnapshot(snapshot, { trace = 50 } = {}) {
  if (!snapshot) return null;
  return JSON.parse(JSON.stringify(snapshot, (key, value) => {
    if (key === 'image' || key === 'pixels') return undefined;
    if (key === 'dataURL') return isRasterKey(value) ? undefined : value;
    if (key === 'trace' && Array.isArray(value)) return trace ? value.slice(-trace) : undefined;
    if (typeof value === 'bigint') return String(value);
    return value;
  }));
}
/** The manifest facts of the inventory (it also carries class and string tables the API does not need). */
export function inventorySummary(inventory) {
  if (!inventory) return null;
  const pick = ['packageName', 'applicationName', 'usesSdk', 'launcherActivity', 'activities', 'services', 'providers', 'receivers', 'usesPermissions', 'declaredPermissions', 'componentCounts', 'autoVerifyHosts', 'unsupportedFeatures', 'totalDexBytes', 'nativeLibraries', 'framework', 'skia'];
  const out = {}; for (const key of pick) if (inventory[key] !== undefined) out[key] = inventory[key];
  if (Array.isArray(inventory.dexFiles)) out.dexFiles = inventory.dexFiles.length;
  if (Array.isArray(inventory.classNames)) out.classCount = inventory.classNames.length;
  return JSON.parse(JSON.stringify(out, (key, value) => typeof value === 'bigint' ? String(value) : value));
}

export class Session extends EventEmitter {
  constructor({ id = randomUUID(), owner = null, bundle, painter, limits, policy, appDataDir = null, deviceMemory = hostDeviceMemory(), log = () => {} }) {
    super(); this.setMaxListeners(100);
    Object.assign(this, { id, owner, bundle, painter, limits, policy, appDataDir, deviceMemory, log });
    this.state = 'created'; this.createdAt = Date.now(); this.lastUsedAt = Date.now();
    this.config = {}; this.inventory = null; this.appData = null; this.snapshot = null; this.snapshotSeq = 0; this.lastError = null; this.runtimeErrors = [];
    this.queue = Promise.resolve(); this.queued = 0; this.busyWith = null;
    this.logs = []; this.logTotal = 0; this.logDropped = 0; this.lastLogSeq = -1; this.logStreaming = false; this.logHolds = 0; this.logListeners = 0;
    this.netlog = new Map(); this.netTotal = 0;
    this.permissionConfig = null; this.permissionRequests = new Map(); this.apiGaps = null; this.metrics = { loadMs: null, launchMs: null, operations: 0 };
    this.plugins = null; this.apk = null; this.lastReady = null; this.snapshotAt = 0;
  }
  touch() { this.lastUsedAt = Date.now(); }

  // ---- the VM Worker -------------------------------------------------------------------------------------------------------------------------------------------------
  workerFactory(heapMb) {
    return url => {
      const thread = new Worker(VM_WORKER_URL, { workerData: { workerURL: url.href, runtimeDir: this.bundle.info.dir, appDataDir: this.appDataDir, deviceMemory: this.deviceMemory, allowPrivateNetwork: this.policy?.allowPrivateNetwork === true }, env: {}, argv: [], execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: 64, stackSizeMb: 16 }, name: `apk-vm:${this.id.slice(0, 8)}` });
      const adapter = { onmessage: null, onerror: null, onmessageerror: null,
        postMessage: (data, transfer) => thread.postMessage(data, transfer?.filter(item => item instanceof ArrayBuffer)), terminate: () => { adapter.terminated = true; thread.terminate().catch(() => {}); } };
      thread.on('message', data => {
        if (data?.type === '__ready' || data?.type === 'audio' || data?.type === 'webview') return;   // no audio output and no WebView iframes on a server
        if (data?.type === '__fatal') { this.log('error', `session ${this.id}: ${data.message}`); return; }
        adapter.onmessage?.({ data });
      });
      thread.on('error', error => { const oom = error?.code === 'ERR_WORKER_OUT_OF_MEMORY'; this.log('warn', `session ${this.id}: VM worker ${oom ? 'out of memory' : 'error'}: ${error?.message}`); adapter.onerror?.({ message: oom ? `memória do Worker esgotada (limite ${heapMb} MiB do runner)` : String(error?.message ?? error), preventDefault() {} }); });
      thread.on('exit', code => { if (!adapter.terminated && this.state !== 'closed') { this.state = 'crashed'; this.lastError = { message: `VM worker exited (code ${code})` }; this.emit('event', 'crashed', { code }); } });
      return adapter;
    };
  }
  createClient(heapMb) {
    const client = new this.bundle.APKWorkerClient({ workerURL: this.bundle.workerURL, workerFactory: this.workerFactory(heapMb), loadTimeoutMs: this.limits.loadTimeoutMs, eventTimeoutMs: this.limits.operationTimeoutMs });
    client.rasters = this.bundle.createRasterReceiver(rasterHooks);
    client.onRuntimeSnapshot = (snapshot, seq) => { this.setSnapshot(snapshot); client.ackFrame(seq); };   // "drawn" at once: the server keeps the newest frame
    client.onRuntimeError = error => { const entry = { at: Date.now(), message: error.message, summary: error.summary ?? null, uncaught: error.uncaught ?? null }; this.runtimeErrors.push(entry); if (this.runtimeErrors.length > MAX_RUNTIME_ERRORS) this.runtimeErrors.shift(); this.emit('event', 'runtime-error', entry); };
    client.onLogcat = message => this.onLogcat(message);
    client.onNetlog = message => this.onNetlog(message);
    client.onAppData = status => { this.appData = status; this.emit('event', 'app-data', status); };
    client.onApiGaps = report => { this.apiGaps = report; };
    client.onPermissionRequest = request => this.onPermissionRequest(request);
    client.onPermissionConfig = config => { this.permissionConfig = config; this.emit('event', 'permission-config', config); };
    return client;
  }
  setSnapshot(snapshot) {
    if (!snapshot) return;
    this.snapshot = snapshot; this.snapshotSeq++; this.snapshotAt = Date.now();
    this.plugins?.host.snapshot(snapshot);
    this.emit('snapshot', snapshot);
    this.emit('event', 'snapshot', { seq: this.snapshotSeq, activity: snapshot.activityName ?? null, closed: !!snapshot.closed, ready: snapshot.screenReady ? !!snapshot.screenReady.ready : null });
    // "Tela pronta" flips (the Worker posts a snapshot when the quiet period ends even when nothing else happens): one 'ready' event per change, true or false
    const ready = snapshot.screenReady ? !!snapshot.screenReady.ready : null;
    if (ready !== null && ready !== (this.lastReady ?? false)) { this.lastReady = ready; this.emit('event', 'ready', { seq: this.snapshotSeq, ...screenReadyOut(snapshot) }); }
    else if (ready !== null) this.lastReady = ready;
  }

  /** Serializes VM operations (the Worker runs one at a time); at most MAX_QUEUED_OPERATIONS wait. */
  op(name, fn) {
    if (this.state === 'closed') return Promise.reject(conflict('session-closed', 'The session is closed'));
    if (this.queued >= MAX_QUEUED_OPERATIONS) return Promise.reject(Object.assign(new HttpError(429, 'too-many-operations', `More than ${MAX_QUEUED_OPERATIONS} operations waiting on this session`), { retryAfter: 1 }));
    this.queued++; this.touch();
    const run = async () => {
      this.busyWith = name;
      try {
        if (this.state === 'closed') throw conflict('session-closed', 'The session is closed');
        if (name !== 'load' && (!this.client?.worker || this.state === 'crashed')) throw conflict('vm-not-running', `The VM is not running (state ${this.state}${this.lastError ? `: ${this.lastError.message}` : ''}); POST /sessions/${this.id}/restart to load the APK again`);
        this.metrics.operations++;
        return await fn();
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error?.name === 'TimeoutError' || /O Worker foi encerrado/.test(error?.message ?? '')) this.state = 'crashed';
        this.lastError = { operation: name, at: Date.now(), name: error?.name ?? 'Error', message: String(error?.message ?? error), summary: error?.summary ?? null, uncaught: error?.uncaught ?? null, details: error?.details ?? null, stubs: error?.stubs ?? [] };
        throw new HttpError(422, 'vm-error', String(error?.message ?? error).slice(0, 4000), { operation: name, summary: error?.summary ?? null, uncaught: error?.uncaught ?? null, kind: error?.details?.kind ?? null, state: this.state });
      } finally { this.busyWith = null; this.queued--; this.touch(); }
    };
    const result = this.queue.then(run, run); this.queue = result.catch(() => {});
    return result;
  }

  // ---- load / restart ------------------------------------------------------------------------------------------------------------------------------------------------
  async load(apk, config) {
    this.apk = Buffer.from(apk); this.config = config;
    return this.op('load', () => this.loadNow());
  }
  async loadNow() {
    // memory "automatic" (memoryMiB 0) follows navigator.deviceMemory like the site (memory.mjs); the Worker's JS heap is sized for that budget
    const config = this.config, memory = this.memoryFor(config) ?? { budgetMiB: config.memoryMiB || 400 }, heapMb = workerHeapMb(memory.budgetMiB, this.limits);
    this.memory = { ...memory, workerHeapMb: heapMb };
    this.client?.cancel(); this.client?.rasters?.reset(); this.plugins?.dispose(); this.plugins = null;
    this.state = 'loading'; this.snapshot = null; this.lastReady = null; this.logs = []; this.lastLogSeq = -1; this.netlog.clear(); this.permissionRequests.clear(); this.lastError = null; this.runtimeErrors = []; this.logStreaming = false;
    const client = this.client = this.createClient(heapMb);
    const bytes = this.apk.buffer.slice(this.apk.byteOffset, this.apk.byteOffset + this.apk.byteLength);   // a copy: the Worker takes ownership of it
    const started = performance.now();
    const result = await client.load(bytes, {
      device: deviceForVM(config, this.bundle), tolerateMissing: missingApisMode(config.missingApis), strictCrash: config.strictCrash === true,
      keepData: this.appDataDir ? config.appData?.keep !== false : false, clearData: config.appData?.clear === true, webview: false, memoryMiB: config.memoryMiB ?? 0,
      methodOverrides: config.methodOverrides ?? [], ignoredActivities: config.ignoredActivities ?? [], endpointMocks: config.endpointMocks ?? [], eventSeconds: config.eventSeconds ?? 0,
      permissions: config.permissions?.config || config.permissions?.location ? { config: config.permissions.config ?? { states: {}, denials: {}, once: [] }, location: config.permissions.location } : null,
      motionRaster: config.raster === 'progressive', rasterScale: config.rasterScale ?? 0.5, rasterNavigation: config.rasterNavigation !== false, logcatStreaming: false });
    this.metrics.loadMs = Math.round(performance.now() - started);
    this.inventory = result.inventory; this.appData = result.appData; this.state = 'ready';
    if (config.permissions?.dialogs && config.permissions.dialogs !== 'dismiss') await client.setPermissions({ dialogs: true });
    this.plugins = createServerPluginHost({ bundle: this.bundle, vm: client, limits: this.limits.plugins, log: this.log,
      captureImage: options => this.capturePluginImage(options), getPackage: () => this.inventory?.packageName ?? null,
      onLogStreaming: wanted => { this.pluginLogs = wanted; this.syncLogcat(); }, onChange: id => this.emit('event', 'plugin', { id }) });
    this.plugins.host.vmChanged();
    if (config.plugins?.length) this.plugins.setPlugins(config.plugins);
    await this.syncLogcat();
    this.emit('event', 'loaded', { packageName: this.inventory?.packageName ?? null, loadMs: this.metrics.loadMs });
    if (config.launch) await this.launchNow(typeof config.launch === 'string' ? config.launch : undefined);
    return this.describe();
  }
  restart(partialConfig) {
    if (!this.apk) throw conflict('no-apk', 'No APK was loaded in this session');
    if (partialConfig) this.config = { ...this.config, ...partialConfig };
    return this.op('load', () => this.loadNow());
  }

  // ---- live config -----------------------------------------------------------------------------------------------------------------------------------------------------
  /** Applies a validated partial config through the same live paths the site uses; restart-only keys are stored and reported. */
  async updateConfig(partial) {
    const applied = [], restartRequired = [];
    for (const key of Object.keys(partial)) if (RESTART_KEYS.includes(key)) restartRequired.push(key);
    const next = { ...this.config, ...partial };
    if (partial.device || partial.network) { next.device = { ...(this.config.device ?? {}), ...(partial.device ?? {}) }; next.network = { ...(this.config.network ?? {}), ...(partial.network ?? {}) }; }
    if (partial.permissions) next.permissions = { ...(this.config.permissions ?? {}), ...partial.permissions };
    this.config = next;
    const client = this.client, running = !!client?.worker && this.state !== 'crashed';
    if (running) {
      if (partial.device || partial.network) { const { outcome, snapshot } = await this.op('device', () => client.setDevice(deviceForVM(next, this.bundle))); if (snapshot) this.setSnapshot(snapshot); applied.push({ key: 'device', outcome }); }
      if (partial.eventSeconds !== undefined) applied.push({ key: 'eventSeconds', limits: await client.setTimeLimits(partial.eventSeconds) });
      // "Resolução no movimento" / "Tela nova em baixa resolução": the next snapshot uses them; with raster "full" the Worker keeps the reduced replay off (enabled: false)
      if (partial.rasterScale !== undefined || partial.rasterNavigation !== undefined) applied.push({ key: 'raster', raster: await client.setRasterSettings({ scale: next.rasterScale ?? 0.5, navigation: next.rasterNavigation !== false }) });
      if (partial.methodOverrides) applied.push({ key: 'methodOverrides', statuses: await client.setMethodOverrides(partial.methodOverrides) });
      if (partial.endpointMocks) applied.push({ key: 'endpointMocks', statuses: await client.setEndpointMocks(partial.endpointMocks) });
      if (partial.ignoredActivities) applied.push({ key: 'ignoredActivities', statuses: await client.setIgnoredActivities(partial.ignoredActivities) });
      if (partial.permissions) {
        const payload = {}; if (partial.permissions.config) payload.config = partial.permissions.config; if ('location' in partial.permissions) payload.location = partial.permissions.location;
        if (partial.permissions.dialogs) payload.dialogs = partial.permissions.dialogs !== 'dismiss';
        applied.push({ key: 'permissions', result: await client.setPermissions(payload) });
      }
      if (partial.plugins) { this.plugins?.setPlugins(partial.plugins); applied.push({ key: 'plugins', count: partial.plugins.length }); }
      if (partial.logcat) { await this.syncLogcat(); applied.push({ key: 'logcat', streaming: this.logStreaming }); }
    }
    return { applied, restartRequired, running, config: this.config };
  }

  /** { budgetMiB, maxHeapObjects, source, deviceMemory } of a config: a memoryMiB step, else the device-memory rule of the site. */
  memoryFor(config = this.config) { return typeof this.bundle.memoryBudget === 'function' ? memoryReport(this.bundle.memoryBudget, { memoryMiB: config?.memoryMiB ?? 0, deviceMemory: this.deviceMemory }) : null; }

  // ---- operations ------------------------------------------------------------------------------------------------------------------------------------------------------
  async launchNow(activity) {
    const started = performance.now(); const snapshot = await this.client.launch(activity);
    this.metrics.launchMs = Math.round(performance.now() - started); this.state = 'running'; this.setSnapshot(snapshot); return snapshot;
  }
  launch(activity) { return this.op('launch', () => this.launchNow(activity)); }
  intent(intent) { return this.op('intent', async () => { const { deepLink, snapshot } = await this.client.startIntent(intent); if (snapshot) { this.state = 'running'; this.setSnapshot(snapshot); } return { deepLink, snapshot }; }); }
  /** "Recriar" (recreate: Activity.recreate(), saved state and retained ViewModels kept) or "Reabrir" (reopen: a fresh instance with the same Intent, no saved state). */
  reload(mode = 'recreate') {
    if (!RELOAD_MODES.includes(mode)) throw badRequest(`reload: mode must be ${RELOAD_MODES.join(' or ')}`);
    return this.op('reload', async () => { const snapshot = await this.client.reloadActivity({ mode }); this.state = 'running'; this.setSnapshot(snapshot); return snapshot; });
  }
  back() { return this.op('back', async () => { const snapshot = await this.client.back(); this.setSnapshot(snapshot); return snapshot; }); }
  /** One raw Worker input (click/input/check/focus/press/scroll/scrollby/compose-action/pointer) on ids the caller took from a snapshot. */
  raw(type, payload) {
    return this.op(type, async () => {
      const c = this.client, p = payload;
      const snapshot = type === 'click' ? await c.click(p.id) : type === 'input' ? await c.input(p.id, p.text) : type === 'check' ? await c.check(p.id, p.checked) : type === 'focus' ? await c.focus(p.id, p.focused)
        : type === 'press' ? await c.press(p.id, p.pressed) : type === 'scroll' ? await c.scroll(p.id, p.x, p.y) : type === 'scrollby' ? await c.scrollBy(p.id, p.dx, p.dy)
        : type === 'compose-action' ? await c.composeAction(p.ownerViewId, p.nodeId, p.action, p.args ?? []) : type === 'pointer' ? await c.pointer(p) : null;
      if (!snapshot) throw badRequest(`unknown input type ${type}`);
      this.setSnapshot(snapshot); return snapshot;
    });
  }

  // ---- elements ----------------------------------------------------------------------------------------------------------------------------------------------------------
  contentOffset() { const frame = this.snapshot?.systemBars?.contentFrame; return { x: frame?.left ?? 0, y: frame?.top ?? 0 }; }
  /** The boxes of "Mostrar limites de layout" for the current frame; names from one Compose inspection when `names`. Bounds are window (content) dp; screenBounds add the system bar offset. */
  async layoutBounds({ names = true } = {}) {
    if (!this.snapshot) return [];
    let inspection = null;
    if (names && this.client?.worker) { try { inspection = await this.client.inspectCompose({ maxNodes: 2000 }); } catch { inspection = null; } }
    const offset = this.contentOffset();
    return this.bundle.buildLayoutBoundsElements(inspection, this.snapshot).map(element => elementOut(element, offset));
  }
  /** Elements matching a selector { key, testTag, text, textContains, contentDescription, androidId, viewId, kind, clickable, index }. */
  find(selector, elements) {
    const s = selector ?? {}, list = elements ?? this.bundle.buildLayoutBoundsElements(null, this.snapshot).map(element => elementOut(element, this.contentOffset()));
    const keys = ['key', 'testTag', 'text', 'textContains', 'contentDescription', 'androidId', 'viewId', 'kind'];
    if (!keys.some(key => s[key] !== undefined)) throw badRequest(`selector needs one of ${keys.join(', ')}`);
    const lower = value => String(value ?? '').toLowerCase();
    const matches = list.filter(e => (s.key === undefined || e.key === s.key) && (s.testTag === undefined || e.testTag === s.testTag) && (s.kind === undefined || e.kind === s.kind)
      && (s.viewId === undefined || (e.kind === 'view' && e.id === Number(s.viewId))) && (s.androidId === undefined || e.androidId === s.androidId || (typeof e.androidId === 'string' && e.androidId.endsWith(`/${s.androidId}`)))
      && (s.text === undefined || [...e.texts, e.editableText].includes(s.text)) && (s.contentDescription === undefined || e.contentDescriptions.includes(s.contentDescription))
      && (s.textContains === undefined || [...e.texts, e.editableText ?? '', ...e.contentDescriptions].some(t => lower(t).includes(lower(s.textContains))))
      && (s.clickable === undefined || e.clickable === !!s.clickable));
    // a merged Compose node and its own text child both match a text: the one that can be clicked comes first, then the smallest
    matches.sort((a, b) => Number(b.clickable) - Number(a.clickable) || area(a) - area(b));
    return matches;
  }
  findOne(selector) {
    const all = this.find(selector), index = Number(selector?.index ?? 0), element = all[index];
    if (!element) throw new HttpError(404, 'element-not-found', `No element on the screen matches ${JSON.stringify(selector)}${all.length ? ` (only ${all.length} matches)` : ''}`, { activity: this.snapshot?.activityName ?? null });
    return element;
  }
  /**
   * Waits until an element matching `selector` is on the screen (or gone, with gone: true) and, with ready: true, the screen is "Tela pronta" (snapshot.screenReady.ready);
   * either condition alone works. Resolves with the element (or null), the elapsed time and the screenReady of the snapshot that satisfied it.
   */
  waitFor(selector, { timeoutMs = 10000, gone = false, ready = false } = {}) {
    if (!selector && !ready) throw badRequest('wait needs a selector, ready: true, or both');
    const started = Date.now(), check = () => {
      if (!this.snapshot) return undefined;
      if (ready && !this.snapshot.screenReady?.ready) return undefined;
      if (!selector) return null;
      const found = this.find(selector)[0] ?? null; return gone ? (found ? undefined : null) : found ?? undefined;
    };
    return new Promise((resolve, reject) => {
      const done = (value, error) => { clearTimeout(timer); this.off('snapshot', onSnapshot); this.off('closed', onClosed); if (error) reject(error); else resolve({ element: value, waitedMs: Date.now() - started, screenReady: screenReadyOut(this.snapshot) }); };
      const onSnapshot = () => { try { const value = check(); if (value !== undefined) done(value); } catch (error) { done(null, error); } };
      const onClosed = () => done(null, conflict('session-closed', 'The session closed while waiting'));
      const timer = setTimeout(() => {
        const screenReady = screenReadyOut(this.snapshot), notReady = ready && !screenReady?.ready, waitingFor = notReady ? (screenReady?.waitingFor?.length ? screenReady.waitingFor : [this.snapshot ? 'sem informação de prontidão (screenReady)' : 'nenhuma tela ainda']) : [];
        const what = [selector ? `${gone ? 'the disappearance of ' : ''}${JSON.stringify(selector)}` : null, ready ? 'the screen to be ready' : null].filter(Boolean).join(' and ');
        done(null, new HttpError(408, notReady && !selector ? 'ready-timeout' : 'wait-timeout', `Timed out after ${timeoutMs} ms waiting for ${what}${notReady ? ` (waiting for: ${waitingFor.join('; ')})` : ''}`, { activity: this.snapshot?.activityName ?? null, waitingFor, screenReady }));
      }, timeoutMs);
      this.on('snapshot', onSnapshot); this.once('closed', onClosed);
      onSnapshot();
    });
  }
  /** Resolves once the screen is "Tela pronta"; 408 ready-timeout with the reasons it still waits for. */
  waitReady({ timeoutMs = READY_TIMEOUT_MS } = {}) { return this.waitFor(null, { ready: true, timeoutMs }); }
  /** The latest screenReady and whether it describes the screen now: `current` is false while an operation runs (its snapshot is not in yet), before the first screen or when the VM stopped. */
  readiness() {
    const s = this.snapshot, screenReady = screenReadyOut(s), running = !!this.client?.worker && ['running', 'ready'].includes(this.state);
    const current = !!s && !!screenReady && running && !this.busyWith;
    return { ready: current && screenReady.ready, current, state: this.state, busyWith: this.busyWith, activity: s?.activityName ?? null, seq: this.snapshotSeq, snapshotAgeMs: s ? Date.now() - this.snapshotAt : null, screenReady };
  }
  /** Tap at screen coordinates (dp): a Compose owner under the point gets a real pointer DOWN/UP; otherwise the deepest clickable View is clicked (View.performClick path of the Worker). */
  tapAt(x, y, { longPressMs = 0 } = {}) {
    return this.op('tap', async () => {
      const target = this.hitTest(x, y); if (!target) throw new HttpError(404, 'nothing-here', `No visible View at ${x},${y}`);
      if (target.compose) {
        const local = { ownerViewId: target.compose.id, x: x - target.compose.screen.left, y: y - target.compose.screen.top }, t = performance.now();
        await this.client.pointer({ ...local, action: ACTION_DOWN, t });
        if (longPressMs > 0) await sleep(Math.min(longPressMs, 5000));
        const snapshot = await this.client.pointer({ ...local, action: ACTION_UP, t: t + Math.max(60, longPressMs) }); this.setSnapshot(snapshot);
        return { via: 'pointer', ownerViewId: target.compose.id, x: local.x, y: local.y, snapshot };
      }
      if (!target.clickable) throw new HttpError(404, 'nothing-clickable', `No clickable View at ${x},${y} (deepest View: ${target.view.type ?? target.view.id})`);
      const snapshot = await this.client.click(target.clickable.id); this.setSnapshot(snapshot);
      return { via: 'click', viewId: target.clickable.id, snapshot };
    });
  }
  hitTest(x, y) {
    if (!this.snapshot) throw conflict('no-screen', 'No screen yet: launch the app first');
    const offset = this.contentOffset(), cx = x - offset.x, cy = y - offset.y, views = this.bundle.flattenViews(this.snapshot), byId = new Map(views.map(v => [v.id, v]));
    const inside = v => v.visible && v.bounds && cx >= v.bounds.left && cx < v.bounds.right && cy >= v.bounds.top && cy < v.bounds.bottom;
    let deepest = null; for (const view of views) if (inside(view)) deepest = view;   // flattenViews lists windows in z order and children after parents
    if (!deepest) return null;
    let compose = null, clickable = null;
    for (let v = deepest; v; v = v.parentId !== null ? byId.get(v.parentId) : null) { if (!compose && v.compose) compose = v; if (!clickable && v.clickable) clickable = v; }
    return { view: deepest, compose: compose ? { id: compose.id, screen: { left: compose.bounds.left + offset.x, top: compose.bounds.top + offset.y } } : null, clickable };
  }
  /** Tap on an element: a Compose node with OnClick gets the semantics action (like the site's accessibility layer); anything else a tap at its center. */
  async tapElement(selector, { longPress = false } = {}) {
    const element = this.findOne(selector), action = longPress ? 'OnLongClick' : 'OnClick';
    if (element.kind === 'compose' && element.actions.includes(action)) {
      const snapshot = await this.raw('compose-action', { ownerViewId: element.ownerViewId, nodeId: element.id, action, args: [] });
      return { via: 'semantics', action, element, snapshot };
    }
    if (element.kind === 'view' && element.clickable && !longPress) { const snapshot = await this.raw('click', { id: element.id }); return { via: 'click', element, snapshot }; }
    const b = element.screenBounds; const result = await this.tapAt((b.left + b.right) / 2, (b.top + b.bottom) / 2, { longPressMs: longPress ? 700 : 0 });
    return { ...result, element };
  }
  /** Types text into an element: Compose SetText (or InsertTextAtCursor with append) / EditText input. */
  async typeText(selector, text, { append = false } = {}) {
    if (typeof text !== 'string' || text.length > 100000) throw badRequest('text must be a string of at most 100000 characters');
    const element = this.findOne(selector);
    if (element.kind === 'compose') {
      const action = append && element.actions.includes('InsertTextAtCursor') ? 'InsertTextAtCursor' : 'SetText';
      if (!element.actions.includes(action)) throw new HttpError(422, 'not-editable', `Element ${element.key} has no ${action} semantics action (actions: ${element.actions.join(', ') || 'none'})`);
      const snapshot = await this.raw('compose-action', { ownerViewId: element.ownerViewId, nodeId: element.id, action, args: [text] }); return { via: 'semantics', action, element, snapshot };
    }
    if (element.viewKind !== 'input') throw new HttpError(422, 'not-editable', `View ${element.key} is not an EditText (kind ${element.viewKind})`);
    const value = append ? `${element.texts[0] ?? ''}${text}` : text;
    const snapshot = await this.raw('input', { id: element.id, text: value }); return { via: 'input', element, snapshot };
  }
  /** Scrolls an element (Compose ScrollBy semantics, RecyclerView/ListView scrollBy, ScrollView scrollTo) or, at a point, a Compose wheel event. Deltas in dp. */
  async scroll({ selector, x, y, dx = 0, dy = 0 }) {
    if (![dx, dy].every(value => Number.isFinite(value) && Math.abs(value) < 100000)) throw badRequest('dx/dy must be finite numbers below 100000');
    if (selector) {
      const element = this.findOne(selector);
      if (element.kind === 'compose') { if (!element.actions.includes('ScrollBy')) throw new HttpError(422, 'not-scrollable', `Element ${element.key} has no ScrollBy action`); return { via: 'semantics', element, snapshot: await this.raw('compose-action', { ownerViewId: element.ownerViewId, nodeId: element.id, action: 'ScrollBy', args: [dx, dy] }) }; }
      if (/RecyclerView;$|\/ListView;$/.test(element.type ?? '')) return { via: 'scrollBy', element, snapshot: await this.raw('scrollby', { id: element.id, dx, dy }) };
      const raw = findRaw(this.snapshot, element.id);
      return { via: 'scrollTo', element, snapshot: await this.raw('scroll', { id: element.id, x: Math.round((raw?.scrollX ?? 0) + dx), y: Math.round((raw?.scrollY ?? 0) + dy) }) };
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw badRequest('scroll needs a selector or x/y');
    return this.op('wheel', async () => {
      const target = this.hitTest(x, y); if (!target?.compose) throw new HttpError(422, 'not-scrollable', 'Wheel scrolling at a point needs a Compose view under it; use a selector for Views');
      const snapshot = await this.client.pointer({ ownerViewId: target.compose.id, action: ACTION_SCROLL, x: x - target.compose.screen.left, y: y - target.compose.screen.top, t: performance.now(), dx, dy }); this.setSnapshot(snapshot);
      return { via: 'wheel', snapshot };
    });
  }

  // ---- screenshots -------------------------------------------------------------------------------------------------------------------------------------------------------
  /** With waitReady, first waits for "Tela pronta" (readyTimeoutMs, 408 ready-timeout); the result carries `ready` { waitedMs, screenReady }. */
  async screenshot({ scale = 1, systemBars = true, waitReady = false, readyTimeoutMs = READY_TIMEOUT_MS } = {}) {
    const ready = waitReady ? await this.waitReady({ timeoutMs: readyTimeoutMs }) : null;
    if (!this.snapshot) throw conflict('no-screen', 'No screen yet: launch the app first');
    const shot = await this.painter.paint(this.snapshot, { scale, systemBars });
    return { ...shot, ready: ready ? { waitedMs: ready.waitedMs, screenReady: ready.screenReady } : null };
  }
  async elementScreenshot(key, { scale = 1, waitReady = false, readyTimeoutMs = READY_TIMEOUT_MS } = {}) {
    const ready = waitReady ? await this.waitReady({ timeoutMs: readyTimeoutMs }) : null;
    if (!this.snapshot) throw conflict('no-screen', 'No screen yet: launch the app first');
    const element = (await this.layoutBounds({ names: false })).find(item => item.key === key);
    if (!element) throw new HttpError(404, 'element-not-found', `Element ${key} is not on the screen (GET /sessions/${this.id}/layout-bounds lists the current keys)`);
    const result = await this.painter.paint(this.snapshot, { scale, crop: element.screenBounds });
    return { ...result, element, ready: ready ? { waitedMs: ready.waitedMs, screenReady: ready.screenReady } : null };
  }
  async capturePluginImage({ snapshot, element, maxWidth }) {
    const offset = this.contentOffset(), b = element ? (element.windowBounds ?? element.bounds) : null;
    const crop = b ? { left: b.left + offset.x, top: b.top + offset.y, right: b.right + offset.x, bottom: b.bottom + offset.y } : null;
    const width = crop ? crop.right - crop.left : snapshot?.systemBars?.widthDp ?? 411, limit = Math.max(16, Math.min(2048, Number(maxWidth) || 1080));
    const result = await this.painter.paint(snapshot, { crop, scale: Math.min(1, limit / Math.max(1, width)) });
    return { blob: new Blob([result.png], { type: 'image/png' }), width: result.width, height: result.height, type: 'image/png', notes: Object.entries(result.notes).filter(([, n]) => n).map(([k, n]) => `${k}: ${n}`) };
  }

  // ---- inspection --------------------------------------------------------------------------------------------------------------------------------------------------------
  async composeTree({ maxNodes = 2000 } = {}) { if (!this.client?.worker) throw conflict('vm-not-running', 'The VM is not running'); return this.client.inspectCompose({ maxNodes: Math.min(4000, Math.max(1, Number(maxNodes) || 2000)) }); }
  async pluginQuery(query, args) {
    if (!this.client?.worker) throw conflict('vm-not-running', 'The VM is not running');
    try { return await this.client.pluginQuery(query, args); }
    catch (error) { const code = error?.code ?? 'failed'; throw new HttpError(code === 'bad-query' || code === 'bad-handle' ? 400 : code === 'collected' ? 410 : code === 'busy' ? 503 : 422, code, String(error?.message ?? error)); }
  }
  async screenState() { if (!this.client) return null; return this.client.screenState(); }
  async diagnostic() {
    const screen = await this.screenState().catch(() => null), s = this.snapshot;
    return { session: this.describe(), screenState: screen?.text ?? null, blankScreen: screen?.blank ?? null, blankReasons: screen?.reasons ?? [], lastError: this.lastError, runtimeErrors: this.runtimeErrors, apiGaps: this.apiGaps,
      vmHealth: s?.vmHealth ?? null, missing: s ? { void: s.missingVoid, returns: s.missingReturns, classes: s.missingClasses, libraries: s.missingLibraries } : null,
      debugging: s ? { methodOverrides: s.methodOverrides ?? [], endpointMocks: s.endpointMocks ?? [], hostMap: s.hostMap ?? [], ignoredActivities: s.ignoredActivities ?? [] } : null, appData: this.appData, permissionConfig: this.permissionConfig };
  }

  // ---- logcat / network log ----------------------------------------------------------------------------------------------------------------------------------------------
  onLogcat(message) {
    if (Array.isArray(message?.rows) && !message.count) {
      if (message.reset && Number.isFinite(message.total) && message.total <= this.lastLogSeq) { this.logs = []; this.lastLogSeq = -1; }
      const fresh = [];
      for (const row of message.rows) { const seq = Number(row?.[0]); if (!(seq > this.lastLogSeq)) continue; this.lastLogSeq = seq; const entry = { seq, uptime: row[1], wall: row[2], pid: row[3], tid: row[4], thread: row[5], level: row[6], tag: row[7], message: row[8] }; this.logs.push(entry); fresh.push(entry); }
      if (this.logs.length > LOG_RING) this.logs.splice(0, this.logs.length - LOG_RING);
      if (fresh.length) this.emit('logcat', fresh);
    }
    if (Number.isFinite(message?.total)) this.logTotal = message.total; if (Number.isFinite(message?.dropped)) this.logDropped = message.dropped;
    this.plugins?.host.logcat(message);
  }
  onNetlog(message) {
    if (message?.reset) this.netlog.clear();
    const fresh = [];
    for (const row of message?.rows ?? []) { if (!row || !Number.isFinite(row.seq)) continue; this.netlog.delete(row.seq); this.netlog.set(row.seq, row); fresh.push(row); }
    while (this.netlog.size > NET_RING) this.netlog.delete(this.netlog.keys().next().value);
    if (Number.isFinite(message?.total)) this.netTotal = message.total;
    if (fresh.length) this.emit('netlog', fresh);
    this.plugins?.host.netlog(message);
  }
  /** Logcat lines reach the server only while someone wants them (an SSE listener, a plugin listening to 'log', a paged read in progress, or config.logcat = 'always'). */
  async syncLogcat() {
    const wanted = this.logListeners > 0 || this.logHolds > 0 || !!this.pluginLogs || this.config.logcat === 'always';
    if (wanted === this.logStreaming || !this.client?.worker) return;
    this.logStreaming = wanted;
    try { await this.client.setLogcatStreaming(wanted); } catch (error) { this.logStreaming = !wanted; this.log('warn', `session ${this.id}: logcat streaming: ${error.message}`); }
  }
  /** A paged read: opens the stream briefly when closed (the Worker then posts its recent lines, at most 2000) and reads the buffer. */
  async readLogcat({ since = -1, limit = 500, level = null, tag = null, contains = null } = {}) {
    if (!this.logStreaming && this.client?.worker) { this.logHolds++; try { await this.syncLogcat(); await sleep(250); } finally { this.logHolds--; setTimeout(() => this.syncLogcat(), 0); } }
    const levels = ['V', 'D', 'I', 'W', 'E', 'A'], min = level ? levels.indexOf(level) : 0;
    const rows = this.logs.filter(entry => entry.seq > since && (min <= 0 || levels.indexOf(entry.level) >= min) && (!tag || entry.tag === tag) && (!contains || String(entry.message).includes(contains)));
    const page = rows.slice(0, limit);
    return { lines: page, next: page.length ? page[page.length - 1].seq : since, more: rows.length > page.length, total: this.logTotal, dropped: this.logDropped, streaming: this.logStreaming };
  }
  readNetlog({ since = -1, limit = 200 } = {}) {
    const rows = [...this.netlog.values()].filter(entry => entry.seq > since).sort((a, b) => a.seq - b.seq), page = rows.slice(0, limit);
    return { requests: page, next: page.length ? page[page.length - 1].seq : since, more: rows.length > page.length, total: this.netTotal };
  }

  // ---- permission dialogs ------------------------------------------------------------------------------------------------------------------------------------------------
  onPermissionRequest(request) {
    const mode = this.config.permissions?.dialogs ?? 'dismiss';
    this.permissionConfig = request.config ?? this.permissionConfig;
    if (mode === 'dismiss') { this.client.permissionResponse(request.id, null); this.emit('event', 'permission-request', { id: request.id, answered: 'dismiss' }); return; }
    if (mode !== 'manual') { let config = this.permissionConfig ?? { states: {}, denials: {}, once: [] }; for (const dialog of request.dialogs ?? []) config = this.bundle.answerDialog(config, this.inventory, dialog, mode); this.permissionConfig = config; this.client.permissionResponse(request.id, config); this.emit('event', 'permission-request', { id: request.id, answered: mode }); return; }
    const entry = { id: String(request.id), request, index: 0, config: this.bundle.sanitizePermissionConfig(request.config ?? this.permissionConfig ?? {}), at: Date.now() };
    this.permissionRequests.set(entry.id, entry); this.emit('event', 'permission-request', { id: entry.id, pending: true, dialog: request.dialogs?.[0] ?? null });
  }
  listPermissionRequests() { return [...this.permissionRequests.values()].map(entry => ({ id: entry.id, at: entry.at, dialog: entry.request.dialogs?.[entry.index] ?? null, remainingDialogs: (entry.request.dialogs?.length ?? 0) - entry.index, permissions: entry.request.permissions ?? null, appLabel: entry.request.appLabel ?? null })); }
  answerPermission(id, answer) {
    const entry = this.permissionRequests.get(String(id)); if (!entry) throw new HttpError(404, 'not-found', `No pending permission request ${id}`);
    if (!['allow', 'once', 'deny', 'dismiss'].includes(answer)) throw badRequest('answer: "allow", "once", "deny" or "dismiss"');
    if (answer === 'dismiss') { this.permissionRequests.delete(entry.id); this.client.permissionResponse(entry.request.id, null); return { done: true }; }
    entry.config = this.bundle.answerDialog(entry.config, this.inventory, entry.request.dialogs[entry.index], answer); entry.index++;
    if (entry.index < (entry.request.dialogs?.length ?? 0)) return { done: false, next: entry.request.dialogs[entry.index] };
    this.permissionRequests.delete(entry.id); this.permissionConfig = entry.config; this.client.permissionResponse(entry.request.id, entry.config); return { done: true, config: entry.config };
  }
  clearAppData() { return this.op('app-data-clear', async () => { this.appData = await this.client.clearAppData(); return this.appData; }); }
  searchMethods(query) { if (!this.client?.worker) throw conflict('vm-not-running', 'The VM is not running'); return this.client.searchMethods(query); }
  setPlugins(list) { const plugins = validatePlugins(list, this.policy); this.config.plugins = plugins; this.plugins?.setPlugins(plugins); return plugins; }

  describe() {
    return { id: this.id, state: this.state, busyWith: this.busyWith, queued: this.queued, createdAt: new Date(this.createdAt).toISOString(), lastUsedAt: new Date(this.lastUsedAt).toISOString(),
      packageName: this.inventory?.packageName ?? null, launcherActivity: this.inventory?.launcherActivity ?? null, activity: this.snapshot?.activityName ?? null, canGoBack: !!this.snapshot?.canGoBack,
      closed: !!this.snapshot?.closed, screenReady: this.snapshot?.screenReady ? !!this.snapshot.screenReady.ready : null, appData: this.appData, metrics: this.metrics, lastError: this.lastError ? { operation: this.lastError.operation, message: this.lastError.message } : null,
      plugins: this.config.plugins?.length ?? 0, logcatStreaming: this.logStreaming, runtimeRevision: this.bundle.info.revision,
      memory: { ...(this.memory ?? this.memoryFor()), liveObjects: this.snapshot?.vmHealth?.liveObjects ?? null, vmLimit: this.snapshot?.vmHealth?.limit ?? null } };
  }
  close(reason = 'closed') {
    if (this.state === 'closed') return;
    this.state = 'closed'; this.closeReason = reason;
    try { this.plugins?.dispose(); } catch { /* ignore */ }
    try { this.client?.cancel(); } catch { /* ignore */ }
    try { this.client?.rasters?.reset(); } catch { /* ignore */ }
    this.snapshot = null; this.apk = null; this.logs = []; this.netlog.clear();
    this.emit('event', 'closed', { reason }); this.emit('closed');
  }
}

const area = e => e.bounds ? (e.bounds.right - e.bounds.left) * (e.bounds.bottom - e.bounds.top) : Infinity;
function findRaw(snapshot, id) { const stack = [...(snapshot?.views ?? [])]; while (stack.length) { const v = stack.pop(); if (v?.id === id) return v; for (const c of v?.children ?? []) stack.push(c); } return null; }
/** An element of buildLayoutBoundsElements in the API's shape (the plugin API's lab.layoutBounds fields, plus screenBounds and the ids to act on it). */
export function elementOut(element, offset = { x: 0, y: 0 }) {
  const s = element.semantics ?? null, b = element.windowBounds ?? element.bounds ?? null;
  return { key: element.key, kind: element.kind, name: element.name, nameSource: element.nameSource, id: element.id, ownerViewId: element.ownerViewId ?? null,
    bounds: b, screenBounds: b ? { left: b.left + offset.x, top: b.top + offset.y, right: b.right + offset.x, bottom: b.bottom + offset.y } : null, size: b ? { width: b.right - b.left, height: b.bottom - b.top } : null,
    texts: s?.texts ?? (element.text ? [element.text] : []), editableText: s?.editableText ?? null, role: s?.role ?? null, testTag: s?.testTag ?? null,
    contentDescriptions: s?.contentDescriptions ?? (element.contentDescription ? [element.contentDescription] : []), actions: s?.actions ?? [], enabled: s ? s.enabled !== false : true,
    clickable: element.kind === 'compose' ? (s?.actions ?? []).includes('OnClick') : !!element.clickable, focused: s?.focused ?? null, selected: s?.selected ?? null, toggleState: s?.toggleState ?? null,
    modifiers: (element.modifiers ?? []).map(m => m.label ?? m), measurePolicy: element.measurePolicy ?? null, type: element.type ?? null, viewKind: element.viewKind ?? null, androidId: element.androidId ?? null,
    window: element.window ?? null, hasRaster: element.hostId !== null && element.hostId !== undefined };
}
