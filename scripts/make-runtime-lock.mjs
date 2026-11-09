#!/usr/bin/env node
// Maintainer tool: writes runtime.lock.json from a checkout of the public site repository at a given commit. The lock pins the runtime this service uses:
// the commit of the public site repository, the bundle revision (build-info.json) and the SHA-256 of every file `npm run fetch-runtime` downloads.
//   node scripts/make-runtime-lock.mjs <site checkout> --repo madmax-dev-br/apk-browser-lab-site --commit <full sha>
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : null; };
const site = args.find((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'));
const repo = option('--repo') ?? 'madmax-dev-br/apk-browser-lab-site', commit = option('--commit');
if (!site || !/^[0-9a-f]{40}$/.test(commit ?? '')) { console.error('usage: make-runtime-lock.mjs <site checkout> --commit <40-hex sha> [--repo owner/name]'); process.exit(2); }
const root = path.resolve(site);
// Whole directories the Worker loads assets from (and their licenses), plus the page modules this service imports and their imports.
const DIRECTORIES = ['runtime', 'framework-aosp', 'framework-resources', 'vendor', 'fonts', 'licenses'];
const FILES = ['build-info.json', 'THIRD_PARTY.md'];
const { BUNDLE_ENTRY_POINTS } = await import(new URL('../services/runner/bundle.mjs', import.meta.url));
const files = new Set(FILES);
async function walk(dir) { for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) { const rel = `${dir}/${entry.name}`; if (entry.isDirectory()) await walk(rel); else if (entry.isFile()) files.add(rel); } }
for (const dir of DIRECTORIES) await walk(dir);
const queue = BUNDLE_ENTRY_POINTS.filter(file => !file.startsWith('runtime/')), visited = new Set();
while (queue.length) {
  const file = queue.shift(); if (visited.has(file)) continue; visited.add(file); files.add(file);
  const text = await readFile(path.join(root, file), 'utf8');
  for (const [, dependency] of text.matchAll(/(?:from\s+|import\s*\(\s*)['"]\.\/([\w.-]+\.js)(?:\?v=\w+)?['"]/g)) if (!visited.has(dependency)) queue.push(dependency);
}
const revision = JSON.parse(await readFile(path.join(root, 'build-info.json'), 'utf8')).revision;
const entries = {};
for (const file of [...files].sort()) { const bytes = await readFile(path.join(root, file)); entries[file] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: (await stat(path.join(root, file))).size }; }
const lock = { format: 1, source: { repository: `https://github.com/${repo}`, commit, revision, site: `https://${repo.split('/')[0]}.github.io/${repo.split('/')[1]}/`, raw: `https://raw.githubusercontent.com/${repo}/${commit}/` }, files: entries };
const target = fileURLToPath(new URL('../runtime.lock.json', import.meta.url));
await writeFile(target, JSON.stringify(lock, null, 1) + '\n');
const total = Object.values(entries).reduce((sum, entry) => sum + entry.bytes, 0);
console.log(`runtime.lock.json: revision ${revision}, commit ${commit}, ${Object.keys(entries).length} files, ${(total / 1048576).toFixed(1)} MiB`);
