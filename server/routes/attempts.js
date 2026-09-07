import { Router } from 'express';
import { db, now } from '../lib/db.js';
import { gradeAttempt, nextReview } from '../quiz/grader.js';
import { normaliseMedia } from '../quiz/types.js';
import { courseMemberIds } from './courses.js';
import { awardXp, xpForAttempt } from '../lib/gamification.js';
import { sanitize } from './quizzes.js';
import { requireAuth, requireRole, canEditCourse, isEnrolled, publicUser } from '../middleware/auth.js';

const router = Router();

const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/** Open an attempt: locks in the question order and starts the clock. */
router.post('/start', requireAuth, (req, res) => {
  const quiz = db.quizzes.byId(req.body?.quizId);
  if (!quiz) return res.status(404).json({ error: 'quiz_not_found' });
  // Admins run the platform, they are not learners: no attempts, no scores,
  // no leaderboard presence.
  if (req.user.role === 'admin') {
    return res.status(403).json({ error: 'role_cannot_attempt', role: req.user.role });
  }
  const course = db.courses.byId(quiz.courseId);
  const teaching = canEditCourse(req.user, course);
  if (!quiz.published && !teaching) return res.status(403).json({ error: 'not_published' });
  if (!teaching && req.user.role === 'student' && !isEnrolled(req.user.id, quiz.courseId)) {
    return res.status(403).json({ error: 'not_enrolled' });
  }
  if (quiz.maxAttempts > 0 && db.attempts.count({ userId: req.user.id, quizId: quiz.id }) >= quiz.maxAttempts) {
    return res.status(429).json({ error: 'max_attempts_reached', max: quiz.maxAttempts });
  }

  const open = db.attempts.findOne({ userId: req.user.id, quizId: quiz.id, status: 'in_progress' });
  if (open) {
    return res.json({ attempt: open, questions: open.order.map(i => sanitize(db.questions.byId(i))).filter(Boolean), resumed: true });
  }

  let ids = [...(quiz.questionIds || [])];
  if (quiz.shuffleQuestions) ids = shuffle(ids);
  const questions = ids.map(i => db.questions.byId(i)).filter(Boolean);

  const attempt = db.attempts.insert({
    userId: req.user.id, quizId: quiz.id, courseId: quiz.courseId,
    mode: req.body?.mode || 'solo', partyId: req.body?.partyId || null,
    order: questions.map(q => q.id), responses: {}, status: 'in_progress',
    startedAt: now(), deadline: quiz.timeLimitSec ? new Date(Date.now() + quiz.timeLimitSec * 1000).toISOString() : null
  });
  res.status(201).json({ attempt, questions: questions.map(sanitize), resumed: false });
});

/** Autosave — students can close the tab without losing work. */
router.patch('/:id/save', requireAuth, (req, res) => {
  const attempt = db.attempts.byId(req.params.id);
  if (!attempt || attempt.userId !== req.user.id) return res.status(404).json({ error: 'not_found' });
  if (attempt.status !== 'in_progress') return res.status(409).json({ error: 'already_submitted' });
  const responses = { ...attempt.responses, ...(req.body?.responses || {}) };
  db.attempts.update(attempt.id, { responses, savedAt: now() });
  res.json({ ok: true, saved: Object.keys(responses).length });
});

router.post('/:id/submit', requireAuth, (req, res) => {
  const attempt = db.attempts.byId(req.params.id);
  if (!attempt || attempt.userId !== req.user.id) return res.status(404).json({ error: 'not_found' });
  if (attempt.status !== 'in_progress') {
    return res.status(409).json({ error: 'already_submitted', attemptId: attempt.id });
  }
  const quiz = db.quizzes.byId(attempt.quizId);
  const responses = { ...attempt.responses, ...(req.body?.responses || {}) };
  const questions = attempt.order.map(i => db.questions.byId(i)).filter(Boolean);

  // A late submission still grades, but the overtime is recorded.
  const durationSec = Math.round((Date.now() - new Date(attempt.startedAt)) / 1000);
  const overtime = attempt.deadline ? Date.now() > new Date(attempt.deadline).getTime() + 5000 : false;

  const result = gradeAttempt(questions, responses);
  const passed = result.percent >= (quiz?.passPercent ?? 60);

  db.attempts.update(attempt.id, {
    responses, result, durationSec, overtime, passed,
    status: result.pending ? 'needs_review' : 'graded',
    submittedAt: now()
  });

  // Flashcard confidence feeds the spaced-repetition schedule.
  for (const q of questions.filter(q => q.type === 'flashcard')) {
    const state = db.flashcardStates.findOne({ userId: req.user.id, questionId: q.id });
    const sched = nextReview(state || {}, responses[q.id]?.confidence ?? 3);
    if (state) db.flashcardStates.update(state.id, sched);
    else db.flashcardStates.insert({ userId: req.user.id, questionId: q.id, courseId: q.courseId, ...sched });
  }

  const gain = quiz?.kind === 'survey' ? null : awardXp(req.user.id, xpForAttempt(result, quiz, durationSec), 'quiz');

  res.json({
    attempt: db.attempts.byId(attempt.id),
    result,
    passed,
    gain,
    // Answer keys and explanations are released only if the teacher allows it.
    review: quiz?.showAnswersAfter ? buildReview(questions, responses, result) : null
  });
});

