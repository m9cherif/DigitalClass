import { Router } from 'express';
import crypto from 'node:crypto';
import { db, now } from '../lib/db.js';
import { progress } from '../lib/gamification.js';
import { sendMail } from '../lib/mail.js';
import { sendSms } from '../lib/sms.js';
import {
  ROLES, hashPassword, checkPassword, signToken, publicUser, requireAuth, requireRole
} from '../middleware/auth.js';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+[1-9]\d{6,14}$/;

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

const newOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

/** Generates and delivers a fresh OTP over whichever channel the account
 *  uses — email or phone are mutually exclusive per user. Reused for first
 *  verification, resends, and every phone login (which is OTP-only).
 *
 *  Delivery happens BEFORE the otp/cooldown fields are written: if sending
 *  throws, the account is left exactly as it was (no live code, no cooldown
 *  started), so a retry via /resend-otp isn't blocked by a code that never
 *  actually reached anyone. */
async function issueAndSendOtp(user) {
  const code = newOtp();
  if (user.phone) {
    await sendSms(user.phone, `DigitalClass verification code: ${code} (valid 10 min)`);
  } else {
    await sendMail({
      to: user.email,
      subject: 'DigitalClass — your verification code',
      text: `Your DigitalClass verification code is ${code}. It expires in 10 minutes.`,
      html: `<p>Your DigitalClass verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It expires in 10 minutes.</p>`
    });
  }
  db.users.update(user.id, {
    otpHash: hashPassword(code), otpExpiresAt: Date.now() + OTP_TTL_MS,
    otpAttempts: 0, otpSentAt: Date.now()
  });
  // So a local/staging run never depends on inbox/phone access to test the flow.
  if (process.env.NODE_ENV !== 'production') console.log(`[otp] ${user.phone || user.email} -> ${code}`);
}

const newUserSkeleton = (extra) => ({
  status: 'active', verified: false, avatar: null, bio: '', xp: 0, level: 1,
  streak: 0, longestStreak: 0, childIds: [], theme: 'dark', ...extra
});

router.post('/register', async (req, res) => {
  const { name, email, password, role = 'student', lang = 'fr' } = req.body || {};
  if (!name || !EMAIL_RE.test(email || '')) return res.status(400).json({ error: 'invalid_email_or_name' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'weak_password', min: 8 });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'invalid_role' });
  // Registering as admin is only ever allowed to bootstrap the very first
  // one — once an admin exists, later admins must be promoted from the
  // admin console instead of self-registered.
  if (role === 'admin' && db.users.count({ role: 'admin' }) > 0) {
    return res.status(400).json({ error: 'invalid_role' });
  }
  if (db.users.findOne({ email: email.toLowerCase() })) return res.status(409).json({ error: 'email_taken' });

  const user = db.users.insert(newUserSkeleton({
    name: String(name).slice(0, 80), email: email.toLowerCase(),
    password: hashPassword(password), role, lang
  }));
  try {
    await issueAndSendOtp(user);
  } catch (err) {
    // Nobody could ever verify a row whose very first code never arrived —
    // drop it so the same email isn't stuck on "already taken" forever.
    db.users.remove(user.id);
    throw err;
  }
  res.status(201).json({ pendingVerification: true, userId: user.id, email: user.email });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.users.findOne({ email: String(email || '').toLowerCase() });
  if (!user || !checkPassword(password, user.password)) {
    return res.status(401).json({ error: 'bad_credentials' });
  }
  if (user.status === 'suspended') return res.status(403).json({ error: 'account_suspended' });
  // Rows created before email verification existed have no `verified` field
  // at all — undefined is treated as verified, so nobody who already had an
  // account is retroactively locked out by this requirement.
  if (user.verified === false) {
    return res.status(403).json({ error: 'email_not_verified', userId: user.id, email: user.email });
  }
  db.users.update(user.id, { lastLoginAt: new Date().toISOString() });
  res.json({ token: signToken(user), user: publicUser(user) });
});

/** Phone accounts carry no password — registering just reserves the number
 *  and role, exactly like /register does for email, and the OTP below is
 *  what actually creates the session. */
router.post('/phone/register', async (req, res) => {
  const { name, phone, role = 'student', lang = 'fr' } = req.body || {};
  if (!name) return res.status(400).json({ error: 'invalid_email_or_name' });
  if (!PHONE_RE.test(phone || '')) return res.status(400).json({ error: 'invalid_phone' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'invalid_role' });
  if (role === 'admin' && db.users.count({ role: 'admin' }) > 0) {
    return res.status(400).json({ error: 'invalid_role' });
  }
  if (db.users.findOne({ phone })) return res.status(409).json({ error: 'phone_taken' });

  const user = db.users.insert(newUserSkeleton({ name: String(name).slice(0, 80), phone, role, lang }));
  try {
    await issueAndSendOtp(user);
  } catch (err) {
    db.users.remove(user.id);
    throw err;
  }
  res.status(201).json({ pendingVerification: true, userId: user.id, phone: user.phone });
});

/** Phone login is OTP-only, every time — this just finds the account and
 *  sends the code; /verify below is what actually issues a session. */
router.post('/phone/login', async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  const user = db.users.findOne({ phone });
  if (!user) return res.status(404).json({ error: 'phone_not_found' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'account_suspended' });
  await issueAndSendOtp(user);
  res.json({ pendingVerification: true, userId: user.id, phone: user.phone });
});

/** The single OTP-check endpoint behind email verification, phone
 *  verification, and every phone login: it flips verified false -> true the
 *  first time (registration) and just issues a session every time after
 *  (recurring phone login), since a correct code proves the same thing
 *  either way. */
router.post('/verify', async (req, res) => {
  const { userId, code } = req.body || {};
  const user = db.users.byId(String(userId || ''));
  if (!user) return res.status(400).json({ error: 'invalid_verification' });
  if (!user.otpExpiresAt || Date.now() > user.otpExpiresAt) return res.status(400).json({ error: 'otp_expired' });
  if ((user.otpAttempts || 0) >= OTP_MAX_ATTEMPTS) return res.status(429).json({ error: 'too_many_attempts' });

  if (!checkPassword(String(code || ''), user.otpHash)) {
    db.users.update(user.id, { otpAttempts: (user.otpAttempts || 0) + 1 });
    return res.status(400).json({ error: 'invalid_code' });
  }

  const patch = { otpHash: null, otpExpiresAt: null, otpAttempts: 0, lastLoginAt: now() };
  if (user.verified === false) patch.verified = true;
  const updated = db.users.update(user.id, patch);
  res.json({ token: signToken(updated), user: publicUser(updated) });
});

router.post('/resend-otp', async (req, res) => {
  const user = db.users.byId(String(req.body?.userId || ''));
  if (!user) return res.status(400).json({ error: 'invalid_verification' });
  if (user.otpSentAt && Date.now() - user.otpSentAt < OTP_RESEND_COOLDOWN_MS) {
    return res.status(429).json({
      error: 'otp_cooldown', retryInSec: Math.ceil((OTP_RESEND_COOLDOWN_MS - (Date.now() - user.otpSentAt)) / 1000)
    });
  }
  await issueAndSendOtp(user);
  res.json({ ok: true });
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
