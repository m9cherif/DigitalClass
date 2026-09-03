/**
 * Tiny embedded JSON document store.
 * Zero native dependencies: every collection is one JSON file under /data,
 * kept in memory and flushed atomically (write temp -> rename) with debouncing.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const COLLECTIONS = [
  'users', 'courses', 'lessons', 'enrollments', 'quizzes', 'questions',
  'attempts', 'assignments', 'submissions', 'badges', 'awards', 'parties',
  'threads', 'posts', 'messages', 'notifications', 'announcements',
  'certificates', 'events', 'links', 'resources', 'flashcardStates'
];

const cache = new Map();
const dirty = new Set();
let timer = null;

function file(name) { return path.join(DATA_DIR, `${name}.json`); }

function load(name) {
  if (cache.has(name)) return cache.get(name);
  let rows = [];
  try {
    const raw = fs.readFileSync(file(name), 'utf8');
    rows = JSON.parse(raw);
    if (!Array.isArray(rows)) rows = [];
  } catch { rows = []; }
  cache.set(name, rows);
  return rows;
}

function flush(name) {
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache.get(name) ?? [], null, 2));
  fs.renameSync(tmp, file(name));
}

function schedule(name) {
  dirty.add(name);
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    for (const n of dirty) flush(n);
    dirty.clear();
  }, 40);
}

export function flushAll() {
  if (timer) { clearTimeout(timer); timer = null; }
  for (const n of dirty) flush(n);
  dirty.clear();
}

export const id = (prefix = '') =>
  prefix + crypto.randomBytes(9).toString('base64url');

export const now = () => new Date().toISOString();

function matches(row, where) {
  for (const [k, v] of Object.entries(where)) {
    if (typeof v === 'function') { if (!v(row[k], row)) return false; continue; }
    if (Array.isArray(v)) { if (!v.includes(row[k])) return false; continue; }
    if (row[k] !== v) return false;
  }
  return true;
}

/** Collection handle with a minimal query API. */
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
      schedule(name);
      return row;
    },
    insertMany(docs) { return docs.map(d => this.insert(d)); },
    update(rowId, patch) {
      const rows = load(name);
      const i = rows.findIndex(r => r.id === rowId);
      if (i === -1) return null;
      rows[i] = { ...rows[i], ...patch, id: rows[i].id, updatedAt: now() };
      schedule(name);
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
      schedule(name);
      return true;
    },
    removeWhere(where) {
      let n = 0;
      for (const row of this.find(where)) { this.remove(row.id); n++; }
      return n;
    },
    clear() { cache.set(name, []); schedule(name); }
  };
}

export const db = Object.fromEntries(COLLECTIONS.map(c => [c, table(c)]));

process.on('exit', flushAll);
process.on('SIGINT', () => { flushAll(); process.exit(0); });
process.on('SIGTERM', () => { flushAll(); process.exit(0); });
