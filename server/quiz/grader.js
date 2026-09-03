/**
 * Grading engine. grade(question, response) -> { score 0..1, correct, feedback, details }
 * Every branch is pure except the code_* ones, which call the vm sandbox.
 */
import { runJs } from './sandbox.js';
import { isAutoGraded } from './types.js';

const norm = (s, caseSensitive = false) => {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ');
  return caseSensitive ? t : t.toLowerCase();
};
const normSql = s => String(s ?? '')
  .replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ')
  .replace(/\s*([(),;=<>*])\s*/g, '$1').replace(/;$/, '').trim().toLowerCase();
const normCmd = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const arr = v => Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]);
const clamp01 = n => Math.max(0, Math.min(1, n));

/** Levenshtein ratio, used to forgive small typos in short answers. */
export function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

const result = (score, feedback, details = {}) => ({
  score: clamp01(score), correct: clamp01(score) >= 0.999, feedback, details
});

export function grade(question, response) {
  const d = question.data ?? {};
  const t = question.type;

  if (!isAutoGraded(t)) {
    return { score: 0, correct: false, pending: true, feedback: 'awaiting_teacher', details: {} };
  }

  switch (t) {
    case 'mcq_single': {
      const ok = Number(response) === Number(d.answer);
      return result(ok ? 1 : 0, ok ? 'correct' : 'wrong_option', { expected: d.answer });
    }

    case 'mcq_multiple': {
      const picked = new Set(arr(response).map(Number));
      const right = new Set(arr(d.answer).map(Number));
      const total = d.options?.length ?? right.size;
      const hits = [...right].filter(i => picked.has(i)).length;
      const falsePos = [...picked].filter(i => !right.has(i)).length;
      if (d.partial === false) {
        const exact = hits === right.size && falsePos === 0;
        return result(exact ? 1 : 0, exact ? 'correct' : 'wrong_selection', { expected: [...right] });
      }
      // Partial credit: reward hits, penalise every wrong tick.
      const score = clamp01((hits - falsePos) / Math.max(1, right.size));
      return result(score, score === 1 ? 'correct' : 'partial', { hits, falsePos, total, expected: [...right] });
    }

    case 'true_false': {
      const ok = Boolean(response) === Boolean(d.answer);
      return result(ok ? 1 : 0, ok ? 'correct' : 'wrong_option', { expected: d.answer });
    }

    case 'short_answer': {
      const given = norm(response, d.caseSensitive);
      if (d.regex) {
        try {
          const ok = new RegExp(d.regex, d.caseSensitive ? '' : 'i').test(String(response ?? '').trim());
          return result(ok ? 1 : 0, ok ? 'correct' : 'wrong_answer', { regex: d.regex });
        } catch { /* fall through to literal matching */ }
      }
      const accepted = arr(d.accepted).map(a => norm(a, d.caseSensitive));
      if (accepted.includes(given)) return result(1, 'correct', { expected: d.accepted });
      const fuzz = Math.max(0, ...accepted.map(a => similarity(a, given)));
      const tol = d.typoTolerance ?? 0.86;
      if (fuzz >= tol) {
        return result(d.typoPenalty === false ? 1 : 0.75, 'near_miss',
          { similarity: +fuzz.toFixed(2), expected: d.accepted });
      }
      return result(0, 'wrong_answer', { expected: d.accepted });
    }

    case 'numeric': {
      const v = Number(String(response).replace(',', '.'));
      if (!Number.isFinite(v)) return result(0, 'not_a_number', { expected: d.answer });
      const tol = Number(d.tolerance ?? 0);
      const ok = Math.abs(v - Number(d.answer)) <= tol + 1e-9;
      return result(ok ? 1 : 0, ok ? 'correct' : 'wrong_answer', { expected: d.answer, tolerance: tol });
    }

    case 'fill_blanks': {
      const blanks = arr(d.blanks);
      const given = arr(response);
      let hits = 0;
      const per = blanks.map((b, i) => {
        const accepted = arr(b.accepted ?? b).map(a => norm(a, b.caseSensitive));
        const val = norm(given[i], b.caseSensitive);
        const ok = accepted.includes(val) ||
          Math.max(0, ...accepted.map(a => similarity(a, val))) >= (b.typoTolerance ?? 0.9);
        if (ok) hits++;
        return { index: i, ok, expected: b.accepted ?? b };
      });
      return result(blanks.length ? hits / blanks.length : 0,
        hits === blanks.length ? 'correct' : 'partial', { blanks: per, hits, total: blanks.length });
    }

    case 'matching': {
      const key = d.answer ?? {};
      const given = response ?? {};
      const keys = Object.keys(key);
      const hits = keys.filter(k => String(given[k]) === String(key[k])).length;
      return result(keys.length ? hits / keys.length : 0,
        hits === keys.length ? 'correct' : 'partial', { hits, total: keys.length, expected: key });
    }

    case 'ordering': {
      const expected = arr(d.answer).map(String);
      const given = arr(response).map(String);
      if (given.length !== expected.length) return result(0, 'incomplete', { expected });
      if (given.every((v, i) => v === expected[i])) return result(1, 'correct', { expected });
      // Partial credit from the longest correctly-ordered subsequence.
      const pos = new Map(expected.map((v, i) => [v, i]));
      const seq = given.map(v => pos.has(v) ? pos.get(v) : -1).filter(i => i >= 0);
      const lis = longestIncreasing(seq);
      return result(clamp01(lis / expected.length) * 0.9, 'partial', { lis, total: expected.length, expected });
    }

    case 'categorize': {
      const key = d.answer ?? {};
      const given = response ?? {};
      const items = Object.keys(key);
      const hits = items.filter(i => String(given[i]) === String(key[i])).length;
      return result(items.length ? hits / items.length : 0,
        hits === items.length ? 'correct' : 'partial', { hits, total: items.length, expected: key });
    }

    case 'code_output': {
      const accepted = arr(d.accepted).map(a => String(a).replace(/\r/g, '').trim());
      const given = String(response ?? '').replace(/\r/g, '').trim();
      const loose = s => s.replace(/\s+/g, ' ').trim();
      const ok = accepted.includes(given) || accepted.map(loose).includes(loose(given));
      return result(ok ? 1 : 0, ok ? 'correct' : 'wrong_output', { expected: d.accepted });
    }

    case 'code_write':
    case 'code_fix': {
      const tests = arr(d.tests);
      const run = runJs(String(response ?? ''), { fnName: d.functionName, tests });
      if (!run.ok) {
        return result(0, 'runtime_error', { error: run.error, output: run.output, tests: [] });
      }
      const passed = run.results.filter(r => r.pass).length;
      const score = tests.length ? passed / tests.length : 1;
      return result(score, score === 1 ? 'correct' : (passed ? 'partial' : 'tests_failed'), {
        output: run.output,
        passed,
        total: tests.length,
        // Hidden tests report pass/fail only - never their inputs.
        tests: run.results.map(r => r.hidden ? { name: r.name, hidden: true, pass: r.pass } : r)
      });
    }

    case 'bug_find': {
      const ok = Number(response) === Number(d.answer);
      return result(ok ? 1 : 0, ok ? 'correct' : 'wrong_line', { expected: d.answer, explanation: d.explanation });
    }

    case 'sql_query': {
      const given = normSql(response);
      const accepted = arr(d.accepted).map(normSql);
      if (accepted.includes(given)) return result(1, 'correct', {});
      const fuzz = Math.max(0, ...accepted.map(a => similarity(a, given)));
      if (fuzz >= 0.92) return result(0.7, 'near_miss', { similarity: +fuzz.toFixed(2) });
      return result(0, 'wrong_answer', { expected: d.accepted });
    }

    case 'terminal': {
      const given = normCmd(response);
      const accepted = arr(d.accepted).map(normCmd);
      const stripFlags = s => normCmd(s.replace(/\s+-{1,2}[\w-]+/g, ''));
      const ok = accepted.includes(given) ||
        (d.ignoreFlags && accepted.some(a => stripFlags(a) === stripFlags(given)));
      return result(ok ? 1 : 0, ok ? 'correct' : 'wrong_command', { expected: d.accepted });
    }

    case 'base_convert': {
      const expected = parseInt(String(d.value), Number(d.fromBase)).toString(Number(d.toBase));
      const given = String(response ?? '').trim().toLowerCase().replace(/^0[bxo]/, '');
      const ok = given === expected.toLowerCase();
      return result(ok ? 1 : 0, ok ? 'correct' : 'wrong_answer', { expected, toBase: d.toBase });
    }

    case 'truth_table': {
      const expected = arr(d.answer).map(Boolean);
      const given = arr(response).map(Boolean);
      const hits = expected.filter((v, i) => given[i] === v).length;
      return result(expected.length ? hits / expected.length : 0,
        hits === expected.length ? 'correct' : 'partial', { hits, total: expected.length, expected });
    }

    case 'hotspot': {
      const ok = arr(d.answer).map(String).includes(String(response));
      return result(ok ? 1 : 0, ok ? 'correct' : 'wrong_region', { expected: d.answer });
    }

    case 'flashcard': {
      // Self-assessed study card: always credited, the confidence feeds spaced repetition.
      const conf = Number(response?.confidence ?? response ?? 0);
      return result(1, 'reviewed', { confidence: clamp01(conf / 5) });
    }

    default:
      return result(0, 'unsupported_type', { type: t });
  }
}

