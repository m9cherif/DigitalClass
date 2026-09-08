/* Views: quiz player, quiz builder, review queue, analytics, flashcards, playground. */
import {
  api, store, session, router, t, i18n, esc, toast, modal, avatar,
  barChart, percentColor, fmtDuration
} from '../core.js';
import * as Q from '../questions.js';

/* ------------------------------------------------------------ quiz intro */

// A quiz created straight from the party hub has no course to link back
// to — that's the point of it — so the back link falls back to the hub
// it was most likely opened from instead.
const backHref = q => q.courseId ? `/classes/${q.classId}/courses/${q.courseId}` : '/party';

export async function quizView({ id }, out) {
  const data = await api.get(`/quizzes/${id}`);
  const q = data.quiz;
  const best = data.attempts.filter(a => a.percent != null);
  // Admins supervise, never answer questions.
  const canAnswer = store.user.role !== 'admin';

  out.innerHTML = `
    <a href="${backHref(q)}" class="small">← ${t('common.back')}</a>
    <div class="card mt">
      <div class="between">
        <div>
          <div class="row mb">
            <span class="badge badge-primary">${esc(q.kind)}</span>
            <span class="badge">${t('quiz.difficulty')}: ${esc(q.difficulty)}</span>
            ${q.published ? '' : `<span class="badge badge-warning">${t('common.draft')}</span>`}
          </div>
          <h1>${esc(i18n.pick(q, 'title', q.title))}</h1>
          <p class="muted">${esc(q.description || '')}</p>
        </div>
        <div class="stack course-actions">
          ${canAnswer ? `<button class="btn btn-primary btn-lg" id="start">${t('quiz.start')}</button>` : ''}
          ${data.editable ? `<a class="btn" href="/quiz/${id}/edit">✏️ ${t('common.edit')}</a>
                             <a class="btn" href="/analytics/${id}">📊 ${t('analytics.title')}</a>` : ''}
        </div>
      </div>
      <div class="grid grid-4 mt">
        <div class="stat"><div class="v">${data.questions.length}</div><div class="k">${t('quiz.question')}</div></div>
        <div class="stat"><div class="v">${q.timeLimitSec ? Math.round(q.timeLimitSec / 60) : '∞'}</div><div class="k">${t('common.minutes')}</div></div>
        <div class="stat"><div class="v">${q.passPercent}%</div><div class="k">${t('quiz.passPercent')}</div></div>
        <div class="stat"><div class="v">${q.maxAttempts || '∞'}</div><div class="k">${t('quiz.attempts')}</div></div>
      </div>
    </div>

    ${!canAnswer ? `<div class="card mt small muted">ℹ️ ${t('admin.notLearner')}</div>` : ''}

    <div class="card mt live-card">
      <div id="liveHost"></div>
    </div>

    <div class="card mt">
      <h3>${t('quiz.attempts')}</h3>
      ${best.length ? `<table><tbody>${data.attempts.map(a => `
        <tr>
          <td class="tiny muted">${i18n.date(a.submittedAt, { dateStyle: 'short', timeStyle: 'short' })}</td>
          <td><span class="badge badge-${percentColor(a.percent || 0)}">${a.percent ?? '—'}%</span></td>
          <td>${a.status === 'needs_review' ? `<span class="badge badge-warning">${t('quiz.pendingReview')}</span>` : ''}</td>
          <td><a class="btn btn-sm" href="/attempt/${a.id}">${t('quiz.review')}</a></td>
        </tr>`).join('')}</tbody></table>`
        : `<div class="muted small">${t('quiz.noAttempts')}</div>`}
    </div>`;

  import('../live.js').then(({ liveSection }) =>
    liveSection(out.querySelector('#liveHost'), { scope: 'quiz', id }));

  out.querySelector('#start')?.addEventListener('click', async () => {
    try {
      const r = await api.post('/attempts/start', { quizId: id });
      runPlayer(r, q, out);
    } catch (e) {
      toast(t(e.body?.error === 'max_attempts_reached' ? 'quiz.attempts' : 'common.error'), 'error');
    }
  });
}

/* ----------------------------------------------------------- quiz player */

function runPlayer({ attempt, questions }, quiz, out) {
  const responses = { ...(attempt.responses || {}) };
  let index = 0;
  let saveTimer = null;
  let ticker = null;

  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => api.patch(`/attempts/${attempt.id}/save`, { responses }).catch(() => {}), 900);
  };

  const answered = qq => {
    const v = responses[qq.id];
    return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
  };

  const draw = () => {
    const q = questions[index];
    out.innerHTML = `
      <div class="between mb">
        <div>
          <div class="small muted">${t('quiz.question')} ${index + 1} ${t('common.of')} ${questions.length}</div>
          <h2 style="margin:0">${esc(i18n.pick(quiz, 'title', quiz.title))}</h2>
        </div>
        <div class="row">
          <span id="timer" class="timer ${attempt.deadline ? '' : 'hidden'}"></span>
          <button class="btn btn-success" id="finish">${t('quiz.submit')}</button>
        </div>
      </div>

      <div class="progress mb"><i style="inline-size:${((index + 1) / questions.length) * 100}%"></i></div>

      <div class="q-card">
        <div class="between mb">
          <span class="badge">${Q.typeLabel(q.type)}</span>
          <span class="badge badge-primary">${q.points} ${t('common.points')}</span>
        </div>
        <div class="q-prompt">${esc(i18n.pick(q, 'prompt', q.prompt))}</div>
        ${Q.renderMedia(q.media)}
        ${q.hint ? `<details class="small mb"><summary class="muted">${t('quiz.hint')}</summary>${esc(q.hint)}</details>` : ''}
        <div id="qbody"></div>
      </div>

      <div class="between mt">
        <button class="btn" id="prev" ${index === 0 ? 'disabled' : ''}>← ${t('common.previous')}</button>
        <div class="q-nav">${questions.map((qq, i) =>
          `<button class="q-dot ${answered(qq) ? 'answered' : ''} ${i === index ? 'current' : ''}" data-go="${i}">${i + 1}</button>`).join('')}</div>
        <button class="btn" id="next" ${index === questions.length - 1 ? 'disabled' : ''}>${t('common.next')} →</button>
      </div>`;

    const body = out.querySelector('#qbody');
    body.innerHTML = Q.render(q, responses[q.id]);
    Q.bind(body, q, responses[q.id], v => { responses[q.id] = v; save(); });

    out.querySelector('#prev').onclick = () => { index--; draw(); };
    out.querySelector('#next').onclick = () => { index++; draw(); };
    out.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { index = Number(b.dataset.go); draw(); });
    out.querySelector('#finish').onclick = finish;
    tick();
  };

  const tick = () => {
    if (!attempt.deadline) return;
    const el = out.querySelector('#timer');
    if (!el) return;
    const left = Math.max(0, Math.round((new Date(attempt.deadline) - Date.now()) / 1000));
    el.textContent = `⏱ ${fmtDuration(left)}`;
    el.className = `timer ${left < 30 ? 'danger' : left < 90 ? 'warn' : ''}`;
    if (left === 0) finish(true);
  };
  ticker = setInterval(tick, 1000);

  async function finish(auto = false) {
    if (!auto && !confirm(t('quiz.submit') + ' ?')) return;
    clearInterval(ticker);
    clearTimeout(saveTimer);
    const r = await api.post(`/attempts/${attempt.id}/submit`, { responses });
    await session.refresh();
    showResult(r, quiz, out);
  }

  draw();
}

