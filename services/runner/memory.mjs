// The VM's memory budget on a server, made equal to the site's for a visitor on the same machine.
// With memory "automatic" (config.memoryMiB 0) the lab's heapLimitFor (memory-budget.js of the bundle) follows navigator.deviceMemory, which a browser reports and Node
// does not have; without it the VM falls back to 262,144 objects. The VM Worker shim (vm-worker.mjs) therefore defines navigator.deviceMemory as Chrome would on this
// machine: the RAM in GiB rounded down to a power of two, clamped to [0.25, 8]. A server with 8 GiB or more gets the site's 1024 MiB budget (671,088 objects).
import os from 'node:os';

const GiB = 1024 * 1024 * 1024;

/** navigator.deviceMemory for a machine with `totalBytes` of RAM: GiB rounded down to a power of two, clamped to [0.25, 8]. */
export function deviceMemoryFor(totalBytes) {
  const gib = Number(totalBytes) / GiB;
  if (!Number.isFinite(gib) || gib <= 0) return null;
  return Math.min(8, Math.max(0.25, 2 ** Math.floor(Math.log2(gib))));
}
/** The RAM this process may use: os.totalmem(), or the cgroup limit (process.constrainedMemory) when a container sets a smaller one. */
export function machineMemoryBytes() {
  const total = os.totalmem(), constrained = Number(globalThis.process?.constrainedMemory?.() ?? 0);
  return constrained > 0 && constrained < total ? constrained : total;
}
export const hostDeviceMemory = () => deviceMemoryFor(machineMemoryBytes());

/** { budgetMiB, maxHeapObjects, source, deviceMemory } of a session: a chosen memoryMiB step wins, else the device-memory rule (the bundle's memoryBudget). */
export function memoryReport(memoryBudget, { memoryMiB = 0, deviceMemory = hostDeviceMemory() } = {}) {
  const step = Number(memoryMiB) > 0 ? Number(memoryMiB) : null;
  const budget = memoryBudget(step ? { override: step } : { deviceMemory });
  return { budgetMiB: budget.budgetMiB, maxHeapObjects: budget.maxHeapObjects, source: budget.source, deviceMemory: step ? null : deviceMemory };
}
/** JS heap (MB) of the VM Worker for a Java heap budget: twice the budget plus 1 GiB for the framework, resources and Skia, at least `vmHeapMb`, at most `vmHeapMaxMb`. */
export function workerHeapMb(budgetMiB, { vmHeapMb, vmHeapMaxMb }) {
  return Math.min(vmHeapMaxMb, Math.max(vmHeapMb, Math.ceil(budgetMiB) * 2 + 1024));
}
