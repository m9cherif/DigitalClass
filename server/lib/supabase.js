/**
 * Supabase persistence backend.
 *
 * Supabase is the durable store: nothing is written to disk. At boot every
 * table is hydrated into memory, and from then on each mutation is applied to
 * the in-memory copy immediately (so the rest of the app stays synchronous)
 * and pushed to Postgres through an ordered write queue.
 *
 * Credentials come from the environment — set them in your host's dashboard,
 * no .env file required. Recognised names:
 *   SUPABASE_URL              | SUPABASE_PROJECT_URL | SUPABASE_API_URL
 *   SUPABASE_SERVICE_ROLE_KEY | SUPABASE_SERVICE_KEY | SUPABASE_KEY
 */
import { createClient } from '@supabase/supabase-js';

const env = (...names) => {
  for (const n of names) if (process.env[n]) return process.env[n].trim();
  return null;
};

export const supabaseUrl = () => env('SUPABASE_URL', 'SUPABASE_PROJECT_URL', 'SUPABASE_API_URL');
export const supabaseKey = () =>
  env('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_KEY', 'SUPABASE_ANON_KEY');

export const isConfigured = () => Boolean(supabaseUrl() && supabaseKey());

/** camelCase collection -> snake_case table. */
export const tableName = c => c.replace(/[A-Z]/g, ch => '_' + ch.toLowerCase());

const MAX_RETRIES = 4;
const PAGE = 1000;

export function createSupabaseBackend({ url = supabaseUrl(), key = supabaseKey(), log = console } = {}) {
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'digitalclass' } }
  });

  const queue = [];
  let draining = null;
  let failures = 0;

  /** Read every row of a table, paging past PostgREST's row cap. */
  async function fetchAll(collection) {
    const table = tableName(collection);
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await client
        .from(table)
        .select('id, data, created_at, updated_at')
        .order('created_at', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`hydrate ${table}: ${error.message}`);
      rows.push(...data);
      if (data.length < PAGE) break;
    }
    // The document lives in `data`; id/timestamps are real columns.
    return rows.map(r => ({ ...r.data, id: r.id, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  async function runOp(op) {
    const table = tableName(op.collection);
    if (op.type === 'delete') {
      const { error } = await client.from(table).delete().eq('id', op.id);
      if (error) throw new Error(`delete ${table}/${op.id}: ${error.message}`);
      return;
    }
    const payload = op.rows.map(row => {
      const { id, createdAt, updatedAt, ...data } = row;
      return { id, data, created_at: createdAt, updated_at: updatedAt };
    });
    const { error } = await client.from(table).upsert(payload, { onConflict: 'id' });
    if (error) throw new Error(`upsert ${table} (${payload.length}): ${error.message}`);
  }

  async function drain() {
    while (queue.length) {
      // Coalesce consecutive upserts to the same table into one request.
      const first = queue.shift();
      if (first.type === 'upsert') {
        while (queue.length && queue[0].type === 'upsert' && queue[0].collection === first.collection
               && first.rows.length < 500) {
          first.rows.push(...queue.shift().rows);
        }
      }
      let attempt = 0;
      for (;;) {
        try {
          await runOp(first);
          break;
        } catch (err) {
          if (++attempt > MAX_RETRIES) {
            failures++;
            log.error('[supabase] dropped write after retries:', err.message);
            break;
          }
          await new Promise(r => setTimeout(r, 150 * 2 ** attempt));
        }
      }
    }
    draining = null;
  }

  return {
    name: 'supabase',

    async hydrate(collections) {
      const out = {};
      // Sequential rather than parallel: a free-tier project rate-limits bursts.
      for (const c of collections) out[c] = await fetchAll(c);
      return out;
    },

    persist(op) {
      queue.push(op);
      draining ??= drain();
    },

    /** Resolves once every queued write has been attempted. */
    async flush() {
      while (draining) await draining;
    },

    stats: () => ({ pending: queue.length, failures })
  };
}
