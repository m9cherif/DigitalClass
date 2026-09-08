import { Router } from 'express';
import multer from 'multer';
import { db, flushAll, COLLECTIONS } from '../lib/db.js';
import { UPLOAD_DIR } from '../lib/uploads.js';
import { QUESTION_TYPES } from '../quiz/types.js';
import crypto from 'node:crypto';
import { publicUser, requireAuth, requireRole, hashPassword, canEditCourse, signToken } from '../middleware/auth.js';
import { listRooms } from '../lib/party.js';

const router = Router();

/* ------------------------------------------------------------- analytics */

/** Dashboard tailored to the caller's role. */
router.get('/dashboard', requireAuth, (req, res) => {
  const u = req.user;

  if (u.role === 'student') {
    const enrollments = db.enrollments.find({ userId: u.id, status: 'active' });
    const attempts = db.attempts.find({ userId: u.id, status: 'graded' });
    const due = db.assignments.all().filter(a =>
      enrollments.some(e => e.courseId === a.courseId) && a.dueAt && new Date(a.dueAt) > new Date() &&
      !db.submissions.findOne({ assignmentId: a.id, userId: u.id }));
    return res.json({
      role: 'student',
      courses: enrollments.map(e => {
        const course = db.courses.byId(e.courseId);
        const total = Math.max(1, db.lessons.count({ courseId: e.courseId }));
        return course && {
          id: course.id, title: course.title, color: course.color, topic: course.topic,
          classId: course.classId || null,
          percent: Math.round((Object.values(e.progress || {}).filter(p => p.done).length / total) * 100)
        };
      }).filter(Boolean),
      stats: {
        attempts: attempts.length,
        averageScore: attempts.length ? +(attempts.reduce((s, a) => s + (a.result?.percent || 0), 0) / attempts.length).toFixed(1) : null,
        xp: u.xp || 0, level: u.level || 1, streak: u.streak || 0,
        badges: db.awards.count({ userId: u.id }),
        certificates: db.certificates.count({ userId: u.id }),
        flashcardsDue: db.flashcardStates.find({ userId: u.id }).filter(s => s.due <= new Date().toISOString()).length
      },
      dueSoon: due.slice(0, 5),
      recentScores: attempts.slice(-12).map(a => ({ at: a.submittedAt, percent: a.result?.percent || 0 })),
      byType: typeBreakdown(attempts)
    });
  }

  // teacher / admin
  const courses = db.courses.all().filter(c => canEditCourse(u, c));
  const courseIds = new Set(courses.map(c => c.id));
  const attempts = db.attempts.all().filter(a => courseIds.has(a.courseId) && a.status === 'graded');
  const students = new Set(db.enrollments.all().filter(e => courseIds.has(e.courseId) && e.status === 'active').map(e => e.userId));
  return res.json({
    role: u.role,
    courses: courses.map(c => ({
      id: c.id, title: c.title, color: c.color, status: c.status, classId: c.classId || null,
      students: db.enrollments.count({ courseId: c.id, status: 'active' }),
      quizzes: db.quizzes.count({ courseId: c.id }),
      lessons: db.lessons.count({ courseId: c.id })
    })),
    stats: {
      courses: courses.length, students: students.size, attempts: attempts.length,
      classAverage: attempts.length ? +(attempts.reduce((s, a) => s + (a.result?.percent || 0), 0) / attempts.length).toFixed(1) : null,
      needsReview: db.attempts.all().filter(a => a.status === 'needs_review' && courseIds.has(a.courseId)).length,
      ungradedSubmissions: db.submissions.all().filter(s => courseIds.has(s.courseId) && s.status === 'submitted').length,
      liveParties: listRooms().filter(r => r.hostName === u.name).length
    },
    activity: last14Days(attempts),
    byType: typeBreakdown(attempts)
  });
});

