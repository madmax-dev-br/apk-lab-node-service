// The runner registry of the queue: a static list (QUEUE_RUNNERS), health-checked every few seconds, and a small HTTP client for the runner API.

export class RunnerError extends Error {
  constructor(message, { status = 0, code = 'runner-error', body = null, infrastructure = false, capacity = false } = {}) { super(message); Object.assign(this, { status, code, body, infrastructure, capacity }); }
}

/** "http://a:8081, http://b:8081|token-b" -> [{ id, url, token }] (a runner without its own token uses `defaultToken`). */
export function parseRunnerList(text, defaultToken = '') {
  return String(text ?? '').split(/[\s,]+/).map(item => item.trim()).filter(Boolean).map((item, index) => {
    const [url, token] = item.split('|');
    const parsed = new URL(url); if (!/^https?:$/.test(parsed.protocol)) throw new Error(`Runner URL must be http(s): ${url}`);
    return { id: `runner-${index + 1}`, url: parsed.href.replace(/\/$/, ''), token: token ?? defaultToken };
  });
}

export class RunnerClient {
  constructor({ id, url, token }, { timeoutMs = 60000 } = {}) { Object.assign(this, { id, url, token, timeoutMs }); this.healthy = false; this.available = 0; this.assignedSinceHealth = 0; this.lastHealth = null; this.lastError = null; this.lastAssignedAt = 0; }
  headers(extra = {}) { return { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...extra }; }
  async request(method, path, { body, headers = {}, timeoutMs = this.timeoutMs, raw = false, signal } = {}) {
    let response;
    const timeout = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    try { response = await fetch(`${this.url}${path}`, { method, headers: this.headers(headers), body, signal: combined, duplex: body && (typeof body.pipe === 'function' || typeof body.getReader === 'function') ? 'half' : undefined }); }
    catch (error) { if (signal?.aborted) throw new RunnerError('cancelled', { code: 'cancelled' }); throw new RunnerError(`runner ${this.id} unreachable: ${error?.cause?.code ?? error.message}`, { infrastructure: true, code: 'runner-unreachable' }); }
    if (raw) return response;
    const text = await response.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!response.ok) {
      const code = json?.error?.code ?? `http-${response.status}`, message = json?.error?.message ?? text.slice(0, 500);
      throw new RunnerError(`runner ${this.id}: ${response.status} ${message}`, { status: response.status, code, body: json, capacity: response.status === 503 && code === 'at-capacity', infrastructure: response.status >= 500 || code === 'vm-not-running' || json?.error?.details?.state === 'crashed' });
    }
    return json;
  }
  async health() {
    try {
      const health = await this.request('GET', '/health', { timeoutMs: 5000 });
      Object.assign(this, { healthy: health?.ok === true, available: Number(health?.available ?? 0), maxSessions: health?.maxSessions ?? null, pluginsAllowed: !!health?.pluginsAllowed, runtimeRevision: health?.runtimeRevision ?? null, lastHealth: Date.now(), lastError: null, assignedSinceHealth: 0 });
    } catch (error) { Object.assign(this, { healthy: false, available: 0, lastError: error.message, lastHealth: Date.now() }); }
    return this.describe();
  }
  describe() { return { id: this.id, url: this.url, healthy: this.healthy, available: this.available, maxSessions: this.maxSessions ?? null, pluginsAllowed: !!this.pluginsAllowed, runtimeRevision: this.runtimeRevision ?? null, lastHealth: this.lastHealth ? new Date(this.lastHealth).toISOString() : null, lastError: this.lastError }; }
  createSession(apk, config, { signal } = {}) {
    return this.request('POST', '/sessions', { body: apk, signal, headers: { 'content-type': 'application/vnd.android.package-archive', 'x-apk-config': Buffer.from(JSON.stringify(config ?? {})).toString('base64url') }, timeoutMs: 180000 });
  }
  session(id, method, path, body, { signal, timeoutMs } = {}) {
    return this.request(method, `/sessions/${encodeURIComponent(id)}${path}`, { body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'content-type': 'application/json' }, signal, timeoutMs });
  }
  async sessionBytes(id, path, { signal, timeoutMs } = {}) {
    const response = await this.request('GET', `/sessions/${encodeURIComponent(id)}${path}`, { raw: true, signal, ...(timeoutMs ? { timeoutMs } : {}) });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) { let json = null; try { json = JSON.parse(bytes.toString('utf8')); } catch { /* not JSON */ } throw new RunnerError(`runner ${this.id}: ${response.status} ${json?.error?.message ?? ''}`, { status: response.status, code: json?.error?.code ?? `http-${response.status}`, body: json, infrastructure: response.status >= 500 }); }
    return { bytes, type: response.headers.get('content-type'), notes: response.headers.get('x-screenshot-notes'), ready: response.headers.get('x-screen-ready') };
  }
  async deleteSession(id) { try { await this.request('DELETE', `/sessions/${encodeURIComponent(id)}`, { timeoutMs: 10000 }); } catch { /* already gone */ } }
}
