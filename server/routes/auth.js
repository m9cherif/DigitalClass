import { Router } from 'express';
import crypto from 'node:crypto';
import { db, now } from '../lib/db.js';
import { progress } from '../lib/gamification.js';
import { sendMail } from '../lib/mail.js';
import { verifyGoogleIdToken } from '../lib/googleAuth.js';
import { verifyMicrosoftIdToken } from '../lib/microsoftAuth.js';
import { verifyFacebookAccessToken } from '../lib/facebookAuth.js';
import {
  ROLES, hashPassword, checkPassword, signToken, publicUser, requireAuth
} from '../middleware/auth.js';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

const newOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

async function issueAndSendOtp(user) {
  const code = newOtp();
  db.users.update(user.id, {
    otpHash: hashPassword(code), otpExpiresAt: Date.now() + OTP_TTL_MS,
    otpAttempts: 0, otpSentAt: Date.now()
  });
  await sendMail({
    to: user.email,
    subject: 'DigitalClass — your verification code',
    text: `Your DigitalClass verification code is ${code}. It expires in 10 minutes.`,
    html: `<p>Your DigitalClass verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It expires in 10 minutes.</p>`
  });
  // So a local/staging run never depends on inbox access to test the flow.
  if (process.env.NODE_ENV !== 'production') console.log(`[otp] ${user.email} -> ${code}`);
}

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

  const user = db.users.insert({
    name: String(name).slice(0, 80),
    email: email.toLowerCase(),
    password: hashPassword(password),
    role, lang, status: 'active', emailVerified: false,
    avatar: null, bio: '', xp: 0, level: 1, streak: 0, longestStreak: 0,
    childIds: [], theme: 'dark'
  });
  await issueAndSendOtp(user);
  res.status(201).json({ pendingVerification: true, userId: user.id, email: user.email });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.users.findOne({ email: String(email || '').toLowerCase() });
  if (!user || !checkPassword(password, user.password)) {
    return res.status(401).json({ error: 'bad_credentials' });
  }
  if (user.status === 'suspended') return res.status(403).json({ error: 'account_suspended' });
  // Rows created before email verification existed have no emailVerified
  // field at all — undefined is treated as verified, so nobody who already
  // had an account is retroactively locked out by this requirement.
  if (user.emailVerified === false) {
    return res.status(403).json({ error: 'email_not_verified', userId: user.id, email: user.email });
  }
  db.users.update(user.id, { lastLoginAt: new Date().toISOString() });
  res.json({ token: signToken(user), user: publicUser(user) });
});

/**
 * Google already verified this person owns the email, so no password and
 * no OTP: an existing account (matched by email) logs straight in. A first
 * time sign-in has no role to put on the account yet — it comes back with
 * needsRole so the client can ask once, then resend the same credential
 * together with the chosen role to actually create the account.
 */
router.post('/google', async (req, res) => {
  const { credential, role } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'invalid_verification' });

  let payload;
  try {
    payload = await verifyGoogleIdToken(credential);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.code || 'google_auth_failed' });
  }
  if (!payload.email || payload.email_verified !== true) {
    return res.status(400).json({ error: 'google_email_unverified' });
  }
  const email = payload.email.toLowerCase();

  const existing = db.users.findOne({ email });
  if (existing) {
    if (existing.status === 'suspended') return res.status(403).json({ error: 'account_suspended' });
    const updated = db.users.update(existing.id, { lastLoginAt: now(), googleId: payload.sub });
    return res.json({ token: signToken(updated), user: publicUser(updated) });
  }

  if (!role) return res.json({ needsRole: true, name: payload.name, email });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'invalid_role' });
  if (role === 'admin' && db.users.count({ role: 'admin' }) > 0) {
    return res.status(400).json({ error: 'invalid_role' });
  }

  const user = db.users.insert({
    name: String(payload.name || email.split('@')[0]).slice(0, 80),
    email, role, lang: 'fr', status: 'active', emailVerified: true, googleId: payload.sub,
    avatar: payload.picture || null, bio: '', xp: 0, level: 1, streak: 0, longestStreak: 0,
    childIds: [], theme: 'dark'
  });
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

/** Mirrors /google exactly, just against Microsoft's identity platform —
 *  same needsRole handshake for a first-ever sign-in, same instant login by
 *  email match otherwise. */
