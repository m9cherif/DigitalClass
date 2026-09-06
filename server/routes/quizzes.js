import { Router } from 'express';
import { db } from '../lib/db.js';
import { QUESTION_TYPES, TYPE_LIST, normaliseMedia, typesByGroup } from '../quiz/types.js';
import { runJs } from '../quiz/sandbox.js';
import { requireAuth, requireRole, canEditCourse } from '../middleware/auth.js';

const router = Router();

/** Strip every answer key before a question is sent to a student. */
export function sanitize(question) {
  const d = question.data || {};
  const safe = {};
  const carry = ['options', 'text', 'code', 'language', 'items', 'buckets', 'left', 'right',
    'image', 'regions', 'blanks', 'starter', 'functionName', 'schema', 'inputs', 'expression',
    'value', 'fromBase', 'toBase', 'minWords', 'rubric', 'placeholder', 'back',
    'multiple', 'markers', 'labels', 'imageAlt'];
  for (const k of carry) if (d[k] !== undefined) safe[k] = d[k];

  if (d.blanks) safe.blanks = d.blanks.map((b, i) => ({ index: i, hint: b.hint || null }));
  if (d.tests) safe.tests = d.tests.filter(t => !t.hidden).map(t => ({ name: t.name, args: t.args, expected: t.expected }));
  if (d.tests) safe.hiddenTestCount = d.tests.filter(t => t.hidden).length;
  if (question.type === 'matching' && d.right) safe.right = shuffle([...d.right]);
  if (question.type === 'ordering' && d.items) safe.items = shuffle([...d.items]);
  if (question.type === 'flashcard') delete safe.back;

  // Image types: the answer geometry must never reach the browser, or the
  // target could simply be read out of the markup.
  if (question.type === 'image_hotspot') delete safe.zones;
  if (question.type === 'image_label') {
    safe.markers = (d.markers || []).map(m => ({ id: m.id, x: m.x, y: m.y }));
    safe.labels = shuffle([...(d.labels || [])]);
  }
  if (question.type === 'image_order' && d.items) safe.items = shuffle([...d.items]);

  return {
    id: question.id, type: question.type, prompt: question.prompt, i18n: question.i18n || {},
    points: question.points ?? 1, difficulty: question.difficulty, hint: question.hint || null,
    media: normaliseMedia(question.media), tags: question.tags || [], data: safe
  };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

router.get('/types', (_req, res) => {
  res.json({
    types: TYPE_LIST.map(t => ({ id: t, ...QUESTION_TYPES[t] })),
    groups: typesByGroup()
  });
});

/** Quiz list — teachers see their drafts, students only published ones. */
router.get('/', requireAuth, (req, res) => {
  const { courseId, kind } = req.query;
  let rows = db.quizzes.all();
  if (courseId) rows = rows.filter(q => q.courseId === courseId);
  if (kind) rows = rows.filter(q => q.kind === kind);
  rows = rows.filter(q => {
    const course = db.courses.byId(q.courseId);
    return q.published || canEditCourse(req.user, course);
  });
  res.json({
    quizzes: rows.map(q => ({
      ...q, questionIds: undefined,
      questionCount: (q.questionIds || []).length,
      course: db.courses.byId(q.courseId)?.title,
      myAttempts: db.attempts.count({ userId: req.user.id, quizId: q.id })
    }))
  });
});

router.get('/:id', requireAuth, (req, res) => {
  const quiz = db.quizzes.byId(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'not_found' });
  const course = db.courses.byId(quiz.courseId);
  const editable = canEditCourse(req.user, course);
  if (!quiz.published && !editable) return res.status(403).json({ error: 'forbidden' });

  const questions = (quiz.questionIds || []).map(qid => db.questions.byId(qid)).filter(Boolean);
  res.json({
    quiz, editable,
    // Teachers get the answer keys; everyone else gets sanitised questions.
    questions: editable ? questions : questions.map(sanitize),
    attempts: db.attempts.find({ userId: req.user.id, quizId: quiz.id })
      .map(a => ({ id: a.id, status: a.status, percent: a.result?.percent, submittedAt: a.submittedAt }))
  });
});

