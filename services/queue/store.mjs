// Persistence of jobs and leases. The queue keeps its working set in memory and calls the store on every change; a store only has to implement
//   async load() -> item[]      (at start)
//   save(item)                  (item changed; may be batched)
//   remove(id)                  (item deleted by retention)
//   async flush()               (shutdown)
// MemoryStore keeps nothing across restarts; JsonFileStore writes one JSON file atomically (debounced). A database store (PostgreSQL, Redis, ...) implements the same four methods.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

export class MemoryStore {
  async load() { return []; }
  save() {}
  remove() {}
  async flush() {}
}

export class JsonFileStore {
  constructor(file, { debounceMs = 200 } = {}) { this.file = path.resolve(file); this.items = new Map(); this.debounceMs = debounceMs; this.timer = null; this.writing = Promise.resolve(); }
  async load() {
    try { const data = JSON.parse(await readFile(this.file, 'utf8')); for (const item of data.items ?? []) this.items.set(item.id, item); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read the queue store ${this.file}: ${error.message}`); }
    return [...this.items.values()].map(item => structuredClone(item));
  }
  save(item) { this.items.set(item.id, persistable(item)); this.schedule(); }
  remove(id) { this.items.delete(id); this.schedule(); }
  schedule() { if (this.timer) return; this.timer = setTimeout(() => { this.timer = null; this.writing = this.writing.then(() => this.write()).catch(() => {}); }, this.debounceMs); this.timer.unref?.(); }
  async write() {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), items: [...this.items.values()] }));
    await rename(temp, this.file);
  }
  async flush() { clearTimeout(this.timer); this.timer = null; await this.writing; await this.write(); }
}

/** The stored form of an item: runtime-only fields (abort controllers, timers, listeners) are dropped. */
export function persistable(item) {
  const { abort, timer, listeners, ...rest } = item; void abort; void timer; void listeners;
  return JSON.parse(JSON.stringify(rest));
}