router.post('/microsoft', async (req, res) => {
  const { credential, role } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'invalid_verification' });

  let payload;
  try {
    payload = await verifyMicrosoftIdToken(credential);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.code || 'microsoft_auth_failed', detail: err.message });
  }
  const rawEmail = payload.email || payload.preferred_username || '';
  if (!EMAIL_RE.test(rawEmail)) {
    return res.status(400).json({ error: 'microsoft_email_unverified' });
  }
  const email = rawEmail.toLowerCase();

  const existing = db.users.findOne({ email });
  if (existing) {
    if (existing.status === 'suspended') return res.status(403).json({ error: 'account_suspended' });
    const updated = db.users.update(existing.id, { lastLoginAt: now(), microsoftId: payload.sub || payload.oid });
    return res.json({ token: signToken(updated), user: publicUser(updated) });
  }

  if (!role) return res.json({ needsRole: true, name: payload.name, email });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'invalid_role' });
  if (role === 'admin' && db.users.count({ role: 'admin' }) > 0) {
    return res.status(400).json({ error: 'invalid_role' });
  }

  const user = db.users.insert({
    name: String(payload.name || email.split('@')[0]).slice(0, 80),
    email, role, lang: 'fr', status: 'active', emailVerified: true, microsoftId: payload.sub || payload.oid,
    avatar: null, bio: '', xp: 0, level: 1, streak: 0, longestStreak: 0,
    childIds: [], theme: 'dark'
  });
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

/** Same needsRole handshake as /google and /microsoft, fed by a Facebook
 *  Graph API profile instead of an ID token — accessToken is the token
 *  FB.login() already returns in the browser, re-verified here (and safe to
 *  re-verify again on the role-selection follow-up, unlike a one-time
 *  authorization code would be). */
router.post('/facebook', async (req, res) => {
  const { accessToken, role } = req.body || {};
  if (!accessToken) return res.status(400).json({ error: 'invalid_verification' });

  let profile;
  try {
    profile = await verifyFacebookAccessToken(accessToken);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.code || 'facebook_auth_failed', detail: err.message });
  }
  if (!profile.email || !EMAIL_RE.test(profile.email)) {
    return res.status(400).json({
      error: 'facebook_email_unverified',
      detail: `granted scopes: ${profile.grantedScopes?.join(', ') || 'none'}`
    });
  }
  const email = profile.email.toLowerCase();

  const existing = db.users.findOne({ email });
  if (existing) {
    if (existing.status === 'suspended') return res.status(403).json({ error: 'account_suspended' });
    const updated = db.users.update(existing.id, { lastLoginAt: now(), facebookId: profile.id });
    return res.json({ token: signToken(updated), user: publicUser(updated) });
  }

  if (!role) return res.json({ needsRole: true, name: profile.name, email });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'invalid_role' });
  if (role === 'admin' && db.users.count({ role: 'admin' }) > 0) {
    return res.status(400).json({ error: 'invalid_role' });
  }

  const user = db.users.insert({
    name: String(profile.name || email.split('@')[0]).slice(0, 80),
    email, role, lang: 'fr', status: 'active', emailVerified: true, facebookId: profile.id,
    avatar: null, bio: '', xp: 0, level: 1, streak: 0, longestStreak: 0,
    childIds: [], theme: 'dark'
  });
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

/** Completes registration: the OTP just emailed is the only thing standing
 *  between an unverified account and a real session. */
router.post('/verify-email', async (req, res) => {
  const { userId, code } = req.body || {};
  const user = db.users.byId(String(userId || ''));
  if (!user || user.emailVerified !== false) return res.status(400).json({ error: 'invalid_verification' });
  if (!user.otpExpiresAt || Date.now() > user.otpExpiresAt) return res.status(400).json({ error: 'otp_expired' });
  if ((user.otpAttempts || 0) >= OTP_MAX_ATTEMPTS) return res.status(429).json({ error: 'too_many_attempts' });

  if (!checkPassword(String(code || ''), user.otpHash)) {
    db.users.update(user.id, { otpAttempts: (user.otpAttempts || 0) + 1 });
    return res.status(400).json({ error: 'invalid_code' });
  }

  const verified = db.users.update(user.id, {
    emailVerified: true, otpHash: null, otpExpiresAt: null, otpAttempts: 0,
    lastLoginAt: now()
  });
  res.json({ token: signToken(verified), user: publicUser(verified) });
});

router.post('/resend-otp', async (req, res) => {
  const user = db.users.byId(String(req.body?.userId || ''));
  if (!user || user.emailVerified !== false) return res.status(400).json({ error: 'invalid_verification' });
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


export default router;
