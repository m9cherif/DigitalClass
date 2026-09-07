/**
 * Classes: the container a student actually joins. A class groups any number
 * of courses under one teacher; one join code grants access to every course
 * inside it — including ones added after the student joined. Courses
 * themselves no longer carry their own invite code (see routes/courses.js).
 */
import { Router } from 'express';
import { db, now } from '../lib/db.js';
import { awardXp } from '../lib/gamification.js';
import {
  requireAuth, requireRole, canEditClass, isClassMember, publicUser
} from '../middleware/auth.js';

const router = Router();

// Ambiguous glyphs (0/O, 1/I) are left out so a code read aloud is unambiguous.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newClassCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (db.classes.findOne({ code }));
  return code;
}

const memberCount = cls => db.classEnrollments.count({ classId: cls.id, status: 'active' });
const courseCount = cls => db.courses.count({ classId: cls.id });

/** Every class a user can see: their own (teacher), or one they belong to. */
router.get('/', requireAuth, (req, res) => {
  const u = req.user;
  const myClassIds = new Set(db.classEnrollments.find({ userId: u.id, status: 'active' }).map(e => e.classId));
  const rows = db.classes.all().filter(c => canEditClass(u, c) || myClassIds.has(c.id));

  res.json({
    classes: rows.map(c => ({
      ...c,
      code: canEditClass(u, c) ? c.code : undefined,
      teacher: publicUser(db.users.byId(c.teacherId)),
      courseCount: courseCount(c),
      memberCount: memberCount(c),
      isMember: myClassIds.has(c.id)
    }))
  });
});

router.post('/', requireRole('teacher', 'admin'), (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'title_required' });
  const cls = db.classes.insert({
    title: b.title, description: b.description || '', color: b.color || '#9184d9',
    teacherId: req.user.id, coTeacherIds: [], status: b.status || 'published',
    code: newClassCode()
  });
  res.status(201).json({ class: cls });
});

router.get('/:id', requireAuth, (req, res) => {
  const cls = db.classes.byId(req.params.id);
  if (!cls) return res.status(404).json({ error: 'not_found' });
  const editable = canEditClass(req.user, cls);
  const isMember = isClassMember(req.user.id, cls.id);
  if (!editable && !isMember) return res.status(403).json({ error: 'forbidden' });

  res.json({
    class: { ...cls, code: editable ? cls.code : undefined, teacher: publicUser(db.users.byId(cls.teacherId)) },
    editable, isMember,
    memberCount: memberCount(cls)
  });
});

router.patch('/:id', requireAuth, (req, res) => {
  const cls = db.classes.byId(req.params.id);
  if (!cls) return res.status(404).json({ error: 'not_found' });
  if (!canEditClass(req.user, cls)) return res.status(403).json({ error: 'forbidden' });
  const allowed = ['title', 'description', 'color', 'status', 'coTeacherIds'];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  res.json({ class: db.classes.update(cls.id, patch) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const cls = db.classes.byId(req.params.id);
  if (!cls) return res.status(404).json({ error: 'not_found' });
  if (!canEditClass(req.user, cls)) return res.status(403).json({ error: 'forbidden' });
  // Courses are detached, not deleted — a teacher may want to keep the
  // lessons/quizzes and fold them into a different class later.
  db.courses.updateWhere({ classId: cls.id }, { classId: null });
  db.classEnrollments.removeWhere({ classId: cls.id });
  db.classes.remove(cls.id);
  res.json({ ok: true });
});

/** Join a class with its 6-character code. Grants every course inside it,
 *  including ones the teacher adds afterwards — there is nothing more to join. */
router.post('/join', requireRole('student'), (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (code.length !== 6) return res.status(400).json({ error: 'bad_code_format' });

  const cls = db.classes.findOne({ code });
  if (!cls) return res.status(404).json({ error: 'code_not_found' });

  const existing = db.classEnrollments.findOne({ userId: req.user.id, classId: cls.id });
  if (existing) {
    if (existing.status !== 'active') db.classEnrollments.update(existing.id, { status: 'active' });
    return res.json({ class: { id: cls.id, title: cls.title }, alreadyMember: true });
  }

  db.classEnrollments.insert({ userId: req.user.id, classId: cls.id, status: 'active', joinedAt: now() });
  db.notifications.insert({
    userId: cls.teacherId, kind: 'new_student', read: false,
    data: { classId: cls.id, courseTitle: cls.title, studentName: req.user.name }
  });
  awardXp(req.user.id, 10, 'enroll');
  res.status(201).json({ class: { id: cls.id, title: cls.title }, alreadyMember: false });
});

router.delete('/:id/leave', requireAuth, (req, res) => {
  db.classEnrollments.updateWhere({ userId: req.user.id, classId: req.params.id }, { status: 'dropped' });
  res.json({ ok: true });
});

/** A teacher/admin removes a specific student from their class — access to
 *  every course inside it goes with the membership; the student's own
 *  progress/attempts are left untouched in case they rejoin later. */
router.delete('/:id/members/:userId', requireAuth, (req, res) => {
  const cls = db.classes.byId(req.params.id);
  if (!cls) return res.status(404).json({ error: 'not_found' });
  if (!canEditClass(req.user, cls)) return res.status(403).json({ error: 'forbidden' });
  const n = db.classEnrollments.updateWhere(
    { classId: cls.id, userId: req.params.userId, status: 'active' }, { status: 'removed' }
  );
  if (!n) return res.status(404).json({ error: 'not_a_member' });
  res.json({ ok: true });
});

/** Rotate the code — used when it leaks or a term ends. */
router.post('/:id/code/regenerate', requireAuth, (req, res) => {
  const cls = db.classes.byId(req.params.id);
  if (!cls) return res.status(404).json({ error: 'not_found' });
  if (!canEditClass(req.user, cls)) return res.status(403).json({ error: 'forbidden' });
  res.json({ code: db.classes.update(cls.id, { code: newClassCode() }).code });
});

/** Members with an at-a-glance progress figure across every course in the class. */
router.get('/:id/roster', requireAuth, (req, res) => {
  const cls = db.classes.byId(req.params.id);
  if (!cls) return res.status(404).json({ error: 'not_found' });
  if (!canEditClass(req.user, cls)) return res.status(403).json({ error: 'forbidden' });

  const courses = db.courses.find({ classId: cls.id });
  const memberIds = new Set(db.classEnrollments.find({ classId: cls.id, status: 'active' }).map(e => e.userId));

  const roster = [...memberIds].map(userId => {
    const student = db.users.byId(userId);
    let done = 0, total = 0;
    for (const c of courses) {
      const lessons = db.lessons.count({ courseId: c.id });
      total += lessons;
      const e = db.enrollments.findOne({ userId, courseId: c.id });
      done += Object.values(e?.progress || {}).filter(p => p.done).length;
    }
    const attempts = db.attempts.find({ userId, status: 'graded' })
      .filter(a => courses.some(c => c.id === a.courseId));
    const avg = attempts.length
      ? +(attempts.reduce((s, a) => s + (a.result?.percent || 0), 0) / attempts.length).toFixed(1) : null;
    return {
      student: publicUser(student),
      lessonsDone: done, lessonsTotal: Math.max(1, total),
      attempts: attempts.length, averageScore: avg,
      lastActive: student?.lastActiveDay || null
    };
  }).filter(r => r.student);

  res.json({ class: { id: cls.id, title: cls.title }, courses: courses.length, roster });
});

export default router;
