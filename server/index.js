import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';

import { initStore, storeInfo } from './lib/db.js';
import { UPLOAD_DIR, uploadsAreEphemeral } from './lib/uploads.js';
import { attachUser } from './middleware/auth.js';
import { attachRealtime } from './realtime.js';
import authRoutes from './routes/auth.js';
import courseRoutes from './routes/courses.js';
import classRoutes from './routes/classes.js';
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
  const login = [
    '/auth/login', '/auth/register', '/auth/verify-email', '/auth/resend-otp',
    '/auth/google', '/auth/microsoft', '/auth/facebook'
  ]
    .some(p => req.path.startsWith(p));
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
app.use('/api/classes', classRoutes);
app.use('/api/quizzes', quizRoutes);
app.use('/api/attempts', attemptRoutes);
app.use('/api/social', socialRoutes);
app.use('/api', adminRoutes);

/** Feature flags/IDs the client needs before it can render anything that
 *  depends on them — a client ID is meant to be public, unlike an API key. */
app.get('/api/config', (_req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    microsoftClientId: process.env.MICROSOFT_CLIENT_ID || null,
    // The app secret backing this is never sent — only the two IDs the
    // client-side SDK needs to open the login dialog.
    facebookAppId: process.env.FACEBOOK_APP_ID || null,
    facebookConfigId: process.env.FACEBOOK_CONFIG_ID || null
  });
});

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
// means the current app.js. `no-cache` asks any cache to revalidate with the
// server before reusing a copy (a cheap 304 when unchanged), which is enough
// for a browser sitting directly in front of the app. It is NOT enough here:
// this site sits behind Hostinger's own CDN (hcdn), which caches /js and /css
// by file extension on its own schedule and does not pass Cache-Control
// through to the client for them (confirmed against production — the header
// simply never arrives, independent of what the origin sends). Relying on it
// alone is exactly what let the assignment-grading fix ship, build, and pass
// every check, while real visitors kept getting served the previous deploy's
// app.js from the edge for several minutes after.
//
// So the entry page is versioned instead: BUILD_ID changes every time this
// process starts (i.e. every deploy, since the host restarts it), and the
// script/style tags below carry it as a query string. hcdn's cache key
// includes the query string, so a new deploy always means a URL the edge has
// never seen — the old cached copy is simply never requested again. `/` and
// the SPA fallback are themselves untouched by hcdn's static-asset caching
// (verified as "DYNAMIC" in its response headers), so the new BUILD_ID is
// guaranteed to reach every visitor on their very next navigation.
const BUILD_ID = Date.now().toString(36);
const indexShell = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
  .replace('/js/app.js', `/js/app.js?v=${BUILD_ID}`)
  .replace('/css/style.css', `/css/style.css?v=${BUILD_ID}`);

const sendShell = (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(indexShell);
};

// The same staleness BUILD_ID was introduced for above bites every OTHER
// script too: app.js statically imports the view modules, which import
// core.js, which import each other, all by plain relative specifiers with
// no query string of their own — hcdn can keep serving any one of them from
// a stale edge indefinitely, deploy after deploy, independent of app.js
// itself being fresh. Rewriting every relative `.js` import/dynamic-import
// specifier to carry the same `?v=` on the way out closes that gap the
// exact same way, for every module instead of just the entry point.
const JS_IMPORT_RE = /((?:from|import\()\s*['"])(\.[^'"]+?\.js)(['"])/g;
const versionImports = src => src.replace(JS_IMPORT_RE, (_m, pre, spec, post) => `${pre}${spec}?v=${BUILD_ID}${post}`);

app.get(/^\/js\/.+\.js$/, (req, res) => {
  const filePath = path.join(PUBLIC, decodeURIComponent(req.path));
  if (!filePath.startsWith(PUBLIC)) return res.status(400).end();
  fs.readFile(filePath, 'utf8', (err, src) => {
    if (err) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-cache');
    res.type('application/javascript').send(versionImports(src));
  });
});

app.use(express.static(PUBLIC, {
  extensions: ['html'],
  index: false,   // '/' is handled by sendShell below, not by serving the file as-is
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache')
}));

app.get('/', sendShell);
app.use('/api', (_req, res) => res.status(404).json({ error: 'no_such_endpoint' }));
// Everything else is handled by the client-side router.
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  sendShell(req, res);
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
