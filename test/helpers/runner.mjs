// Starts a real runner (needs the runtime) on a free port and gives a small API helper.
import { createRunner, runnerSettingsFromEnv } from '../../services/runner/app.mjs';
import { runtime, silent } from './env.mjs';

export const RUNNER_TOKEN = 'runner-test-token';
export async function startRunner(over = {}) {
  const settings = { ...runnerSettingsFromEnv(), host: '127.0.0.1', port: 0, token: RUNNER_TOKEN, authDisabled: false, runtimeDir: runtime.dir, maxSessions: 3, allowedHosts: ['127.0.0.1'], corsOrigins: [], pluginsAllowed: false, appDataDir: '', ...over };
  const runner = await createRunner(settings, { log: silent }); const address = await runner.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const api = async (method, path, { json, body, headers = {}, token = RUNNER_TOKEN } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: json !== undefined ? JSON.stringify(json) : body });
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, headers: response.headers, body: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  };
  const create = (apk, config = {}) => api('POST', '/sessions', { body: apk, headers: { 'content-type': 'application/vnd.android.package-archive', 'x-apk-config': JSON.stringify(config) } });
  return { runner, base, api, create, url: base, token: RUNNER_TOKEN, close: () => runner.close() };
}
/** { width, height } of a PNG, or null when the bytes are not a PNG. */
export function pngSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
/** Reads Server-Sent Events from a fetch Response until `until(events)` is true or `timeoutMs` passes. */
export async function readEvents(response, { until, timeoutMs = 10000 }) {
  const events = [], reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline && !until(events)) {
      const chunk = await Promise.race([reader.read(), new Promise(resolve => setTimeout(() => resolve({ timeout: true }), Math.max(1, deadline - Date.now())))]);
      if (chunk.timeout || chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let at; while ((at = buffer.indexOf('\n\n')) >= 0) { const block = buffer.slice(0, at); buffer = buffer.slice(at + 2); const event = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1]; if (event && data) events.push({ event, data: JSON.parse(data) }); }
    }
  } finally { reader.cancel().catch(() => {}); }
  return events;
}
