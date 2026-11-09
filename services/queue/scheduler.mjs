// The queue's scheduling rules, pure and synchronous (unit-tested without runners):
//   * a job is dispatchable while it is 'queued' and its client has fewer than maxPerClient jobs/leases holding a runner session;
//   * among dispatchable jobs: higher priority first; within a priority, the client with fewer running items first (fairness), then the oldest (FIFO);
//   * a job goes to the runner with the most free capacity (healthy runners only; ties: the least recently used).

export const PRIORITY_MIN = 0, PRIORITY_MAX = 9, DEFAULT_PRIORITY = 5;
export const ACTIVE_STATES = new Set(['assigned', 'running', 'active']);   // holding (or about to hold) a runner session
export const FINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'released']);

/** Counts of items holding a runner session, per client. */
export function runningByClient(items) {
  const counts = new Map();
  for (const item of items) if (ACTIVE_STATES.has(item.state)) counts.set(item.clientId, (counts.get(item.clientId) ?? 0) + 1);
  return counts;
}

/** The next queued item to dispatch, or null. `items`: every job/lease; `limits`: { maxPerClient, clientLimits?: Map(clientId -> n) }. */
export function pickNext(items, { maxPerClient, clientLimits = new Map() }) {
  const running = runningByClient(items);
  let best = null;
  for (const item of items) {
    if (item.state !== 'queued') continue;
    if (item.notBefore && item.notBefore > Date.now()) continue;
    const limit = clientLimits.get(item.clientId) ?? maxPerClient;
    if ((running.get(item.clientId) ?? 0) >= limit) continue;
    if (!best || compare(item, best, running) < 0) best = item;
  }
  return best;
}
function compare(a, b, running) {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const ra = running.get(a.clientId) ?? 0, rb = running.get(b.clientId) ?? 0;
  if (ra !== rb) return ra - rb;
  if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt - b.enqueuedAt;
  return a.seq - b.seq;
}

/** The runner for the next session: healthy, with free capacity (health minus what this queue assigned since that health report), most free first. */
export function pickRunner(runners) {
  let best = null;
  for (const runner of runners) {
    if (!runner.healthy) continue;
    const free = freeSlots(runner); if (free <= 0) continue;
    if (!best || free > freeSlots(best) || (free === freeSlots(best) && (runner.lastAssignedAt ?? 0) < (best.lastAssignedAt ?? 0))) best = runner;
  }
  return best;
}
export const freeSlots = runner => Math.max(0, (runner.available ?? 0) - (runner.assignedSinceHealth ?? 0));

/** Position of each queued item in dispatch order (1-based), for status responses. */
export function queuePositions(items) {
  const queued = items.filter(item => item.state === 'queued'), running = runningByClient(items), order = [];
  const simulated = new Map(running), remaining = new Set(queued);
  while (remaining.size) {
    let best = null;
    for (const item of remaining) if (!best || compare(item, best, simulated) < 0) best = item;
    remaining.delete(best); order.push(best);
    simulated.set(best.clientId, (simulated.get(best.clientId) ?? 0) + 1);
  }
  return new Map(order.map((item, index) => [item.id, index + 1]));
}

/** Retry decision after a failure: infrastructure failures (runner unreachable, runner 5xx, VM worker crash, capacity race) retry up to maxAttempts; app/step failures do not. */
export function retryDecision(item, failure, { maxAttempts }) {
  if (item.state === 'cancelled') return { retry: false };
  if (failure?.capacity) return { retry: true, countAttempt: false, delayMs: 2000 };
  if (failure?.infrastructure && item.attempts < (item.maxAttempts ?? maxAttempts)) return { retry: true, countAttempt: true, delayMs: Math.min(30000, 1000 * 2 ** Math.max(0, item.attempts - 1)) };
  return { retry: false };
}

/** Lease expiry: absolute (expiresAt) or idle (no proxied call for idleMs). */
export function leaseExpired(lease, now, { idleMs }) {
  if (lease.state !== 'active') return false;
  if (lease.expiresAt && now >= lease.expiresAt) return 'max-duration';
  if (idleMs && now - (lease.lastUsedAt ?? lease.startedAt ?? now) >= idleMs) return 'idle';
  return false;
}