function showResult(r, quiz, out) {
  const pct = r.result.percent;
  out.innerHTML = `
    <div class="card center" style="border-top:4px solid var(--${percentColor(pct)})">
      <div style="font-size:3.2rem">${r.passed ? '🎉' : pct >= 40 ? '💪' : '📚'}</div>
      <h1 style="font-size:2.6rem;margin:0">${pct}%</h1>
      <div class="muted">${r.result.earnedPoints} / ${r.result.totalPoints} ${t('common.points')}</div>
      <div class="row mt" style="justify-content:center">
        <span class="badge badge-${r.passed ? 'success' : 'danger'}">${t(r.passed ? 'quiz.passed' : 'quiz.failed')}</span>
        ${r.result.pending ? `<span class="badge badge-warning">${t('quiz.pendingReview')}</span>` : ''}
        ${r.gain ? `<span class="badge badge-primary">+${r.gain.unlocked?.length ? '🏅 ' : ''}${t('dash.xp')} ${r.gain.streak ? '· 🔥 ' + r.gain.streak : ''}</span>` : ''}
      </div>
      ${r.gain?.unlocked?.length ? `<div class="row mt" style="justify-content:center">${r.gain.unlocked.map(b =>
        `<span class="badge badge-success">${b.icon} ${esc(b.id)}</span>`).join('')}</div>` : ''}
      ${r.gain?.leveledUp ? `<div class="badge badge-primary mt">⬆️ ${t('notif.level_up', { level: r.gain.level })}</div>` : ''}
      <div class="row mt" style="justify-content:center">
        <a class="btn" href="${backHref(quiz)}">${t('common.back')}</a>
        <a class="btn btn-primary" href="/quiz/${quiz.id}">${t('quiz.start')}</a>
      </div>
    </div>
    ${r.review ? `<h2 class="mt">${t('quiz.review')}</h2>
      ${r.review.map(item => Q.renderReview(item)).join('')}` : ''}`;
}

export async function attemptView({ id }, out) {
  const d = await api.get(`/attempts/${id}`);
  const pct = d.attempt.result?.percent ?? 0;
  out.innerHTML = `
    <a href="/quiz/${d.attempt.quizId}" class="small">← ${t('common.back')}</a>
    <div class="card mt between">
      <div>
        <h1>${esc(d.quiz?.title || '')}</h1>
        <div class="row small muted">
          <span>${esc(d.student?.name || '')}</span>
          <span>· ${i18n.date(d.attempt.submittedAt, { dateStyle: 'medium', timeStyle: 'short' })}</span>
          <span>· ⏱ ${fmtDuration(d.attempt.durationSec)}</span>
        </div>
      </div>
      <div class="center">
        <div style="font-size:2.2rem;font-weight:750">${pct}%</div>
        <span class="badge badge-${percentColor(pct)}">${d.attempt.result?.earnedPoints}/${d.attempt.result?.totalPoints}</span>
      </div>
    </div>
    ${d.review ? d.review.map(item => Q.renderReview(item)).join('')
      : `<div class="empty-state mt">${t('quiz.pendingReview')}</div>`}`;
}

/* ---------------------------------------------------------- quiz builder */

export async function quizEditView({ id }, out) {
  const data = await api.get(`/quizzes/${id}`);
  const quiz = data.quiz;
  const { types, groups } = await api.get('/quizzes/types');

  const draw = async () => {
    const fresh = await api.get(`/quizzes/${id}`);
    render(fresh);
  };

  const render = d => {
    out.innerHTML = `
      <div class="between mb">
        <div>
          <a href="${backHref(quiz)}" class="small">← ${t('common.back')}</a>
          <h1>${esc(d.quiz.title)}</h1>
        </div>
        <div class="row">
          <button class="btn" id="settings">⚙️</button>
          <a class="btn" href="/api/quizzes/${id}/export" target="_blank">⬇️ JSON</a>
          <button class="btn ${d.quiz.published ? '' : 'btn-primary'}" id="pub">
            ${t(d.quiz.published ? 'quiz.unpublish' : 'quiz.publish')}</button>
        </div>
      </div>

      <div class="card mb row">
        <span class="badge badge-primary">${d.questions.length} ${t('quiz.question')}</span>
        <span class="badge">${d.questions.reduce((s, q) => s + (q.points || 1), 0)} ${t('common.points')}</span>
        <span class="badge">${esc(d.quiz.kind)}</span>
        <span class="badge">${d.quiz.timeLimitSec ? Math.round(d.quiz.timeLimitSec / 60) + ' ' + t('common.minutes') : t('quiz.noTimeLimit')}</span>
        <span style="flex:1"></span>
        <button class="btn btn-primary" id="add">+ ${t('quiz.addQuestion')}</button>
      </div>

      <div class="stack">${d.questions.map((q, i) => `
        <div class="card">
          <div class="between mb">
            <span class="row">
              <span class="avatar">${i + 1}</span>
              <span class="badge badge-primary">${Q.typeLabel(q.type)}</span>
              <span class="badge">${q.points} ${t('common.points')}</span>
            </span>
            <span class="row">
              <button class="btn btn-sm" data-edit="${q.id}">✏️</button>
              <button class="btn btn-sm btn-danger" data-del="${q.id}">🗑</button>
            </span>
          </div>
          <div style="font-weight:600">${esc(q.prompt)}</div>
          ${q.data?.options ? `<div class="row mt tiny">${q.data.options.map((o, oi) =>
            `<span class="badge ${(Array.isArray(q.data.answer) ? q.data.answer.includes(oi) : q.data.answer === oi)
              ? 'badge-success' : ''}">${esc(o)}</span>`).join('')}</div>` : ''}
        </div>`).join('') || `<div class="empty-state">${t('common.empty')}</div>`}</div>`;

    out.querySelector('#add').onclick = () => questionEditor(id, types, null, draw, groups);
    out.querySelectorAll('[data-edit]').forEach(b => b.onclick = () =>
      questionEditor(id, types, d.questions.find(q => q.id === b.dataset.edit), draw, groups));
    out.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm(t('common.delete') + ' ?')) return;
      await api.del(`/quizzes/questions/${b.dataset.del}`);
      draw();
    });
    out.querySelector('#pub').onclick = async () => {
      await api.patch(`/quizzes/${id}`, { published: !d.quiz.published });
      draw();
    };
    out.querySelector('#settings').onclick = () => modal(`
      <h2>${t('common.edit')}</h2>
      <div class="field"><label>Title</label><input id="ti" value="${esc(d.quiz.title)}"></div>
      <div class="row">
        <div class="field" style="flex:1"><label>${t('quiz.timeLimit')} (${t('common.minutes')})</label>
          <input id="tl" type="number" value="${Math.round(d.quiz.timeLimitSec / 60)}"></div>
        <div class="field" style="flex:1"><label>${t('quiz.passPercent')}</label>
          <input id="pp" type="number" value="${d.quiz.passPercent}"></div>
        <div class="field" style="flex:1"><label>${t('quiz.attempts')} (0 = ∞)</label>
          <input id="ma" type="number" value="${d.quiz.maxAttempts}"></div>
      </div>
      <label class="row small"><input type="checkbox" id="sh" style="inline-size:auto" ${d.quiz.shuffleQuestions ? 'checked' : ''}> shuffle</label>
      <label class="row small mb"><input type="checkbox" id="sa" style="inline-size:auto" ${d.quiz.showAnswersAfter ? 'checked' : ''}> show answers after</label>
      <button class="btn btn-primary" id="sv">${t('common.save')}</button>`,
      { onMount: (root, close) => root.querySelector('#sv').onclick = async () => {
          await api.patch(`/quizzes/${id}`, {
            title: root.querySelector('#ti').value,
            timeLimitSec: Number(root.querySelector('#tl').value) * 60,
            passPercent: Number(root.querySelector('#pp').value),
            maxAttempts: Number(root.querySelector('#ma').value),
            shuffleQuestions: root.querySelector('#sh').checked,
            showAnswersAfter: root.querySelector('#sa').checked
          });
          close(); draw();
        } });
  };

  render(data);
}

