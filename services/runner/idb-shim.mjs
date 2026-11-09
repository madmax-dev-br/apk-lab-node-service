// A minimal IndexedDB subset backed by files, for the lab's app-data store (runtime/app-data-store.js createIndexedDbBackend) inside a Node worker_threads VM Worker.
// It implements exactly what that backend uses: indexedDB.open(name, version) with onupgradeneeded/onsuccess, db.objectStoreNames.contains, db.createObjectStore,
// db.transaction(stores, mode) with oncomplete/onerror/onabort, objectStore(name).get/put/delete/getAll. Values are stored with v8.serialize. Writes of a readwrite
// transaction are applied together when it completes (temp file + rename per entry). It is not a general IndexedDB.
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { serialize, deserialize } from 'node:v8';
import { createHash } from 'node:crypto';
import path from 'node:path';

const fileFor = (dir, key) => path.join(dir, createHash('sha256').update(typeof key === 'string' ? key : JSON.stringify(key)).digest('hex') + '.bin');
class Request { constructor() { this.onsuccess = null; this.onerror = null; this.result = undefined; this.error = null; this.readyState = 'pending'; } }
const succeed = (request, result) => queueMicrotask(() => { request.result = result; request.readyState = 'done'; request.onsuccess?.({ target: request }); });
const fail = (request, error) => queueMicrotask(() => { request.error = error; request.readyState = 'done'; request.onerror?.({ target: request }); });

export function createFileIndexedDB(root) {
  mkdirSync(root, { recursive: true });
  return {
    open(name, version = 1) {
      const request = new Request(), dbDir = path.join(root, createHash('sha256').update(String(name)).digest('hex').slice(0, 24));
      queueMicrotask(() => {
        try {
          const fresh = !existsSync(dbDir); mkdirSync(dbDir, { recursive: true });
          const stores = new Set(readdirSync(dbDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name));
          const db = {
            name, version, onversionchange: null,
            objectStoreNames: { contains: storeName => stores.has(storeName) },
            createObjectStore(storeName) { mkdirSync(path.join(dbDir, storeName), { recursive: true }); stores.add(storeName); return {}; },
            close() {},
            transaction(names, mode = 'readonly') { return createTransaction(dbDir, stores, Array.isArray(names) ? names : [names], mode); },
          };
          request.result = db;
          if (fresh) request.onupgradeneeded?.({ target: request, oldVersion: 0, newVersion: version });
          succeed(request, db);
        } catch (error) { fail(request, error); }
      });
      return request;
    },
  };
}

function createTransaction(dbDir, stores, names, mode) {
  for (const name of names) if (!stores.has(name)) throw Object.assign(new Error(`NotFoundError: object store ${name}`), { name: 'NotFoundError' });
  const writes = []; let pending = 0, finished = false, failed = null;
  const transaction = { mode, oncomplete: null, onerror: null, onabort: null, error: null, objectStore(name) { if (!names.includes(name)) throw new Error(`object store ${name} not in this transaction`); return store(name); } };
  const settle = () => setTimeout(() => {
    if (finished || pending > 0) return; finished = true;
    if (failed) { transaction.error = failed; transaction.onerror?.({ target: transaction }); return; }
    try {
      for (const write of writes) {
        if (write.remove) rmSync(write.file, { force: true });
        else { const temp = `${write.file}.${process.pid}.tmp`; writeFileSync(temp, write.bytes); renameSync(temp, write.file); }
      }
      transaction.oncomplete?.({ target: transaction });
    } catch (error) { transaction.error = error; transaction.onerror?.({ target: transaction }); }
  }, 0);
  const track = (request, work) => {
    pending++;
    queueMicrotask(() => {
      try { const result = work(); succeed(request, result); } catch (error) { failed = error; fail(request, error); }
      finally { pending--; settle(); }
    });
    return request;
  };
  function store(name) {
    const dir = path.join(dbDir, name);
    return {
      get(key) { return track(new Request(), () => { try { return deserialize(readFileSync(fileFor(dir, key))).value; } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }); },
      getAll() { return track(new Request(), () => readdirSync(dir).filter(file => file.endsWith('.bin')).map(file => deserialize(readFileSync(path.join(dir, file))).value)); },
      put(value, key) { if (mode !== 'readwrite') throw new Error('ReadOnlyError'); return track(new Request(), () => { writes.push({ file: fileFor(dir, key), bytes: serialize({ key, value }) }); return key; }); },
      delete(key) { if (mode !== 'readwrite') throw new Error('ReadOnlyError'); return track(new Request(), () => { writes.push({ file: fileFor(dir, key), remove: true }); return undefined; }); },
    };
  }
  settle();
  return transaction;
}
