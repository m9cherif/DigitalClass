import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db } from '../lib/db.js';

// The fallback exists so `npm start` works out of the box locally. In
// production it would be a hole: the value is public in this repository, so
// anyone could mint an admin token. Refuse to boot instead.
const SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret';
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production — refusing to start with the public development secret.');
}
const TTL = '30d';

export const ROLES = ['admin', 'teacher', 'student'];

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
  const { password, resetToken, otpHash, otpExpiresAt, otpAttempts, ...rest } = u;
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

/** Teachers may only touch their own quiz; admins may touch any. A quiz
 *  made straight from the party hub has no course at all — ownership then
 *  falls back to whoever authored it, the same way a class-less course
 *  never existed for one to inherit editing rights from. */
export function canEditQuiz(user, quiz) {
  if (!user || !quiz) return false;
  if (user.role === 'admin') return true;
  if (quiz.courseId) return canEditCourse(user, db.courses.byId(quiz.courseId));
  return user.role === 'teacher' && quiz.authorId === user.id;
}

/**
 * A student has access to a course either through a direct per-course
 * enrolment (the original model, still used for courses that stand alone) or
 * by being a member of the class the course belongs to — joining a class
 * grants every course inside it, including ones added to the class later.
 */
export function isEnrolled(userId, courseId) {
  if (!userId) return false;
  if (db.enrollments.findOne({ userId, courseId, status: 'active' })) return true;
  const course = db.courses.byId(courseId);
  if (!course?.classId) return false;
  return !!db.classEnrollments.findOne({ userId, classId: course.classId, status: 'active' });
}

/** Teachers may only touch their own class; admins may touch any. */
export function canEditClass(user, cls) {
  if (!user || !cls) return false;
  if (user.role === 'admin') return true;
  return user.role === 'teacher' &&
    (cls.teacherId === user.id || (cls.coTeacherIds || []).includes(user.id));
}

export function isClassMember(userId, classId) {
  if (!userId) return false;
  return !!db.classEnrollments.findOne({ userId, classId, status: 'active' });
}

/** Every course id a user can open: direct enrolments plus every course
 *  inside a class they are a member of. */
export function accessibleCourseIds(userId) {
  if (!userId) return new Set();
  const ids = new Set(db.enrollments.find({ userId, status: 'active' }).map(e => e.courseId));
  const classIds = new Set(db.classEnrollments.find({ userId, status: 'active' }).map(e => e.classId));
  if (classIds.size) {
    for (const c of db.courses.all()) if (classIds.has(c.classId)) ids.add(c.id);
  }
  return ids;
}

