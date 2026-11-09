#!/usr/bin/env node
// Repository hygiene for a public repository: no local home-directory paths, no Android binaries (APK/DEX/.so) or other bundled binaries, no obvious secrets,
// no oversized files. Runs on the files git tracks (or every file outside vendor/, data/ and node_modules/ when git is not available).
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let files;
try { files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean); }
catch { const walk = dir => readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => { const rel = dir ? `${dir}/${entry.name}` : entry.name; if (['.git', 'vendor', 'data', 'node_modules'].includes(rel)) return []; return entry.isDirectory() ? walk(rel) : [rel]; }); files = walk(''); }
const BINARY = /\.(apk|aab|dex|so|jar|wasm|zip|class|keystore|jks|p12)$/i;
const sep = '/';
const HOME = new RegExp(['', 'Users', '[A-Za-z0-9._-]+', ''].join(`\\${sep}`) + '|' + ['', 'home', '[A-Za-z0-9._-]+', ''].join(`\\${sep}`) + '|C:\\\\Users\\\\|' + ['', 'private', 'tmp', ''].join(`\\${sep}`) + '|scratch' + 'pad');
const SECRET = new RegExp(['gh' + 'p_[A-Za-z0-9]{20,}', 'AKI' + 'A[0-9A-Z]{16}', '-----BEGIN ' + '(?:RSA |EC |OPENSSH )?PRIVATE KEY', 'xox' + '[baprs]-[A-Za-z0-9-]{10,}'].join('|'));
const problems = [];
for (const file of files) {
  if (BINARY.test(file)) { problems.push(`${file}: binary/Android artifact must not be committed`); continue; }
  let size; try { size = statSync(path.join(root, file)).size; } catch { continue; }
  if (size > 512 * 1024 && file !== 'runtime.lock.json') problems.push(`${file}: ${size} bytes (larger than 512 KiB)`);
  const text = readFileSync(path.join(root, file), 'utf8');
  const home = HOME.exec(text); if (home) problems.push(`${file}: local path "${home[0]}"`);
  const secret = SECRET.exec(text); if (secret) problems.push(`${file}: looks like a secret (${secret[0].slice(0, 12)}...)`);
}
if (problems.length) { console.error(`check-repo: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`); process.exit(1); }
console.log(`check-repo: ${files.length} files OK (no local paths, binaries or secrets)`);
