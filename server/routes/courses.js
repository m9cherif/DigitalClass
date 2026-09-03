import { Router } from 'express';
import { db, id, now } from '../lib/db.js';
import { awardXp } from '../lib/gamification.js';
import {
  requireAuth, requireRole, canEditCourse, isEnrolled, publicUser, isGuardianOf
} from '../middleware/auth.js';

const router = Router();

/** Course catalogue with search, topic filter and localisation-aware fields. */
router.get('/', (req, res) => {
  const { q = '', topic, level, teacherId, mine } = req.query;
  let rows = db.courses.all()
    .filter(c => c.status === 'published' || (req.user && canEditCourse(req.user, c)));
  if (topic) rows = rows.filter(c => c.topic === topic);
  if (level) rows = rows.filter(c => c.level === level);
  if (teacherId) rows = rows.filter(c => c.teacherId === teacherId);
  if (mine === '1' && req.user) {
    const ids = new Set(db.enrollments.find({ userId: req.user.id, status: 'active' }).map(e => e.courseId));
    rows = rows.filter(c => ids.has(c.id));
  }
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter(c => JSON.stringify([c.title, c.description, c.tags]).toLowerCase().includes(needle));
  }
  res.json({
    courses: rows.map(c => ({
      ...c,
      teacher: publicUser(db.users.byId(c.teacherId)),
      lessonCount: db.lessons.count({ courseId: c.id }),
      quizCount: db.quizzes.count({ courseId: c.id }),
      studentCount: db.enrollments.count({ courseId: c.id, status: 'active' }),
      enrolled: req.user ? isEnrolled(req.user.id, c.id) : false
    }))
  });
});

router.get('/topics', (_req, res) => {
  const topics = {};
  for (const c of db.courses.all()) topics[c.topic] = (topics[c.topic] || 0) + 1;
  res.json({ topics });
});

router.get('/:id', (req, res) => {
  const course = db.courses.byId(req.params.id);
  if (!course) return res.status(404).json({ error: 'not_found' });
  const editable = canEditCourse(req.user, course);
  if (course.status !== 'published' && !editable) return res.status(403).json({ error: 'forbidden' });

  const enrolled = req.user ? isEnrolled(req.user.id, course.id) : false;
  const enrollment = req.user ? db.enrollments.findOne({ userId: req.user.id, courseId: course.id }) : null;
  const lessons = db.lessons.find({ courseId: course.id }).sort((a, b) => a.order - b.order);

  res.json({
    course: { ...course, teacher: publicUser(db.users.byId(course.teacherId)) },
    editable, enrolled,
    progress: enrollment?.progress || {},
    // Lesson bodies stay hidden from people who have not enrolled (previews excepted).
    lessons: lessons.map(l => (enrolled || editable || l.preview) ? l : { ...l, body: null, locked: true }),
    quizzes: db.quizzes.find({ courseId: course.id }).map(q => ({
      id: q.id, title: q.title, type: q.kind, questionCount: (q.questionIds || []).length,
      difficulty: q.difficulty, timeLimitSec: q.timeLimitSec, published: q.published,
      attempts: req.user ? db.attempts.count({ userId: req.user.id, quizId: q.id }) : 0
    })),
    assignments: db.assignments.find({ courseId: course.id }),
    resources: db.resources.find({ courseId: course.id })
  });
});

router.post('/', requireRole('teacher', 'admin'), (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'title_required' });
  const course = db.courses.insert({
    title: b.title, description: b.description || '',
    topic: b.topic || 'programming', level: b.level || 'beginner',
    lang: b.lang || 'fr', langs: b.langs || ['fr'],
    tags: b.tags || [], cover: b.cover || null, color: b.color || '#6366f1',
    teacherId: req.user.id, coTeacherIds: [], status: b.status || 'draft',
    estimatedHours: Number(b.estimatedHours) || 10
  });
  res.status(201).json({ course });
});