router.post('/', requireRole('teacher', 'admin'), (req, res) => {
  const b = req.body || {};
  const course = db.courses.byId(b.courseId);
  if (!course) return res.status(400).json({ error: 'course_required' });
  if (!canEditCourse(req.user, course)) return res.status(403).json({ error: 'forbidden' });
  const quiz = db.quizzes.insert({
    courseId: course.id, title: b.title || 'New quiz', description: b.description || '',
    kind: b.kind || 'practice',                 // practice | graded | exam | party | flashcards | survey
    difficulty: b.difficulty || 'medium',
    timeLimitSec: Number(b.timeLimitSec) || 0,  // 0 = untimed
    maxAttempts: Number(b.maxAttempts) || 0,    // 0 = unlimited
    shuffleQuestions: b.shuffleQuestions !== false,
    showAnswersAfter: b.showAnswersAfter ?? true,
    passPercent: Number(b.passPercent) || 60,
    questionIds: [], published: false, i18n: b.i18n || {},
    authorId: req.user.id
  });
  res.status(201).json({ quiz });
});

router.patch('/:id', requireAuth, (req, res) => {
  const quiz = db.quizzes.byId(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'not_found' });
  if (!canEditCourse(req.user, db.courses.byId(quiz.courseId))) return res.status(403).json({ error: 'forbidden' });
  const allowed = ['title', 'description', 'kind', 'difficulty', 'timeLimitSec', 'maxAttempts',
    'shuffleQuestions', 'showAnswersAfter', 'passPercent', 'published', 'questionIds', 'i18n'];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  res.json({ quiz: db.quizzes.update(quiz.id, patch) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const quiz = db.quizzes.byId(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'not_found' });
  if (!canEditCourse(req.user, db.courses.byId(quiz.courseId))) return res.status(403).json({ error: 'forbidden' });
  db.quizzes.remove(quiz.id);
  res.json({ ok: true });
});

/* ------------------------------------------------------------- questions */

function validateQuestion(body) {
  if (!TYPE_LIST.includes(body.type)) return `unknown_type:${body.type}`;
  if (!body.prompt) return 'prompt_required';
  const d = body.data || {};
  switch (body.type) {
    case 'mcq_single':
      if (!Array.isArray(d.options) || d.options.length < 2) return 'need_2_options';
      if (typeof d.answer !== 'number' || d.answer < 0 || d.answer >= d.options.length) return 'bad_answer_index';
      break;
    case 'mcq_multiple':
      if (!Array.isArray(d.options) || d.options.length < 2) return 'need_2_options';
      if (!Array.isArray(d.answer) || !d.answer.length) return 'need_answer_indices';
      break;
    case 'true_false':
      if (typeof d.answer !== 'boolean') return 'answer_must_be_boolean';
      break;
    case 'short_answer': case 'code_output': case 'sql_query': case 'terminal':
      if (!d.regex && (!Array.isArray(d.accepted) || !d.accepted.length)) return 'need_accepted_answers';
      break;
    case 'numeric':
      if (!Number.isFinite(Number(d.answer))) return 'need_numeric_answer';
      break;
    case 'fill_blanks':
      if (!Array.isArray(d.blanks) || !d.blanks.length) return 'need_blanks';
      break;
    case 'matching': case 'categorize':
      if (!d.answer || !Object.keys(d.answer).length) return 'need_answer_map';
      break;
    case 'ordering': case 'truth_table':
      if (!Array.isArray(d.answer) || !d.answer.length) return 'need_answer_array';
      break;
    case 'code_write': case 'code_fix':
      if (!d.functionName) return 'need_function_name';
      if (!Array.isArray(d.tests) || !d.tests.length) return 'need_tests';
      break;
    case 'bug_find':
      if (!Number.isFinite(Number(d.answer))) return 'need_line_number';
      break;
    case 'base_convert':
      if (!d.value || !d.fromBase || !d.toBase) return 'need_bases';
      break;
    case 'hotspot':
      if (!d.answer) return 'need_region';
      break;
    case 'image_choice':
      if (!Array.isArray(d.options) || d.options.length < 2) return 'need_2_images';
      if (d.options.some(o => !o?.url)) return 'every_option_needs_an_image';
      if (d.multiple ? !Array.isArray(d.answer) || !d.answer.length : typeof d.answer !== 'number') {
        return 'bad_answer_index';
      }
      break;
    case 'image_hotspot': {
      if (!d.image) return 'need_image';
      if (!Array.isArray(d.zones) || !d.zones.length) return 'need_zones';
      const ids = new Set(d.zones.map(z => String(z.id)));
      if (!Array.isArray(d.answer) || !d.answer.length) return 'need_answer_zone';
      if (d.answer.some(a => !ids.has(String(a)))) return 'answer_zone_not_in_zones';
      break;
    }
    case 'image_label':
      if (!d.image) return 'need_image';
      if (!Array.isArray(d.markers) || !d.markers.length) return 'need_markers';
      if (!Array.isArray(d.labels) || d.labels.length < 2) return 'need_2_labels';
      if (!d.answer || Object.keys(d.answer).length !== d.markers.length) return 'label_every_marker';
      break;
    case 'image_order':
      if (!Array.isArray(d.items) || d.items.length < 2) return 'need_2_images';
      if (d.items.some(i => !i?.url)) return 'every_item_needs_an_image';
      if (!Array.isArray(d.answer) || d.answer.length !== d.items.length) return 'need_answer_order';
      break;
  }
  return null;
}

