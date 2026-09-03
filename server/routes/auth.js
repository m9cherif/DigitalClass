import { Router } from 'express';
import { db } from '../lib/db.js';
import { progress } from '../lib/gamification.js';
import {
  ROLES, hashPassword, checkPassword, signToken, publicUser, requireAuth, requireRole
} from '../middleware/auth.js';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', (req, res) => {
  const { name, email, password, role = 'student', lang = 'fr' } = req.body || {};
  if (!name || !EMAIL_RE.test(email || '')) return res.status(400).json({ error: 'invalid_email_or_name' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'weak_password', min: 8 });
  if (!ROLES.includes(role) || role === 'admin') return res.status(400).json({ error: 'invalid_role' });
  if (db.users.findOne({ email: email.toLowerCase() })) return res.status(409).json({ error: 'email_taken' });

  const user = db.users.insert({
    name: String(name).slice(0, 80),
    email: email.toLowerCase(),
    password: hashPassword(password),
    role, lang, status: 'active',
    avatar: null, bio: '', xp: 0, level: 1, streak: 0, longestStreak: 0,
    childIds: [], theme: 'dark'
  });
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.users.findOne({ email: String(email || '').toLowerCase() });
  if (!user || !checkPassword(password, user.password)) {
    return res.status(401).json({ error: 'bad_credentials' });
  }
  if (user.status === 'suspended') return res.status(403).json({ error: 'account_suspended' });
  db.users.update(user.id, { lastLoginAt: new Date().toISOString() });
  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get('/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    user: publicUser(u),
    progress: progress(u.xp || 0),
    badges: db.awards.find({ userId: u.id }),
    unread: db.notifications.count({ userId: u.id, read: false }),
    enrollments: db.enrollments.find({ userId: u.id, status: 'active' }).length
  });
});

router.patch('/me', requireAuth, (req, res) => {
  const allowed = ['name', 'bio', 'lang', 'theme', 'avatar'];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  res.json({ user: publicUser(db.users.update(req.user.id, patch)) });
});

router.post('/me/password', requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  if (!checkPassword(current, req.user.password)) return res.status(403).json({ error: 'bad_password' });
  if (!next || next.length < 8) return res.status(400).json({ error: 'weak_password', min: 8 });
  db.users.update(req.user.id, { password: hashPassword(next) });
  res.json({ ok: true });
});

/** A parent links a child by the code the student shares from their profile. */
router.post('/me/children', requireRole('parent'), (req, res) => {
  const child = db.users.findOne({ id: String(req.body?.studentCode || '').trim(), role: 'student' });
  if (!child) return res.status(404).json({ error: 'student_not_found' });
  const childIds = [...new Set([...(req.user.childIds || []), child.id])];
  db.users.update(req.user.id, { childIds });
  db.links.insert({ parentId: req.user.id, studentId: child.id });
  db.notifications.insert({
    userId: child.id, kind: 'guardian_linked', read: false,
    data: { parentName: req.user.name }
  });
  res.json({ children: childIds.map(id => publicUser(db.users.byId(id))).filter(Boolean) });
});

router.get('/me/children', requireRole('parent'), (req, res) => {
  res.json({ children: (req.user.childIds || []).map(id => publicUser(db.users.byId(id))).filter(Boolean) });
});

router.delete('/me/children/:id', requireRole('parent'), (req, res) => {
  const childIds = (req.user.childIds || []).filter(i => i !== req.params.id);
  db.users.update(req.user.id, { childIds });
  db.links.removeWhere({ parentId: req.user.id, studentId: req.params.id });
  res.json({ ok: true });
});

export default router;
