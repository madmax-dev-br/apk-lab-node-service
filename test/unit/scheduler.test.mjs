import test from 'node:test';
import assert from 'node:assert/strict';
import { pickNext, pickRunner, queuePositions, retryDecision, leaseExpired, runningByClient } from '../../services/queue/scheduler.mjs';

let seq = 0;
const item = (over = {}) => ({ id: `i${++seq}`, kind: 'job', clientId: 'a', state: 'queued', priority: 5, enqueuedAt: seq, seq, attempts: 0, ...over });

test('higher priority first, FIFO within a priority', () => {
  const low = item({ priority: 1 }), first = item(), second = item(), high = item({ priority: 9 });
  assert.equal(pickNext([low, first, second, high], { maxPerClient: 5 }).id, high.id);
  assert.equal(pickNext([low, second, first], { maxPerClient: 5 }).id, first.id);
});

test('per-client limit: a client at its limit waits, another client goes first', () => {
  const running = item({ clientId: 'a', state: 'running' }), a = item({ clientId: 'a' }), b = item({ clientId: 'b', enqueuedAt: 1e9 });
  assert.equal(pickNext([running, a, b], { maxPerClient: 1 }).id, b.id);
  assert.equal(pickNext([running, a], { maxPerClient: 1 }), null);
  assert.equal(pickNext([running, a], { maxPerClient: 1, clientLimits: new Map([['a', 2]]) }).id, a.id, 'a client-specific limit overrides the default');
});

test('fairness: within a priority the client with fewer running items is served first', () => {
  const r1 = item({ clientId: 'a', state: 'running' }), a = item({ clientId: 'a' }), b = item({ clientId: 'b' });
  assert.equal(pickNext([r1, a, b], { maxPerClient: 5 }).id, b.id);
  const positions = queuePositions([r1, a, b]);
  assert.equal(positions.get(b.id), 1); assert.equal(positions.get(a.id), 2);
  assert.deepEqual([...runningByClient([r1, a, b])], [['a', 1]]);
});

test('notBefore delays a retried item', () => {
  const later = item({ notBefore: Date.now() + 60000 }), now = item();
  assert.equal(pickNext([later, now], { maxPerClient: 5 }).id, now.id);
  assert.equal(pickNext([later], { maxPerClient: 5 }), null);
});

test('runner choice: healthy, free capacity (minus assignments since the last health check), most free first', () => {
  const r1 = { id: 'r1', healthy: true, available: 2, assignedSinceHealth: 2 }, r2 = { id: 'r2', healthy: true, available: 1, assignedSinceHealth: 0 }, r3 = { id: 'r3', healthy: false, available: 5 };
  assert.equal(pickRunner([r1, r2, r3]).id, 'r2');
  assert.equal(pickRunner([r1, r3]), null);
  assert.equal(pickRunner([{ id: 'x', healthy: true, available: 3 }, { id: 'y', healthy: true, available: 1 }]).id, 'x');
});

test('retries: infrastructure failures retry with backoff up to maxAttempts; capacity races do not count; step failures never retry', () => {
  assert.deepEqual(retryDecision({ attempts: 1, state: 'running' }, { infrastructure: true }, { maxAttempts: 3 }), { retry: true, countAttempt: true, delayMs: 1000 });
  assert.equal(retryDecision({ attempts: 3, state: 'running' }, { infrastructure: true }, { maxAttempts: 3 }).retry, false);
  assert.deepEqual(retryDecision({ attempts: 3, state: 'running' }, { capacity: true }, { maxAttempts: 3 }), { retry: true, countAttempt: false, delayMs: 2000 });
  assert.equal(retryDecision({ attempts: 1, state: 'running' }, { infrastructure: false }, { maxAttempts: 3 }).retry, false);
  assert.equal(retryDecision({ attempts: 1, state: 'cancelled' }, { infrastructure: true }, { maxAttempts: 3 }).retry, false);
});

test('leases expire at their end time or after idling', () => {
  const now = 1_000_000;
  assert.equal(leaseExpired({ state: 'active', expiresAt: now - 1, lastUsedAt: now }, now, { idleMs: 1000 }), 'max-duration');
  assert.equal(leaseExpired({ state: 'active', expiresAt: now + 1e6, lastUsedAt: now - 2000 }, now, { idleMs: 1000 }), 'idle');
  assert.equal(leaseExpired({ state: 'active', expiresAt: now + 1e6, lastUsedAt: now - 10 }, now, { idleMs: 1000 }), false);
  assert.equal(leaseExpired({ state: 'queued' }, now, { idleMs: 1 }), false);
});
