import { Router } from 'express';
import { db, id, now } from '../lib/db.js';
import { awardXp } from '../lib/gamification.js';
import {
  requireAuth, requireRole, canEditCourse, canEditClass, isEnrolled,
  accessibleCourseIds, publicUser
} from '../middleware/auth.js';

const router = Router();

/** Every student with access to a course: direct enrolments plus, if the
 *  course belongs to a class, every active member of that class. */
export function courseMemberIds(course) {
  const ids = new Set(db.enrollments.find({ courseId: course.id, status: 'active' }).map(e => e.userId));
  if (course.classId) {
    for (const e of db.classEnrollments.find({ classId: course.classId, status: 'active' })) ids.add(e.userId);
  }
  return ids;
}

/** Course catalogue with search, topic filter and localisation-aware fields.
 *  Joining happens at the class level now (see routes/classes.js); a course
 *  on its own has no code of its own any more. */
router.get('/', (req, res) => {
  const { q = '', topic, level, teacherId, mine, classId } = req.query;
  const myCourseIds = req.user ? accessibleCourseIds(req.user.id) : new Set();

  // Drafts stay out of the public catalogue, but remain visible to their
  // teacher and to students who already have access through their class.
  let rows = db.courses.all().filter(c =>
    c.status === 'published' || myCourseIds.has(c.id) || (req.user && canEditCourse(req.user, c)));
  if (topic) rows = rows.filter(c => c.topic === topic);
  if (level) rows = rows.filter(c => c.level === level);
  if (teacherId) rows = rows.filter(c => c.teacherId === teacherId);
  if (classId) rows = rows.filter(c => c.classId === classId);
  if (mine === '1' && req.user) rows = rows.filter(c => myCourseIds.has(c.id));
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
      studentCount: courseMemberIds(c).size,
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
  const enrolled = req.user ? isEnrolled(req.user.id, course.id) : false;
  // A draft is hidden from the catalogue, but a student who joined it with the
  // teacher's code is a member and must be able to open it — the code is the
  // invitation, so refusing here would strand them on a 403 right after joining.
  if (course.status !== 'published' && !editable && !enrolled) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const enrollment = req.user ? db.enrollments.findOne({ userId: req.user.id, courseId: course.id }) : null;
  const lessons = db.lessons.find({ courseId: course.id }).sort((a, b) => a.order - b.order);

  const cls = course.classId ? db.classes.byId(course.classId) : null;
  res.json({
    course: {
      ...course,
      teacher: publicUser(db.users.byId(course.teacherId)),
      class: cls ? { id: cls.id, title: cls.title } : null
    },
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
  // Every course lives inside a class now — there is no standalone catalogue
  // to find an orphan course in, and no page left that could even show one.
  if (!b.classId) return res.status(400).json({ error: 'class_required' });

  // Anyone who can edit the class can then edit this course too, so a
  // co-teacher of the class is not locked out of a course they didn't
  // personally create.
  const cls = db.classes.byId(b.classId);
  if (!cls || !canEditClass(req.user, cls)) return res.status(403).json({ error: 'forbidden' });
  const coTeacherIds = [...new Set([cls.teacherId, ...(cls.coTeacherIds || [])])].filter(x => x !== req.user.id);

  const course = db.courses.insert({
    title: b.title, description: b.description || '',
    classId: cls.id,
    topic: b.topic || 'programming', level: b.level || 'beginner',
    lang: b.lang || 'fr', langs: b.langs || ['fr'],
    tags: b.tags || [], cover: b.cover || null, color: b.color || cls.color || '#6366f1',
    teacherId: req.user.id, coTeacherIds, status: b.status || 'draft',
    estimatedHours: Number(b.estimatedHours) || 10
  });
  res.status(201).json({ course });
});

router.patch('/:id', requireAuth, (req, res) => {
  const course = db.courses.byId(req.params.id);
  if (!course) return res.status(404).json({ error: 'not_found' });
  if (!canEditCourse(req.user, course)) return res.status(403).json({ error: 'forbidden' });
  const allowed = ['title', 'description', 'topic', 'level', 'lang', 'langs', 'tags',
    'cover', 'color', 'status', 'estimatedHours', 'coTeacherIds', 'classId'];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  if ('classId' in patch && patch.classId) {
    const cls = db.classes.byId(patch.classId);
    if (!cls || !canEditClass(req.user, cls)) return res.status(403).json({ error: 'forbidden' });
  }
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

// Joining by code now happens once, at the class level (routes/classes.js),
// and grants every course inside it. A published, ungrouped course can still
// be enrolled in directly by browsing the catalogue:

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

/** Roster with per-student progress — teachers and admins only. Includes
 *  students who have access only through the course's class, not just those
 *  with a direct enrolment row. */
router.get('/:id/roster', requireAuth, (req, res) => {
  const course = db.courses.byId(req.params.id);
  if (!canEditCourse(req.user, course)) return res.status(403).json({ error: 'forbidden' });
  const total = Math.max(1, db.lessons.count({ courseId: course.id }));
  const roster = [...courseMemberIds(course)].map(userId => {
    const student = db.users.byId(userId);
    const e = db.enrollments.findOne({ userId, courseId: course.id, status: 'active' });
    const attempts = db.attempts.find({ userId, courseId: course.id, status: 'graded' });
    const avg = attempts.length
      ? +(attempts.reduce((s, a) => s + (a.result?.percent || 0), 0) / attempts.length).toFixed(1) : null;
    return {
      student: publicUser(student),
      lessonsDone: Object.values(e?.progress || {}).filter(p => p.done).length,
      lessonsTotal: total,
      completed: e?.completed || false,
      attempts: attempts.length,
      averageScore: avg,
      lastActive: student?.lastActiveDay || null
    };
  }).filter(r => r.student);
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
  for (const userId of courseMemberIds(course)) {
    db.notifications.insert({
      userId, kind: 'assignment', read: false,
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

/** A single assignment, with the class roster's submission status folded in
 *  so the grading page has everything in one request. */
router.get('/assignments/:id', requireAuth, (req, res) => {
  const assignment = db.assignments.byId(req.params.id);
  if (!assignment) return res.status(404).json({ error: 'not_found' });
  const course = db.courses.byId(assignment.courseId);
  if (!course) return res.status(404).json({ error: 'not_found' });

  const editable = canEditCourse(req.user, course);
  const mine = req.user ? db.submissions.findOne({ assignmentId: assignment.id, userId: req.user.id }) : null;
  if (!editable && !mine && !isEnrolled(req.user?.id, course.id)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const payload = {
    assignment: { ...assignment, course: { id: course.id, title: course.title, classId: course.classId || null } },
    editable
  };
  if (editable) {
    const roster = db.enrollments.find({ courseId: course.id, status: 'active' });
    payload.submissions = roster.map(e => {
      const submission = db.submissions.findOne({ assignmentId: assignment.id, userId: e.userId });
      return {
        student: publicUser(db.users.byId(e.userId)),
        submission: submission || null
      };
    });
  } else {
    payload.mySubmission = mine || null;
  }
  res.json(payload);
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

export default router;