/** Type-aware editor: the answer-key fields change with the selected type. */
/* ------------------------------------------------------- authoring helpers */

/** Opens the file picker, uploads, and resolves to the stored URL (or null). */
function pickImage() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        resolve((await api.upload(file)).url);
      } catch (err) {
        toast(err.body?.error === 'rejected_file_type_or_size'
          ? t('build.imageRejected') : t('common.error'), 'error');
        resolve(null);
      }
    };
    input.click();
  });
}

/** Upload / paste-a-URL / clear control, rendered into `host`. */
function imageSlot(host, value, onChange) {
  const draw = url => {
    host.innerHTML = `
      ${url ? `<img class="build-thumb" src="${esc(url)}" alt="">` : `<div class="build-empty">${t('build.noImage')}</div>`}
      <div class="row mt">
        <button type="button" class="btn btn-sm" data-up>⬆ ${t('build.upload')}</button>
        <button type="button" class="btn btn-sm" data-url>🔗 ${t('build.useUrl')}</button>
        ${url ? `<button type="button" class="btn btn-sm btn-danger" data-clear>✕</button>` : ''}
      </div>`;
    host.querySelector('[data-up]').onclick = async () => {
      const picked = await pickImage();
      if (picked) { draw(picked); onChange(picked); }
    };
    host.querySelector('[data-url]').onclick = () => {
      const entered = window.prompt(t('build.useUrl'), url || 'https://');
      if (entered) { draw(entered.trim()); onChange(entered.trim()); }
    };
    host.querySelector('[data-clear]')?.addEventListener('click', () => { draw(''); onChange(''); });
  };
  draw(value || '');
}

/** Percentage position of a click inside an element, clamped to 0-100. */
function clickPercent(el, event) {
  const r = el.getBoundingClientRect();
  return {
    x: +Math.max(0, Math.min(100, ((event.clientX - r.left) / r.width) * 100)).toFixed(1),
    y: +Math.max(0, Math.min(100, ((event.clientY - r.top) / r.height) * 100)).toFixed(1)
  };
}

