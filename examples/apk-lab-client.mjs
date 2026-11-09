// A small Node client (no dependencies, Node 22+) for the runner and the queue APIs. Copy it into your project or import it from this repository.
//
//   import { RunnerClient, QueueClient } from './apk-lab-client.mjs';
//   const runner = new RunnerClient({ url: 'http://127.0.0.1:8081', token: process.env.RUNNER_TOKEN });
//   const session = await runner.createSession(await readFile('app.apk'), { launch: true });
//   await session.tap({ selector: { testTag: 'login' } });
//
// A session reached through a queue lease has the same methods (QueueClient.lease(...).session).

export class ApiError extends Error {
  constructor(status, body) { super(body?.error?.message ?? `HTTP ${status}`); this.status = status; this.code = body?.error?.code ?? null; this.details = body?.error?.details ?? null; this.body = body; }
}

class Http {
  constructor({ url, token, clientId = null }) { this.url = String(url).replace(/\/$/, ''); this.token = token; this.clientId = clientId; }
  headers(extra = {}) { return { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(this.clientId ? { 'x-client-id': this.clientId } : {}), ...extra }; }
  async request(method, path, { json, body, headers = {}, raw = false } = {}) {
    const response = await fetch(this.url + path, { method, headers: this.headers({ ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }), body: json !== undefined ? JSON.stringify(json) : body });
    if (raw) { if (!response.ok) throw new ApiError(response.status, await response.json().catch(() => null)); return response; }
    const text = await response.text(), data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new ApiError(response.status, data);
    return data;
  }
  async bytes(path) { const response = await this.request('GET', path, { raw: true }); return Buffer.from(await response.arrayBuffer()); }
  /** Server-Sent Events: calls onEvent({ event, data, id }) until the returned stop() is called or the stream ends. */
  stream(path, onEvent) {
    const controller = new AbortController();
    const done = (async () => {
      const response = await fetch(this.url + path, { headers: this.headers({ accept: 'text/event-stream' }), signal: controller.signal });
      if (!response.ok) throw new ApiError(response.status, await response.json().catch(() => null));
      const decoder = new TextDecoder(); let buffer = '';
      try {
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true }); let at;
          while ((at = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1], id = /^id: (.*)$/m.exec(block)?.[1];
            if (event && data) onEvent({ event, data: JSON.parse(data), id });
          }
        }
      } catch (error) { if (error.name !== 'AbortError') throw error; }
    })();
    return { stop: () => controller.abort(), done: done.catch(error => { if (error.name !== 'AbortError') throw error; }) };
  }
}

/** One VM session: `base` is /sessions/<id> on a runner, or /leases/<id>/session on the queue. */
export class Session {
  constructor(http, base, info = null) { this.http = http; this.base = base; this.info = info; }
  get id() { return this.info?.id ?? null; }
  call(method, path = '', json) { return this.http.request(method, this.base + path, json === undefined ? {} : { json }); }
  describe() { return this.call('GET'); }
  launch(activity) { return this.call('POST', '/launch', activity ? { activity } : {}); }
  intent(intent) { return this.call('POST', '/intent', intent); }
  back() { return this.call('POST', '/back', {}); }
  tap(target) { return this.call('POST', '/tap', target); }                       // { selector } | { key } | { x, y } (+ longPress)
  type(selector, text, { append = false } = {}) { return this.call('POST', '/type', { selector, text, append }); }
  scroll(target) { return this.call('POST', '/scroll', target); }                 // { selector, dx, dy } | { x, y, dx, dy }
  input(raw) { return this.call('POST', '/input', raw); }                         // raw Worker input: { type: 'click' | 'compose-action' | 'pointer' | ..., ... }
  wait(selector, { timeoutMs = 10000, gone = false } = {}) { return this.call('POST', '/wait', { selector, timeoutMs, gone }); }
  snapshot({ full = false } = {}) { return this.call('GET', `/snapshot${full ? '?full=1' : ''}`); }
  layoutBounds({ names = true } = {}) { return this.call('GET', `/layout-bounds?names=${names ? 1 : 0}`); }
  elements(selector = {}) { return this.call('GET', `/elements?${new URLSearchParams(Object.entries(selector).map(([k, v]) => [k, String(v)]))}`); }
  composeTree(maxNodes = 2000) { return this.call('GET', `/compose-tree?maxNodes=${maxNodes}`); }
  screenshot({ scale = 1, systemBars = true } = {}) { return this.http.bytes(`${this.base}/screenshot.png?scale=${scale}&systemBars=${systemBars ? 1 : 0}`); }
  elementScreenshot(key, { scale = 1 } = {}) { return this.http.bytes(`${this.base}/elements/${encodeURIComponent(key)}/screenshot.png?scale=${scale}`); }
  config() { return this.call('GET', '/config'); }
  updateConfig(partial) { return this.call('PATCH', '/config', partial); }
  restart(config) { return this.call('POST', '/restart', config ? { config } : {}); }
  activity() { return this.call('GET', '/activity'); }
  viewModels() { return this.call('GET', '/view-models'); }
  fragments() { return this.call('GET', '/fragments'); }
  inspect(handle, options = {}) { return this.call('POST', '/inspect', { handle, options }); }
  field(handle, path, options = {}) { return this.call('POST', '/field', { handle, path, options }); }
  methods(query) { return this.call('GET', `/methods?query=${encodeURIComponent(query)}`); }
  logcat(query = {}) { return this.call('GET', `/logcat?${new URLSearchParams(query)}`); }
  network(query = {}) { return this.call('GET', `/network?${new URLSearchParams(query)}`); }
  diagnostic() { return this.call('GET', '/diagnostic'); }
  screenState() { return this.call('GET', '/screen-state'); }
  permissionRequests() { return this.call('GET', '/permission-requests'); }
  answerPermission(id, answer) { return this.call('POST', `/permission-requests/${encodeURIComponent(id)}`, { answer }); }
  clearAppData() { return this.call('POST', '/app-data/clear', {}); }
  setPlugins(plugins) { return this.call('PUT', '/plugins', { plugins }); }
  plugins() { return this.call('GET', '/plugins'); }
  plugin(id) { return this.call('GET', `/plugins/${encodeURIComponent(id)}`); }
  pluginImage(path) { return this.http.bytes(`${this.base}/${path}`); }
  streamLogcat(onLine) { return this.http.stream(`${this.base}/logcat/stream`, ({ event, data }) => event === 'log' && onLine(data)); }
  streamNetwork(onRequest) { return this.http.stream(`${this.base}/network/stream`, ({ event, data }) => event === 'request' && onRequest(data)); }
  streamEvents(onEvent) { return this.http.stream(`${this.base}/events`, onEvent); }
  streamPlugins(onOutput) { return this.http.stream(`${this.base}/plugins/stream`, ({ event, data }) => event === 'plugin' && onOutput(data)); }
  close() { return this.call('DELETE'); }
}

