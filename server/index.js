import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';

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
app.use('/api', (req, res, next) => {
  const key = `${req.ip}:${req.path.startsWith('/auth/login') ? 'login' : 'api'}`;
  const limit = key.endsWith('login') ? 20 : 600;
  const window = 60_000;
  const rec = hits.get(key);
  if (!rec || Date.now() > rec.reset) hits.set(key, { n: 1, reset: Date.now() + window });
  else if (++rec.n > limit) return res.status(429).json({ error: 'rate_limited', retryInSec: Math.ceil((rec.reset - Date.now()) / 1000) });
  next();
});

app.use(attachUser);

app.use('/api/auth', authRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/quizzes', quizRoutes);
app.use('/api/attempts', attemptRoutes);
app.use('/api/social', socialRoutes);
app.use('/api', adminRoutes);

app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use(express.static(PUBLIC, { extensions: ['html'] }));

app.use('/api', (_req, res) => res.status(404).json({ error: 'no_such_endpoint' }));
// Everything else is handled by the client-side router.
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
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
server.listen(PORT, () => {
  console.log(`\n  DigitalClass  →  http://localhost:${PORT}`);
  console.log(`  env: ${process.env.NODE_ENV || 'development'}  ·  realtime: on\n`);
});
