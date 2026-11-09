#!/usr/bin/env node
// Submits a job to the queue and saves its artifacts.
//   QUEUE=http://127.0.0.1:8080 QUEUE_TOKEN=... node examples/run-job.mjs app.apk job.json out/
// job.json example:
//   { "steps": [ { "type": "launch" }, { "type": "wait", "selector": { "textContains": "Bem-vindo" } }, { "type": "screenshot", "name": "inicio" } ],
//     "collect": { "logcat": true, "network": true } }
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { QueueClient } from './apk-lab-client.mjs';

const [apkFile, jobFile, outDir = 'job-output'] = process.argv.slice(2);
if (!apkFile) { console.error('usage: run-job.mjs <app.apk> [job.json] [output dir]'); process.exit(2); }
const queue = new QueueClient({ url: process.env.QUEUE ?? 'http://127.0.0.1:8080', token: process.env.QUEUE_TOKEN });
const job = jobFile ? JSON.parse(await readFile(jobFile, 'utf8')) : { steps: [{ type: 'launch' }, { type: 'waitReady' }, { type: 'screenshot', name: 'tela', waitReady: true }], collect: { logcat: true } };
const submitted = await queue.submitJob(await readFile(apkFile), job);
console.log(`job ${submitted.id} queued (position ${submitted.position})`);
const progress = queue.jobEvents(submitted.id, ({ event, data }) => { if (event === 'step-finished') console.log(`  step ${data.index}: ${data.ok ? 'ok' : `failed: ${data.error?.message}`} (${data.ms} ms)`); else if (event !== 'end') console.log(`  ${event}`); });
const done = await queue.waitJob(submitted.id);
progress.stop();
await mkdir(outDir, { recursive: true });
for (const artifact of done.result?.artifacts ?? []) { await writeFile(path.join(outDir, artifact.name), await queue.artifact(done, artifact.name)); console.log(`  saved ${path.join(outDir, artifact.name)} (${artifact.bytes} bytes)`); }
await writeFile(path.join(outDir, 'job.json'), JSON.stringify(done, null, 2));
console.log(`job ${done.state}${done.error ? `: ${done.error.message}` : ''}`);
process.exit(done.state === 'succeeded' ? 0 : 1);