function buildReview(questions, responses, result) {
  return questions.map(q => {
    const r = result.perQuestion.find(p => p.questionId === q.id);
    return {
      questionId: q.id, type: q.type, prompt: q.prompt,
      media: normaliseMedia(q.media),
      // Lets the review draw the click back onto the picture it was made on.
      image: q.data?.image ?? null,
      // Choice labels, so the review can say "Cyan" instead of "1".
      options: ['mcq_single', 'mcq_multiple', 'image_choice'].includes(q.type)
        ? (q.data?.options ?? null) : null,
      yourAnswer: responses[q.id] ?? null,
      correct: r?.correct, score: r?.score, earned: r?.earned, points: r?.points,
      feedback: r?.feedback, details: r?.details, explanation: q.explanation || ''
    };
  });
}

router.get('/:id', requireAuth, (req, res) => {
  const attempt = db.attempts.byId(req.params.id);
  if (!attempt) return res.status(404).json({ error: 'not_found' });
  const quiz = db.quizzes.byId(attempt.quizId);
  const teaching = canEditCourse(req.user, db.courses.byId(attempt.courseId));
  if (attempt.userId !== req.user.id && !teaching) return res.status(403).json({ error: 'forbidden' });

  const questions = attempt.order.map(i => db.questions.byId(i)).filter(Boolean);
  const showKeys = teaching || quiz?.showAnswersAfter;
  res.json({
    attempt, quiz,
    student: publicUser(db.users.byId(attempt.userId)),
    review: attempt.result && showKeys ? buildReview(questions, attempt.responses, attempt.result) : null
  });
});

router.get('/', requireAuth, (req, res) => {
  const { quizId, courseId, userId } = req.query;
  let rows = db.attempts.all();
  const teaching = courseId ? canEditCourse(req.user, db.courses.byId(courseId)) : false;
  rows = rows.filter(a => a.userId === req.user.id ||
    (req.user.role === 'admin') ||
    (teaching && a.courseId === courseId));
  if (quizId) rows = rows.filter(a => a.quizId === quizId);
  if (courseId) rows = rows.filter(a => a.courseId === courseId);
  if (userId) rows = rows.filter(a => a.userId === userId);
  res.json({
    attempts: rows.sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || '')).map(a => ({
      id: a.id, quizId: a.quizId, quiz: db.quizzes.byId(a.quizId)?.title,
      student: publicUser(db.users.byId(a.userId)),
      status: a.status, percent: a.result?.percent, passed: a.passed,
      durationSec: a.durationSec, submittedAt: a.submittedAt, mode: a.mode
    }))
  });
});

/** Manual grading pass for essay questions. */
router.post('/:id/review', requireRole('teacher', 'admin'), (req, res) => {
  const attempt = db.attempts.byId(req.params.id);
  if (!attempt) return res.status(404).json({ error: 'not_found' });
  if (!canEditCourse(req.user, db.courses.byId(attempt.courseId))) return res.status(403).json({ error: 'forbidden' });

  const scores = req.body?.scores || {};      // { questionId: earnedPoints }
  const comments = req.body?.comments || {};
  const result = { ...attempt.result };
  result.perQuestion = result.perQuestion.map(p => {
    if (scores[p.questionId] === undefined) return p;
    const earned = Math.max(0, Math.min(p.points, Number(scores[p.questionId])));
    return { ...p, earned, score: p.points ? earned / p.points : 0, correct: earned >= p.points,
      pending: false, teacherComment: comments[p.questionId] || p.teacherComment || '' };
  });
  result.earnedPoints = +result.perQuestion.reduce((s, p) => s + p.earned, 0).toFixed(3);
  result.percent = result.totalPoints ? +((result.earnedPoints / result.totalPoints) * 100).toFixed(2) : 0;
  result.pending = result.perQuestion.some(p => p.pending);

  const quiz = db.quizzes.byId(attempt.quizId);
  db.attempts.update(attempt.id, {
    result, status: result.pending ? 'needs_review' : 'graded',
    passed: result.percent >= (quiz?.passPercent ?? 60),
    reviewedBy: req.user.id, reviewedAt: now()
  });
  db.notifications.insert({
    userId: attempt.userId, kind: 'attempt_reviewed', read: false,
    data: { attemptId: attempt.id, percent: result.percent, quiz: quiz?.title }
  });
  if (!result.pending) awardXp(attempt.userId, xpForAttempt(result, quiz, attempt.durationSec), 'quiz_reviewed');
  res.json({ attempt: db.attempts.byId(attempt.id) });
});

