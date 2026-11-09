// One server-side plugin: a worker_threads Worker (memory-limited, empty environment) that runs the site's plugin runtime (plugin-runtime.js pluginWorkerSource(), passed in
// workerData) inside a node:vm context holding only timers, console and the message bridge. The plugin's code arrives in the 'start' message exactly as on the site and
// sees the same `lab` API. node:vm and worker_threads are NOT a security boundary (see README, "Segurança"): this only removes the obvious capabilities (process, require,
// import(), fetch, the runner's environment), keeps objects of this realm out of the plugin's reach (messages enter the context as JSON text) and bounds memory and CPU.
// Plugin submission must stay limited to trusted users.
import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

const context = vm.createContext(Object.create(null), { name: 'apk-lab-plugin', codeGeneration: { strings: true, wasm: false } });
const blobs = new Map(); let nextBlob = 0;
// Blobs (lab.screenshot images) stay here; the plugin holds { __blob, type, size } and gets them back into its ui.image ops on the way out.
const encode = value => JSON.stringify(value, (key, item) => { if (item instanceof Blob) { const id = ++nextBlob; blobs.set(id, item); if (blobs.size > 64) blobs.delete(blobs.keys().next().value); return { __blob: id, type: item.type, size: item.size }; } return typeof item === 'bigint' ? String(item) : item; });
const restore = message => {
  if (message?.t === 'ui' && Array.isArray(message.ops)) return { ...message, ops: message.ops.map(op => op?.op === 'image' && op.blob && typeof op.blob === 'object' && blobs.has(op.blob.__blob) ? { ...op, blob: blobs.get(op.blob.__blob) } : op) };
  return message;
};
const bridge = {
  post: text => parentPort.postMessage(restore(JSON.parse(text))),
  setTimeout: (fn, ms) => setTimeout(fn, Math.max(0, Math.min(2147483647, Number(ms) || 0))),
  setInterval: (fn, ms) => setInterval(fn, Math.max(10, Math.min(2147483647, Number(ms) || 0))),
  clearTimeout: id => clearTimeout(id), clearInterval: id => clearInterval(id),
};
// Inside the context: the Worker-like global the plugin runtime expects. Only strings and numbers cross the bridge; timer handles are numbers.
const install = vm.runInContext(`(bridge) => {
  const g = globalThis, listeners = { error: [], unhandledrejection: [] }, timers = new Map(); let nextTimer = 0;
  const post = bridge.post, setT = bridge.setTimeout, setI = bridge.setInterval, clearT = bridge.clearTimeout, clearI = bridge.clearInterval;
  g.self = g;
  g.postMessage = message => post(JSON.stringify(message, (key, item) => typeof item === 'bigint' ? String(item) : item));
  g.setTimeout = (fn, ms) => { const id = ++nextTimer; timers.set(id, setT(() => { timers.delete(id); fn(); }, ms)); return id; };
  g.setInterval = (fn, ms) => { const id = ++nextTimer; timers.set(id, setI(() => fn(), ms)); return id; };
  g.clearTimeout = id => { const handle = timers.get(id); if (handle !== undefined) { clearT(handle); timers.delete(id); } };
  g.clearInterval = id => { const handle = timers.get(id); if (handle !== undefined) { clearI(handle); timers.delete(id); } };
  g.addEventListener = (type, fn) => { if (listeners[type]) listeners[type].push(fn); };
  g.console = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  return {
    deliver: text => g.onmessage && g.onmessage({ data: JSON.parse(text) }),
    fail: (type, text) => { const info = JSON.parse(text), error = Object.assign(new Error(info.message), { stack: info.stack }); for (const fn of listeners[type] ?? []) fn(type === 'error' ? { error, message: info.message, preventDefault() {} } : { reason: error, preventDefault() {} }); },
  };
}`, context)(bridge);
vm.runInContext(workerData.source, context, { filename: 'plugin-runtime.js', timeout: 5000 });
const describe = error => JSON.stringify({ message: String(error?.message ?? error), stack: String(error?.stack ?? '') });
process.on('unhandledRejection', reason => { try { install.fail('unhandledrejection', describe(reason)); } catch { /* ignore */ } });
process.on('uncaughtException', error => { try { install.fail('error', describe(error)); } catch { /* ignore */ } });
parentPort.on('message', data => { try { install.deliver(encode(data)); } catch (error) { try { install.fail('error', describe(error)); } catch { /* ignore */ } } });
