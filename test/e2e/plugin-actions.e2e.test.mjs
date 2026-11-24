// The actions of a plugin sent through the API (lab.invoke, lab.mock, lab.scrollToPercent, lab.reload), end to end on the synthetic Compose example.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { apkPath, apkSkip } from '../helpers/env.mjs';

const COMPOSE = 'compose-approvals-debug.apk';
const PLUGIN = `
  const out = {};
  const run = async (key, fn) => { try { out[key] = await fn(); } catch (error) { out[key] = 'error ' + error.code; } };
  const tela = await lab.activity();
  await run('pacote', async () => (await lab.invoke(tela.handle, 'getPackageName', [], { signature: '()Ljava/lang/String;' })).value);
  await run('abs', async () => (await lab.invoke({ static: 'java.lang.Math' }, 'abs', [-5], { signature: '(I)I' })).value);
  await run('excecao', () => lab.invoke({ static: 'java.lang.Integer' }, 'parseInt', ['x'], { signature: '(Ljava/lang/String;)I' }));
  await run('semMetodo', () => lab.invoke(tela.handle, 'naoExiste'));
  const mock = await lab.mock({ method: 'GET', url: 'https://api.example.com/v1/x', body: { a: 1 } });
  await run('mocks', async () => (await lab.mocks()).length);
  await run('removido', async () => (await lab.unmock(mock.id)).removed);
  await run('rolagem', async () => (await lab.scrollToPercent(100)).percentY);
  await run('recarregar', async () => (await lab.reload('recreate')).mode);
  lab.ui.kv(out, { id: 'saida' });
`;

test("a plugin calls the app's methods and acts on the session", { skip: apkSkip(COMPOSE), timeout: 120000 }, async () => {
  const { startRunner } = await import('../helpers/runner.mjs');
  const r = await startRunner({ pluginsAllowed: true });
  try {
    // sent with the session, so it starts before the app is launched: its first action waits for the launch
    const early = { id: 'cedo', name: 'Cedo', code: "lab.ui.text(String((await lab.invoke({ static: 'java.lang.Math' }, 'abs', [-7], { signature: '(I)I' })).value), { id: 'v' });" };
    const created = await r.create(await readFile(apkPath(COMPOSE)), { launch: true, plugins: [early] }); assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.session.id;
    assert.equal((await r.api('POST', `/sessions/${id}/wait`, { json: { ready: true, timeoutMs: 30000 } })).body.ready, true);
    const output = async pid => { let out; for (let i = 0; i < 300; i++) { out = (await r.api('GET', `/sessions/${id}/plugins/${pid}`)).body; if (out?.blocks?.length || out?.errorCount) break; await new Promise(resolve => setTimeout(resolve, 100)); } assert.equal(out.errorCount ?? 0, 0, JSON.stringify(out.errors)); return out; };
    assert.equal((await output('cedo')).blocks[0].text, '7');
    const put = await r.api('PUT', `/sessions/${id}/plugins`, { json: [{ id: 'acoes', name: 'Acoes', code: PLUGIN }] }); assert.equal(put.status, 200, JSON.stringify(put.body));
    const entries = Object.fromEntries((await output('acoes')).blocks[0].entries.map(([key, value]) => [key, String(value)]));
    assert.deepEqual(entries, { pacote: 'dev.apkweb.approvals', abs: '5', excecao: 'error exception', semMetodo: 'error no-method', mocks: '1', removido: 'true', rolagem: '100', recarregar: 'recreate' });
    const session = (await r.api('GET', `/sessions/${id}`)).body; assert.equal((session.session ?? session).state, 'running');
  } finally { await r.close(); }
});
