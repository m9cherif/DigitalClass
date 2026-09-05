/**
 * MySQL / MariaDB persistence backend.
 *
 * Designed for the database that ships with shared hosting: the app creates
 * its own schema on first boot, hydrates every collection into memory, and
 * then streams each mutation to the server through an ordered write queue.
 *
 * Credentials come from the environment — set them in your host's dashboard,
 * no .env file required. Recognised names:
 *   DB_HOST | MYSQL_HOST        (default: localhost)
 *   DB_PORT | MYSQL_PORT        (default: 3306)
 *   DB_USER | MYSQL_USER
 *   DB_PASSWORD | DB_PASS | MYSQL_PASSWORD
 *   DB_NAME | DB_DATABASE | MYSQL_DATABASE
 * or a single connection string in DATABASE_URL / MYSQL_URL.
 */
// The driver is imported lazily, inside the factory, so a deployment that does
// not use MySQL never pays for loading it.
const env = (...names) => {
  for (const n of names) if (process.env[n]) return String(process.env[n]).trim();
  return null;
};

export function mysqlConfig() {
  const urlString = env('DATABASE_URL', 'MYSQL_URL', 'JAWSDB_URL');
  if (urlString && /^mysql/i.test(urlString)) {
    const u = new URL(urlString);
    return {
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, '')
    };
  }
  const user = env('DB_USER', 'MYSQL_USER');
  const database = env('DB_NAME', 'DB_DATABASE', 'MYSQL_DATABASE');
  if (!user || !database) return null;
  return {
    host: env('DB_HOST', 'MYSQL_HOST') || 'localhost',
    port: Number(env('DB_PORT', 'MYSQL_PORT') || 3306),
    user,
    password: env('DB_PASSWORD', 'DB_PASS', 'MYSQL_PASSWORD') || '',
    database
  };
}

export const isConfigured = () => mysqlConfig() !== null;

/** camelCase collection -> snake_case table. */
export const tableName = c => c.replace(/[A-Z]/g, ch => '_' + ch.toLowerCase());

/**
 * Columns worth exposing outside the app (phpMyAdmin, ad-hoc SQL). They are
 * STORED generated columns, so the app never writes them. Adding them is
 * best-effort: on a server that dislikes the syntax the table still works,
 * it just has fewer convenience columns.
 */
const EXTRA_COLUMNS = {
  users: { email: 'email', role: 'role', status: 'status' },
  courses: { code: 'code', teacher_id: 'teacherId', status: 'status', topic: 'topic' },
  lessons: { course_id: 'courseId' },
  enrollments: { user_id: 'userId', course_id: 'courseId', status: 'status' },
  quizzes: { course_id: 'courseId', kind: 'kind' },
  questions: { quiz_id: 'quizId', course_id: 'courseId', type: 'type' },
  attempts: { user_id: 'userId', quiz_id: 'quizId', course_id: 'courseId', status: 'status' },
  assignments: { course_id: 'courseId' },
  submissions: { assignment_id: 'assignmentId', user_id: 'userId', status: 'status' },
  awards: { user_id: 'userId', badge_id: 'badgeId' },
  parties: { pin: 'pin', host_id: 'hostId', course_id: 'courseId' },
  threads: { course_id: 'courseId', author_id: 'authorId' },
  posts: { thread_id: 'threadId', author_id: 'authorId' },
  messages: { room_id: 'roomId', kind: 'kind', to_id: 'toId' },
  notifications: { user_id: 'userId', kind: 'kind' },
  announcements: { course_id: 'courseId' },
  certificates: { user_id: 'userId', course_id: 'courseId', serial: 'serial' },
  events: { user_id: 'userId', kind: 'kind' },
  links: { parent_id: 'parentId', student_id: 'studentId' },
  resources: { course_id: 'courseId' },
  flashcard_states: { user_id: 'userId', question_id: 'questionId' }
};

const MAX_RETRIES = 4;
const CHUNK = 200;