export class RunnerClient {
  constructor(options) { this.http = new Http(options); }
  health() { return this.http.request('GET', '/health'); }
  sessions() { return this.http.request('GET', '/sessions'); }
  session(id) { return new Session(this.http, `/sessions/${encodeURIComponent(id)}`, { id }); }
  /** Uploads the APK with its session config; resolves once the APK is loaded (and launched when config.launch). */
  async createSession(apk, config = {}) {
    const created = await this.http.request('POST', '/sessions', { body: apk, headers: { 'content-type': 'application/vnd.android.package-archive', 'x-apk-config': Buffer.from(JSON.stringify(config)).toString('base64url') } });
    const session = new Session(this.http, `/sessions/${encodeURIComponent(created.session.id)}`, created.session);
    session.created = created; return session;
  }
}

export class QueueClient {
  constructor(options) { this.http = new Http(options); }
  health() { return this.http.request('GET', '/health'); }
  stats() { return this.http.request('GET', '/stats'); }
  submitJob(apk, job = {}) { return this.http.request('POST', '/jobs', { body: apk, headers: { 'content-type': 'application/vnd.android.package-archive', 'x-job': Buffer.from(JSON.stringify(job)).toString('base64url') } }); }
  job(id) { return this.http.request('GET', `/jobs/${encodeURIComponent(id)}`); }
  jobs(state) { return this.http.request('GET', `/jobs${state ? `?state=${state}` : ''}`); }
  cancelJob(id) { return this.http.request('DELETE', `/jobs/${encodeURIComponent(id)}`); }
  artifact(job, name) { return this.http.bytes(`/jobs/${encodeURIComponent(job.id ?? job)}/artifacts/${encodeURIComponent(name)}`); }
  jobEvents(id, onEvent) { return this.http.stream(`/jobs/${encodeURIComponent(id)}/events`, onEvent); }
  /** Polls until the job ends; resolves with the final job. */
  async waitJob(id, { intervalMs = 500, timeoutMs = 15 * 60 * 1000 } = {}) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { const job = await this.job(id); if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job; await new Promise(resolve => setTimeout(resolve, intervalMs)); }
    throw new Error(`job ${id} still running after ${timeoutMs} ms`);
  }
  /** Requests an interactive session; resolves when it is active with { lease, session } (session talks to the runner through the queue). */
  async lease(apk, spec = {}, { intervalMs = 300, timeoutMs = 10 * 60 * 1000 } = {}) {
    const created = await this.http.request('POST', '/leases', { body: apk, headers: { 'content-type': 'application/vnd.android.package-archive', 'x-job': Buffer.from(JSON.stringify(spec)).toString('base64url') } });
    const end = Date.now() + timeoutMs; let lease = created;
    while (lease.state === 'queued' || lease.state === 'assigned') { if (Date.now() > end) throw new Error('lease not granted in time'); await new Promise(resolve => setTimeout(resolve, intervalMs)); lease = await this.http.request('GET', `/leases/${lease.id}`); }
    if (lease.state !== 'active') throw new ApiError(409, { error: lease.error ?? { message: `lease ${lease.state}` } });
    return { lease, session: new Session(this.http, `/leases/${encodeURIComponent(lease.id)}/session`, lease.session), release: () => this.http.request('DELETE', `/leases/${encodeURIComponent(lease.id)}`), extend: seconds => this.http.request('POST', `/leases/${lease.id}/extend`, { json: { seconds } }) };
  }
}
