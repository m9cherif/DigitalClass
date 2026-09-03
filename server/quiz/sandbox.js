/**
 * Minimal JavaScript runner used by code_write / code_fix questions.
 * Runs student code in a fresh vm context with no globals, a hard timeout and
 * an output buffer. It is a teaching sandbox, not a security boundary — do not
 * expose it to untrusted internet traffic without a container/worker isolate.
 */
import vm from 'node:vm';

const TIMEOUT_MS = 1500;
const MAX_OUTPUT = 8000;

export function runJs(code, { fnName, tests = [] } = {}) {
  const logs = [];
  const sandbox = {
    console: {
      log: (...a) => { if (logs.join('\n').length < MAX_OUTPUT) logs.push(a.map(fmt).join(' ')); },
      error: (...a) => logs.push(a.map(fmt).join(' ')),
      warn: (...a) => logs.push(a.map(fmt).join(' '))
    },
    Math, JSON, Date, Number, String, Boolean, Array, Object, Map, Set, RegExp, Error,
    parseInt, parseFloat, isNaN, isFinite
  };
  const context = vm.createContext(sandbox, { name: 'digitalclass-sandbox' });

  try {
    new vm.Script(code, { filename: 'answer.js' }).runInContext(context, { timeout: TIMEOUT_MS });
  } catch (err) {
    return { ok: false, error: `${err.name}: ${err.message}`, output: logs.join('\n'), results: [] };
  }

  if (!fnName) return { ok: true, output: logs.join('\n'), results: [] };

  const fn = context[fnName];
  if (typeof fn !== 'function') {
    return { ok: false, error: `Function "${fnName}" is not defined`, output: logs.join('\n'), results: [] };
  }

  const results = tests.map((t, i) => {
    try {
      const value = vm.runInContext(
        `__fn.apply(null, __args)`,
        Object.assign(context, { __fn: fn, __args: t.args ?? [] }),
        { timeout: TIMEOUT_MS }
      );
      const pass = deepEqual(value, t.expected);
      return { i, name: t.name ?? `test ${i + 1}`, hidden: !!t.hidden, pass, got: fmt(value), expected: fmt(t.expected) };
    } catch (err) {
      return { i, name: t.name ?? `test ${i + 1}`, hidden: !!t.hidden, pass: false, got: `${err.name}: ${err.message}`, expected: fmt(t.expected) };
    }
  });

  return { ok: true, output: logs.join('\n'), results };
}

function fmt(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => deepEqual(a[k], b[k]));
}
