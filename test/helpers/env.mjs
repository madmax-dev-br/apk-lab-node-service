// Test environment: the runtime (APK_LAB_RUNTIME_DIR or vendor/apk-lab) and the synthetic test APKs (APK_LAB_TEST_APK_DIR). Tests that need them skip when absent.
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectRuntime, runtimeDirFromEnv } from '../../lib/runtime-dir.mjs';

export const runtime = inspectRuntime(runtimeDirFromEnv());
export const runtimeSkip = runtime.ok ? false : `no APK Web Lab runtime (set APK_LAB_RUNTIME_DIR or run npm run fetch-runtime)`;
export const apkDir = process.env.APK_LAB_TEST_APK_DIR ? path.resolve(process.env.APK_LAB_TEST_APK_DIR) : null;
export const apkPath = name => apkDir ? path.join(apkDir, name) : null;
export const apkSkip = (...names) => runtimeSkip || (!apkDir ? 'APK_LAB_TEST_APK_DIR not set' : names.find(name => !existsSync(apkPath(name))) ? `test APK missing: ${names.find(name => !existsSync(apkPath(name)))}` : false);
export const tempDir = prefix => mkdtempSync(path.join(tmpdir(), `apk-lab-${prefix}-`));
export const silent = () => {};
/** A minimal valid ZIP (empty archive) the services accept as an "APK" file for validation paths that never reach the VM. */
export const EMPTY_ZIP = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