router.post('/:id/questions', requireAuth, (req, res) => {
  const quiz = db.quizzes.byId(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'not_found' });
  if (!canEditCourse(req.user, db.courses.byId(quiz.courseId))) return res.status(403).json({ error: 'forbidden' });

  const err = validateQuestion(req.body || {});
  if (err) return res.status(400).json({ error: err });

  const b = req.body;
  const question = db.questions.insert({
    quizId: quiz.id, courseId: quiz.courseId, type: b.type, prompt: b.prompt,
    i18n: b.i18n || {}, data: b.data || {}, points: Number(b.points) || 1,
    difficulty: b.difficulty || quiz.difficulty, explanation: b.explanation || '',
    hint: b.hint || null, media: b.media || null, tags: b.tags || [], authorId: req.user.id
  });
  db.quizzes.update(quiz.id, { questionIds: [...(quiz.questionIds || []), question.id] });
  res.status(201).json({ question });
});

router.patch('/questions/:id', requireAuth, (req, res) => {
  const question = db.questions.byId(req.params.id);
  if (!question) return res.status(404).json({ error: 'not_found' });
  const quiz = db.quizzes.byId(question.quizId);
  if (!canEditCourse(req.user, db.courses.byId(quiz?.courseId))) return res.status(403).json({ error: 'forbidden' });
  const merged = { ...question, ...req.body };
  const err = validateQuestion(merged);
  if (err) return res.status(400).json({ error: err });
  const allowed = ['prompt', 'data', 'points', 'difficulty', 'explanation', 'hint', 'media', 'tags', 'i18n', 'type'];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  res.json({ question: db.questions.update(question.id, patch) });
});

router.delete('/questions/:id', requireAuth, (req, res) => {
  const question = db.questions.byId(req.params.id);
  if (!question) return res.status(404).json({ error: 'not_found' });
  const quiz = db.quizzes.byId(question.quizId);
  if (!canEditCourse(req.user, db.courses.byId(quiz?.courseId))) return res.status(403).json({ error: 'forbidden' });
  db.quizzes.update(quiz.id, { questionIds: (quiz.questionIds || []).filter(i => i !== question.id) });
  db.questions.remove(question.id);
  res.json({ ok: true });
});