function longestIncreasing(a) {
  const tails = [];
  for (const x of a) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < x) lo = mid + 1; else hi = mid; }
    tails[lo] = x;
  }
  return tails.length;
}

/** Score a whole attempt, weighting each question by its points. */
export function gradeAttempt(questions, responses) {
  const perQuestion = questions.map(q => {
    const r = grade(q, responses?.[q.id]);
    const points = Number(q.points ?? 1);
    return { questionId: q.id, type: q.type, points, earned: +(r.score * points).toFixed(3), ...r };
  });
  const total = perQuestion.reduce((s, r) => s + r.points, 0);
  const earned = perQuestion.reduce((s, r) => s + r.earned, 0);
  return {
    perQuestion,
    totalPoints: +total.toFixed(3),
    earnedPoints: +earned.toFixed(3),
    percent: total ? +((earned / total) * 100).toFixed(2) : 0,
    pending: perQuestion.some(r => r.pending)
  };
}

/** Spaced-repetition scheduling (SM-2 lite) for flashcard decks. */
export function nextReview(state = {}, confidence = 3) {
  const q = Math.max(0, Math.min(5, Number(confidence)));
  let ease = state.ease ?? 2.5;
  let reps = state.reps ?? 0;
  let interval = state.interval ?? 0;
  if (q < 3) { reps = 0; interval = 1; }
  else {
    reps += 1;
    interval = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(interval * ease);
    ease = Math.max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  }
  return { ease: +ease.toFixed(2), reps, interval, due: new Date(Date.now() + interval * 864e5).toISOString() };
}
