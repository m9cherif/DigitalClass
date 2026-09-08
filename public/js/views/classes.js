/* Class Hub: the container a student actually joins. One code grants access
 * to every course inside a class, including ones added to it later — courses
 * on their own no longer carry a code. */
import {
  api, store, router, t, i18n, esc, toast, modal, confirmDialog, avatar, percentColor, LANGS
} from '../core.js';

/* --------------------------------------------------------------------- list */

export async function classHubView(_p, out) {
  const { classes } = await api.get('/classes');
  const canCreate = ['teacher', 'admin'].includes(store.user.role);
  const isStudent = store.user.role === 'student';

  out.innerHTML = `
    <div class="between mb">
      <h1>${t('classes.hub')}</h1>
      ${canCreate ? `<a class="btn btn-primary" href="/classes/new">+ ${t('classes.newClass')}</a>` : ''}
    </div>

    ${isStudent ? `
      <form class="card join-card mb" id="joinForm">
        <div class="join-lead">
          <strong>🔑 ${t('classes.join')}</strong>
          <div class="small muted">${t('classes.joinHint')}</div>
        </div>
        <div class="join-controls">
          <input id="joinCode" class="code-input" maxlength="6" autocomplete="off"
                 placeholder="${t('classes.joinPlaceholder')}" aria-label="${t('classes.code')}">
          <button class="btn btn-primary">${t('classes.join')}</button>
        </div>
        <div id="joinErr" class="small" style="color:var(--danger)"></div>
      </form>` : ''}

    <div class="grid grid-2">${classes.map(c => `
      <a class="card card-hover" href="/classes/${c.id}" style="color:inherit;border-top:3px solid ${esc(c.color)}">
        <div class="between mb">
          <span class="tag-label">${esc(c.title)}</span>
          ${c.status !== 'published' ? `<span class="badge badge-warning">${t('common.draft')}</span>` : ''}
        </div>
        <h3>${esc(c.title)}</h3>
        <p class="small muted">${esc(c.description || '').slice(0, 130)}</p>
        <div class="row tiny muted">
          ${icon('book')} ${c.courseCount} ${t('classes.courses')}
          ${icon('users')} ${c.memberCount} ${t('course.students')}
        </div>
        <div class="between mt">
          <span class="small">${t('course.by')} ${esc(c.teacher?.name || '')}</span>
          ${c.isMember ? `<span class="badge badge-success">${t('course.enrolled')}</span>` : ''}
        </div>
      </a>`).join('') || `<div class="empty-state"><span class="ic">📭</span>${t('common.empty')}</div>`}
    </div>`;

  const joinForm = out.querySelector('#joinForm');
  if (joinForm) {
    const input = out.querySelector('#joinCode');
    input.oninput = () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); };
    joinForm.onsubmit = async e => {
      e.preventDefault();
      const err = out.querySelector('#joinErr');
      err.textContent = '';
      try {
        const r = await api.post('/classes/join', { code: input.value });
        toast(r.alreadyMember
          ? t('classes.alreadyMember')
          : '✅ ' + t('classes.joined', { class: esc(r.class.title) }), 'success');
        router.go('/classes/' + r.class.id);
      } catch (ex) {
        const code = ex.body?.error;
        err.textContent = t('classes.' + code) !== 'classes.' + code ? t('classes.' + code) : t('common.error');
      }
    };
  }
}