function typeBreakdown(attempts) {
  const acc = {};
  for (const a of attempts) {
    for (const q of a.result?.perQuestion || []) {
      acc[q.type] ??= { type: q.type, asked: 0, correct: 0 };
      acc[q.type].asked++;
      if (q.correct) acc[q.type].correct++;
    }
  }
  return Object.values(acc)
    .map(r => ({ ...r, accuracy: r.asked ? Math.round((r.correct / r.asked) * 100) : 0 }))
    .sort((a, b) => b.asked - a.asked);
}

function last14Days(attempts) {
  const days = Array.from({ length: 14 }, (_, i) => new Date(Date.now() - (13 - i) * 864e5).toISOString().slice(0, 10));
  const counts = Object.fromEntries(days.map(d => [d, 0]));
  for (const a of attempts) {
    const d = (a.submittedAt || '').slice(0, 10);
    if (d in counts) counts[d]++;
  }
  return days.map(d => ({ date: d, attempts: counts[d] }));
}

/** Per-question difficulty analysis — which items the class actually fails. */
router.get('/analytics/quiz/:quizId', requireAuth, (req, res) => {
  const quiz = db.quizzes.byId(req.params.quizId);
  if (!quiz) return res.status(404).json({ error: 'not_found' });
  if (!canEditCourse(req.user, db.courses.byId(quiz.courseId))) return res.status(403).json({ error: 'forbidden' });

  const attempts = db.attempts.find({ quizId: quiz.id, status: 'graded' });
  const items = (quiz.questionIds || []).map(qid => {
    const q = db.questions.byId(qid);
    const rows = attempts.map(a => (a.result?.perQuestion || []).find(p => p.questionId === qid)).filter(Boolean);
    const correct = rows.filter(r => r.correct).length;
    const wrongAnswers = {};
    for (const a of attempts) {
      const r = (a.result?.perQuestion || []).find(p => p.questionId === qid);
      if (r && !r.correct) {
        const key = JSON.stringify(a.responses?.[qid] ?? null);
        wrongAnswers[key] = (wrongAnswers[key] || 0) + 1;
      }
    }
    return {
      questionId: qid, prompt: q?.prompt, type: q?.type,
      attempts: rows.length, correct,
      difficulty: rows.length ? Math.round((1 - correct / rows.length) * 100) : null,
      commonMistakes: Object.entries(wrongAnswers).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([answer, count]) => ({ answer, count }))
    };
  });

  const scores = attempts.map(a => a.result?.percent || 0).sort((a, b) => a - b);
  res.json({
    quiz: { id: quiz.id, title: quiz.title },
    totals: {
      attempts: attempts.length,
      average: scores.length ? +(scores.reduce((s, v) => s + v, 0) / scores.length).toFixed(1) : null,
      median: scores.length ? scores[Math.floor(scores.length / 2)] : null,
      passRate: scores.length ? Math.round((scores.filter(s => s >= quiz.passPercent).length / scores.length) * 100) : null,
      averageDuration: attempts.length
        ? Math.round(attempts.reduce((s, a) => s + (a.durationSec || 0), 0) / attempts.length) : null
    },
    items: items.sort((a, b) => (b.difficulty ?? -1) - (a.difficulty ?? -1)),
    histogram: [0, 20, 40, 60, 80].map((lo, i, arr) => ({
      band: `${lo}-${i === arr.length - 1 ? 100 : lo + 19}`,
      count: scores.filter(s => s >= lo && s <= (i === arr.length - 1 ? 100 : lo + 19)).length
    }))
  });
});

/* ------------------------------------------------------------- live rooms */

// classId absent/empty -> the homepage hub's global rooms; a class id -> that
// class's own hub. The two never share a room or a history list.
router.get('/parties/live', requireAuth, (req, res) =>
  res.json({ rooms: listRooms({ classId: req.query.classId || null }) }));

router.get('/parties/history', requireAuth, (req, res) => {
  const classId = req.query.classId || null;
  const rows = db.parties.all()
    .filter(p => (p.classId || null) === classId)
    .filter(p => req.user.role === 'admin' || p.hostId === req.user.id ||
      p.players.some(pl => pl.userId === req.user.id))
    .sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || '')).slice(0, 50);
  res.json({ parties: rows });
});

