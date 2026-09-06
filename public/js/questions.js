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

/**
 * Illustration attached to any question — an image, a diagram, a short clip or
 * an audio sample. Rendered above the answer area by the player and the review
 * screen, so every type can be visual without a type of its own.
 */
export function renderMedia(media) {
  if (!media) return '';
  const m = typeof media === 'string' ? { url: media, kind: 'image' } : media;
  if (!m.url) return '';
  const alt = esc(m.alt || '');
  const body =
    m.kind === 'video' ? `<video controls preload="metadata" src="${esc(m.url)}"></video>`
    : m.kind === 'audio' ? `<audio controls preload="metadata" src="${esc(m.url)}"></audio>`
    : `<img src="${esc(m.url)}" alt="${alt}" loading="lazy">`;
  return `<figure class="q-media">${body}${m.alt ? `<figcaption>${alt}</figcaption>` : ''}</figure>`;
}

/**
 * Percentage position of a pointer event inside an element, clamped to 0-100.
 * Returns null when the box has no size — recording 0,0 from a collapsed image
 * would silently mark the answer wrong instead of doing nothing.
 */
function pointPercent(el, event) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const src = event.touches?.[0] ?? event.changedTouches?.[0] ?? event;
  if (src?.clientX === undefined) return null;
  return {
    x: Math.max(0, Math.min(100, ((src.clientX - r.left) / r.width) * 100)),
    y: Math.max(0, Math.min(100, ((src.clientY - r.top) / r.height) * 100))
  };
}

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

    /* ---------------------------------------------------------------- image */

    case 'image_choice': {
      const multi = !!d.multiple;
      const sel = multi ? new Set((value || []).map(Number)) : new Set([Number(value)]);
      return `
        <div class="muted small mb">${t(multi ? 'q.selectMany' : 'q.selectOne')}</div>
        <div class="img-grid">
          ${(d.options || []).map((o, i) => `
            <button type="button" class="img-tile ${sel.has(i) ? 'selected' : ''}" data-img-opt="${i}">
              <img src="${esc(o.url)}" alt="${esc(o.label || '')}" loading="lazy">
              <span class="img-tile-tick">${sel.has(i) ? '✓' : LETTERS[i]}</span>
              ${o.label ? `<span class="img-tile-label">${esc(o.label)}</span>` : ''}
            </button>`).join('')}
        </div>`;
    }

    case 'image_hotspot': {
      const p = value && typeof value === 'object' ? value : null;
      return `
        <div class="muted small mb">${t('q.clickImage')}</div>
        <div class="img-canvas" data-hotspot>
          <img src="${esc(d.image)}" alt="${esc(d.imageAlt || '')}">
          ${p ? `<span class="img-pin" style="inset-inline-start:${p.x}%;inset-block-start:${p.y}%"></span>` : ''}
        </div>
        <div class="tiny muted mt" data-hotspot-status>${p ? t('q.pinPlaced') : ''}</div>`;
    }

    case 'image_label': {
      const map = value || {};
      const markers = d.markers || [];
      const labels = d.labels || [];
      return `
        <div class="muted small mb">${t('q.labelMarkers')}</div>
        <div class="img-canvas">
          <img src="${esc(d.image)}" alt="${esc(d.imageAlt || '')}">
          ${markers.map((m, i) => `
            <span class="img-marker ${map[m.id] ? 'done' : ''}"
                  style="inset-inline-start:${m.x}%;inset-block-start:${m.y}%"
                  data-marker-dot="${esc(m.id)}">${i + 1}</span>`).join('')}
        </div>
        <div class="stack mt">
          ${markers.map((m, i) => `
            <label class="row marker-row">
              <span class="marker-num">${i + 1}</span>
              <select data-marker="${esc(m.id)}" style="flex:1">
                <option value="">—</option>
                ${labels.map(l => `<option ${map[m.id] === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}
              </select>
            </label>`).join('')}
        </div>`;
    }

    case 'image_order': {
      const items = value?.length
        ? value.map(id => (d.items || []).find(i => String(i.id) === String(id))).filter(Boolean)
        : (d.items || []);
      return `
        <div class="muted small mb">${t('q.dragToOrder')}</div>
        <div class="img-order" data-img-order>
          ${items.map((it, i) => `
            <div class="img-order-item" data-item-id="${esc(it.id)}">
              <span class="img-order-rank">${i + 1}</span>
              <img src="${esc(it.url)}" alt="${esc(it.caption || '')}" loading="lazy">
              ${it.caption ? `<span class="img-order-caption">${esc(it.caption)}</span>` : ''}
              <span class="img-order-moves">
                <button type="button" class="btn btn-sm" data-img-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
                <button type="button" class="btn btn-sm" data-img-down="${i}" ${i === items.length - 1 ? 'disabled' : ''}>↓</button>
              </span>
            </div>`).join('')}
        </div>`;
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
                <button type="button" class="btn btn-sm tt-cell ${vals[r] === true || vals[r] === false ? 'answered' : ''}"
                        data-tt="${r}">${vals[r] === true ? '1' : vals[r] === false ? '0' : '?'}</button>
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
      // The prompt is already shown by the player above this block, so the card
      // only carries the hidden answer side.
      return `
        <div class="card center flash-face">
          <div data-back class="hidden">${esc(q.data.back || '')}</div>
          <button type="button" class="btn" data-flip>${t('flash.showAnswer')}</button>
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
        // Re-render into the same host we were bound to; reaching for
        // parentElement broke whenever the caller changed the wrapper.
        el.innerHTML = render({ ...q, data: { ...d, items } }, items);
        bind(el, q, items, onSet);
      };
      $$('[data-up]').forEach(b => b.onclick = () => swap(Number(b.dataset.up), Number(b.dataset.up) - 1));
      $$('[data-down]').forEach(b => b.onclick = () => swap(Number(b.dataset.down), Number(b.dataset.down) + 1));
      // The order on screen is already a candidate answer — record it so a
      // student who judges it correct and submits untouched is not marked blank.
      if (!value?.length) onSet([...items]);
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

    /* ---------------------------------------------------------------- image */

    case 'image_choice': {
      const multi = !!d.multiple;
      const sel = new Set(multi ? (value || []).map(Number) : []);
      $$('[data-img-opt]').forEach(tile => tile.onclick = () => {
        const i = Number(tile.dataset.imgOpt);
        if (!multi) {
          $$('[data-img-opt]').forEach((x, xi) => {
            x.classList.toggle('selected', xi === i);
            x.querySelector('.img-tile-tick').textContent = xi === i ? '✓' : LETTERS[xi];
          });
          return onSet(i);
        }
        sel.has(i) ? sel.delete(i) : sel.add(i);
        tile.classList.toggle('selected', sel.has(i));
        tile.querySelector('.img-tile-tick').textContent = sel.has(i) ? '✓' : LETTERS[i];
        onSet([...sel]);
      });
      break;
    }

    case 'image_hotspot': {
      const canvas = el.querySelector('[data-hotspot]');
      const status = el.querySelector('[data-hotspot-status]');
      const place = event => {
        event.preventDefault();
        // Measure the image, not the canvas: percentages for absolutely
        // positioned pins resolve against the padding box, so using a box that
        // includes the border would offset every click by the border width.
        const p = pointPercent(canvas.querySelector('img') || canvas, event);
        if (!p) return;
        canvas.querySelector('.img-pin')?.remove();
        const pin = document.createElement('span');
        pin.className = 'img-pin';
        pin.style.insetInlineStart = `${p.x}%`;
        pin.style.insetBlockStart = `${p.y}%`;
        canvas.appendChild(pin);
        if (status) status.textContent = t('q.pinPlaced');
        onSet({ x: +p.x.toFixed(2), y: +p.y.toFixed(2) });
      };
      canvas.onclick = place;
      // Touch devices fire click too, but this keeps the pin from lagging.
      canvas.ontouchend = place;
      break;
    }

    case 'image_label': {
      const map = { ...(value || {}) };
      const paint = () => $$('[data-marker-dot]').forEach(dot =>
        dot.classList.toggle('done', !!map[dot.dataset.markerDot]));
      $$('[data-marker]').forEach(sel => sel.onchange = e => {
        const id = sel.dataset.marker;
        if (e.target.value) map[id] = e.target.value; else delete map[id];
        paint();
        onSet(map);
      });
      // Clicking a dot on the image jumps to its dropdown — much easier than
      // hunting for the matching row on a phone.
      $$('[data-marker-dot]').forEach(dot => dot.onclick = () => {
        const target = el.querySelector(`[data-marker="${CSS.escape(dot.dataset.markerDot)}"]`);
        target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target?.focus();
      });
      break;
    }

    case 'image_order': {
      let items = value?.length
        ? value.map(id => (d.items || []).find(i => String(i.id) === String(id))).filter(Boolean)
        : [...(d.items || [])];
      const move = (from, to) => {
        [items[from], items[to]] = [items[to], items[from]];
        const order = items.map(i => i.id);
        onSet(order);
        el.innerHTML = render(q, order);
        bind(el, q, order, onSet);
      };
      $$('[data-img-up]').forEach(b => b.onclick = () => move(Number(b.dataset.imgUp), Number(b.dataset.imgUp) - 1));
      $$('[data-img-down]').forEach(b => b.onclick = () => move(Number(b.dataset.imgDown), Number(b.dataset.imgDown) + 1));
      // An order is only meaningful once submitted, so seed it immediately.
      if (!value?.length) onSet(items.map(i => i.id));
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
      const rows = 2 ** (d.inputs?.length ?? 2);
      // Fixed-length and null-filled: an untouched cell must stay unanswered
      // rather than collapsing to `false` and earning accidental credit.
      const vals = Array.from({ length: rows }, (_, i) =>
        typeof value?.[i] === 'boolean' ? value[i] : null);
      $$('[data-tt]').forEach(b => b.onclick = () => {
        const r = Number(b.dataset.tt);
        vals[r] = vals[r] === true ? false : vals[r] === false ? null : true;
        b.textContent = vals[r] === true ? '1' : vals[r] === false ? '0' : '?';
        b.classList.toggle('answered', vals[r] !== null);
        onSet([...vals]);
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
export function renderReview(item) {
  const cls = item.correct ? 'success' : item.score > 0 ? 'warning' : 'danger';
  const d = item.details || {};

  /** Turn a stored answer into something a student can actually read. */
  const optionName = i => {
    const o = item.options?.[i];
    if (o == null) return `#${Number(i) + 1}`;
    return typeof o === 'string' ? o : (o.label || o.caption || `#${Number(i) + 1}`);
  };
  const fmt = v => {
    if (v == null || v === '') return '—';
    if (item.options && (typeof v === 'number' || typeof v === 'string') && !Number.isNaN(Number(v))) {
      return esc(optionName(Number(v)));
    }
    if (item.options && Array.isArray(v)) return esc(v.map(i => optionName(Number(i))).join(', '));
    if (item.type === 'image_hotspot' && v?.x !== undefined) return '📍';
    if (Array.isArray(v)) return esc(v.map(x => (x == null ? '—' : x)).join(' → '));
    if (typeof v === 'object') {
      return esc(Object.entries(v).map(([k, val], i) => `${i + 1}. ${val}`).join(' · ')) || '—';
    }
    return esc(v);
  };

  /** For image choices, show the pictures rather than describing them. */
  const thumb = (i, kind) => {
    const o = item.options?.[Number(i)];
    if (!o?.url) return '';
    return `<figure class="review-thumb ${kind}">
        <img src="${esc(o.url)}" alt="${esc(o.label || '')}" loading="lazy">
        <figcaption>${esc(o.label || '')}</figcaption>
      </figure>`;
  };
  const chosen = [].concat(item.yourAnswer ?? []).filter(v => v !== null && v !== '');
  const wanted = [].concat(d.expected ?? []).filter(v => v !== null && v !== '');
  const imageAnswers = item.type === 'image_choice' && item.options
    ? `<div class="review-thumbs">
         ${chosen.map(i => thumb(i, item.correct ? 'ok' : 'bad')).join('')}
         ${!item.correct ? wanted.map(i => thumb(i, 'want')).join('') : ''}
       </div>` : '';

  // Image answers read as coordinates in JSON; show them on the picture instead.
  const spatial = item.type === 'image_hotspot' && d.point
    ? `<div class="img-canvas review">
         <img src="${esc(item.image || d.image || '')}" alt="">
         ${(d.zones || []).map(z => `<span class="img-zone" style="
             inset-inline-start:${z.x}%;inset-block-start:${z.y}%;
             inline-size:${z.w}%;block-size:${z.h}%"></span>`).join('')}
         <span class="img-pin ${item.correct ? 'ok' : 'bad'}"
               style="inset-inline-start:${d.point.x}%;inset-block-start:${d.point.y}%"></span>
       </div>` : '';

  return `
    <div class="q-card mb">
      <div class="between mb">
        <span class="badge">${typeLabel(item.type)}</span>
        <span class="badge badge-${cls}">${item.earned}/${item.points} ${t('common.points')}</span>
      </div>
      <div class="q-prompt">${esc(item.prompt)}</div>
      ${renderMedia(item.media)}
      ${spatial}
      ${imageAnswers}
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
