#!/usr/bin/env node
// Queue entry point: `npm run start:queue`. Configuration through environment variables (README).
import { createQueue, queueSettingsFromEnv } from './app.mjs';
import { defaultLog } from '../runner/app.mjs';

let settings, queue;
try { settings = queueSettingsFromEnv(); }
catch (error) { console.error(error.message); process.exit(1); }
const log = defaultLog(settings.logLevel);
try { queue = await createQueue(settings, { log }); }
catch (error) { log('error', error.message); process.exit(1); }
const address = await queue.listen();
log('info', `apk-lab queue listening on http://${address.address}:${address.port} (${settings.runners.length} runner(s), store ${settings.store}, max ${settings.maxPerClient} per client)`);
if (!settings.runners.length) log('warn', 'QUEUE_RUNNERS is empty: jobs will wait until a runner is configured');
const stop = async signal => { log('info', `${signal}: stopping`); await queue.close(); process.exit(0); };
process.on('SIGINT', () => stop('SIGINT')); process.on('SIGTERM', () => stop('SIGTERM'));
