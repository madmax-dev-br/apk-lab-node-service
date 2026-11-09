import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime, runtimeSkip, silent } from '../helpers/env.mjs';
import { validatePlugins } from '../../services/runner/config.mjs';

test('plugins are refused unless the operator enabled them', () => {
  const policy = { pluginsAllowed: false, maxPlugins: 4, maxPluginCodeBytes: 1024 };
  assert.deepEqual(validatePlugins([], policy), []);
  assert.throws(() => validatePlugins([{ code: 'lab.ui.text(1)' }], policy), error => error.status === 403 && error.code === 'plugins-disabled');
  const allowed = { ...policy, pluginsAllowed: true };
  assert.equal(validatePlugins([{ id: 'a', code: 'x' }], allowed)[0].enabled, true);
  assert.throws(() => validatePlugins([{ id: 'a', code: 'x' }, { id: 'a', code: 'y' }], allowed), /unique/);
  assert.throws(() => validatePlugins([{ code: 'x'.repeat(2000) }], allowed), /larger than/);
  assert.throws(() => validatePlugins(Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, code: 'x' })), allowed), /at most 4/);
});

test('plugin sandbox: no process/require/fetch/import, CPU watchdog, memory limit', { skip: runtimeSkip, timeout: 60000 }, async () => {
  const { loadBundle } = await import('../../services/runner/bundle.mjs');
  const { createServerPluginHost } = await import('../../services/runner/plugins.mjs');
  const bundle = await loadBundle(runtime.dir);
  const host = createServerPluginHost({ bundle, vm: null, limits: { heapMb: 32, busySeconds: 2, maxRunSeconds: 0 }, captureImage: null, getPackage: () => null, onLogStreaming: () => {}, onChange: () => {}, log: silent });
  const wait = async (id, predicate, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const out = await host.get(id); if (predicate(out)) return out; await new Promise(resolve => setTimeout(resolve, 100)); } return host.get(id); };
  try {
    host.setPlugins([
      { id: 'caps', name: 'caps', enabled: true, code: `
        let dynamicImport = 'blocked'; try { await import('node:fs'); dynamicImport = 'allowed'; } catch {}
        let escape = 'blocked'; try { const reply = await lab.screen(); escape = [lab.screen.constructor.constructor('return typeof process')(), reply.constructor.constructor('return typeof process')(), self.postMessage.constructor.constructor('return typeof process')()].join(','); } catch (error) { escape = 'error ' + error.message; }
        lab.ui.kv({ process: typeof process, require: typeof require, fetch: typeof fetch, dynamicImport, escape }, { id: 'caps' });
        lab.ui.text(JSON.stringify(await lab.screen()), { id: 'screen' });` },
      { id: 'spin', name: 'spin', enabled: true, code: 'while (true) {}' },
      { id: 'hog', name: 'hog', enabled: true, code: 'const keep = []; while (true) keep.push(new Array(1e5).fill(Math.random()));' },
    ]);
    const caps = await wait('caps', out => out.blocks.length >= 2);
    const kv = Object.fromEntries(caps.blocks.find(block => block.id === 'caps').entries);
    assert.deepEqual({ process: kv.process, require: kv.require, fetch: kv.fetch, dynamicImport: kv.dynamicImport }, { process: 'undefined', require: 'undefined', fetch: 'undefined', dynamicImport: 'blocked' });
    assert.equal(kv.escape, 'undefined,undefined,undefined', 'functions and replies handed to the plugin belong to its own realm');
    assert.match(caps.blocks.find(block => block.id === 'screen').text, /"activity":null/);
    const spin = await wait('spin', out => out.status === 'erro');
    assert.equal(spin.status, 'erro'); assert.match(spin.errors.at(-1).message, /CPU/);
    const hog = await wait('hog', out => out.status === 'erro');
    assert.equal(hog.status, 'erro'); assert.match(hog.errors.at(-1).message, /memória|memory|CPU/);
  } finally { host.dispose(); }
});