// A tiny inline icon, duplicated from core.js's set so this file has no
// import cycle risk — kept intentionally tiny (two glyphs used here).
function icon(name) {
  const paths = {
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21V5.5Z"/><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M2.5 19a6.5 6.5 0 0 1 13 0"/><circle cx="17.5" cy="8.5" r="2.5"/><path d="M15 6.2A4 4 0 0 1 21.5 9"/>'
  };
  return `<svg class="ic-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

export async function classNewView(_p, out) {
  out.innerHTML = `
    <h1>${t('classes.newClass')}</h1>
    <form class="card" id="f" style="max-inline-size:560px">
      <div class="field"><label>${t('common.create')}</label><input name="title" required></div>
      <div class="field"><label>${t('classes.hub')}</label><textarea name="description"></textarea></div>
      <div class="field"><label>Color</label><input name="color" type="color" value="#9184d9" style="inline-size:80px"></div>
      <button class="btn btn-primary">${t('common.create')}</button>
    </form>`;

  out.querySelector('#f').onsubmit = async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    const { class: cls } = await api.post('/classes', body);
    toast(t('quiz.saved'), 'success');
    router.go(`/classes/${cls.id}`);
  };
}

/* ------------------------------------------------------------------- detail */

export async function classDetailView({ id }, out) {
  const data = await api.get(`/classes/${id}`);
  const cls = data.class;

  out.innerHTML = `
    <a href="/classes" class="small">← ${t('classes.hub')}</a>
    <div class="card mt mb" style="border-top:4px solid ${esc(cls.color)}">
      <div class="between">
        <div>
          <h1>${esc(cls.title)}</h1>
          <p class="muted">${esc(cls.description || '')}</p>
          <div class="small muted">${t('course.by')} ${esc(cls.teacher?.name || '')} ·
            ${data.memberCount} ${t('course.students')}</div>
        </div>
        <div class="stack course-actions">
          ${data.editable ? `<button class="btn" id="edit">✏️ ${t('common.edit')}</button>` : ''}
        </div>
      </div>
    </div>

    ${cls.code ? `
      <div class="card code-card mb">
        <div>
          <div class="small muted">${t('classes.code')}</div>
          <div class="code-value" id="codeValue">${esc(cls.code)}</div>
          <div class="tiny muted">${t('classes.codeHint')}</div>
        </div>
        <div class="row">
          <button class="btn btn-sm" id="copyCode">📋</button>
          <button class="btn btn-sm" id="newCode">${t('course.regenerate')}</button>
        </div>
      </div>` : ''}

    <div class="tabs">
      <button class="tab active" data-tab="courses">${t('classes.courses')}</button>
      <button class="tab" data-tab="party">🎉 ${t('nav.party')}</button>
      ${data.editable ? `<button class="tab" data-tab="roster">${t('course.roster')}</button>` : ''}
    </div>
    <div id="tab"></div>`;

  out.querySelector('#copyCode')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(cls.code);
      toast('✅ ' + t('course.codeCopied'), 'success');
    } catch {
      const range = document.createRange();
      range.selectNodeContents(out.querySelector('#codeValue'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
  });
  out.querySelector('#newCode')?.addEventListener('click', async () => {
    const r = await api.post(`/classes/${id}/code/regenerate`);
    out.querySelector('#codeValue').textContent = r.code;
    cls.code = r.code;
    toast('🔑 ' + r.code, 'success');
  });
  out.querySelector('#edit')?.addEventListener('click', () => modal(`
    <h2>${t('common.edit')}</h2>
    <div class="field"><label>Title</label><input id="ti" value="${esc(cls.title)}"></div>
    <div class="field"><label>Description</label><textarea id="de">${esc(cls.description || '')}</textarea></div>
    <div class="field"><label>Status</label>
      <select id="st"><option value="draft" ${cls.status === 'draft' ? 'selected' : ''}>${t('common.draft')}</option>
        <option value="published" ${cls.status === 'published' ? 'selected' : ''}>${t('common.published')}</option></select></div>
    <div class="row"><button class="btn btn-primary" id="sv">${t('common.save')}</button>
      <button class="btn btn-danger" id="del">${t('common.delete')}</button></div>`,
    { onMount: (root, close) => {
        root.querySelector('#sv').onclick = async () => {
          await api.patch(`/classes/${id}`, {
            title: root.querySelector('#ti').value,
            description: root.querySelector('#de').value,
            status: root.querySelector('#st').value
          });
          close(); router.resolve();
        };
        root.querySelector('#del').onclick = async () => {
          if (!await confirmDialog(t('classes.confirmDelete'), { danger: true })) return;
          await api.del(`/classes/${id}`);
          close();
          router.go('/classes');
        };
      } }));

  const panes = {
    courses: () => renderCourses(),
    party: () => `<div id="partyHost"></div>`,
    roster: () => `<div id="rosterHost"></div>`
  };

  const tabEl = out.querySelector('#tab');
  const showTab = async name => {
    tabEl.innerHTML = panes[name]();
    if (name === 'courses') wireCourses();
    if (name === 'party') {
      const { classPartyView } = await import('./party.js');
      classPartyView({ classId: id }, tabEl.querySelector('#partyHost'));
    }
    if (name === 'roster') loadRoster();
  };

  out.querySelectorAll('.tab').forEach(b => b.onclick = () => {
    out.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    showTab(b.dataset.tab);
  });

  function renderCourses() {
    return `
      ${data.editable ? `<button class="btn btn-sm mb" id="addCourse">+ ${t('course.newCourse')}</button>` : ''}
      <div id="courseGrid" class="grid grid-2"><div class="skeleton"></div></div>`;
  }

  async function wireCourses() {
    out.querySelector('#addCourse')?.addEventListener('click', () => newCourseModal(id, () => showTab('courses')));
    const { courses } = await api.get(`/courses?classId=${id}`);
    const grid = out.querySelector('#courseGrid');
    if (!grid) return;
    grid.innerHTML = courses.map(c => `
      <a class="card card-hover" href="/classes/${id}/courses/${c.id}" style="color:inherit;border-top:3px solid ${esc(c.color)}">
        <div class="between mb">
          <span class="tag-label">${t('topic.' + c.topic)}</span>
          ${c.status !== 'published' ? `<span class="badge badge-warning">${t('common.draft')}</span>` : ''}
        </div>
        <h3>${esc(i18n.pick(c, 'title', c.title))}</h3>
        <div class="row tiny muted">
          <span>📚 ${c.lessonCount} ${t('course.lessons')}</span>
          <span>❓ ${c.quizCount} ${t('course.quizzes')}</span>
        </div>
      </a>`).join('') || `<div class="empty-state">${t('common.empty')}</div>`;
  }

  async function loadRoster() {
    const host = out.querySelector('#rosterHost');
    const r = await api.get(`/classes/${id}/roster`);
    host.innerHTML = `
      <div class="card table-wrap"><table>
        <thead><tr><th>${t('lb.student')}</th><th>${t('course.progress')}</th>
          <th>${t('quiz.attempts')}</th><th>${t('gradebook.average')}</th><th>${t('common.lastActive')}</th><th></th></tr></thead>
        <tbody>${r.roster.map(row => `
          <tr>
            <td class="row">${avatar(row.student)} ${esc(row.student.name)}</td>
            <td style="min-inline-size:140px">
              <div class="progress"><i style="inline-size:${Math.round((row.lessonsDone / row.lessonsTotal) * 100)}%"></i></div>
              <span class="tiny muted">${row.lessonsDone}/${row.lessonsTotal}</span>
            </td>
            <td>${row.attempts}</td>
            <td>${row.averageScore != null ? `<span class="badge badge-${percentColor(row.averageScore)}">${row.averageScore}%</span>` : '—'}</td>
            <td class="tiny muted">${row.lastActive || '—'}</td>
            <td><button class="btn btn-sm btn-danger" data-remove="${row.student.id}">${t('classes.removeStudent')}</button></td>
          </tr>`).join('') || `<tr><td colspan="6" class="empty-state">${t('common.empty')}</td></tr>`}</tbody>
      </table></div>`;

    host.querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => {
      if (!await confirmDialog(t('classes.confirmRemoveStudent'), { danger: true })) return;
      await api.del(`/classes/${id}/members/${b.dataset.remove}`);
      toast('✅ ' + t('classes.studentRemoved'), 'success');
      loadRoster();
    });
  }

  showTab('courses');
}

function newCourseModal(classId, done) {
  modal(`
    <h2>${t('course.newCourse')}</h2>
    <div class="field"><label>${t('common.create')}</label><input id="ti" required></div>
    <div class="field"><label>${t('course.catalogue')}</label><textarea id="de"></textarea></div>
    <div class="row">
      <div class="field" style="flex:1"><label>Topic</label>
        <select id="tp">${['algorithms', 'web', 'networks', 'databases', 'programming', 'security', 'hardware', 'ai']
          .map(x => `<option value="${x}">${t('topic.' + x)}</option>`).join('')}</select></div>
      <div class="field" style="flex:1"><label>${t('quiz.difficulty')}</label>
        <select id="lv">${['beginner', 'intermediate', 'advanced']
          .map(x => `<option value="${x}">${t('course.level.' + x)}</option>`).join('')}</select></div>
      <div class="field" style="flex:1"><label>${t('profile.language')}</label>
        <select id="lg">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
    </div>
    <button class="btn btn-primary" id="sv">${t('common.create')}</button>`,
    { onMount: (root, close) => root.querySelector('#sv').onclick = async () => {
        const title = root.querySelector('#ti').value.trim();
        if (!title) return;
        await api.post('/courses', {
          title, classId, status: 'draft',
          description: root.querySelector('#de').value,
          topic: root.querySelector('#tp').value,
          level: root.querySelector('#lv').value,
          lang: root.querySelector('#lg').value
        });
        close();
        done();
      } });
}
