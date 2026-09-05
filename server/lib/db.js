/**
 * In-memory document store with a pluggable durable backend.
 *
 * Reads are synchronous and served from memory, which is what lets the rest of
 * the codebase stay simple. Writes update memory immediately and are forwarded
 * to the backend:
 *
 *   - Supabase  — used automatically when SUPABASE_URL and a service key are
 *                 present in the environment. Postgres is the source of truth;
 *                 nothing is written to disk. Survives host redeploys.
 *   - JSON files — the zero-configuration fallback for local development,
 *                 one file per collection under /data.
 *
 * Call `await initStore()` once at boot, before serving traffic.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as supa from './supabase.js';
import * as sql from './mysql.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_DIR = path.join(ROOT, 'data');

export const COLLECTIONS = [
  'users', 'courses', 'lessons', 'enrollments', 'quizzes', 'questions',
  'attempts', 'assignments', 'submissions', 'badges', 'awards', 'parties',
  'threads', 'posts', 'messages', 'notifications', 'announcements',
  'certificates', 'events', 'links', 'resources', 'flashcardStates'
];

const cache = new Map();
let backend = null;
let ready = false;

/** Resolves once initStore() has finished; awaited by anything that runs
 *  before boot completes (Socket.IO handshakes, early requests). */
let markReady;
export const whenReady = new Promise(resolve => { markReady = resolve; });

/* ------------------------------------------------------------ file backend */

function createFileBackend() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = name => path.join(DATA_DIR, `${name}.json`);
  const dirty = new Set();
  let timer = null;

  const write = name => {
    const tmp = file(name) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache.get(name) ?? [], null, 2));
    fs.renameSync(tmp, file(name));
  };

  return {
    name: 'files',
    async hydrate(collections) {
      const out = {};
      for (const c of collections) {
        try {
          const rows = JSON.parse(fs.readFileSync(file(c), 'utf8'));
          out[c] = Array.isArray(rows) ? rows : [];
        } catch { out[c] = []; }
      }
      return out;
    },
    // The whole collection is rewritten, so the op detail is irrelevant here.
    persist(op) {
      dirty.add(op.collection);
      if (timer) return;
      timer = setTimeout(() => { timer = null; this.flushSync(); }, 40);
    },
    flushSync() {
      for (const n of dirty) write(n);
      dirty.clear();
    },
    async flush() { this.flushSync(); },
    stats: () => ({ pending: dirty.size, failures: 0 })
  };
}

/* ---------------------------------------------------------------- lifecycle */

/**
 * Choose a backend and load every collection into memory.
 * MySQL wins when configured, then Supabase, then local files.
 */
export async function initStore({ log = console } = {}) {
  let where = '';
  if (sql.isConfigured()) {
    const cfg = sql.mysqlConfig();
    backend = await sql.createMysqlBackend({ log });
    where = ` (${cfg.user}@${cfg.host}/${cfg.database})`;
  } else if (supa.isConfigured()) {
    backend = await supa.createSupabaseBackend({ log });
    where = ` (${supa.supabaseUrl()})`;
  } else {
    backend = createFileBackend();
  }

  const loaded = await backend.hydrate(COLLECTIONS);
  for (const c of COLLECTIONS) cache.set(c, loaded[c] ?? []);
  ready = true;
  markReady();
  const total = COLLECTIONS.reduce((n, c) => n + cache.get(c).length, 0);
  log.log?.(`  store: ${backend.name}${where} · ${total} rows`);
  return backend.name;
}

export const storeInfo = () => ({
  backend: backend?.name ?? 'uninitialised',
  ready,
  rows: Object.fromEntries(COLLECTIONS.map(c => [c, cache.get(c)?.length ?? 0])),
  ...(backend?.stats() ?? {})
});

export async function flushAll() {
  backend?.flushSync?.();
  await backend?.flush();
}

function load(name) {
  if (!ready) {
    throw new Error(`db.${name} used before initStore() — await initStore() during boot`);
  }
  return cache.get(name) ?? [];
}

const persist = op => backend?.persist(op);

/* ------------------------------------------------------------------ helpers */

export const id = (prefix = '') => prefix + crypto.randomBytes(9).toString('base64url');
export const now = () => new Date().toISOString();

function matches(row, where) {
  for (const [k, v] of Object.entries(where)) {
    if (typeof v === 'function') { if (!v(row[k], row)) return false; continue; }
    if (Array.isArray(v)) { if (!v.includes(row[k])) return false; continue; }
    if (row[k] !== v) return false;
  }
  return true;
}

/* -------------------------------------------------------------- collections */

export function table(name) {
  if (!COLLECTIONS.includes(name)) COLLECTIONS.push(name);
  return {
    name,
    all() { return load(name); },
    find(where = {}) { return load(name).filter(r => matches(r, where)); },
    findOne(where = {}) { return load(name).find(r => matches(r, where)) ?? null; },
    byId(rowId) { return load(name).find(r => r.id === rowId) ?? null; },
    count(where = {}) { return this.find(where).length; },

    insert(doc) {
      const rows = load(name);
      const row = { id: doc.id ?? id(), createdAt: now(), updatedAt: now(), ...doc };
      rows.push(row);
      persist({ collection: name, type: 'upsert', rows: [row] });
      return row;
    },
    insertMany(docs) { return docs.map(d => this.insert(d)); },

    update(rowId, patch) {
      const rows = load(name);
      const i = rows.findIndex(r => r.id === rowId);
      if (i === -1) return null;
      rows[i] = { ...rows[i], ...patch, id: rows[i].id, updatedAt: now() };
      persist({ collection: name, type: 'upsert', rows: [rows[i]] });
      return rows[i];
    },
    updateWhere(where, patch) {
      let n = 0;
      for (const row of this.find(where)) { this.update(row.id, patch); n++; }
      return n;
    },

    remove(rowId) {
      const rows = load(name);
      const i = rows.findIndex(r => r.id === rowId);
      if (i === -1) return false;
      rows.splice(i, 1);
      persist({ collection: name, type: 'delete', id: rowId });
      return true;
    },
    removeWhere(where) {
      let n = 0;
      for (const row of this.find(where)) { this.remove(row.id); n++; }
      return n;
    },

    clear() {
      for (const row of [...load(name)]) this.remove(row.id);
      cache.set(name, []);
    }
  };
}

export const db = Object.fromEntries(COLLECTIONS.map(c => [c, table(c)]));

/* Best-effort durability on shutdown. The file backend flushes synchronously;
   Supabase writes are already in flight, so we give them a moment to land. */
const shutdown = () => {
  backend?.flushSync?.();
  const done = () => process.exit(0);
  if (backend?.name === 'files') return done();
  // Give in-flight remote writes a moment to land before exiting.
  Promise.race([backend.flush(), new Promise(r => setTimeout(r, 2500))]).then(done, done);
};
process.on('exit', () => backend?.flushSync?.());
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
