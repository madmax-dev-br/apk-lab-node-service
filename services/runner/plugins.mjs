// Server-side plugins: the site's own plugin host (plugin-host.js createPluginHost) driven by a session, with each plugin in a memory-limited worker_threads Worker
// (plugin-worker.mjs) watched for CPU: a plugin whose thread stays busy for longer than `busySeconds` is terminated and reported, like the site's "Parar".
import { Worker } from 'node:worker_threads';

const PLUGIN_WORKER_URL = new URL('./plugin-worker.mjs', import.meta.url);

export function createServerPluginHost({ bundle, vm, limits, captureImage, getPackage, onLogStreaming, onChange, log = () => {} }) {
  const watchdogs = new Set();
  function createWorker(name) {
    const thread = new Worker(PLUGIN_WORKER_URL, { workerData: { source: bundle.pluginWorkerSource() }, env: {}, argv: [], execArgv: [], stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: limits.heapMb, maxYoungGenerationSizeMb: Math.max(4, Math.round(limits.heapMb / 4)), codeRangeSizeMb: 16, stackSizeMb: 4 }, name: `plugin:${String(name).slice(0, 40)}` });
    thread.stdout?.resume(); thread.stderr?.resume();   // a plugin's own stdout/stderr never reaches the runner's logs
    const adapter = { onmessage: null, onerror: null, onmessageerror: null, terminated: false,
      postMessage(data) { if (!adapter.terminated) thread.postMessage(data); },
      terminate() { if (adapter.terminated) return; adapter.terminated = true; stop(); thread.terminate().catch(() => {}); } };
    thread.on('message', data => adapter.onmessage?.({ data }));
    thread.on('error', error => { if (!adapter.terminated) adapter.onerror?.({ message: /ERR_WORKER_OUT_OF_MEMORY/.test(error?.code ?? '') ? `memória do plugin esgotada (limite ${limits.heapMb} MiB)` : String(error?.message ?? error), preventDefault() {} }); });
    thread.on('exit', () => { if (!adapter.terminated) { adapter.terminated = true; stop(); adapter.onerror?.({ message: 'o Worker do plugin terminou', preventDefault() {} }); } });
    // CPU watchdog: the worker's event-loop utilization, read from this thread without the plugin's cooperation.
    let last = thread.performance.eventLoopUtilization(), busyFor = 0, startedAt = Date.now();
    const timer = setInterval(() => {
      if (adapter.terminated) return;
      const now = thread.performance.eventLoopUtilization(), delta = thread.performance.eventLoopUtilization(now, last); last = now;
      busyFor = delta.utilization > 0.9 ? busyFor + 1 : 0;
      const runningSeconds = (Date.now() - startedAt) / 1000;
      const reason = busyFor >= limits.busySeconds ? `plugin ocupado (CPU) por mais de ${limits.busySeconds} s seguidos: encerrado` : limits.maxRunSeconds > 0 && runningSeconds > limits.maxRunSeconds ? `plugin rodou mais de ${limits.maxRunSeconds} s: encerrado` : null;
      if (reason) { log('warn', `plugin ${name}: ${reason}`); const onerror = adapter.onerror; adapter.terminated = true; stop(); thread.terminate().catch(() => {}); onerror?.({ message: reason, preventDefault() {} }); }
    }, 1000);
    timer.unref?.();
    const stop = () => { clearInterval(timer); watchdogs.delete(stop); };
    watchdogs.add(stop);
    return { worker: adapter, release: null };
  }
  const host = bundle.createPluginHost({ vm, createWorker, getPackage, onLogStreaming, onChange, captureImage });
  const imageStore = new Map();   // `${pluginId}:${blockIndex}` -> { bytes, type } of the last listing
  async function describe(plugin, { inlineImages = false } = {}) {
    const blocks = [];
    for (const [index, block] of (plugin.output?.blocks ?? []).entries()) {
      if (block.kind === 'image') {
        const bytes = Buffer.from(await block.blob.arrayBuffer()); imageStore.set(`${plugin.id}:${index}`, { bytes, type: block.blob.type });
        blocks.push({ id: block.id, kind: 'image', type: block.blob.type, bytes: bytes.length, width: block.width, height: block.height, caption: block.caption, path: `plugins/${encodeURIComponent(plugin.id)}/blocks/${index}/image`, ...(inlineImages ? { dataBase64: bytes.toString('base64') } : {}) });
      } else blocks.push(block);
    }
    return { id: plugin.id, name: plugin.name, enabled: plugin.enabled, status: plugin.status, reason: plugin.reason, badge: plugin.output?.badge ?? '', blocks,
      console: plugin.console, errors: plugin.errors, errorCount: plugin.errorCount, subscriptions: [...(plugin.subs ?? [])], stats: plugin.stats, startedAt: plugin.startedAt, finished: plugin.finished };
  }
  return {
    host,
    setPlugins: list => host.setPlugins(list),
    stop: id => host.stop(id), restart: id => host.restart(id),
    async list(options) { const out = []; for (const plugin of host.list()) out.push(await describe(plugin, options)); return out; },
    async get(id, options) { const plugin = host.get(id); return plugin ? describe(plugin, options) : null; },
    async image(id, index) { const plugin = host.get(id); if (!plugin) return null; await describe(plugin); return imageStore.get(`${id}:${index}`) ?? null; },
    dispose() { host.dispose(); for (const stop of [...watchdogs]) stop(); imageStore.clear(); },
  };
}