/** Everything waiting on a human: essay answers across a teacher's courses. */
router.get('/queue/review', requireRole('teacher', 'admin'), (req, res) => {
  const mine = new Set(db.courses.all().filter(c => canEditCourse(req.user, c)).map(c => c.id));
  const rows = db.attempts.find({ status: 'needs_review' }).filter(a => mine.has(a.courseId));
  res.json({
    queue: rows.map(a => ({
      id: a.id, student: publicUser(db.users.byId(a.userId)),
      quiz: db.quizzes.byId(a.quizId)?.title, course: db.courses.byId(a.courseId)?.title,
      submittedAt: a.submittedAt,
      pendingQuestions: (a.result?.perQuestion || []).filter(p => p.pending).map(p => {
        const q = db.questions.byId(p.questionId);
        return { questionId: p.questionId, prompt: q?.prompt, points: p.points,
          rubric: q?.data?.rubric || [], answer: a.responses[p.questionId] };
      })
    }))
  });
});

/** Gradebook matrix: students down the side, quizzes across the top. */
router.get('/gradebook/:courseId', requireAuth, (req, res) => {
  const course = db.courses.byId(req.params.courseId);
  if (!canEditCourse(req.user, course)) return res.status(403).json({ error: 'forbidden' });
  const quizzes = db.quizzes.find({ courseId: course.id });
  const students = [...courseMemberIds(course)].map(id => db.users.byId(id)).filter(Boolean);

  const rows = students.map(s => {
    const cells = quizzes.map(q => {
      const attempts = db.attempts.find({ userId: s.id, quizId: q.id, status: 'graded' });
      const best = attempts.reduce((m, a) => Math.max(m, a.result?.percent || 0), attempts.length ? 0 : null);
      return { quizId: q.id, best, attempts: attempts.length };
    });
    const scored = cells.filter(c => c.best !== null);
    return {
      student: publicUser(s),
      cells,
      average: scored.length ? +(scored.reduce((t, c) => t + c.best, 0) / scored.length).toFixed(1) : null
    };
  });
  res.json({
    course: { id: course.id, title: course.title },
    quizzes: quizzes.map(q => ({ id: q.id, title: q.title, kind: q.kind, passPercent: q.passPercent })),
    rows,
    classAverage: rows.filter(r => r.average !== null).length
      ? +(rows.filter(r => r.average !== null).reduce((t, r) => t + r.average, 0) /
          rows.filter(r => r.average !== null).length).toFixed(1) : null
  });
});

/** Flashcards due today, oldest first. */
router.get('/flashcards/due', requireAuth, (req, res) => {
  const today = new Date().toISOString();
  const states = db.flashcardStates.find({ userId: req.user.id });
  const dueIds = new Set(states.filter(s => s.due <= today).map(s => s.questionId));
  const seen = new Set(states.map(s => s.questionId));
  const all = db.questions.find({ type: 'flashcard' })
    .filter(q => !req.query.courseId || q.courseId === req.query.courseId)
    .filter(q => dueIds.has(q.id) || !seen.has(q.id));
  res.json({
    due: all.slice(0, 30).map(q => ({ id: q.id, prompt: q.prompt, back: q.data?.back, i18n: q.i18n })),
    totalTracked: states.length,
    dueCount: all.length
  });
});

router.post('/flashcards/:questionId/review', requireAuth, (req, res) => {
  const q = db.questions.byId(req.params.questionId);
  if (!q) return res.status(404).json({ error: 'not_found' });
  const state = db.flashcardStates.findOne({ userId: req.user.id, questionId: q.id });
  const sched = nextReview(state || {}, req.body?.confidence ?? 3);
  const saved = state
    ? db.flashcardStates.update(state.id, sched)
    : db.flashcardStates.insert({ userId: req.user.id, questionId: q.id, courseId: q.courseId, ...sched });
  awardXp(req.user.id, 3, 'flashcard');
  res.json({ state: saved });
});

export default router;