/* --------------------------------------------------------------- uploads */

// Homework comes in whatever format a school actually uses — Word/Excel/
// PowerPoint (old .doc/.xls/.ppt binary formats included, not just the
// modern .docx/.xlsx/.pptx ones) and OpenDocument, alongside the original
// image/code/archive types.
const ALLOWED = /\.(png|jpe?g|gif|webp|svg|pdf|zip|rar|7z|txt|md|csv|json|js|py|c|cpp|java|sql|docx?|xlsx?|pptx?|odt|ods|odp)$/i;

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^\w.\-]/g, '_').slice(-60);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
    }
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED.test(file.originalname))
});

router.post('/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'rejected_file_type_or_size' });
  res.status(201).json({
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    size: req.file.size
  });
});

/* ----------------------------------------------------------- certificates */

router.get('/certificates/:serial', (req, res) => {
  const cert = db.certificates.findOne({ serial: req.params.serial });
  if (!cert) return res.status(404).json({ error: 'not_found' });
  res.json({ certificate: cert, valid: true });
});

router.get('/certificates', requireAuth, (req, res) => {
  res.json({ certificates: db.certificates.find({ userId: req.user.id }) });
});

/* ------------------------------------------------------------ admin only */

router.get('/users', requireRole('admin'), (req, res) => {
  const { role, q = '' } = req.query;
  let rows = db.users.all();
  if (role) rows = rows.filter(u => u.role === role);
  if (q) rows = rows.filter(u => (u.name + u.email).toLowerCase().includes(String(q).toLowerCase()));
  res.json({ users: rows.map(publicUser) });
});

router.patch('/users/:id', requireRole('admin'), (req, res) => {
  const allowed = ['role', 'status', 'name', 'email'];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  if (req.body?.password) patch.password = hashPassword(req.body.password);
  const user = db.users.update(req.params.id, patch);
  if (!user) return res.status(404).json({ error: 'not_found' });
  res.json({ user: publicUser(user) });
});

router.delete('/users/:id', requireRole('admin'), (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'cannot_delete_self' });
  db.users.update(req.params.id, { status: 'suspended' });
  res.json({ ok: true });
});

router.get('/stats', requireRole('admin'), (_req, res) => {
  res.json({
    counts: Object.fromEntries(COLLECTIONS.map(c => [c, db[c]?.all().length ?? 0])),
    users: {
      total: db.users.count(),
      students: db.users.count({ role: 'student' }),
      teachers: db.users.count({ role: 'teacher' }),
      active7d: db.users.all().filter(u => u.lastActiveDay &&
        u.lastActiveDay >= new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)).length
    },
    questionTypes: Object.fromEntries(Object.keys(QUESTION_TYPES).map(t => [t, db.questions.count({ type: t })])),
    liveParties: listRooms().length
  });
});

router.post('/backup', requireRole('admin'), (_req, res) => {
  flushAll();
  res.json({ ok: true, collections: COLLECTIONS, at: new Date().toISOString() });
});

/** Irreversible: erases every row in every collection, then immediately
 *  recreates the calling admin's own account with a fresh random password —
 *  a wipe must never lock every admin out of the platform it just reset. */
router.post('/wipe-all', requireRole('admin'), async (req, res) => {
  const { name, email, lang, theme } = req.user;
  for (const collection of COLLECTIONS) db[collection].clear();

  const password = crypto.randomBytes(9).toString('base64url');
  const admin = db.users.insert({
    name, email, password: hashPassword(password), role: 'admin', status: 'active',
    avatar: null, bio: '', xp: 0, level: 1, streak: 0, longestStreak: 0,
    childIds: [], lang: lang || 'fr', theme: theme || 'dark'
  });
  await flushAll();

  res.json({
    ok: true, wipedAt: new Date().toISOString(),
    token: signToken(admin), user: publicUser(admin), temporaryPassword: password
  });
});

export default router;