export async function createMysqlBackend({ config = mysqlConfig(), log = console } = {}) {
  const { default: mysql } = await import('mysql2/promise');
  const pool = mysql.createPool({
    ...config,
    waitForConnections: true,
    connectionLimit: 4,
    charset: 'utf8mb4',
    // Keep dates as strings; the app speaks ISO-8601 everywhere.
    dateStrings: true,
    enableKeepAlive: true
  });

  const queue = [];
  let draining = null;
  let failures = 0;

  const parse = v => {
    if (v == null) return {};
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return {}; }
  };
  const iso = v => (v ? new Date(v.replace(' ', 'T') + (/[Z+]/.test(v) ? '' : 'Z')).toISOString() : new Date().toISOString());

  async function ensureTable(collection) {
    const t = tableName(collection);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS \`${t}\` (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        data JSON NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    // Convenience columns + indexes. Any server that refuses them is fine;
    // the app only ever reads and writes `data`.
    for (const [column, key] of Object.entries(EXTRA_COLUMNS[t] ?? {})) {
      try {
        await pool.query(
          `ALTER TABLE \`${t}\` ADD COLUMN \`${column}\` VARCHAR(190)
           GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(\`data\`, '$.${key}'))) STORED`);
        await pool.query(`CREATE INDEX \`idx_${t}_${column}\` ON \`${t}\` (\`${column}\`)`);
      } catch { /* already present, or unsupported on this server */ }
    }
  }

  async function runOp(op) {
    const t = tableName(op.collection);
    if (op.type === 'delete') {
      await pool.query(`DELETE FROM \`${t}\` WHERE id = ?`, [op.id]);
      return;
    }
    for (let i = 0; i < op.rows.length; i += CHUNK) {
      const chunk = op.rows.slice(i, i + CHUNK);
      const values = chunk.map(row => {
        const { id, createdAt, updatedAt, ...data } = row;
        return [id, JSON.stringify(data), sqlDate(createdAt), sqlDate(updatedAt)];
      });
      await pool.query(
        `INSERT INTO \`${t}\` (id, data, created_at, updated_at) VALUES ?
         ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at)`,
        [values]
      );
    }
  }

  const sqlDate = v => {
    const d = v ? new Date(v) : new Date();
    return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString().slice(0, 23).replace('T', ' ');
  };

  async function drain() {
    while (queue.length) {
      const first = queue.shift();
      if (first.type === 'upsert') {
        while (queue.length && queue[0].type === 'upsert' && queue[0].collection === first.collection
               && first.rows.length < 500) {
          first.rows.push(...queue.shift().rows);
        }
      }
      let attempt = 0;
      for (;;) {
        try { await runOp(first); break; }
        catch (err) {
          if (++attempt > MAX_RETRIES) {
            failures++;
            log.error?.('[mysql] dropped write after retries:', err.message);
            break;
          }
          await new Promise(r => setTimeout(r, 150 * 2 ** attempt));
        }
      }
    }
    draining = null;
  }

  return {
    name: 'mysql',

    /** The database may still be waking up when the app boots after a deploy. */
    async connect({ attempts = 5 } = {}) {
      for (let i = 1; ; i++) {
        try { await pool.query('SELECT 1'); return; }
        catch (err) {
          if (i >= attempts) throw err;
          log.warn?.(`[mysql] connection attempt ${i} failed (${err.code || err.message}), retrying…`);
          await new Promise(r => setTimeout(r, 1000 * i));
        }
      }
    },

    async hydrate(collections) {
      await this.connect();
      const out = {};
      for (const c of collections) {
        await ensureTable(c);
        const [rows] = await pool.query(
          `SELECT id, data, created_at, updated_at FROM \`${tableName(c)}\` ORDER BY created_at`);
        out[c] = rows.map(r => ({
          ...parse(r.data), id: r.id, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at)
        }));
      }
      return out;
    },

    persist(op) {
      queue.push(op);
      draining ??= drain();
    },

    async flush() { while (draining) await draining; },

    async close() { await this.flush(); await pool.end(); },

    stats: () => ({ pending: queue.length, failures })
  };
}
