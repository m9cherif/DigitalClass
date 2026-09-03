import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db } from '../lib/db.js';

const SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret';
const TTL = '30d';

export const ROLES = ['admin', 'teacher', 'student', 'parent'];

export const hashPassword = pw => bcrypt.hashSync(pw, 10);
export const checkPassword = (pw, hash) => bcrypt.compareSync(pw, hash || '');

export const signToken = user =>
  jwt.sign({ sub: user.id, role: user.role, email: user.email }, SECRET, { expiresIn: TTL });

export function verifyToken(token) {
  try { return jwt.verify(token, SECRET); } catch { return null; }
}

/** Strips password hashes and other internals before a user leaves the API. */
export function publicUser(u) {
  if (!u) return null;
  const { password, resetToken, ...rest } = u;
  return rest;
}

function tokenFrom(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return req.cookies?.dc_token || null;
}

/** Populates req.user when a valid token is present; never rejects. */
export function attachUser(req, _res, next) {
  const payload = verifyToken(tokenFrom(req));
  req.user = payload ? db.users.byId(payload.sub) : null;
  if (req.user?.status === 'suspended') req.user = null;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden', need: roles });
    next();
  };
}

/** Teachers may only touch their own course; admins may touch any. */
export function canEditCourse(user, course) {
  if (!user || !course) return false;
  if (user.role === 'admin') return true;
  return user.role === 'teacher' &&
    (course.teacherId === user.id || (course.coTeacherIds || []).includes(user.id));
}

export function isEnrolled(userId, courseId) {
  return !!db.enrollments.findOne({ userId, courseId, status: 'active' });
}

/** A parent may read anything about a child linked to their account. */
export function isGuardianOf(parent, studentId) {
  return parent?.role === 'parent' && (parent.childIds || []).includes(studentId);
}
