/**
 * Renders and reads back every question type.
 *   render(q, value)          -> HTML string
 *   bind(el, q, value, onSet) -> wires interaction, calls onSet(newValue)
 * Read-only review rendering lives in renderReview().
 */
import { t, esc, i18n, api, toast } from './core.js';

const LETTERS = 'ABCDEFGHIJ';
const prompt = q => i18n.pick(q, 'prompt', q.prompt);
const opts = q => i18n.pick(q, 'options', q.data.options) || [];

export function typeLabel(type) { return t(`qtype.${type}`); }

export function render(q, value) {
  const d = q.data || {};
  switch (q.type) {

    case 'mcq_single':
    case 'mcq_multiple': {
      const multi = q.type === 'mcq_multiple';
      const sel = multi ? new Set((value || []).map(Number)) : new Set([Number(value)]);
      return `
        <div class="muted small mb">${t(multi ? 'q.selectMany' : 'q.selectOne')}</div>
        ${opts(q).map((o, i) => `
          <div class="opt ${sel.has(i) ? 'selected' : ''}" data-opt="${i}">
            <span class="key">${multi ? (sel.has(i) ? '✓' : '') : LETTERS[i]}</span>
            <span>${esc(o)}</span>
          </div>`).join('')}`;
    }

    case 'true_false':
      return `<div class="row">
        ${[true, false].map(v => `
          <div class="opt ${value === v ? 'selected' : ''}" data-bool="${v}" style="flex:1">
            <span class="key">${v ? '✓' : '✕'}</span><span>${t(v ? 'q.true' : 'q.false')}</span>
          </div>`).join('')}</div>`;

    case 'short_answer':
    case 'sql_query':
    case 'terminal':
      return `
        ${d.schema ? `<pre class="small">${esc(d.schema)}</pre>` : ''}
        <input data-input class="${q.type === 'short_answer' ? '' : 'mono'}"
               placeholder="${esc(d.placeholder || t('q.typeAnswer'))}" value="${esc(value ?? '')}"
               ${q.type !== 'short_answer' ? 'dir="ltr"' : ''}>`;

    case 'numeric':
      return `<input data-input type="number" step="any" dir="ltr" style="max-inline-size:220px"
                     placeholder="${t('q.typeAnswer')}" value="${esc(value ?? '')}">`;

    case 'base_convert':
      return `
        <div class="row mb">
          <span class="badge badge-primary mono">${esc(d.value)}<sub>${esc(d.fromBase)}</sub></span>
          <span>→</span>
          <span class="badge">${t('q.convertTo')} ${esc(d.toBase)}</span>
        </div>
        <input data-input class="mono" dir="ltr" style="max-inline-size:260px"
               placeholder="${t('q.typeAnswer')}" value="${esc(value ?? '')}">`;

    case 'fill_blanks': {
      const vals = value || [];
      let n = -1;
      const body = esc(d.text || '').replace(/\{\{(\d+)\}\}/g, () => {
        n++;
        const b = d.blanks?.[n] || {};
        return `<input class="blank-input mono" dir="ltr" data-blank="${n}" value="${esc(vals[n] ?? '')}"
                       placeholder="${esc(b.hint || (n + 1))}">`;
      });
      return `<div class="cloze">${body}</div>`;
    }

    case 'ordering': {
      const items = value?.length ? value : (d.items || []);
      return `
        <div class="muted small mb">${t('q.dragToOrder')}</div>
        <div data-order>${items.map((it, i) => `
          <div class="order-item" data-item="${esc(it)}">
            <span class="idx">${i + 1}</span>
            <span style="flex:1">${esc(it)}</span>
            <button class="btn btn-sm" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn btn-sm" data-down="${i}" ${i === items.length - 1 ? 'disabled' : ''}>↓</button>
          </div>`).join('')}</div>`;
    }

    case 'matching': {
      const map = value || {};
      return `
        <div class="muted small mb">${t('q.matchPairs')}</div>
        <div class="stack">${(d.left || []).map(l => `
          <div class="row">
            <strong style="min-inline-size:180px">${esc(l)}</strong>
            <select data-match="${esc(l)}" style="max-inline-size:280px">
              <option value="">—</option>
              ${(d.right || []).map(r => `<option ${map[l] === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
            </select>
          </div>`).join('')}</div>`;
    }

    case 'categorize': {
      const map = value || {};
      const unplaced = (d.items || []).filter(i => !map[i]);
      return `
        <div class="card mb" style="background:var(--surface-2)">
          <div class="row" data-pool>${unplaced.map(i =>
            `<span class="chip" draggable="true" data-item="${esc(i)}">${esc(i)}</span>`).join('') ||
            `<span class="muted small">—</span>`}</div>
        </div>
        <div class="grid grid-3">${(d.buckets || []).map(b => `
          <div class="bucket" data-bucket="${esc(b)}">
            <h4>${esc(b)}</h4>
            <div class="row">${(d.items || []).filter(i => map[i] === b).map(i =>
              `<span class="chip selected" draggable="true" data-item="${esc(i)}">${esc(i)}</span>`).join('')}</div>
          </div>`).join('')}</div>`;
    }

    case 'code_output':
      return `
        <pre>${esc(d.code || '')}</pre>
        <label class="mt">${t('quiz.output')}</label>
        <textarea data-input class="code-editor" style="min-block-size:90px" dir="ltr"
                  placeholder="${t('q.typeAnswer')}">${esc(value ?? '')}</textarea>`;

    case 'code_write':
    case 'code_fix':
      return `
        ${q.type === 'code_fix' && d.code ? `<div class="muted small mb">${t('qtype.code_fix')}</div>` : ''}
        <textarea data-input class="code-editor" dir="ltr" spellcheck="false">${esc(value ?? d.starter ?? d.code ?? '')}</textarea>
        <div class="row mt">
          <button class="btn btn-sm" data-run>▶ ${t('quiz.runCode')}</button>
          ${d.hiddenTestCount ? `<span class="tiny muted">+${d.hiddenTestCount} hidden tests</span>` : ''}
        </div>
        <div data-runout class="mt"></div>`;

    case 'bug_find': {
      const lines = String(d.code || '').split('\n');
      return `
        <div class="muted small mb">${t('q.whichLine')}</div>
        <div class="code-lines card" style="background:var(--surface-3)">
          ${lines.map((ln, i) => {
            // A leading "12  " in the source is the teacher's own numbering.
            const m = ln.match(/^\s*(\d+)\s{1,3}(.*)$/);
            const no = m ? Number(m[1]) : i + 1;
            const text = m ? m[2] : ln;
            return `<div class="code-line ${Number(value) === no ? 'selected' : ''}" data-line="${no}">
                      <span class="n">${no}</span><span>${esc(text) || '&nbsp;'}</span>
                    </div>`;
          }).join('')}
        </div>`;
    }

    case 'truth_table': {
      const inputs = d.inputs || ['A', 'B'];
      const rows = 2 ** inputs.length;
      const vals = value || [];
      return `
        <div class="mb"><span class="badge badge-primary mono">${esc(d.expression || '')}</span></div>
        <div class="table-wrap"><table>
          <thead><tr>${inputs.map(i => `<th>${esc(i)}</th>`).join('')}<th>=</th></tr></thead>
          <tbody>${Array.from({ length: rows }, (_, r) => `
            <tr>
              ${inputs.map((_, c) => `<td class="mono">${(r >> (inputs.length - 1 - c)) & 1}</td>`).join('')}
              <td>
                <button class="btn btn-sm" data-tt="${r}">${vals[r] === true ? '1' : vals[r] === false ? '0' : '?'}</button>
              </td>
            </tr>`).join('')}</tbody>
        </table></div>`;
    }

    case 'hotspot':
      return `
        <div class="muted small mb">${t('q.clickRegion')}</div>
        ${d.image ? `<img src="${esc(d.image)}" alt="" style="max-inline-size:100%;border-radius:var(--radius)">` : ''}
        <div class="row">${(d.regions || []).map(r => `
          <button class="chip ${value === r.id ? 'selected' : ''}" data-region="${esc(r.id)}">${esc(r.label || r.id)}</button>
        `).join('')}</div>`;

    case 'flashcard':
      return `
        <div class="card center" style="background:var(--surface-2)">
          <div style="font-size:1.15rem;font-weight:600">${esc(prompt(q))}</div>
          <div data-back class="hidden mt">${esc(q.data.back || '')}</div>
          <button class="btn mt" data-flip>${t('flash.showAnswer')}</button>
        </div>
        <div class="row mt" data-conf>
          ${[[0, 'flash.again'], [3, 'flash.hard'], [4, 'flash.good'], [5, 'flash.easy']].map(([c, k]) =>
            `<button class="btn btn-sm ${value?.confidence === c ? 'btn-primary' : ''}" data-c="${c}">${t(k)}</button>`).join('')}
        </div>`;

    case 'essay': {
      const words = String(value || '').trim().split(/\s+/).filter(Boolean).length;
      return `
        ${d.rubric?.length ? `<div class="card mb small" style="background:var(--surface-2)">
          <strong>${t('review.rubric')}</strong><ul>${d.rubric.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
        <textarea data-input style="min-block-size:190px">${esc(value ?? '')}</textarea>
        <div class="tiny muted mt" data-words>${words} ${t('q.wordCount')}${
          d.minWords ? ` · ${d.minWords} ${t('q.minWords')}` : ''}</div>`;
    }

    default:
      return `<div class="muted">${esc(q.type)}</div>`;
  }
}

export function bind(el, q, value, onSet) {
  const d = q.data || {};
  const $$ = sel => [...el.querySelectorAll(sel)];

  switch (q.type) {
    case 'mcq_single':
      $$('[data-opt]').forEach(o => o.onclick = () => {
        $$('[data-opt]').forEach(x => x.classList.remove('selected'));
        o.classList.add('selected');
        onSet(Number(o.dataset.opt));
      });
      break;

    case 'mcq_multiple': {
      const sel = new Set((value || []).map(Number));
      $$('[data-opt]').forEach(o => o.onclick = () => {
        const i = Number(o.dataset.opt);
        sel.has(i) ? sel.delete(i) : sel.add(i);
        o.classList.toggle('selected', sel.has(i));
        o.querySelector('.key').textContent = sel.has(i) ? '✓' : '';
        onSet([...sel]);
      });
      break;
    }

    case 'true_false':
      $$('[data-bool]').forEach(o => o.onclick = () => {
        $$('[data-bool]').forEach(x => x.classList.remove('selected'));
        o.classList.add('selected');
        onSet(o.dataset.bool === 'true');
      });
      break;

    case 'short_answer': case 'numeric': case 'sql_query':
    case 'terminal': case 'code_output': case 'base_convert':
      el.querySelector('[data-input]').oninput = e => onSet(e.target.value);
      break;

    case 'essay': {
      const box = el.querySelector('[data-input]');
      box.oninput = e => {
        onSet(e.target.value);
        const n = e.target.value.trim().split(/\s+/).filter(Boolean).length;
        el.querySelector('[data-words]').textContent =
          `${n} ${t('q.wordCount')}${d.minWords ? ` · ${d.minWords} ${t('q.minWords')}` : ''}`;
      };
      break;
    }

    case 'fill_blanks': {
      const vals = [...(value || [])];
      $$('[data-blank]').forEach(inp => inp.oninput = e => {
        vals[Number(inp.dataset.blank)] = e.target.value;
        onSet(vals);
      });
      break;
    }

    case 'ordering': {
      let items = value?.length ? [...value] : [...(d.items || [])];
      const swap = (i, j) => {
        [items[i], items[j]] = [items[j], items[i]];
        onSet(items);
        const host = el.querySelector('[data-order]').parentElement;
        host.innerHTML = render({ ...q, data: { ...d, items } }, items);
        bind(host, q, items, onSet);
      };
      $$('[data-up]').forEach(b => b.onclick = () => swap(Number(b.dataset.up), Number(b.dataset.up) - 1));
      $$('[data-down]').forEach(b => b.onclick = () => swap(Number(b.dataset.down), Number(b.dataset.down) + 1));
      break;
    }

    case 'matching': {
      const map = { ...(value || {}) };
      $$('[data-match]').forEach(s => s.onchange = e => {
        map[s.dataset.match] = e.target.value;
        onSet(map);
      });
      break;
    }

    case 'categorize': {
      const map = { ...(value || {}) };
      let dragged = null;
      const redraw = () => {
        const host = el;
        host.innerHTML = render(q, map);
        bind(host, q, map, onSet);
      };
      $$('[data-item]').forEach(chip => {
        chip.ondragstart = () => { dragged = chip.dataset.item; };
        // Tapping cycles through the buckets, so this works without a mouse too.
        chip.onclick = () => {
          const buckets = d.buckets || [];
          const cur = map[chip.dataset.item];
          const next = buckets[(buckets.indexOf(cur) + 1) % (buckets.length + 1)];
          if (next === undefined) delete map[chip.dataset.item];
          else map[chip.dataset.item] = next;
          onSet(map);
          redraw();
        };
      });
      $$('[data-bucket]').forEach(b => {
        b.ondragover = e => { e.preventDefault(); b.classList.add('over'); };
        b.ondragleave = () => b.classList.remove('over');
        b.ondrop = e => {
          e.preventDefault();
          b.classList.remove('over');
          if (dragged) { map[dragged] = b.dataset.bucket; onSet(map); redraw(); }
        };
      });
      const pool = el.querySelector('[data-pool]');
      if (pool) {
        pool.ondragover = e => e.preventDefault();
        pool.ondrop = () => { if (dragged) { delete map[dragged]; onSet(map); redraw(); } };
      }
      break;
    }

    case 'bug_find':
      $$('[data-line]').forEach(l => l.onclick = () => {
        $$('[data-line]').forEach(x => x.classList.remove('selected'));
        l.classList.add('selected');
        onSet(Number(l.dataset.line));
      });
      break;

    case 'truth_table': {
      const vals = [...(value || [])];
      $$('[data-tt]').forEach(b => b.onclick = () => {
        const r = Number(b.dataset.tt);
        vals[r] = vals[r] === true ? false : vals[r] === false ? undefined : true;
        b.textContent = vals[r] === true ? '1' : vals[r] === false ? '0' : '?';
        onSet(vals.map(v => v === true));
      });
      break;
    }

    case 'hotspot':
      $$('[data-region]').forEach(b => b.onclick = () => {
        $$('[data-region]').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
        onSet(b.dataset.region);
      });
      break;

    case 'flashcard': {
      el.querySelector('[data-flip]').onclick = e => {
        el.querySelector('[data-back]').classList.remove('hidden');
        e.target.classList.add('hidden');
      };
      $$('[data-c]').forEach(b => b.onclick = () => {
        $$('[data-c]').forEach(x => x.classList.remove('btn-primary'));
        b.classList.add('btn-primary');
        onSet({ confidence: Number(b.dataset.c) });
      });
      break;
    }

    case 'code_write':
    case 'code_fix': {
      const editor = el.querySelector('[data-input]');
      editor.oninput = e => onSet(e.target.value);
      // Tab inserts two spaces instead of leaving the editor.
      editor.onkeydown = e => {
        if (e.key !== 'Tab') return;
        e.preventDefault();
        const s = editor.selectionStart;
        editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(editor.selectionEnd);
        editor.selectionStart = editor.selectionEnd = s + 2;
        onSet(editor.value);
      };
      el.querySelector('[data-run]').onclick = async ev => {
        const out = el.querySelector('[data-runout]');
        ev.target.disabled = true;
        out.innerHTML = `<span class="muted small">${t('common.loading')}</span>`;
        try {
          const r = await api.post('/quizzes/playground/run', {
            code: editor.value, fnName: d.functionName, tests: d.tests || []
          });
          out.innerHTML = runOutput(r);
        } catch { toast(t('common.error'), 'error'); out.innerHTML = ''; }
        ev.target.disabled = false;
      };
      break;
    }
  }
}

export function runOutput(r) {
  const passed = (r.results || []).filter(x => x.pass).length;
  return `
    ${r.error ? `<pre style="color:var(--danger)">${esc(r.error)}</pre>` : ''}
    ${r.output ? `<pre>${esc(r.output)}</pre>` : ''}
    ${r.results?.length ? `
      <div class="row"><span class="badge ${passed === r.results.length ? 'badge-success' : 'badge-warning'}">
        ${passed}/${r.results.length} ${t('quiz.testsPassed')}</span></div>
      <div class="stack mt">${r.results.map(x => `
        <div class="small row">
          <span>${x.pass ? '✅' : '❌'}</span>
          <span>${esc(x.name)}</span>
          ${!x.pass && !x.hidden ? `<span class="muted mono tiny">→ ${esc(x.got)} ≠ ${esc(x.expected)}</span>` : ''}
        </div>`).join('')}</div>` : ''}`;
}

/** Read-only rendering of one graded question, used on the review screen. */
export function renderReview(item, question) {
  const cls = item.correct ? 'success' : item.score > 0 ? 'warning' : 'danger';
  const fmt = v => v == null ? '—' : typeof v === 'object' ? esc(JSON.stringify(v)) : esc(v);
  const d = item.details || {};
  return `
    <div class="q-card mb">
      <div class="between mb">
        <span class="badge">${typeLabel(item.type)}</span>
        <span class="badge badge-${cls}">${item.earned}/${item.points} ${t('common.points')}</span>
      </div>
      <div class="q-prompt">${esc(item.prompt)}</div>
      <div class="small"><strong>${t('quiz.yourAnswer')}:</strong> <span class="mono">${fmt(item.yourAnswer)}</span></div>
      ${!item.correct && d.expected !== undefined
        ? `<div class="small"><strong>${t('quiz.expected')}:</strong> <span class="mono">${fmt(d.expected)}</span></div>` : ''}
      ${d.tests?.length ? `<div class="mt">${runOutput({ results: d.tests, output: d.output, error: d.error })}</div>` : ''}
      ${d.error ? `<pre class="small" style="color:var(--danger)">${esc(d.error)}</pre>` : ''}
      ${item.explanation ? `<div class="card mt small" style="background:var(--surface-2)">
        <strong>${t('quiz.explanation')}</strong><br>${esc(item.explanation)}</div>` : ''}
      ${item.teacherComment ? `<div class="card mt small" style="background:var(--surface-2)">
        <strong>${t('review.comment')}</strong><br>${esc(item.teacherComment)}</div>` : ''}
      ${item.pending ? `<div class="badge badge-warning mt">${t('quiz.pendingReview')}</div>` : ''}
    </div>`;
}
