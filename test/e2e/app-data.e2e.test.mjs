// App data persistence on the runner (RUNNER_APP_DATA_DIR): files the app writes survive into the next session of the same client namespace; clearData wipes them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { apkPath, apkSkip, tempDir } from '../helpers/env.mjs';

const APK = process.env.APP_DATA_APK ?? 'data-probe.apk';
const skip = apkSkip(APK);

test('keepData stores the app private files between sessions; clearData starts empty', { skip, timeout: 120000 }, async () => {
  const { startRunner } = await import('../helpers/runner.mjs');
  const r = await startRunner({ appDataDir: tempDir('app-data') });
  const bytes = await readFile(apkPath(APK)), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    const first = await r.create(bytes, { launch: true }); assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.session.appData.enabled, true, JSON.stringify(first.body.session.appData));
    let status; for (let i = 0; i < 50; i++) { status = (await r.api('GET', `/sessions/${first.body.session.id}`)).body.appData; if (status.files > 0) break; await sleep(100); }
    assert.ok(status.files > 0, `the app wrote private files: ${JSON.stringify(status)}`);
    await r.api('DELETE', `/sessions/${first.body.session.id}`); await sleep(300);
    const second = await r.create(bytes, {}); assert.ok(second.body.session.appData.restoredFiles > 0 || second.body.session.appData.files > 0, JSON.stringify(second.body.session.appData));
    await r.api('DELETE', `/sessions/${second.body.session.id}`);
    const other = await r.api('POST', '/sessions', { body: bytes, headers: { 'content-type': 'application/octet-stream', 'x-client-id': 'outro-cliente' } });
    assert.equal(other.body.session.appData.files, 0, 'another client namespace starts empty');
    await r.api('DELETE', `/sessions/${other.body.session.id}`);
    const cleared = await r.create(bytes, { appData: { clear: true } }); assert.equal(cleared.body.session.appData.files, 0);
    await r.api('DELETE', `/sessions/${cleared.body.session.id}`);
  } finally { await r.close(); }
});
