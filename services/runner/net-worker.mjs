// Bootstrap of the bundle's network worker (runtime/network-worker.js: the lab runs each HTTP exchange of the VM in a nested worker_threads Worker so a VM frame can wait
// for it synchronously). vm-worker.mjs starts this module in its place: it puts the runner's private-network guard (net-guard.mjs) in front of fetch, then loads the
// unmodified network worker, which keeps its own protocol with the VM Worker.
import { workerData } from 'node:worker_threads';
import { createGuardedFetch } from './net-guard.mjs';

globalThis.fetch = createGuardedFetch(globalThis.fetch, { allowPrivate: workerData?.allowPrivateNetwork === true });
await import(workerData.target);