function questionEditor(quizId, types, existing, done, groups) {
  const q = existing || { type: 'mcq_single', prompt: '', points: 1, data: { options: ['', ''], answer: 0 }, explanation: '' };
  // Working copy for the click-driven image editors, which build their data
  // structurally rather than from text inputs.
  const D = { ...(q.data || {}) };

  const dataFields = type => {
    const d = q.type === type ? (q.data || {}) : {};
    const list = (arr, fallback) => (arr?.length ? arr : fallback).join('\n');
    switch (type) {
      case 'mcq_single': case 'mcq_multiple':
        return `<div class="field"><label>Options (one per line)</label>
            <textarea id="d_options">${esc(list(d.options, ['', '', '', '']))}</textarea></div>
          <div class="field"><label>Correct index${type === 'mcq_multiple' ? 'es (comma separated)' : ''} — 0-based</label>
            <input id="d_answer" value="${esc(Array.isArray(d.answer) ? d.answer.join(',') : (d.answer ?? 0))}"></div>`;
      case 'true_false':
        return `<div class="field"><label>Answer</label><select id="d_answer">
          <option value="true" ${d.answer === true ? 'selected' : ''}>${t('q.true')}</option>
          <option value="false" ${d.answer === false ? 'selected' : ''}>${t('q.false')}</option></select></div>`;
      case 'short_answer': case 'code_output': case 'sql_query': case 'terminal':
        return `<div class="field"><label>Accepted answers (one per line)</label>
            <textarea id="d_accepted">${esc(list(d.accepted, ['']))}</textarea></div>
          ${type === 'code_output' ? `<div class="field"><label>Code</label>
            <textarea id="d_code" class="code-editor">${esc(d.code || '')}</textarea></div>` : ''}
          ${type === 'sql_query' ? `<div class="field"><label>Schema</label>
            <input id="d_schema" value="${esc(d.schema || '')}"></div>` : ''}`;
      case 'numeric':
        return `<div class="row"><div class="field" style="flex:1"><label>Answer</label>
            <input id="d_answer" type="number" step="any" value="${esc(d.answer ?? '')}"></div>
          <div class="field" style="flex:1"><label>Tolerance</label>
            <input id="d_tolerance" type="number" step="any" value="${esc(d.tolerance ?? 0)}"></div></div>`;
      case 'fill_blanks':
        return `<div class="field"><label>Text — use {{1}}, {{2}} for blanks</label>
            <textarea id="d_text" class="code-editor">${esc(d.text || '')}</textarea></div>
          <div class="field"><label>Answers (one line per blank, alternatives separated by |)</label>
            <textarea id="d_blanks">${esc((d.blanks || []).map(b => (b.accepted || []).join('|')).join('\n'))}</textarea></div>`;
      case 'ordering':
        return `<div class="field"><label>Items in the CORRECT order (one per line)</label>
          <textarea id="d_answer">${esc(list(d.answer, ['']))}</textarea></div>`;
      case 'matching':
        return `<div class="row"><div class="field" style="flex:1"><label>Left (one per line)</label>
            <textarea id="d_left">${esc(list(d.left, ['']))}</textarea></div>
          <div class="field" style="flex:1"><label>Right — same order = the pairing</label>
            <textarea id="d_right">${esc(list(d.right, ['']))}</textarea></div></div>`;
      case 'categorize':
        return `<div class="field"><label>Buckets (one per line)</label>
            <textarea id="d_buckets">${esc(list(d.buckets, ['']))}</textarea></div>
          <div class="field"><label>Items as "item = bucket" (one per line)</label>
            <textarea id="d_pairs">${esc(Object.entries(d.answer || {}).map(([k, v]) => `${k} = ${v}`).join('\n'))}</textarea></div>`;
      case 'code_write': case 'code_fix':
        return `<div class="field"><label>Function name</label><input id="d_functionName" value="${esc(d.functionName || '')}"></div>
          <div class="field"><label>Starter code</label>
            <textarea id="d_starter" class="code-editor">${esc(d.starter || d.code || '')}</textarea></div>
          <div class="field"><label>Tests — JSON array of {name, args, expected, hidden}</label>
            <textarea id="d_tests" class="code-editor">${esc(JSON.stringify(d.tests || [{ name: 'test 1', args: [1], expected: 1 }], null, 1))}</textarea></div>`;
      case 'bug_find':
        return `<div class="field"><label>Code (prefix each line with its number)</label>
            <textarea id="d_code" class="code-editor">${esc(d.code || '')}</textarea></div>
          <div class="field"><label>Buggy line number</label><input id="d_answer" type="number" value="${esc(d.answer ?? 1)}"></div>`;
      case 'base_convert':
        return `<div class="row"><div class="field" style="flex:1"><label>Value</label><input id="d_value" value="${esc(d.value || '')}"></div>
          <div class="field" style="flex:1"><label>From base</label><input id="d_fromBase" type="number" value="${esc(d.fromBase || 10)}"></div>
          <div class="field" style="flex:1"><label>To base</label><input id="d_toBase" type="number" value="${esc(d.toBase || 2)}"></div></div>`;
      case 'truth_table':
        return `<div class="field"><label>Inputs (comma separated)</label><input id="d_inputs" value="${esc((d.inputs || ['A', 'B']).join(','))}"></div>
          <div class="field"><label>Expression</label><input id="d_expression" value="${esc(d.expression || '')}"></div>
          <div class="field"><label>Output column top→bottom (1/0, comma separated)</label>
            <input id="d_answer" value="${esc((d.answer || []).map(v => v ? 1 : 0).join(','))}"></div>`;
      case 'hotspot':
        return `<div class="field"><label>Image URL (optional)</label><input id="d_image" value="${esc(d.image || '')}"></div>
          <div class="field"><label>Regions as "id = label" (one per line)</label>
            <textarea id="d_regions">${esc((d.regions || []).map(r => `${r.id} = ${r.label}`).join('\n'))}</textarea></div>
          <div class="field"><label>Correct region id</label><input id="d_answer" value="${esc((d.answer || [])[0] || '')}"></div>`;
      case 'image_choice':
        return `
          <label class="row small mb"><input type="checkbox" id="d_multiple" style="inline-size:auto"
            ${d.multiple ? 'checked' : ''}> ${t('build.allowMultiple')}</label>
          <div class="field"><label>${t('build.imageOptions')}</label>
            <div id="d_imgopts" class="build-img-list"></div>
            <button type="button" class="btn btn-sm mt" data-add-img-option>+ ${t('build.addImage')}</button>
          </div>
          <p class="tiny muted">${t('build.imageChoiceHint')}</p>`;

      case 'image_hotspot':
        return `
          <div class="field"><label>${t('build.image')}</label>
            <div data-image-slot="d_image" data-value="${esc(d.image || '')}"></div></div>
          <div class="field"><label>${t('build.zones')}</label>
            <div id="d_zoneCanvas" class="build-canvas"></div>
            <p class="tiny muted">${t('build.zonesHint')}</p>
            <div id="d_zoneList" class="stack mt"></div>
          </div>`;

      case 'image_label':
        return `
          <div class="field"><label>${t('build.image')}</label>
            <div data-image-slot="d_image" data-value="${esc(d.image || '')}"></div></div>
          <div class="field"><label>${t('build.labels')}</label>
            <textarea id="d_labels" rows="3">${esc((d.labels || []).join('\n'))}</textarea>
            <p class="tiny muted">${t('build.labelsHint')}</p></div>
          <div class="field"><label>${t('build.markers')}</label>
            <div id="d_markerCanvas" class="build-canvas"></div>
            <p class="tiny muted">${t('build.markersHint')}</p>
            <div id="d_markerList" class="stack mt"></div>
          </div>`;

      case 'image_order':
        return `
          <div class="field"><label>${t('build.imagesInOrder')}</label>
            <div id="d_orderList" class="build-img-list"></div>
            <button type="button" class="btn btn-sm mt" data-add-order-image>+ ${t('build.addImage')}</button>
            <p class="tiny muted mt">${t('build.imageOrderHint')}</p>
          </div>`;

      case 'flashcard':
        return `<div class="field"><label>Back of the card</label><textarea id="d_back">${esc(d.back || '')}</textarea></div>`;
      case 'essay':
        return `<div class="field"><label>Minimum words</label><input id="d_minWords" type="number" value="${esc(d.minWords || 50)}"></div>
          <div class="field"><label>Rubric (one criterion per line)</label>
            <textarea id="d_rubric">${esc((d.rubric || []).join('\n'))}</textarea></div>`;
      default: return '';
    }
  };

  const { root, close } = modal(`
    <h2>${existing ? t('common.edit') : t('quiz.addQuestion')}</h2>
    <div class="field"><label>Type</label>
      <select id="type">${
        // Grouped: a flat list of two dozen types is hard to scan.
        (groups?.length ? groups : [{ group: 'all', types: types.map(x => x.id) }]).map(g => `
          <optgroup label="${esc(t('qgroup.' + g.group))}">
            ${g.types.map(id =>
              `<option value="${id}" ${q.type === id ? 'selected' : ''}>${t('qtype.' + id)}</option>`).join('')}
          </optgroup>`).join('')}</select></div>
    <div class="field"><label>${t('quiz.question')}</label><textarea id="prompt">${esc(q.prompt)}</textarea></div>
    <details class="field build-media" ${q.media ? 'open' : ''}>
      <summary>🖼️ ${t('build.illustration')}</summary>
      <p class="tiny muted">${t('build.illustrationHint')}</p>
      <div id="mediaSlot"></div>
    </details>
    <div id="typeFields"></div>
    <div class="row">
      <div class="field" style="flex:1"><label>${t('common.points')}</label><input id="points" type="number" value="${q.points}"></div>
      <div class="field" style="flex:1"><label>${t('quiz.difficulty')}</label>
        <select id="difficulty">${['easy', 'medium', 'hard', 'expert'].map(x =>
          `<option ${q.difficulty === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>${t('quiz.explanation')}</label><textarea id="explanation">${esc(q.explanation || '')}</textarea></div>
    <div id="qerr" class="small mb" style="color:var(--danger)"></div>
    <div class="row"><button class="btn btn-primary" id="save">${t('common.save')}</button>
      <button class="btn" data-close>${t('common.cancel')}</button></div>`);

  const typeSel = root.querySelector('#type');
  const fields = root.querySelector('#typeFields');

  let media = q.media ? (typeof q.media === 'string' ? { url: q.media } : { ...q.media }) : null;
  imageSlot(root.querySelector('#mediaSlot'), media?.url, url => { media = url ? { url } : null; });

  const paint = () => {
    fields.innerHTML = dataFields(typeSel.value);
    wireImageAuthoring(typeSel.value);
  };
  typeSel.onchange = paint;

  /* -------------------------------------------------- click-driven editors */

  function wireImageAuthoring(type) {
    // Simple image slots (hotspot / label background).
    fields.querySelectorAll('[data-image-slot]').forEach(slot => {
      imageSlot(slot, slot.dataset.value, url => {
        D.image = url;
        if (type === 'image_hotspot') drawZones();
        if (type === 'image_label') drawMarkers();
      });
    });

    if (type === 'image_choice') {
      D.options = Array.isArray(D.options) ? D.options : [];
      drawImageOptions();
      fields.querySelector('[data-add-img-option]').onclick = async () => {
        const url = await pickImage();
        if (url) { D.options.push({ url, label: '' }); drawImageOptions(); }
      };
    }

    if (type === 'image_order') {
      D.items = Array.isArray(D.items) ? D.items : [];
      drawOrderItems();
      fields.querySelector('[data-add-order-image]').onclick = async () => {
        const url = await pickImage();
        if (url) { D.items.push({ id: 'i' + Date.now().toString(36), url, caption: '' }); drawOrderItems(); }
      };
    }

    if (type === 'image_hotspot') { D.zones ??= []; D.answer ??= []; drawZones(); }
    if (type === 'image_label') { D.markers ??= []; D.answer ??= {}; drawMarkers(); }
  }

  function drawImageOptions() {
    const host = fields.querySelector('#d_imgopts');
    if (!host) return;
    const answers = new Set((Array.isArray(D.answer) ? D.answer : [D.answer]).map(Number));
    const multiple = fields.querySelector('#d_multiple')?.checked;
    host.innerHTML = D.options.map((o, i) => `
      <div class="build-img-row ${answers.has(i) ? 'is-answer' : ''}">
        <img src="${esc(o.url)}" alt="">
        <input placeholder="${t('build.optionLabel')}" value="${esc(o.label || '')}" data-opt-label="${i}">
        <button type="button" class="btn btn-sm ${answers.has(i) ? 'btn-success' : ''}" data-opt-correct="${i}">
          ${answers.has(i) ? '✓ ' + t('quiz.correct') : t('build.markCorrect')}</button>
        <button type="button" class="btn btn-sm btn-danger" data-opt-del="${i}">✕</button>
      </div>`).join('') || `<div class="build-empty">${t('build.noImagesYet')}</div>`;

    host.querySelectorAll('[data-opt-label]').forEach(inp => inp.oninput = () => {
      D.options[Number(inp.dataset.optLabel)].label = inp.value;
    });
    host.querySelectorAll('[data-opt-correct]').forEach(b => b.onclick = () => {
      const i = Number(b.dataset.optCorrect);
      if (multiple) {
        const set = new Set(Array.isArray(D.answer) ? D.answer.map(Number) : []);
        set.has(i) ? set.delete(i) : set.add(i);
        D.answer = [...set].sort((a, b2) => a - b2);
      } else D.answer = i;
      drawImageOptions();
    });
    host.querySelectorAll('[data-opt-del]').forEach(b => b.onclick = () => {
      D.options.splice(Number(b.dataset.optDel), 1);
      D.answer = Array.isArray(D.answer) ? [] : 0;
      drawImageOptions();
    });
    fields.querySelector('#d_multiple').onchange = () => {
      D.answer = fields.querySelector('#d_multiple').checked ? [] : 0;
      drawImageOptions();
    };
  }

  function drawOrderItems() {
    const host = fields.querySelector('#d_orderList');
    if (!host) return;
    host.innerHTML = D.items.map((it, i) => `
      <div class="build-img-row">
        <span class="marker-num">${i + 1}</span>
        <img src="${esc(it.url)}" alt="">
        <input placeholder="${t('build.caption')}" value="${esc(it.caption || '')}" data-item-caption="${i}">
        <button type="button" class="btn btn-sm" data-item-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="btn btn-sm" data-item-down="${i}" ${i === D.items.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="btn btn-sm btn-danger" data-item-del="${i}">✕</button>
      </div>`).join('') || `<div class="build-empty">${t('build.noImagesYet')}</div>`;

    host.querySelectorAll('[data-item-caption]').forEach(inp => inp.oninput = () => {
      D.items[Number(inp.dataset.itemCaption)].caption = inp.value;
    });
    const swap = (a, b) => { [D.items[a], D.items[b]] = [D.items[b], D.items[a]]; drawOrderItems(); };
    host.querySelectorAll('[data-item-up]').forEach(b => b.onclick = () => swap(Number(b.dataset.itemUp), Number(b.dataset.itemUp) - 1));
    host.querySelectorAll('[data-item-down]').forEach(b => b.onclick = () => swap(Number(b.dataset.itemDown), Number(b.dataset.itemDown) + 1));
    host.querySelectorAll('[data-item-del]').forEach(b => b.onclick = () => {
      D.items.splice(Number(b.dataset.itemDel), 1); drawOrderItems();
    });
  }

  function drawZones() {
    const canvas = fields.querySelector('#d_zoneCanvas');
    const list = fields.querySelector('#d_zoneList');
    if (!canvas || !list) return;
    const answers = new Set((D.answer || []).map(String));

    canvas.innerHTML = D.image
      ? `<img src="${esc(D.image)}" alt="">
         ${D.zones.map((z, i) => `<span class="build-zone ${answers.has(String(z.id)) ? 'is-answer' : ''}"
             style="inset-inline-start:${z.x}%;inset-block-start:${z.y}%;inline-size:${z.w}%;block-size:${z.h}%">${i + 1}</span>`).join('')}`
      : `<div class="build-empty">${t('build.addImageFirst')}</div>`;

    if (D.image) {
      canvas.onclick = e => {
        if (e.target.classList.contains('build-zone')) return;
        const p = clickPercent(canvas.querySelector('img') || canvas, e);
        D.zones.push({
          id: 'z' + Date.now().toString(36),
          label: '',
          x: +Math.max(0, p.x - 10).toFixed(1), y: +Math.max(0, p.y - 10).toFixed(1), w: 20, h: 20
        });
        drawZones();
      };
    }

    list.innerHTML = D.zones.map((z, i) => `
      <div class="build-img-row">
        <span class="marker-num">${i + 1}</span>
        <input placeholder="${t('build.zoneLabel')}" value="${esc(z.label || '')}" data-zone-label="${i}">
        <label class="tiny muted">W<input type="number" min="2" max="100" value="${z.w}" data-zone-w="${i}" style="inline-size:64px"></label>
        <label class="tiny muted">H<input type="number" min="2" max="100" value="${z.h}" data-zone-h="${i}" style="inline-size:64px"></label>
        <button type="button" class="btn btn-sm ${answers.has(String(z.id)) ? 'btn-success' : ''}" data-zone-correct="${i}">
          ${answers.has(String(z.id)) ? '✓' : t('build.markCorrect')}</button>
        <button type="button" class="btn btn-sm btn-danger" data-zone-del="${i}">✕</button>
      </div>`).join('') || `<div class="build-empty">${t('build.clickToAddZone')}</div>`;

    list.querySelectorAll('[data-zone-label]').forEach(i2 => i2.oninput = () => D.zones[Number(i2.dataset.zoneLabel)].label = i2.value);
    for (const dim of ['w', 'h']) {
      list.querySelectorAll(`[data-zone-${dim}]`).forEach(inp => inp.onchange = () => {
        D.zones[Number(inp.dataset[`zone${dim.toUpperCase()}`])][dim] = Number(inp.value) || 20;
        drawZones();
      });
    }
    list.querySelectorAll('[data-zone-correct]').forEach(b => b.onclick = () => {
      const id = String(D.zones[Number(b.dataset.zoneCorrect)].id);
      const set = new Set((D.answer || []).map(String));
      set.has(id) ? set.delete(id) : set.add(id);
      D.answer = [...set];
      drawZones();
    });
    list.querySelectorAll('[data-zone-del]').forEach(b => b.onclick = () => {
      const [gone] = D.zones.splice(Number(b.dataset.zoneDel), 1);
      D.answer = (D.answer || []).filter(a => String(a) !== String(gone.id));
      drawZones();
    });
  }

  function drawMarkers() {
    const canvas = fields.querySelector('#d_markerCanvas');
    const list = fields.querySelector('#d_markerList');
    if (!canvas || !list) return;
    const labels = (fields.querySelector('#d_labels')?.value || '')
      .split('\n').map(s => s.trim()).filter(Boolean);

    canvas.innerHTML = D.image
      ? `<img src="${esc(D.image)}" alt="">
         ${D.markers.map((m, i) => `<span class="build-marker"
             style="inset-inline-start:${m.x}%;inset-block-start:${m.y}%">${i + 1}</span>`).join('')}`
      : `<div class="build-empty">${t('build.addImageFirst')}</div>`;

    if (D.image) {
      canvas.onclick = e => {
        if (e.target.classList.contains('build-marker')) return;
        const p = clickPercent(canvas.querySelector('img') || canvas, e);
        D.markers.push({ id: 'm' + Date.now().toString(36), x: p.x, y: p.y });
        drawMarkers();
      };
    }

    list.innerHTML = D.markers.map((m, i) => `
      <div class="build-img-row">
        <span class="marker-num">${i + 1}</span>
        <select data-marker-answer="${esc(m.id)}" style="flex:1">
          <option value="">${t('build.pickCorrectLabel')}</option>
          ${labels.map(l => `<option ${D.answer?.[m.id] === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
        <button type="button" class="btn btn-sm btn-danger" data-marker-del="${i}">✕</button>
      </div>`).join('') || `<div class="build-empty">${t('build.clickToAddMarker')}</div>`;

    list.querySelectorAll('[data-marker-answer]').forEach(sel => sel.onchange = () => {
      D.answer = { ...(D.answer || {}) };
      if (sel.value) D.answer[sel.dataset.markerAnswer] = sel.value;
      else delete D.answer[sel.dataset.markerAnswer];
    });
    list.querySelectorAll('[data-marker-del]').forEach(b => b.onclick = () => {
      const [gone] = D.markers.splice(Number(b.dataset.markerDel), 1);
      if (D.answer) delete D.answer[gone.id];
      drawMarkers();
    });
    const labelBox = fields.querySelector('#d_labels');
    if (labelBox && !labelBox.dataset.wired) {
      labelBox.dataset.wired = '1';
      labelBox.oninput = () => drawMarkers();
    }
  }

  paint();

  const lines = id => (root.querySelector(id)?.value || '').split('\n').map(s => s.trim()).filter(Boolean);

  root.querySelector('#save').onclick = async () => {
    const type = typeSel.value;
    const g = id => root.querySelector(id)?.value;
    let data = {};
    try {
      switch (type) {
        case 'mcq_single':
          data = { options: lines('#d_options'), answer: Number(g('#d_answer')) }; break;
        case 'mcq_multiple':
          data = { options: lines('#d_options'), answer: g('#d_answer').split(',').map(n => Number(n.trim())) }; break;
        case 'true_false':
          data = { answer: g('#d_answer') === 'true' }; break;
        case 'short_answer': case 'terminal':
          data = { accepted: lines('#d_accepted') }; break;
        case 'code_output':
          data = { accepted: lines('#d_accepted'), code: g('#d_code') }; break;
        case 'sql_query':
          data = { accepted: lines('#d_accepted'), schema: g('#d_schema') }; break;
        case 'numeric':
          data = { answer: Number(g('#d_answer')), tolerance: Number(g('#d_tolerance') || 0) }; break;
        case 'fill_blanks':
          data = { text: g('#d_text'), blanks: lines('#d_blanks').map(l => ({ accepted: l.split('|').map(s => s.trim()) })) }; break;
        case 'ordering': {
          const answer = lines('#d_answer');
          data = { items: answer, answer }; break;
        }
        case 'matching': {
          const left = lines('#d_left'), right = lines('#d_right');
          data = { left, right, answer: Object.fromEntries(left.map((l, i) => [l, right[i]])) }; break;
        }
        case 'categorize': {
          const answer = Object.fromEntries(lines('#d_pairs').map(l => {
            const [k, v] = l.split('=').map(s => s.trim());
            return [k, v];
          }));
          data = { buckets: lines('#d_buckets'), items: Object.keys(answer), answer }; break;
        }
        case 'code_write': case 'code_fix':
          data = { functionName: g('#d_functionName'), starter: g('#d_starter'), code: g('#d_starter'), tests: JSON.parse(g('#d_tests')) }; break;
        case 'bug_find':
          data = { code: g('#d_code'), answer: Number(g('#d_answer')) }; break;
        case 'base_convert':
          data = { value: g('#d_value'), fromBase: Number(g('#d_fromBase')), toBase: Number(g('#d_toBase')) }; break;
        case 'truth_table':
          data = {
            inputs: g('#d_inputs').split(',').map(s => s.trim()),
            expression: g('#d_expression'),
            answer: g('#d_answer').split(',').map(s => s.trim() === '1')
          }; break;
        case 'hotspot':
          data = {
            image: g('#d_image') || null,
            regions: lines('#d_regions').map(l => { const [id, label] = l.split('='); return { id: id.trim(), label: (label || id).trim() }; }),
            answer: [g('#d_answer')]
          }; break;
        case 'flashcard': data = { back: g('#d_back') }; break;
        case 'essay': data = { minWords: Number(g('#d_minWords')), rubric: lines('#d_rubric') }; break;

        // The image editors build their structure as the teacher clicks, so the
        // working copy is already the payload.
        case 'image_choice':
          data = { options: D.options || [], answer: D.answer, multiple: !!g('#d_multiple') || fields.querySelector('#d_multiple')?.checked };
          break;
        case 'image_hotspot':
          data = { image: D.image, imageAlt: D.imageAlt || '', zones: D.zones || [], answer: D.answer || [] };
          break;
        case 'image_label':
          data = { image: D.image, imageAlt: D.imageAlt || '', markers: D.markers || [], labels: lines('#d_labels'), answer: D.answer || {} };
          break;
        case 'image_order':
          data = { items: D.items || [], answer: (D.items || []).map(i => i.id) };
          break;
      }
    } catch (e) {
      root.querySelector('#qerr').textContent = 'JSON: ' + e.message;
      return;
    }

    const payload = {
      type, prompt: g('#prompt'), data, media,
      points: Number(g('#points')), difficulty: g('#difficulty'), explanation: g('#explanation')
    };
    try {
      if (existing) await api.patch(`/quizzes/questions/${existing.id}`, payload);
      else await api.post(`/quizzes/${quizId}/questions`, payload);
      close();
      done();
    } catch (e) {
      root.querySelector('#qerr').textContent = e.body?.error || t('common.error');
    }
  };
}

/* ------------------------------------------------------- grading & stats */

export async function reviewQueueView(_p, out) {
  const { queue } = await api.get('/attempts/queue/review');
  out.innerHTML = `
    <h1>${t('review.queue')}</h1>
    ${queue.length ? queue.map(a => `
      <div class="card mb">
        <div class="between mb">
          <span class="row">${avatar(a.student)} <strong>${esc(a.student.name)}</strong>
            <span class="muted small">${esc(a.quiz)} · ${esc(a.course)}</span></span>
          <span class="tiny muted">${i18n.date(a.submittedAt)}</span>
        </div>
        ${a.pendingQuestions.map(p => `
          <div class="card mb" style="background:var(--surface-2)">
            <div style="font-weight:600">${esc(p.prompt)}</div>
            ${p.rubric?.length ? `<div class="tiny muted">${p.rubric.map(esc).join(' · ')}</div>` : ''}
            <div class="card mt small" style="white-space:pre-wrap">${esc(p.answer || '')}</div>
            <div class="row mt">
              <input type="number" min="0" max="${p.points}" placeholder="0-${p.points}"
                     data-score="${a.id}|${p.questionId}" style="inline-size:110px">
              <input placeholder="${t('review.comment')}" data-comment="${a.id}|${p.questionId}" style="flex:1">
            </div>
          </div>`).join('')}
        <button class="btn btn-primary" data-grade="${a.id}">${t('review.grade')}</button>
      </div>`).join('') : `<div class="empty-state"><span class="ic">✅</span>${t('common.empty')}</div>`}`;

  out.querySelectorAll('[data-grade]').forEach(b => b.onclick = async () => {
    const id = b.dataset.grade;
    const scores = {}, comments = {};
    out.querySelectorAll(`[data-score^="${id}|"]`).forEach(i => scores[i.dataset.score.split('|')[1]] = Number(i.value || 0));
    out.querySelectorAll(`[data-comment^="${id}|"]`).forEach(i => comments[i.dataset.comment.split('|')[1]] = i.value);
    await api.post(`/attempts/${id}/review`, { scores, comments });
    toast('✅ ' + t('review.grade'), 'success');
    router.resolve();
  });
}

export async function gradebookView({ courseId }, out) {
  const g = await api.get(`/attempts/gradebook/${courseId}`);
  out.innerHTML = `
    <div class="between mb">
      <h1>${t('gradebook.title')} — ${esc(g.course.title)}</h1>
      <div class="row">
        <span class="badge badge-primary">${t('gradebook.classAverage')}: ${g.classAverage ?? '—'}%</span>
        <button class="btn btn-sm" id="csv">${t('gradebook.export')}</button>
      </div>
    </div>
    <div class="card table-wrap"><table>
      <thead><tr><th>${t('lb.student')}</th>
        ${g.quizzes.map(q => `<th title="${esc(q.title)}">${esc(q.title.slice(0, 18))}</th>`).join('')}
        <th>${t('gradebook.average')}</th></tr></thead>
      <tbody>${g.rows.map(r => `
        <tr>
          <td class="row">${avatar(r.student)} ${esc(r.student.name)}</td>
          ${r.cells.map(c => `<td>${c.best == null ? t('gradebook.noAttempt')
            : `<span class="badge badge-${percentColor(c.best)}">${c.best}%</span>`}</td>`).join('')}
          <td>${r.average == null ? '—' : `<strong>${r.average}%</strong>`}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;

  out.querySelector('#csv').onclick = () => {
    const head = [t('lb.student'), ...g.quizzes.map(q => q.title), t('gradebook.average')];
    const rows = g.rows.map(r => [r.student.name, ...r.cells.map(c => c.best ?? ''), r.average ?? '']);
    const csv = [head, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = `gradebook-${g.course.title}.csv`;
    a.click();
  };
}

export async function analyticsView({ quizId }, out) {
  const a = await api.get(`/analytics/quiz/${quizId}`);
  out.innerHTML = `
    <a href="/quiz/${quizId}" class="small">← ${t('common.back')}</a>
    <h1 class="mt">${t('analytics.title')} — ${esc(a.quiz.title)}</h1>
    <div class="grid grid-4 mb">
      <div class="stat"><div class="v">${a.totals.attempts}</div><div class="k">${t('quiz.attempts')}</div></div>
      <div class="stat"><div class="v">${a.totals.average ?? '—'}%</div><div class="k">${t('gradebook.average')}</div></div>
      <div class="stat"><div class="v">${a.totals.passRate ?? '—'}%</div><div class="k">${t('analytics.passRate')}</div></div>
      <div class="stat"><div class="v">${fmtDuration(a.totals.averageDuration)}</div><div class="k">${t('analytics.avgDuration')}</div></div>
    </div>
    <div class="grid grid-2">
      <div class="card"><h3>${t('quiz.score')}</h3>
        ${barChart(a.histogram.map(h => ({ label: h.band + '%', value: h.count, display: h.count })))}
      </div>
      <div class="card"><h3>${t('analytics.hardest')}</h3>
        ${barChart(a.items.filter(i => i.difficulty != null).slice(0, 8).map(i => ({
          label: i.prompt.slice(0, 26), value: i.difficulty, max: 100, display: i.difficulty + '%',
          color: i.difficulty > 60 ? 'var(--danger)' : 'var(--warning)'
        })))}
      </div>
    </div>
    <div class="card mt"><h3>${t('quiz.question')}</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>${t('quiz.question')}</th><th>Type</th>
          <th>${t('analytics.difficulty')}</th><th>${t('analytics.commonMistakes')}</th></tr></thead>
        <tbody>${a.items.map((i, n) => `
          <tr>
            <td>${n + 1}</td>
            <td>${esc(i.prompt || '').slice(0, 70)}</td>
            <td class="tiny">${t('qtype.' + i.type)}</td>
            <td>${i.difficulty == null ? '—' : `<span class="badge badge-${i.difficulty > 60 ? 'danger' : i.difficulty > 30 ? 'warning' : 'success'}">${i.difficulty}%</span>`}</td>
            <td class="tiny muted mono">${i.commonMistakes.map(m => `${esc(String(m.answer).slice(0, 22))}×${m.count}`).join(', ')}</td>
          </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
}

/* ------------------------------------------------- flashcards, playground */

export async function flashcardsView(_p, out) {
  const { due } = await api.get('/attempts/flashcards/due');
  let i = 0;

  const draw = () => {
    if (i >= due.length) {
      out.innerHTML = `<div class="empty-state"><span class="ic">🎉</span>${t('flash.allDone')}</div>`;
      return;
    }
    const card = due[i];
    out.innerHTML = `
      <div class="between mb"><h1>${t('flash.title')}</h1>
        <span class="badge badge-primary">${due.length - i} ${t('flash.due')}</span></div>
      <div class="card center" style="min-block-size:230px;display:grid;place-content:center">
        <div style="font-size:1.35rem;font-weight:650">${esc(i18n.pick(card, 'prompt', card.prompt))}</div>
        <div id="back" class="hidden mt muted">${esc(card.back || '')}</div>
      </div>
      <div class="center mt"><button class="btn btn-lg" id="flip">${t('flash.showAnswer')}</button></div>
      <div class="row mt hidden" id="conf" style="justify-content:center">
        ${[[0, 'flash.again'], [3, 'flash.hard'], [4, 'flash.good'], [5, 'flash.easy']].map(([c, k]) =>
          `<button class="btn" data-c="${c}">${t(k)}</button>`).join('')}
      </div>`;

    out.querySelector('#flip').onclick = e => {
      out.querySelector('#back').classList.remove('hidden');
      out.querySelector('#conf').classList.remove('hidden');
      e.target.classList.add('hidden');
    };
    out.querySelectorAll('[data-c]').forEach(b => b.onclick = async () => {
      await api.post(`/attempts/flashcards/${card.id}/review`, { confidence: Number(b.dataset.c) });
      i++;
      draw();
    });
  };
  draw();
}

export async function playgroundView(_p, out) {
  out.innerHTML = `
    <h1>${t('play.title')}</h1>
    <p class="muted small">${t('play.hint')}</p>
    <div class="grid grid-2">
      <div class="card">
        <textarea id="code" class="code-editor" spellcheck="false" style="min-block-size:320px">// ${t('play.hint')}
function fibonacci(n) {
  return n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2);
}
for (let i = 0; i < 10; i++) console.log(i, fibonacci(i));</textarea>
        <div class="row mt">
          <button class="btn btn-primary" id="run">▶ ${t('play.run')}</button>
          <button class="btn" id="clr">${t('play.clear')}</button>
        </div>
      </div>
      <div class="card"><h3>${t('quiz.output')}</h3><div id="out"></div></div>
    </div>`;

  const run = async () => {
    const o = out.querySelector('#out');
    o.innerHTML = `<span class="muted small">${t('common.loading')}</span>`;
    try {
      const r = await api.post('/quizzes/playground/run', { code: out.querySelector('#code').value });
      o.innerHTML = Q.runOutput(r) || `<span class="muted small">${t('common.empty')}</span>`;
    } catch { o.innerHTML = `<span style="color:var(--danger)">${t('common.error')}</span>`; }
  };
  out.querySelector('#run').onclick = run;
  out.querySelector('#clr').onclick = () => out.querySelector('#out').innerHTML = '';
  out.querySelector('#code').onkeydown = e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run();
  };
}
