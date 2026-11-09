#!/usr/bin/env node
// Runner entry point: `npm run start:runner`. Configuration through environment variables (README).
import { createRunner, runnerSettingsFromEnv, defaultLog } from './app.mjs';

const settings = runnerSettingsFromEnv(), log = defaultLog(settings.logLevel);
let runner;
try { runner = await createRunner(settings, { log }); }
catch (error) { log('error', error.message); process.exit(1); }
const address = await runner.listen();
log('info', `apk-lab runner listening on http://${address.address}:${address.port} (runtime ${runner.bundle.info.revision}, max ${settings.maxSessions} sessions, plugins ${settings.pluginsAllowed ? 'ENABLED' : 'disabled'}, network allow list: ${settings.allowedHosts.join(', ') || 'none (mocks only)'})`);
const stop = async signal => { log('info', `${signal}: closing sessions`); await runner.close(); process.exit(0); };
process.on('SIGINT', () => stop('SIGINT')); process.on('SIGTERM', () => stop('SIGTERM'));
