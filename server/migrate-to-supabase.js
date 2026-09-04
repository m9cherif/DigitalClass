/**
 * One-shot copy of the local JSON store into Supabase.
 *
 *   node server/migrate-to-supabase.js [--dry] [--wipe]
 *
 * Reads data/*.json directly (not through the store, so it works even when the
 * app is already pointed at Supabase) and upserts every row. Safe to re-run:
 * rows are keyed by their existing id, so a second run overwrites rather than
 * duplicates. Pass --wipe to clear the Supabase tables first.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { COLLECTIONS } from './lib/db.js';
import { isConfigured, supabaseUrl, supabaseKey, tableName } from './lib/supabase.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const dry = process.argv.includes('--dry');
const wipe = process.argv.includes('--wipe');

if (!isConfigured()) {
  console.error(`
  No Supabase credentials found in the environment.

  Set these (in your host's dashboard, or a local .env for testing):
    SUPABASE_URL=https://<project-ref>.supabase.co
    SUPABASE_SERVICE_ROLE_KEY=<service_role key>
`);
  process.exit(1);
}

const client = createClient(supabaseUrl(), supabaseKey(), {
  auth: { persistSession: false, autoRefreshToken: false }
});

const readLocal = c => {
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${c}.json`), 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
};

console.log(`\n  Source: ${DATA_DIR}\n  Target: ${supabaseUrl()}${dry ? '  (dry run)' : ''}\n`);

let total = 0, failed = 0;

for (const collection of COLLECTIONS) {
  const rows = readLocal(collection);
  const table = tableName(collection);
  if (!rows.length) { console.log(`  ${table.padEnd(18)} —`); continue; }

  if (dry) { console.log(`  ${table.padEnd(18)} ${rows.length} rows (not sent)`); total += rows.length; continue; }

  if (wipe) {
    // `neq` on a column that is never null matches every row.
    const { error } = await client.from(table).delete().neq('id', '');
    if (error) console.warn(`  ! wipe ${table}: ${error.message}`);
  }

  // Chunked so a big collection cannot blow the request size limit.
  let done = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200).map(({ id, createdAt, updatedAt, ...data }) => ({
      id, data, created_at: createdAt ?? new Date().toISOString(), updated_at: updatedAt ?? new Date().toISOString()
    }));
    const { error } = await client.from(table).upsert(chunk, { onConflict: 'id' });
    if (error) { console.error(`  ✗ ${table}: ${error.message}`); failed += chunk.length; }
    else done += chunk.length;
  }
  total += done;
  console.log(`  ${table.padEnd(18)} ${done}/${rows.length}`);
}

console.log(`\n  ${total} rows migrated${failed ? `, ${failed} failed` : ''}.\n`);
process.exit(failed ? 1 : 0);