/** Shared question bank: reuse any question a teacher can see. */
router.get('/bank/search', requireRole('teacher', 'admin'), (req, res) => {
  const { q = '', type, difficulty, tag } = req.query;
  let rows = db.questions.all();
  if (type) rows = rows.filter(r => r.type === type);
  if (difficulty) rows = rows.filter(r => r.difficulty === difficulty);
  if (tag) rows = rows.filter(r => (r.tags || []).includes(tag));
  if (q) rows = rows.filter(r => r.prompt.toLowerCase().includes(String(q).toLowerCase()));
  res.json({ questions: rows.slice(0, 100) });
});

router.post('/:id/questions/clone/:questionId', requireAuth, (req, res) => {
  const quiz = db.quizzes.byId(req.params.id);
  const source = db.questions.byId(req.params.questionId);
  if (!quiz || !source) return res.status(404).json({ error: 'not_found' });
  if (!canEditCourse(req.user, db.courses.byId(quiz.courseId))) return res.status(403).json({ error: 'forbidden' });
  const { id: _drop, createdAt, updatedAt, ...rest } = source;
  const clone = db.questions.insert({ ...rest, quizId: quiz.id, courseId: quiz.courseId, clonedFrom: source.id });
  db.quizzes.update(quiz.id, { questionIds: [...(quiz.questionIds || []), clone.id] });
  res.status(201).json({ question: clone });
});

/** Import a whole quiz from JSON — the fastest way to bulk-load content. */
router.post('/import', requireRole('teacher', 'admin'), (req, res) => {
  const { courseId, quiz: spec } = req.body || {};
  const course = db.courses.byId(courseId);
  if (!course || !canEditCourse(req.user, course)) return res.status(403).json({ error: 'forbidden' });
  if (!spec?.questions?.length) return res.status(400).json({ error: 'no_questions' });

  const errors = spec.questions.map((q, i) => ({ i, err: validateQuestion(q) })).filter(e => e.err);
  if (errors.length) return res.status(400).json({ error: 'invalid_questions', details: errors });

  const quiz = db.quizzes.insert({
    courseId, title: spec.title || 'Imported quiz', description: spec.description || '',
    kind: spec.kind || 'practice', difficulty: spec.difficulty || 'medium',
    timeLimitSec: spec.timeLimitSec || 0, maxAttempts: spec.maxAttempts || 0,
    shuffleQuestions: spec.shuffleQuestions !== false, showAnswersAfter: spec.showAnswersAfter ?? true,
    passPercent: spec.passPercent || 60, questionIds: [], published: !!spec.published,
    i18n: spec.i18n || {}, authorId: req.user.id
  });
  const ids = spec.questions.map(q => db.questions.insert({
    ...q, quizId: quiz.id, courseId, points: q.points ?? 1, authorId: req.user.id
  }).id);
  db.quizzes.update(quiz.id, { questionIds: ids });
  res.status(201).json({ quiz: db.quizzes.byId(quiz.id), imported: ids.length });
});

router.get('/:id/export', requireAuth, (req, res) => {
  const quiz = db.quizzes.byId(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'not_found' });
  if (!canEditCourse(req.user, db.courses.byId(quiz.courseId))) return res.status(403).json({ error: 'forbidden' });
  const questions = (quiz.questionIds || []).map(i => db.questions.byId(i)).filter(Boolean)
    .map(({ id, quizId, courseId, authorId, createdAt, updatedAt, ...q }) => q);
  res.setHeader('Content-Disposition', `attachment; filename="${quiz.id}.json"`);
  res.json({ title: quiz.title, description: quiz.description, kind: quiz.kind, difficulty: quiz.difficulty,
    timeLimitSec: quiz.timeLimitSec, passPercent: quiz.passPercent, questions });
});

/** Scratch playground — lets students run JS outside of any graded question. */
router.post('/playground/run', requireAuth, (req, res) => {
  const { code = '', fnName, tests } = req.body || {};
  if (code.length > 20000) return res.status(413).json({ error: 'code_too_long' });
  res.json(runJs(code, { fnName, tests }));
});

export default router;
