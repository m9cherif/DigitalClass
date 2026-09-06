import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';

import { initStore, storeInfo } from './lib/db.js';
import { UPLOAD_DIR, uploadsAreEphemeral } from './lib/uploads.js';
import { attachUser } from './middleware/auth.js';
import { attachRealtime } from './realtime.js';
import authRoutes from './routes/auth.js';
import courseRoutes from './routes/courses.js';
import quizRoutes from './routes/quizzes.js';
import attemptRoutes from './routes/attempts.js';
import socialRoutes from './routes/social.js';
import adminRoutes from './routes/admin.js';

const app = express();
const PUBLIC = path.resolve('public');

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Small in-memory rate limiter — enough to blunt brute-force login attempts.
const hits = new Map();
const WINDOW = 60_000;
// Without this sweep the map grows one entry per client IP, forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of hits) if (now > rec.reset) hits.delete(key);
}, WINDOW).unref();

app.use('/api', (req, res, next) => {
  const login = req.path.startsWith('/auth/login') || req.path.startsWith('/auth/register');
  const key = `${req.ip}:${login ? 'auth' : 'api'}`;
  const limit = login ? 20 : 600;
  const rec = hits.get(key);
  if (!rec || Date.now() > rec.reset) hits.set(key, { n: 1, reset: Date.now() + WINDOW });
  else if (++rec.n > limit) {
    return res.status(429).json({ error: 'rate_limited', retryInSec: Math.ceil((rec.reset - Date.now()) / 1000) });
  }
  next();
});

/**
 * The store hydrates asynchronously, but the HTTP server must start listening
 * immediately: Phusion Passenger (and most process managers) decide the app is
 * dead if nothing is listening shortly after load. So requests that need data
 * wait here instead, and the socket is open from the first tick.
 */
let storeReady = null;
app.use('/api', async (req, res, next) => {
  try {
    await storeReady;
    next();
  } catch (err) {
    res.status(503).json({ error: 'store_unavailable', message: err.message });
  }
});

app.use(attachUser);

app.use('/api/auth', authRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/quizzes', quizRoutes);
app.use('/api/attempts', attemptRoutes);
app.use('/api/social', socialRoutes);
app.use('/api', adminRoutes);

/** Public enough for an uptime probe; row counts are for admins only. */
app.get('/api/health', (req, res) => {
  const info = storeInfo();
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    store: req.user?.role === 'admin'
      ? info
      : { backend: info.backend, ready: info.ready, pending: info.pending }
  });
});

// Served explicitly, because UPLOAD_DIR may point outside the deploy root.
// Filenames here are content-addressed (random + original name), so a long
// cache lifetime is safe: a changed file is a new URL, never a stale one.
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', index: false }));

// This app has no build step and no hashed filenames — /js/app.js always
// means the current app.js. Without an explicit Cache-Control, a browser is
// free to keep serving a pre-deploy copy from disk indefinitely, which is
// exactly what happened after the assignment-grading fix shipped: the app
// silently ran on stale JS until a manual hard refresh. `no-cache` fixes
// that for every future deploy: the browser still caches the file, but must
// revalidate with the server on every load (a cheap 304 when unchanged), so
// a new deploy is always picked up on the next navigation.
app.use(express.static(PUBLIC, {
  extensions: ['html'],
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache')
}));

app.use('/api', (_req, res) => res.status(404).json({ error: 'no_such_endpoint' }));
// Everything else is handled by the client-side router.
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  const status = err.status || 500;
  res.status(status).json({ error: err.code || 'server_error', message: err.message });
});

const server = http.createServer(app);
attachRealtime(server);

const PORT = process.env.PORT || 3000;

// No top-level await here on purpose — it would make this module's evaluation
// return a pending promise, and a loader that does not await it (Passenger)
// would conclude the app never started.
storeReady = initStore().then(backend => {
  console.log(`  store: ${backend} ready`);
  return backend;
}, err => {
  console.error('[store] failed to initialise:', err.message);
  throw err;
});

server.listen(PORT, () => {
  console.log(`\n  DigitalClass  →  http://localhost:${PORT}`);
  console.log(`  env: ${process.env.NODE_ENV || 'development'}  ·  realtime: on`);
  if (uploadsAreEphemeral && process.env.NODE_ENV === 'production') {
    console.warn(`  ! uploads are in ${UPLOAD_DIR}, inside the deploy directory — set UPLOAD_DIR to keep them across releases`);
  }
  console.log('');
});
