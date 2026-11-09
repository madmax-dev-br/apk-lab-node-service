#!/usr/bin/env node
// Downloads the pinned APK Web Lab runtime (runtime.lock.json: a commit of the public site repository) into vendor/apk-lab and checks the SHA-256 of every file.
//   npm run fetch-runtime                      download from raw.githubusercontent.com at the pinned commit
//   npm run fetch-runtime -- --from <dir>      copy from a local checkout of the public site (or a built dist/), still verified against the lock
//   npm run fetch-runtime -- --verify          only verify an existing vendor/apk-lab
//   options: --dest <dir> (default vendor/apk-lab), --concurrency <n> (default 8)
import { readFile, writeFile, mkdir, rm, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : null; };
const lock = JSON.parse(await readFile(path.join(ROOT, 'runtime.lock.json'), 'utf8'));
const dest = path.resolve(option('--dest') ?? path.join(ROOT, 'vendor', 'apk-lab')), from = option('--from'), concurrency = Math.max(1, Math.min(32, Number(option('--concurrency')) || 8));
const entries = Object.entries(lock.files);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const safe = file => { const resolved = path.resolve(dest, file); if (!resolved.startsWith(dest + path.sep)) throw new Error(`unsafe path in lock: ${file}`); return file; };

async function verify(dir) {
  const bad = [];
  for (const [file, expected] of entries) { try { const bytes = await readFile(path.join(dir, safe(file))); if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) bad.push(file); } catch { bad.push(file); } }
  return bad;
}
if (args.includes('--verify')) {
  const bad = await verify(dest);
  if (bad.length) { console.error(`${bad.length} file(s) missing or different in ${dest}: ${bad.slice(0, 10).join(', ')}${bad.length > 10 ? ', ...' : ''}`); process.exit(1); }
  console.log(`vendor runtime OK: revision ${lock.source.revision}, ${entries.length} files verified`); process.exit(0);
}
try { const current = JSON.parse(await readFile(path.join(dest, 'build-info.json'), 'utf8')); if (current.revision === lock.source.revision && !args.includes('--force') && !(await verify(dest)).length) { console.log(`vendor/apk-lab already holds revision ${lock.source.revision} (all ${entries.length} files verified)`); process.exit(0); } } catch { /* not there yet */ }

const temp = `${dest}.download`; await rm(temp, { recursive: true, force: true });
let done = 0, bytesDone = 0; const total = entries.reduce((sum, [, entry]) => sum + entry.bytes, 0);
async function fetchOne(file, expected) {
  let bytes;
  if (from) bytes = await readFile(path.join(path.resolve(from), file));
  else {
    let lastError;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const response = await fetch(`${lock.source.raw}${file.split('/').map(encodeURIComponent).join('/')}`, { signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer()); break;
      } catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 500 * attempt)); }
    }
    if (!bytes) throw new Error(`${file}: ${lastError?.message}`);
  }
  if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error(`${file}: checksum mismatch (expected ${expected.sha256}, got ${sha256(bytes)})`);
  const target = path.join(temp, safe(file)); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
  done++; bytesDone += bytes.length;
  if (done % 50 === 0 || done === entries.length) process.stdout.write(`  ${done}/${entries.length} files, ${(bytesDone / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MiB\n`);
}
console.log(`Fetching APK Web Lab runtime ${lock.source.revision} (${lock.source.repository} @ ${lock.source.commit.slice(0, 12)}) ${from ? `from ${from}` : 'from GitHub'} ...`);
const pending = [...entries]; let failure = null;
await Promise.all(Array.from({ length: concurrency }, async () => { while (pending.length && !failure) { const [file, expected] = pending.shift(); try { await fetchOne(file, expected); } catch (error) { failure = error; } } }));
if (failure) { await rm(temp, { recursive: true, force: true }); console.error(`fetch-runtime failed: ${failure.message}`); process.exit(1); }
await writeFile(path.join(temp, 'RUNTIME-LOCK.json'), JSON.stringify(lock.source, null, 2) + '\n');
await rm(dest, { recursive: true, force: true }); await mkdir(path.dirname(dest), { recursive: true }); await rename(temp, dest);
console.log(`Runtime ${lock.source.revision} installed in ${path.relative(ROOT, dest) || dest} (${entries.length} files, ${(total / 1048576).toFixed(1)} MiB, all SHA-256 verified).`);

