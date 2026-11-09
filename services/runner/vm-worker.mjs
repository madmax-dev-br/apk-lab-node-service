// Bootstrap of one VM session inside a Node worker_threads Worker. It gives the lab's browser Worker module (runtime/apk-worker.js of the public bundle) the Worker
// globals it uses -- self, postMessage, onmessage, addEventListener -- plus:
//   * fetch() and synchronous XMLHttpRequest for the bundle's own assets (file: URLs inside the runtime directory only: framework DEX, resources, wasm, fonts);
//     any other file: URL is refused. http(s) fetches go to Node's fetch behind the runner's private-network guard (net-guard.mjs; RUNNER_ALLOW_PRIVATE_NETWORK);
//   * the same guard in the bundle's network worker (runtime/network-worker.js, where the VM's HTTP exchanges run): worker_threads.Worker starts it through net-worker.mjs;
//   * navigator.deviceMemory as Chrome reports it on this machine (memory.mjs), so memory "automatic" gives the site's budget instead of the lab's fixed Node default;
//   * an optional file-backed IndexedDB subset for the app-data store (keepData) when the runner has RUNNER_APP_DATA_DIR.
// Nothing of the VM is reimplemented here: every message goes to the unmodified Worker code.
import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createGuardedFetch } from './net-guard.mjs';

const runtimeRoot = path.resolve(workerData.runtimeDir) + path.sep;
const TYPES = { '.wasm': 'application/wasm', '.json': 'application/json', '.js': 'text/javascript', '.mjs': 'text/javascript', '.gz': 'application/gzip', '.ttf': 'font/ttf', '.dat': 'application/octet-stream' };
const insideRuntime = url => { try { const file = path.resolve(fileURLToPath(url)); return file.startsWith(runtimeRoot) ? file : null; } catch { return null; } };
const allowPrivateNetwork = workerData.allowPrivateNetwork === true;
const nodeFetch = globalThis.fetch, guardedFetch = createGuardedFetch(nodeFetch, { allowPrivate: allowPrivateNetwork });
globalThis.fetch = async (input, init) => {
  const text = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? String(input);
  const url = new URL(text);
  if (url.protocol === 'file:') {
    const file = insideRuntime(url);
    if (!file) return new Response(null, { status: 403, statusText: 'outside the runtime directory' });
    try { const bytes = await readFile(file); return new Response(bytes, { status: 200, headers: { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'content-length': String(bytes.length) } }); }
    catch { return new Response(null, { status: 404 }); }
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? guardedFetch(input, init) : nodeFetch(input, init);
};
// The bundle's network worker (a nested worker_threads Worker) starts through net-worker.mjs, which installs the same guard before loading it.
const threads = globalThis.process.getBuiltinModule('node:worker_threads'), BaseWorker = threads.Worker, NET_WORKER_URL = new URL('./net-worker.mjs', import.meta.url);
threads.Worker = class GuardedWorker extends BaseWorker {
  constructor(url, options = {}) {
    const href = url instanceof URL ? url.href : String(url);
    let target = null; try { const parsed = new URL(href); if (/\/network-worker\.js$/.test(parsed.pathname) && insideRuntime(parsed)) target = href; } catch { /* not a URL */ }
    if (target) super(NET_WORKER_URL, { ...options, workerData: { target, allowPrivateNetwork } }); else super(url, options);
  }
};
// navigator.deviceMemory as Chrome would report it on this machine (the runner computes it: memory.mjs); the lab's heapLimitFor reads it for memory "automatic".
if (Number.isFinite(workerData.deviceMemory)) {
  if (globalThis.navigator) Object.defineProperty(globalThis.navigator, 'deviceMemory', { value: workerData.deviceMemory, configurable: true, enumerable: true });
  else globalThis.navigator = { deviceMemory: workerData.deviceMemory };
}
globalThis.XMLHttpRequest = class XMLHttpRequest {
  constructor() { this.status = 0; this.response = null; this.responseText = ''; this.responseType = ''; this.readyState = 0; }
  open(method, url, async = true) { if (async !== false) throw new Error('Only synchronous XMLHttpRequest for bundle assets is available in the Node VM Worker'); this.url = new URL(String(url)); this.method = method; this.readyState = 1; }
  overrideMimeType() {}
  setRequestHeader() {}
  send() {
    const file = this.url.protocol === 'file:' ? insideRuntime(this.url) : null;
    if (!file) { this.status = 403; this.readyState = 4; return; }
    try { const bytes = readFileSync(file); this.status = 200; this.response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
    catch { this.status = 404; this.response = null; }
    this.readyState = 4;
  }
};
if (workerData.appDataDir) {
  const { createFileIndexedDB } = await import('./idb-shim.mjs');
  globalThis.indexedDB = createFileIndexedDB(workerData.appDataDir);
}
globalThis.self = globalThis;
const listeners = new Map();
globalThis.addEventListener = (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); };
globalThis.removeEventListener = (type, fn) => listeners.get(type)?.delete(fn);
globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, Array.isArray(transfer) ? transfer.filter(item => item instanceof ArrayBuffer) : undefined);
globalThis.close = () => process.exit(0);
const deliver = data => {
  const event = { data };
  try { globalThis.onmessage?.(event); } catch (error) { parentPort.postMessage({ type: '__fatal', message: String(error?.stack ?? error) }); }
  for (const fn of listeners.get('message') ?? []) fn(event);
};
let early = [];   // messages that arrive while the Worker module graph is still loading
parentPort.on('message', data => { if (early) early.push(data); else deliver(data); });
await import(workerData.workerURL);
const queued = early; early = null; for (const data of queued) deliver(data);
parentPort.postMessage({ type: '__ready' });