router.patch('/:id', requireAuth, (req, res) => {
  const course = db.courses.byId(req.params.id);
  if (!course) return res.status(404).json({ error: 'not_found' });
  if (!canEditCourse(req.user, course)) return res.status(403).json({ error: 'forbidden' });
  const allowed = ['title', 'description', 'topic', 'level', 'lang', 'langs', 'tags',
    'cover', 'color', 'status', 'estimatedHours', 'coTeacherIds'];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  res.json({ course: db.courses.update(course.id, patch) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const course = db.courses.byId(req.params.id);
  if (!course) return res.status(404).json({ error: 'not_found' });
  if (!canEditCourse(req.user, course)) return res.status(403).json({ error: 'forbidden' });
  db.lessons.removeWhere({ courseId: course.id });
  db.enrollments.removeWhere({ courseId: course.id });
  db.courses.remove(course.id);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- lessons */

router.post('/:id/lessons', requireAuth, (req, res) => {
  const course = db.courses.byId(req.params.id);
  if (!canEditCourse(req.user, course)) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  const order = b.order ?? db.lessons.count({ courseId: course.id }) + 1;
  const lesson = db.lessons.insert({
    courseId: course.id, title: b.title || 'Untitled', order,
    body: b.body || '', videoUrl: b.videoUrl || null, durationMin: Number(b.durationMin) || 10,
    preview: !!b.preview, attachments: b.attachments || [], i18n: b.i18n || {}
  });
  res.status(201).json({ lesson });
});

router.patch('/:courseId/lessons/:lessonId', requireAuth, (req, res) => {
  const course = db.courses.byId(req.params.courseId);
  if (!canEditCourse(req.user, course)) return res.status(403).json({ error: 'forbidden' });
  const allowed = ['title', 'body', 'order', 'videoUrl', 'durationMin', 'preview', 'attachments', 'i18n'];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  const lesson = db.lessons.update(req.params.lessonId, patch);
  if (!lesson) return res.status(404).json({ error: 'not_found' });
  res.json({ lesson });
});

router.delete('/:courseId/lessons/:lessonId', requireAuth, (req, res) => {
  const course = db.courses.byId(req.params.courseId);
  if (!canEditCourse(req.user, course)) return res.status(403).json({ error: 'forbidden' });
  db.lessons.remove(req.params.lessonId);
  res.json({ ok: true });
});

/** Mark a lesson done; completing the last one issues a certificate. */
router.post('/:courseId/lessons/:lessonId/complete', requireAuth, (req, res) => {
  const enrollment = db.enrollments.findOne({ userId: req.user.id, courseId: req.params.courseId, status: 'active' });
  if (!enrollment) return res.status(403).json({ error: 'not_enrolled' });

  const progress = { ...(enrollment.progress || {}), [req.params.lessonId]: { done: true, at: now() } };
  const total = db.lessons.count({ courseId: req.params.courseId });
  const done = Object.values(progress).filter(p => p.done).length;
  const completed = total > 0 && done >= total;

  db.enrollments.update(enrollment.id, {
    progress, completed, completedAt: completed ? now() : enrollment.completedAt || null
  });

  const gain = awardXp(req.user.id, 15, 'lesson_complete');
  let certificate = null;
  if (completed && !db.certificates.findOne({ userId: req.user.id, courseId: req.params.courseId })) {
    const course = db.courses.byId(req.params.courseId);
    certificate = db.certificates.insert({
      userId: req.user.id, courseId: course.id, courseTitle: course.title,
      studentName: req.user.name, serial: id('DC-'), issuedAt: now()
    });
    awardXp(req.user.id, 100, 'course_complete');
  }
  res.json({ progress, done, total, completed, certificate, gain });
});

/* ------------------------------------------------------------ enrollment */

router.post('/:id/enroll', requireRole('student'), (req, res) => {
  const course = db.courses.byId(req.params.id);
  if (!course || course.status !== 'published') return res.status(404).json({ error: 'not_found' });
  const existing = db.enrollments.findOne({ userId: req.user.id, courseId: course.id });
  if (existing) {
    db.enrollments.update(existing.id, { status: 'active' });
    return res.json({ enrollment: db.enrollments.byId(existing.id) });
  }
  const enrollment = db.enrollments.insert({
    userId: req.user.id, courseId: course.id, status: 'active',
    progress: {}, completed: false, enrolledAt: now()
  });
  db.notifications.insert({
    userId: course.teacherId, kind: 'new_student', read: false,
    data: { courseId: course.id, courseTitle: course.title, studentName: req.user.name }
  });
  awardXp(req.user.id, 10, 'enroll');
  res.status(201).json({ enrollment });
});

router.delete('/:id/enroll', requireAuth, (req, res) => {
  db.enrollments.updateWhere({ userId: req.user.id, courseId: req.params.id }, { status: 'dropped' });
  res.json({ ok: true });
});

/** Roster with per-student progress — teachers and admins only. */
router.get('/:id/roster', requireAuth, (req, res) => {
  const course = db.courses.byId(req.params.id);
  if (!canEditCourse(req.user, course)) return res.status(403).json({ error: 'forbidden' });
  const total = Math.max(1, db.lessons.count({ courseId: course.id }));
  const roster = db.enrollments.find({ courseId: course.id, status: 'active' }).map(e => {
    const student = db.users.byId(e.userId);
    const attempts = db.attempts.find({ userId: e.userId, courseId: course.id, status: 'graded' });
    const avg = attempts.length
      ? +(attempts.reduce((s, a) => s + (a.result?.percent || 0), 0) / attempts.length).toFixed(1) : null;
    return {
      student: publicUser(student),
      lessonsDone: Object.values(e.progress || {}).filter(p => p.done).length,
      lessonsTotal: total,
      completed: e.completed,
      attempts: attempts.length,
      averageScore: avg,
      lastActive: student?.lastActiveDay || null
    };
  });
  res.json({ roster });
});

/* -------------------------------------------------- assignments & drops */

router.post('/:id/assignments', requireAuth, (req, res) => {
  const course = db.courses.byId(req.params.id);
  if (!canEditCourse(req.user, course)) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  const assignment = db.assignments.insert({
    courseId: course.id, title: b.title || 'Assignment', brief: b.brief || '',
    dueAt: b.dueAt || null, points: Number(b.points) || 20,
    allowFiles: b.allowFiles !== false, allowCode: !!b.allowCode
  });
  for (const e of db.enrollments.find({ courseId: course.id, status: 'active' })) {
    db.notifications.insert({
      userId: e.userId, kind: 'assignment', read: false,
      data: { courseId: course.id, assignmentId: assignment.id, title: assignment.title, dueAt: assignment.dueAt }
    });
  }
  res.status(201).json({ assignment });
});

router.post('/assignments/:id/submit', requireRole('student'), (req, res) => {
  const assignment = db.assignments.byId(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'not_found' });
  if (!isEnrolled(req.user.id, assignment.courseId)) return res.status(403).json({ error: 'not_enrolled' });
  const late = assignment.dueAt ? new Date() > new Date(assignment.dueAt) : false;
  const existing = db.submissions.findOne({ assignmentId: assignment.id, userId: req.user.id });
  const payload = {
    assignmentId: assignment.id, courseId: assignment.courseId, userId: req.user.id,
    text: req.body?.text || '', code: req.body?.code || '', files: req.body?.files || [],
    late, status: 'submitted', submittedAt: now(), grade: null, feedback: null
  };
  const submission = existing ? db.submissions.update(existing.id, payload) : db.submissions.insert(payload);
  awardXp(req.user.id, 20, 'assignment_submit');
  res.json({ submission });
});

router.get('/assignments/:id/submissions', requireAuth, (req, res) => {
  const assignment = db.assignments.byId(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'not_found' });
  const course = db.courses.byId(assignment.courseId);
  if (!canEditCourse(req.user, course)) return res.status(403).json({ error: 'forbidden' });
  res.json({
    submissions: db.submissions.find({ assignmentId: assignment.id })
      .map(s => ({ ...s, student: publicUser(db.users.byId(s.userId)) }))
  });
});

router.post('/submissions/:id/grade', requireRole('teacher', 'admin'), (req, res) => {
  const submission = db.submissions.byId(req.params.id);
  if (!submission) return res.status(404).json({ error: 'not_found' });
  const course = db.courses.byId(submission.courseId);
  if (!canEditCourse(req.user, course)) return res.status(403).json({ error: 'forbidden' });
  const updated = db.submissions.update(submission.id, {
    grade: Number(req.body?.grade) || 0, feedback: req.body?.feedback || '',
    status: 'graded', gradedAt: now(), gradedBy: req.user.id
  });
  db.notifications.insert({
    userId: submission.userId, kind: 'graded', read: false,
    data: { assignmentId: submission.assignmentId, grade: updated.grade }
  });
  awardXp(submission.userId, Math.round(updated.grade), 'assignment_graded');
  res.json({ submission: updated });
});

/* ----------------------------------------------------- shared resources */

router.post('/:id/resources', requireAuth, (req, res) => {
  const course = db.courses.byId(req.params.id);
  if (!canEditCourse(req.user, course)) return res.status(403).json({ error: 'forbidden' });
  res.status(201).json({
    resource: db.resources.insert({
      courseId: course.id, title: req.body?.title || 'Resource',
      url: req.body?.url || '', kind: req.body?.kind || 'link', addedBy: req.user.id
    })
  });
});

/** A parent's read-only window onto one of their children. */
router.get('/child/:studentId/report', requireRole('parent', 'admin'), (req, res) => {
  const studentId = req.params.studentId;
  if (req.user.role === 'parent' && !isGuardianOf(req.user, studentId)) {
    return res.status(403).json({ error: 'not_your_child' });
  }
  const student = db.users.byId(studentId);
  if (!student) return res.status(404).json({ error: 'not_found' });
  const enrollments = db.enrollments.find({ userId: studentId, status: 'active' });
  const attempts = db.attempts.find({ userId: studentId, status: 'graded' });
  res.json({
    student: publicUser(student),
    courses: enrollments.map(e => {
      const course = db.courses.byId(e.courseId);
      const total = Math.max(1, db.lessons.count({ courseId: e.courseId }));
      return {
        course: course && { id: course.id, title: course.title, color: course.color },
        percent: Math.round((Object.values(e.progress || {}).filter(p => p.done).length / total) * 100),
        completed: e.completed
      };
    }),
    stats: {
      attempts: attempts.length,
      averageScore: attempts.length
        ? +(attempts.reduce((s, a) => s + (a.result?.percent || 0), 0) / attempts.length).toFixed(1) : null,
      xp: student.xp || 0, level: student.level || 1, streak: student.streak || 0,
      badges: db.awards.count({ userId: studentId }),
      certificates: db.certificates.find({ userId: studentId })
    },
    recent: attempts.slice(-10).reverse().map(a => ({
      quiz: db.quizzes.byId(a.quizId)?.title, percent: a.result?.percent, at: a.submittedAt
    }))
  });
});

export default router;
