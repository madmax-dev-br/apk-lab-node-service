// Where the APK Web Lab runtime (the public built bundle) lives: APK_LAB_RUNTIME_DIR, else vendor/apk-lab (filled by `npm run fetch-runtime`).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_RUNTIME_DIR = path.join(REPO_ROOT, 'vendor', 'apk-lab');
const REQUIRED = ['build-info.json', 'apk-worker-client.js', 'runtime/apk-worker.js', 'plugin-host.js', 'compose-inspector-panel.js', 'vendor/canvaskit/0.42.0/canvaskit.mjs'];

export function runtimeDirFromEnv() {
  const configured = globalThis.process?.env?.APK_LAB_RUNTIME_DIR;
  return configured ? path.resolve(configured) : DEFAULT_RUNTIME_DIR;
}
/** { dir, revision, missing } for a candidate directory; missing lists the files the services need that are absent. */
export function inspectRuntime(dir = runtimeDirFromEnv()) {
  dir = path.resolve(dir ?? runtimeDirFromEnv());
  const missing = REQUIRED.filter(file => !existsSync(path.join(dir, file)));
  let revision = null; try { revision = JSON.parse(readFileSync(path.join(dir, 'build-info.json'), 'utf8')).revision ?? null; } catch { /* missing */ }
  return { dir, revision, missing, ok: missing.length === 0 && typeof revision === 'string' };
}
/** The runtime or a clear error naming what to do. */
export function requireRuntime(dir = runtimeDirFromEnv()) {
  const info = inspectRuntime(dir ?? runtimeDirFromEnv()); dir = info.dir;
  if (!info.ok) throw new Error(`APK Web Lab runtime not found or incomplete in ${dir} (missing: ${info.missing.join(', ') || 'build-info.json revision'}). Run "npm run fetch-runtime" or set APK_LAB_RUNTIME_DIR to a built dist/ directory.`);
  return info;
}
/** Imports one module of the bundle with the bundle's own ?v=<revision> suffix, so it shares instances with the bundle's internal imports. */
export function importRuntime(info, relative) {
  return import(`${pathToFileURL(path.join(info.dir, relative)).href}?v=${info.revision}`);
}
export const runtimeFileURL = (info, relative) => pathToFileURL(path.join(info.dir, relative));
