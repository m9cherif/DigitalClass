/* Views: login/register, dashboards, course catalogue, course page, lessons. */
import {
  api, store, session, router, t, i18n, esc, toast, modal, avatar, markdown,
  barChart, sparkline, percentColor, LANGS, connectSocket
} from '../core.js';

const title = c => i18n.pick(c, 'title', c.title);
const desc = c => i18n.pick(c, 'description', c.description);

/* ------------------------------------------------------------------ auth */

/** Polls for the Google Identity Services script (loaded via a plain
 *  <script> tag in index.html) to finish loading, since module code can run
 *  before it does. */
function waitForGoogleSdk(timeoutMs = 5000) {
  return new Promise(resolve => {
    const start = Date.now();
    (function poll() {
      if (window.google?.accounts?.id) return resolve(window.google);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(poll, 100);
    })();
  });
}

export function authView(mode) {
  return async (_p, out) => {
    const isLogin = mode === 'login';
    const { googleClientId } = await api.get('/config').catch(() => ({ googleClientId: null }));
    out.innerHTML = `
      <div style="max-inline-size:430px;margin-inline:auto;padding-block:6vh">
        <div class="center mb">
          <div class="brand" style="justify-content:center;font-size:1.5rem">
            <span class="brand-mark">DC</span> ${t('app.name')}
          </div>
          <p class="muted small mt">${t('app.tagline')}</p>
        </div>
        <div class="row mb">
          ${Object.entries(LANGS).map(([code, label]) =>
            `<button class="chip ${i18n.lang === code ? 'selected' : ''}" data-lang="${code}">${label}</button>`).join('')}
        </div>
        <div class="card" id="authCard"></div>
      </div>`;

    out.querySelectorAll('[data-lang]').forEach(b => b.onclick = async () => {
      await i18n.load(b.dataset.lang);
      router.resolve();
      document.dispatchEvent(new CustomEvent('dc:relang'));
    });

    const card = out.querySelector('#authCard');

    const renderOtp = ({ userId, email }) => {
      card.innerHTML = `
        <h2>${t('auth.otpTitle')}</h2>
        <p class="small muted">${t('auth.otpHint', { email: esc(email) })}</p>
        <form id="otpForm">
          <div class="field">
            <input name="code" class="code-input" maxlength="6" inputmode="numeric" autocomplete="one-time-code" required dir="ltr" placeholder="000000">
          </div>
          <div id="otpErr" class="small mb" style="color:var(--danger)"></div>
          <button class="btn btn-primary btn-block btn-lg">${t('auth.otpVerify')}</button>
        </form>
        <div class="center small mt"><a href="#" id="otpResend">${t('auth.otpResend')}</a></div>`;

      out.querySelector('#otpForm').onsubmit = async e => {
        e.preventDefault();
        const code = new FormData(e.target).get('code');
        const err = out.querySelector('#otpErr');
        err.textContent = '';
        try {
          await session.verifyEmail(userId, code);
          document.dispatchEvent(new CustomEvent('dc:auth'));
          router.go('/');
        } catch (ex) {
          err.textContent = t('auth.' + (ex.body?.error || 'invalid_code'));
        }
      };
      out.querySelector('#otpResend').onclick = async e => {
        e.preventDefault();
        try {
          await session.resendOtp(userId);
          toast('✅ ' + t('auth.otpResent'), 'success');
        } catch (ex) {
          const code = ex.body?.error;
          toast(code === 'otp_cooldown' ? t('auth.otp_cooldown', { sec: ex.body.retryInSec }) : t('common.error'), 'error');
        }
      };
    };

    /** First-ever Google sign-in: the account can't be created until we know
     *  which role it should have. */
    const renderGoogleRole = ({ credential, name, email }) => {
      card.innerHTML = `
        <h2>${t('auth.chooseRole')}</h2>
        <p class="small muted">${esc(name || email)}</p>
        <div class="stack" id="roleList">
          ${['student', 'teacher', 'parent'].map(r =>
            `<button class="btn btn-block" data-role="${r}">${t('auth.role.' + r)}</button>`).join('')}
        </div>
        <div id="roleErr" class="small mt" style="color:var(--danger)"></div>`;

      out.querySelectorAll('[data-role]').forEach(b => b.onclick = async () => {
        const err = out.querySelector('#roleErr');
        err.textContent = '';
        try {
          await session.google(credential, b.dataset.role);
          document.dispatchEvent(new CustomEvent('dc:auth'));
          router.go('/');
        } catch (ex) {
          err.textContent = t('auth.' + (ex.body?.error || 'bad_credentials'));
        }
      });
    };

    const onGoogleCredential = async ({ credential }) => {
      const err = out.querySelector('#authErr');
      try {
        const r = await session.google(credential);
        if (r?.needsRole) return renderGoogleRole({ credential, name: r.name, email: r.email });
        document.dispatchEvent(new CustomEvent('dc:auth'));
        router.go('/');
      } catch {
        if (err) err.textContent = t('auth.google_auth_failed');
      }
    };

    const mountGoogleButton = async () => {
      if (!googleClientId) return;
      const container = out.querySelector('#googleBtn');
      if (!container) return;
      const google = await waitForGoogleSdk();
      if (!google) return;
      google.accounts.id.initialize({ client_id: googleClientId, callback: onGoogleCredential });
      // renderButton's width is a fixed pixel value, not responsive — a
      // constant here overflowed narrow phone screens and pushed the button
      // off-screen. Size it to whatever room the container actually has.
      google.accounts.id.renderButton(container, {
        theme: document.documentElement.dataset.theme === 'light' ? 'outline' : 'filled_black',
        size: 'large', width: Math.min(360, container.getBoundingClientRect().width), locale: i18n.lang
      });
    };

    const renderForm = () => {
      card.innerHTML = `
        <h2>${t(isLogin ? 'auth.login' : 'auth.register')}</h2>
        ${googleClientId ? `
          <div id="googleBtn" class="center mb"></div>
          <div class="center tiny muted mb">${t('auth.or')}</div>` : ''}
        <form id="authForm">
          ${isLogin ? '' : `
            <div class="field"><label>${t('auth.name')}</label><input name="name" required></div>
            <div class="field"><label>${t('auth.role')}</label>
              <select name="role">
                <option value="student">${t('auth.role.student')}</option>
                <option value="teacher">${t('auth.role.teacher')}</option>
                <option value="parent">${t('auth.role.parent')}</option>
                <option value="admin">${t('auth.role.admin')}</option>
              </select></div>`}
          <div class="field"><label>${t('auth.email')}</label><input name="email" type="email" required dir="ltr"></div>
          <div class="field"><label>${t('auth.password')}</label><input name="password" type="password" required minlength="8" dir="ltr"></div>
          <div id="authErr" class="small mb" style="color:var(--danger)"></div>
          <button class="btn btn-primary btn-block btn-lg">${t(isLogin ? 'auth.login' : 'auth.register')}</button>
        </form>
        <div class="center small mt">
          ${t(isLogin ? 'auth.noAccount' : 'auth.haveAccount')}
          <a href="${isLogin ? '/register' : '/login'}">${t(isLogin ? 'auth.register' : 'auth.login')}</a>
        </div>`;

      mountGoogleButton();

      out.querySelector('#authForm').onsubmit = async e => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        const err = out.querySelector('#authErr');
        err.textContent = '';
        try {
          if (isLogin) {
            await session.login(f.email, f.password);
            document.dispatchEvent(new CustomEvent('dc:auth'));
            router.go('/');
          } else {
            const r = await session.register(f);
            renderOtp(r);
          }
        } catch (ex) {
          const code = ex.body?.error;
          if (code === 'email_not_verified') renderOtp(ex.body);
          else err.textContent = t('auth.' + (code || 'bad_credentials'));
        }
      };
    };

    renderForm();
  };
}

/* ------------------------------------------------------------- dashboard */

export async function dashboardView(_p, out) {
  const d = await api.get('/dashboard');
  const u = store.user;

  if (d.role === 'parent') return parentDashboard(d, out);

  const isTeacher = d.role === 'teacher' || d.role === 'admin';
  const s = d.stats;

  out.innerHTML = `
    <div class="between mb">
      <div>
        <h1>${t('dash.welcome', { name: esc(u.name.split(' ')[0]) })}</h1>
        <p class="muted">${isTeacher ? t('nav.dashboard') : `${t('dash.level')} ${store.progress?.level} · ${i18n.num(u.xp)} ${t('dash.xp')}`}</p>
      </div>
      ${isTeacher
        ? `<div class="row"><a class="btn btn-primary" href="/courses/new">+ ${t('course.newCourse')}</a>
             <a class="btn" href="/party">🎉 ${t('party.host')}</a></div>`
        : `<a class="btn btn-primary" href="/party">🎉 ${t('nav.party')}</a>`}
    </div>

    ${!isTeacher ? `
      <div class="card mb">
        <div class="between">
          <span class="small muted">${t('dash.level')} ${store.progress.level}</span>
          <span class="small muted">${store.progress.levelXp} / ${store.progress.nextLevelXp} ${t('dash.xp')}</span>
        </div>
        <div class="progress mt"><i style="inline-size:${store.progress.percent}%"></i></div>
      </div>` : ''}

    <div class="grid grid-4 mb">
      ${isTeacher ? `
        <div class="stat"><div class="v">${s.courses}</div><div class="k">${t('nav.courses')}</div></div>
        <div class="stat"><div class="v">${s.students}</div><div class="k">${t('dash.students')}</div></div>
        <div class="stat"><div class="v">${s.classAverage ?? '—'}${s.classAverage != null ? '%' : ''}</div><div class="k">${t('dash.classAverage')}</div></div>
        <div class="stat"><div class="v" style="color:${s.needsReview ? 'var(--warning)' : 'inherit'}">${s.needsReview}</div><div class="k">${t('dash.needsReview')}</div></div>
      ` : `
        <div class="stat"><div class="v">${s.attempts}</div><div class="k">${t('quiz.attempts')}</div></div>
        <div class="stat"><div class="v">${s.averageScore ?? '—'}${s.averageScore != null ? '%' : ''}</div><div class="k">${t('quiz.score')}</div></div>
        <div class="stat"><div class="v">🔥 ${s.streak}</div><div class="k">${t('dash.streak')} (${t('dash.days')})</div></div>
        <div class="stat"><div class="v">${s.badges}</div><div class="k">${t('dash.badges')}</div></div>
      `}
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="between mb"><h3>${isTeacher ? t('nav.courses') : t('dash.myCourses')}</h3>
          <a class="small" href="/courses">${t('common.all')} →</a></div>
        ${d.courses.length ? d.courses.map(c => `
          <a href="/courses/${c.id}" class="row" style="padding:.55rem 0;color:inherit;border-block-end:1px solid var(--border)">
            <span style="inline-size:9px;block-size:34px;border-radius:5px;background:${esc(c.color || 'var(--primary)')}"></span>
            <span style="flex:1">
              <div style="font-weight:600">${esc(c.title)}</div>
              ${isTeacher
                ? `<div class="tiny muted">${c.students} ${t('course.students')} · ${c.quizzes} ${t('course.quizzes')} ${
                     c.status !== 'published' ? `· <span class="badge badge-warning">${t('common.draft')}</span>` : ''}</div>`
                : `<div class="progress mt" style="inline-size:170px"><i style="inline-size:${c.percent}%"></i></div>`}
            </span>
            ${!isTeacher ? `<span class="badge">${c.percent}%</span>` : ''}
          </a>`).join('') : `<div class="empty-state small">${t('common.empty')}</div>`}
      </div>

      <div class="card">
        <h3>${isTeacher ? t('dash.activity') : t('dash.recentScores')}</h3>
        ${isTeacher
          ? sparkline(d.activity.map(a => a.attempts), v => `${v}`)
          : sparkline((d.recentScores || []).map(r => r.percent), v => `${v}%`)}
        <h3 class="mt">${t('dash.byType')}</h3>
        ${barChart((d.byType || []).slice(0, 8).map(r => ({
          label: t('qtype.' + r.type), value: r.accuracy, max: 100, display: r.accuracy + '%',
          color: r.accuracy >= 70 ? 'var(--success)' : r.accuracy >= 45 ? 'var(--warning)' : 'var(--danger)'
        })))}
      </div>
    </div>

    ${!isTeacher && d.dueSoon?.length ? `
      <div class="card mt">
        <h3>${t('dash.dueSoon')}</h3>
        ${d.dueSoon.map(a => `<div class="between" style="padding:.4rem 0">
          <span>${esc(a.title)}</span><span class="badge badge-warning">${i18n.date(a.dueAt)}</span></div>`).join('')}
      </div>` : ''}

    ${!isTeacher && s.flashcardsDue ? `
      <a class="card card-hover mt row" href="/flashcards" style="color:inherit">
        <span style="font-size:1.8rem">🃏</span>
        <span style="flex:1"><strong>${t('flash.title')}</strong>
          <div class="small muted">${s.flashcardsDue} ${t('flash.due')}</div></span>
        <span class="btn btn-primary btn-sm">${t('common.start')}</span>
      </a>` : ''}

    ${isTeacher && s.needsReview ? `
      <a class="card card-hover mt row" href="/review" style="color:inherit">
        <span style="font-size:1.8rem">📝</span>
        <span style="flex:1"><strong>${t('review.queue')}</strong>
          <div class="small muted">${s.needsReview} ${t('dash.needsReview')}</div></span>
        <span class="btn btn-primary btn-sm">${t('common.start')}</span>
      </a>` : ''}`;
}

function parentDashboard(d, out) {
  out.innerHTML = `
    <div class="between mb">
      <h1>${t('parent.title')}</h1>
      <button class="btn btn-primary" id="linkChild">+ ${t('parent.linkChild')}</button>
    </div>
    ${d.children.length ? `<div class="grid grid-2">${d.children.map(c => `
      <div class="card">
        <div class="row mb">${avatar(c.student, 'avatar-lg')}
          <div><h3 style="margin:0">${esc(c.student.name)}</h3>
            <div class="small muted">${t('parent.lastActive')}: ${c.lastActive || '—'}</div></div></div>
        <div class="grid grid-3 mb">
          <div class="stat"><div class="v">${c.averageScore ?? '—'}${c.averageScore != null ? '%' : ''}</div><div class="k">${t('parent.avgScore')}</div></div>
          <div class="stat"><div class="v">${c.courses}</div><div class="k">${t('nav.courses')}</div></div>
          <div class="stat"><div class="v">🔥 ${c.streak}</div><div class="k">${t('dash.streak')}</div></div>
        </div>
        ${sparkline(c.recentScores.map(r => r.percent), v => v + '%')}
        <a class="btn btn-block mt" href="/children/${c.student.id}">${t('parent.report')}</a>
      </div>`).join('')}</div>`
    : `<div class="empty-state"><span class="ic">👨‍👩‍👧</span>${t('parent.noChildren')}</div>`}`;

  out.querySelector('#linkChild').onclick = () => modal(`
    <h2>${t('parent.linkChild')}</h2>
    <div class="field"><label>${t('parent.childCode')}</label><input id="code" dir="ltr" placeholder="XXXXXXXXXXXX"></div>
    <div class="row"><button class="btn btn-primary" id="go">${t('common.save')}</button>
      <button class="btn" data-close>${t('common.cancel')}</button></div>`,
    { onMount: (root, close) => {
      root.querySelector('#go').onclick = async () => {
        try {
          await api.post('/auth/me/children', { studentCode: root.querySelector('#code').value.trim() });
          close(); router.resolve();
        } catch { toast(t('common.error'), 'error'); }
      };
    } });
}

export async function childReportView({ id }, out) {
  const r = await api.get(`/courses/child/${id}/report`);
  out.innerHTML = `
    <a href="/" class="small">← ${t('common.back')}</a>
    <div class="row mt mb">${avatar(r.student, 'avatar-lg')}<h1 style="margin:0">${esc(r.student.name)}</h1></div>
    <div class="grid grid-4 mb">
      <div class="stat"><div class="v">${r.stats.averageScore ?? '—'}%</div><div class="k">${t('parent.avgScore')}</div></div>
      <div class="stat"><div class="v">${r.stats.attempts}</div><div class="k">${t('quiz.attempts')}</div></div>
      <div class="stat"><div class="v">${r.stats.badges}</div><div class="k">${t('dash.badges')}</div></div>
      <div class="stat"><div class="v">${r.stats.certificates.length}</div><div class="k">${t('dash.certificates')}</div></div>
    </div>
    <div class="grid grid-2">
      <div class="card"><h3>${t('dash.myCourses')}</h3>
        ${r.courses.map(c => `<div class="mb">
          <div class="between small"><span>${esc(c.course?.title || '')}</span><span>${c.percent}%</span></div>
          <div class="progress"><i style="inline-size:${c.percent}%"></i></div></div>`).join('') ||
          `<div class="muted small">${t('common.empty')}</div>`}
      </div>
      <div class="card"><h3>${t('dash.recentScores')}</h3>
        ${r.recent.length ? `<table><tbody>${r.recent.map(a => `
          <tr><td>${esc(a.quiz || '')}</td><td class="tiny muted">${i18n.date(a.at)}</td>
              <td><span class="badge badge-${percentColor(a.percent)}">${a.percent}%</span></td></tr>`).join('')}
          </tbody></table>` : `<div class="muted small">${t('common.empty')}</div>`}
      </div>
    </div>`;
}

/* --------------------------------------------------------------- courses */

export async function coursesView(_p, out) {
  const { courses } = await api.get('/courses');
  const topics = [...new Set(courses.map(c => c.topic))];
  const canCreate = ['teacher', 'admin'].includes(store.user.role);

  out.innerHTML = `
    <div class="between mb">
      <h1>${t('course.catalogue')}</h1>
      ${canCreate ? `<a class="btn btn-primary" href="/courses/new">+ ${t('course.newCourse')}</a>` : ''}
    </div>

    <div class="row mb filters">
      <input id="q" placeholder="${t('common.search')}" class="search-input">
      <div class="chips-scroll">
        <button class="chip selected" data-topic="">${t('common.all')}</button>
        ${topics.map(tp => `<button class="chip" data-topic="${tp}">${t('topic.' + tp)}</button>`).join('')}
      </div>
    </div>
    <div id="list" class="grid grid-2"></div>`;

  const list = out.querySelector('#list');
  let filter = { q: '', topic: '' };

  const draw = () => {
    const rows = courses.filter(c =>
      (!filter.topic || c.topic === filter.topic) &&
      (!filter.q || (title(c) + desc(c) + c.tags.join()).toLowerCase().includes(filter.q)));
    list.innerHTML = rows.length ? rows.map(c => `
      <a class="card card-hover" href="/courses/${c.id}" style="color:inherit;border-top:3px solid ${esc(c.color)}">
        <div class="between mb">
          <span class="badge badge-primary">${t('topic.' + c.topic)}</span>
          <span class="badge">${t('course.level.' + c.level)}</span>
        </div>
        <h3>${esc(title(c))}</h3>
        <p class="small muted">${esc(desc(c)).slice(0, 130)}…</p>
        <div class="row tiny muted">
          <span>📚 ${c.lessonCount} ${t('course.lessons')}</span>
          <span>❓ ${c.quizCount} ${t('course.quizzes')}</span>
          <span>👥 ${c.studentCount} ${t('course.students')}</span>
        </div>
        <div class="between mt">
          <span class="small">${t('course.by')} ${esc(c.teacher?.name || '')}</span>
          ${c.enrolled ? `<span class="badge badge-success">${t('course.enrolled')}</span>` : ''}
          ${c.status !== 'published' ? `<span class="badge badge-warning">${t('common.draft')}</span>` : ''}
        </div>
      </a>`).join('') : `<div class="empty-state"><span class="ic">📭</span>${t('common.empty')}</div>`;
  };

  out.querySelector('#q').oninput = e => { filter.q = e.target.value.toLowerCase(); draw(); };
  out.querySelectorAll('[data-topic]').forEach(b => b.onclick = () => {
    out.querySelectorAll('[data-topic]').forEach(x => x.classList.remove('selected'));
    b.classList.add('selected');
    filter.topic = b.dataset.topic;
    draw();
  });
  draw();
}

export async function courseNewView(_p, out) {
  out.innerHTML = `
    <h1>${t('course.newCourse')}</h1>
    <form class="card" id="f" style="max-inline-size:640px">
      <div class="field"><label>${t('common.create')}</label><input name="title" required></div>
      <div class="field"><label>${t('course.catalogue')}</label><textarea name="description"></textarea></div>
      <div class="row">
        <div class="field" style="flex:1"><label>Topic</label>
          <select name="topic">${['algorithms', 'web', 'networks', 'databases', 'programming', 'security', 'hardware', 'ai']
            .map(x => `<option value="${x}">${t('topic.' + x)}</option>`).join('')}</select></div>
        <div class="field" style="flex:1"><label>${t('quiz.difficulty')}</label>
          <select name="level">${['beginner', 'intermediate', 'advanced']
            .map(x => `<option value="${x}">${t('course.level.' + x)}</option>`).join('')}</select></div>
        <div class="field" style="flex:1"><label>${t('profile.language')}</label>
          <select name="lang">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Color</label><input name="color" type="color" value="#6366f1" style="inline-size:80px"></div>
      <button class="btn btn-primary">${t('common.create')}</button>
    </form>`;

  out.querySelector('#f').onsubmit = async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    const { course } = await api.post('/courses', { ...body, status: 'draft' });
    toast(t('quiz.saved'), 'success');
    router.go(`/courses/${course.id}`);
  };
}

export async function courseView({ id }, out) {
  const c = await api.get(`/courses/${id}`);
  const course = c.course;
  const done = key => c.progress?.[key]?.done;
  const total = c.lessons.length || 1;
  const pct = Math.round((c.lessons.filter(l => done(l.id)).length / total) * 100);

  out.innerHTML = `
    ${course.class ? `<a href="/classes/${course.class.id}" class="small">← ${esc(course.class.title)}</a>` : ''}
    <div class="card ${course.class ? 'mt' : ''} mb" style="border-top:4px solid ${esc(course.color)}">
      <div class="between">
        <div>
          <div class="row mb">
            <span class="badge badge-primary">${t('topic.' + course.topic)}</span>
            <span class="badge">${t('course.level.' + course.level)}</span>
            ${course.status !== 'published' ? `<span class="badge badge-warning">${t('common.draft')}</span>` : ''}
          </div>
          <h1>${esc(title(course))}</h1>
          <p class="muted">${esc(desc(course))}</p>
          <div class="small muted">${t('course.by')} ${esc(course.teacher?.name || '')}</div>
        </div>
        <div class="stack course-actions">
          ${c.enrolled
            ? `<div><div class="between small"><span>${t('course.progress')}</span><span>${pct}%</span></div>
                 <div class="progress mt"><i style="inline-size:${pct}%"></i></div></div>`
            : store.user.role === 'student'
              ? `<button class="btn btn-primary btn-lg" id="enroll">${t('course.enroll')}</button>` : ''}
          ${c.editable ? `
            <a class="btn" href="/courses/${id}/roster">👥 ${t('course.roster')}</a>
            <a class="btn" href="/gradebook/${id}">📊 ${t('gradebook.title')}</a>
            <button class="btn" id="edit">✏️ ${t('common.edit')}</button>` : ''}
        </div>
      </div>
    </div>

    <div class="tabs">
      <button class="tab active" data-tab="lessons">${t('course.lessons')} (${c.lessons.length})</button>
      <button class="tab" data-tab="quizzes">${t('course.quizzes')} (${c.quizzes.length})</button>
      <button class="tab" data-tab="assignments">${t('course.assignments')} (${c.assignments.length})</button>
      ${c.enrolled || c.editable ? `<button class="tab" data-tab="live">🎥 ${t('nav.live')}</button>` : ''}
      <button class="tab" data-tab="chat">${t('course.chat')}</button>
    </div>
    <div id="tab"></div>`;

  const panes = {
    lessons: () => `
      ${c.editable ? `<button class="btn btn-sm mb" id="addLesson">+ ${t('course.lessons')}</button>` : ''}
      <div class="stack">${c.lessons.map((l, i) => `
        <div class="card row">
          <span class="avatar">${done(l.id) ? '✓' : i + 1}</span>
          <span style="flex:1">
            <strong>${esc(i18n.pick(l, 'title', l.title))}</strong>
            <div class="tiny muted">${l.durationMin} ${t('common.minutes')}${l.preview ? ' · preview' : ''}</div>
          </span>
          ${l.locked
            ? `<span class="badge">🔒 ${t('course.locked')}</span>`
            : `<a class="btn btn-sm" href="/courses/${id}/lessons/${l.id}">${t('common.start')}</a>`}
        </div>`).join('') || `<div class="empty-state">${t('common.empty')}</div>`}</div>`,

    quizzes: () => `
      ${c.editable ? `<button class="btn btn-sm mb" id="addQuiz">+ ${t('quiz.newQuiz')}</button>` : ''}
      <div class="grid grid-2">${c.quizzes.map(q => `
        <div class="card">
          <div class="between mb">
            <span class="badge badge-primary">${esc(q.type)}</span>
            <span class="badge">${q.questionCount} ${t('quiz.question')}</span>
          </div>
          <h3>${esc(q.title)}</h3>
          <div class="row tiny muted mb">
            <span>${t('quiz.difficulty')}: ${esc(q.difficulty)}</span>
            <span>${q.timeLimitSec ? Math.round(q.timeLimitSec / 60) + ' ' + t('common.minutes') : t('quiz.noTimeLimit')}</span>
            ${!q.published ? `<span class="badge badge-warning">${t('common.draft')}</span>` : ''}
          </div>
          <div class="row">
            <a class="btn btn-primary btn-sm" href="/quiz/${q.id}">${t('quiz.start')}</a>
            ${c.editable ? `<a class="btn btn-sm" href="/quiz/${q.id}/edit">${t('common.edit')}</a>
                            <a class="btn btn-sm" href="/analytics/${q.id}">📊</a>` : ''}
            ${q.attempts ? `<span class="tiny muted">${q.attempts} ${t('quiz.attempts')}</span>` : ''}
          </div>
        </div>`).join('') || `<div class="empty-state">${t('common.empty')}</div>`}</div>`,

    assignments: () => `
      ${c.editable ? `<button class="btn btn-sm mb" id="addAssign">+ ${t('course.assignments')}</button>` : ''}
      <div class="stack">${c.assignments.map(a => `
        <div class="card between">
          <span><strong>${esc(a.title)}</strong>
            <div class="small muted">${esc(a.brief).slice(0, 120)}</div></span>
          <span class="stack" style="text-align:end">
            ${a.dueAt ? `<span class="badge badge-warning">${i18n.date(a.dueAt)}</span>` : ''}
            <span class="tiny muted">${a.points} ${t('common.points')}</span>
            ${c.editable
              ? `<a class="btn btn-sm" href="/assignments/${a.id}">${t('review.grade')}</a>`
              : `<button class="btn btn-sm" data-submit-assign="${a.id}">${t('common.submit')}</button>`}
          </span>
        </div>`).join('') || `<div class="empty-state">${t('common.empty')}</div>`}</div>`,

    live: () => `<div id="liveHost"></div>`,

    chat: () => `
      <div class="card">
        <div id="chatLog" class="stack chat-log"></div>
        <div class="row mt">
          <input id="chatInput" placeholder="${t('msg.placeholder')}" style="flex:1">
          <button class="btn btn-primary" id="chatSend">${t('msg.send')}</button>
        </div>
      </div>`
  };

  const tabEl = out.querySelector('#tab');
  const showTab = async name => {
    tabEl.innerHTML = panes[name]();
    if (name === 'chat') mountChat(id, tabEl);
    if (name === 'live') {
      const { liveSection } = await import('../live.js');
      liveSection(tabEl.querySelector('#liveHost'), { scope: 'course', id });
    }
    wireTab(name);
  };

  out.querySelectorAll('.tab').forEach(b => b.onclick = () => {
    out.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    showTab(b.dataset.tab);
  });

  function wireTab() {
    tabEl.querySelector('#addLesson')?.addEventListener('click', () => lessonModal(id));
    tabEl.querySelector('#addQuiz')?.addEventListener('click', () => quizModal(id));
    tabEl.querySelector('#addAssign')?.addEventListener('click', () => assignmentModal(id));
    tabEl.querySelectorAll('[data-submit-assign]').forEach(b => b.onclick = () => submitAssignment(b.dataset.submitAssign));
  }

  out.querySelector('#enroll')?.addEventListener('click', async () => {
    await api.post(`/courses/${id}/enroll`);
    toast('✅ ' + t('course.enrolled'), 'success');
    router.resolve();
  });

  out.querySelector('#edit')?.addEventListener('click', () => modal(`
    <h2>${t('common.edit')}</h2>
    <div class="field"><label>Title</label><input id="ti" value="${esc(course.title)}"></div>
    <div class="field"><label>Description</label><textarea id="de">${esc(course.description)}</textarea></div>
    <div class="field"><label>Status</label>
      <select id="st"><option value="draft" ${course.status === 'draft' ? 'selected' : ''}>${t('common.draft')}</option>
        <option value="published" ${course.status === 'published' ? 'selected' : ''}>${t('common.published')}</option></select></div>
    <div class="row"><button class="btn btn-primary" id="sv">${t('common.save')}</button>
      <button class="btn btn-danger" id="del">${t('common.delete')}</button></div>`,
    { onMount: (root, close) => {
        root.querySelector('#sv').onclick = async () => {
          await api.patch(`/courses/${id}`, {
            title: root.querySelector('#ti').value,
            description: root.querySelector('#de').value,
            status: root.querySelector('#st').value
          });
          close(); router.resolve();
        };
        root.querySelector('#del').onclick = async () => {
          if (!confirm(t('course.confirmDelete'))) return;
          await api.del(`/courses/${id}`);
          close();
          router.go(course.class ? `/classes/${course.class.id}` : '/courses');
        };
      } }));

  showTab('lessons');
}

function mountChat(courseId, host) {
  const sock = connectSocket();
  const log = host.querySelector('#chatLog');
  const add = m => {
    log.insertAdjacentHTML('beforeend',
      `<div class="small"><strong>${esc(m.authorName)}</strong> <span class="tiny muted">${i18n.date(m.at, { timeStyle: 'short' })}</span><br>${esc(m.text)}</div>`);
    log.scrollTop = log.scrollHeight;
  };
  sock.emit('chat:join', { courseId });
  sock.off('chat:history').on('chat:history', ({ messages }) => { log.innerHTML = ''; messages.forEach(add); });
  sock.off('chat:message').on('chat:message', add);
  sock.off('chat:error').on('chat:error', () => log.innerHTML = `<div class="muted small">${t('course.locked')}</div>`);

  const send = () => {
    const input = host.querySelector('#chatInput');
    if (!input.value.trim()) return;
    sock.emit('chat:send', { courseId, text: input.value });
    input.value = '';
  };
  host.querySelector('#chatSend').onclick = send;
  host.querySelector('#chatInput').onkeydown = e => { if (e.key === 'Enter') send(); };
}

function lessonModal(courseId) {
  modal(`
    <h2>${t('course.lessons')}</h2>
    <div class="field"><label>Title</label><input id="ti"></div>
    <div class="field"><label>Markdown</label><textarea id="bo" class="code-editor"></textarea></div>
    <div class="row"><div class="field"><label>${t('common.minutes')}</label><input id="du" type="number" value="15" style="inline-size:100px"></div>
      <label class="row small"><input type="checkbox" id="pv" style="inline-size:auto"> preview</label></div>
    <button class="btn btn-primary" id="sv">${t('common.save')}</button>`,
    { onMount: (root, close) => root.querySelector('#sv').onclick = async () => {
        await api.post(`/courses/${courseId}/lessons`, {
          title: root.querySelector('#ti').value,
          body: root.querySelector('#bo').value,
          durationMin: Number(root.querySelector('#du').value),
          preview: root.querySelector('#pv').checked
        });
        close(); router.resolve();
      } });
}

function quizModal(courseId) {
  modal(`
    <h2>${t('quiz.newQuiz')}</h2>
    <div class="field"><label>Title</label><input id="ti"></div>
    <div class="row">
      <div class="field" style="flex:1"><label>Kind</label>
        <select id="ki">${['practice', 'graded', 'exam', 'flashcards', 'survey'].map(k => `<option>${k}</option>`).join('')}</select></div>
      <div class="field" style="flex:1"><label>${t('quiz.difficulty')}</label>
        <select id="di">${['easy', 'medium', 'hard', 'expert'].map(k => `<option>${k}</option>`).join('')}</select></div>
      <div class="field" style="flex:1"><label>${t('quiz.timeLimit')} (${t('common.minutes')})</label>
        <input id="tl" type="number" value="0"></div>
    </div>
    <button class="btn btn-primary" id="sv">${t('common.create')}</button>`,
    { onMount: (root, close) => root.querySelector('#sv').onclick = async () => {
        const { quiz } = await api.post('/quizzes', {
          courseId,
          title: root.querySelector('#ti').value || 'New quiz',
          kind: root.querySelector('#ki').value,
          difficulty: root.querySelector('#di').value,
          timeLimitSec: Number(root.querySelector('#tl').value) * 60
        });
        close();
        router.go(`/quiz/${quiz.id}/edit`);
      } });
}

function assignmentModal(courseId) {
  modal(`
    <h2>${t('course.assignments')}</h2>
    <div class="field"><label>Title</label><input id="ti"></div>
    <div class="field"><label>Brief</label><textarea id="br"></textarea></div>
    <div class="row"><div class="field"><label>Due</label><input id="du" type="date"></div>
      <div class="field"><label>${t('common.points')}</label><input id="pt" type="number" value="20"></div></div>
    <button class="btn btn-primary" id="sv">${t('common.create')}</button>`,
    { onMount: (root, close) => root.querySelector('#sv').onclick = async () => {
        await api.post(`/courses/${courseId}/assignments`, {
          title: root.querySelector('#ti').value,
          brief: root.querySelector('#br').value,
          dueAt: root.querySelector('#du').value || null,
          points: Number(root.querySelector('#pt').value)
        });
        close(); router.resolve();
      } });
}

function submitAssignment(assignmentId) {
  modal(`
    <h2>${t('common.submit')}</h2>
    <div class="field"><label>Text</label><textarea id="tx"></textarea></div>
    <div class="field"><label>Code</label><textarea id="cd" class="code-editor"></textarea></div>
    <div class="field"><label>File</label><input id="fi" type="file"></div>
    <button class="btn btn-primary" id="sv">${t('common.submit')}</button>`,
    { onMount: (root, close) => root.querySelector('#sv').onclick = async () => {
        const files = [];
        const f = root.querySelector('#fi').files[0];
        if (f) files.push(await api.upload(f));
        await api.post(`/courses/assignments/${assignmentId}/submit`, {
          text: root.querySelector('#tx').value, code: root.querySelector('#cd').value, files
        });
        close();
        toast('✅ ' + t('common.submit'), 'success');
      } });
}

export async function lessonView({ id, lessonId }, out) {
  const c = await api.get(`/courses/${id}`);
  const idx = c.lessons.findIndex(l => l.id === lessonId);
  const lesson = c.lessons[idx];
  if (!lesson || lesson.locked) {
    out.innerHTML = `<div class="empty-state"><span class="ic">🔒</span>${t('course.locked')}</div>`;
    return;
  }
  const isDone = c.progress?.[lesson.id]?.done;

  out.innerHTML = `
    <a href="/courses/${id}" class="small">← ${esc(title(c.course))}</a>
    <h1 class="mt">${esc(i18n.pick(lesson, 'title', lesson.title))}</h1>
    <div class="row muted small mb">
      <span>${t('quiz.question')} ${idx + 1}/${c.lessons.length}</span>
      <span>· ${lesson.durationMin} ${t('common.minutes')}</span>
    </div>
    ${lesson.videoUrl ? `<video controls src="${esc(lesson.videoUrl)}" style="inline-size:100%;border-radius:var(--radius)"></video>` : ''}
    <div class="card">${markdown(i18n.pick(lesson, 'body', lesson.body))}</div>
    <div class="between mt">
      ${idx > 0 ? `<a class="btn" href="/courses/${id}/lessons/${c.lessons[idx - 1].id}">← ${t('common.previous')}</a>` : '<span></span>'}
      ${c.enrolled ? `<button class="btn ${isDone ? 'btn-success' : 'btn-primary'}" id="done" ${isDone ? 'disabled' : ''}>
        ${isDone ? '✓ ' + t('course.done') : t('course.markDone')}</button>` : ''}
      ${idx < c.lessons.length - 1 ? `<a class="btn" href="/courses/${id}/lessons/${c.lessons[idx + 1].id}">${t('common.next')} →</a>` : '<span></span>'}
    </div>`;

  out.querySelector('#done')?.addEventListener('click', async () => {
    const r = await api.post(`/courses/${id}/lessons/${lesson.id}/complete`);
    toast(`+15 XP ✓`, 'success');
    if (r.certificate) {
      modal(`<div class="cert">
        <h2>🎓 ${t('cert.title')}</h2>
        <p class="muted">${t('cert.awardedTo')}</p>
        <h1>${esc(store.user.name)}</h1>
        <p>${t('cert.forCompleting')} <strong>${esc(r.certificate.courseTitle)}</strong></p>
        <div class="mono small muted">${t('cert.serial')}: ${esc(r.certificate.serial)}</div>
      </div><button class="btn btn-block mt" data-close>${t('common.close')}</button>`);
    }
    await session.refresh();
    router.resolve();
  });
}

/** Teacher grading page for one assignment: the whole class roster, each row
 *  showing what the student turned in (or didn't) with a grade + feedback box. */
export async function assignmentGradeView({ id }, out) {
  const data = await api.get(`/courses/assignments/${id}`);
  const a = data.assignment;

  if (!data.editable) {
    // A student who follows their own submission link sees a read-only recap.
    const s = data.mySubmission;
    out.innerHTML = `
      <a href="/courses/${a.course.id}" class="small">← ${esc(a.course.title)}</a>
      <h1 class="mt">${esc(a.title)}</h1>
      <p class="muted">${esc(a.brief || '')}</p>
      ${s ? `
        <div class="card mt">
          <div class="between mb">
            <span class="badge badge-${s.status === 'graded' ? 'success' : 'primary'}">${
              s.status === 'graded' ? t('assignment.graded') : t('assignment.submitted')}</span>
            ${s.late ? `<span class="badge badge-warning">${t('assignment.late')}</span>` : ''}
          </div>
          ${s.text ? `<div class="card small" style="white-space:pre-wrap;background:var(--surface-2)">${esc(s.text)}</div>` : ''}
          ${s.code ? `<pre class="mt">${esc(s.code)}</pre>` : ''}
          ${s.grade != null ? `<div class="mt"><strong>${t('assignment.grade')}:</strong> ${s.grade}/${a.points}</div>` : ''}
          ${s.feedback ? `<div class="card mt small" style="background:var(--surface-2)">${esc(s.feedback)}</div>` : ''}
        </div>` : `<div class="empty-state mt">${t('assignment.notSubmitted')}</div>`}`;
    return;
  }

  const rows = data.submissions;
  out.innerHTML = `
    <a href="/courses/${a.course.id}" class="small">← ${esc(a.course.title)}</a>
    <div class="between mt mb">
      <div>
        <h1>${esc(a.title)}</h1>
        <p class="muted">${esc(a.brief || '')}</p>
      </div>
      <div class="stack" style="text-align:end">
        ${a.dueAt ? `<span class="badge badge-warning">${i18n.date(a.dueAt)}</span>` : ''}
        <span class="tiny muted">${a.points} ${t('common.points')}</span>
      </div>
    </div>
    <div class="stack">${rows.map(({ student, submission: s }) => `
      <div class="card">
        <div class="between mb">
          <span class="row">${avatar(student)} <strong>${esc(student.name)}</strong></span>
          <span class="row">
            ${!s ? `<span class="badge">${t('assignment.notSubmitted')}</span>`
              : `<span class="badge badge-${s.status === 'graded' ? 'success' : 'primary'}">${
                  s.status === 'graded' ? t('assignment.graded') : t('assignment.submitted')}</span>
                 ${s.late ? `<span class="badge badge-warning">${t('assignment.late')}</span>` : ''}
                 <span class="tiny muted">${i18n.date(s.submittedAt, { dateStyle: 'short', timeStyle: 'short' })}</span>`}
          </span>
        </div>
        ${s ? `
          ${s.text ? `<div class="card small mb" style="white-space:pre-wrap;background:var(--surface-2)">${esc(s.text)}</div>` : ''}
          ${s.code ? `<pre class="mb">${esc(s.code)}</pre>` : ''}
          ${s.files?.length ? `<div class="row mb">${s.files.map(f =>
            `<a class="btn btn-sm" href="${esc(f.url)}" target="_blank" rel="noopener">📎 ${esc(f.name || t('assignment.files'))}</a>`).join('')}</div>` : ''}
          <div class="row">
            <input type="number" min="0" max="${a.points}" placeholder="0-${a.points}"
                   value="${s.grade ?? ''}" data-grade-input="${s.id}" style="inline-size:110px">
            <input placeholder="${t('assignment.feedbackPlaceholder')}" value="${esc(s.feedback || '')}"
                   data-feedback-input="${s.id}" style="flex:1">
            <button class="btn btn-primary btn-sm" data-save-grade="${s.id}">${t('assignment.saveGrade')}</button>
          </div>` : `<div class="tiny muted">${t('assignment.notSubmitted')}</div>`}
      </div>`).join('') || `<div class="empty-state">${t('common.empty')}</div>`}</div>`;

  out.querySelectorAll('[data-save-grade]').forEach(btn => btn.onclick = async () => {
    const sid = btn.dataset.saveGrade;
    const grade = Number(out.querySelector(`[data-grade-input="${sid}"]`).value || 0);
    const feedback = out.querySelector(`[data-feedback-input="${sid}"]`).value;
    await api.post(`/courses/submissions/${sid}/grade`, { grade, feedback });
    toast('✅ ' + t('assignment.saveGrade'), 'success');
    router.resolve();
  });
}

export async function rosterView({ id }, out) {
  const { roster } = await api.get(`/courses/${id}/roster`);
  out.innerHTML = `
    <a href="/courses/${id}" class="small">← ${t('common.back')}</a>
    <h1 class="mt">${t('course.roster')}</h1>
    <div class="card table-wrap"><table>
      <thead><tr><th>${t('lb.student')}</th><th>${t('course.progress')}</th>
        <th>${t('quiz.attempts')}</th><th>${t('gradebook.average')}</th><th>${t('parent.lastActive')}</th><th></th></tr></thead>
      <tbody>${roster.map(r => `
        <tr>
          <td class="row">${avatar(r.student)} ${esc(r.student.name)}</td>
          <td style="min-inline-size:140px">
            <div class="progress"><i style="inline-size:${Math.round((r.lessonsDone / Math.max(1, r.lessonsTotal)) * 100)}%"></i></div>
            <span class="tiny muted">${r.lessonsDone}/${r.lessonsTotal}</span>
          </td>
          <td>${r.attempts}</td>
          <td>${r.averageScore != null ? `<span class="badge badge-${percentColor(r.averageScore)}">${r.averageScore}%</span>` : '—'}</td>
          <td class="tiny muted">${r.lastActive || '—'}</td>
          <td><a class="btn btn-sm" href="/messages/${r.student.id}">✉️</a></td>
        </tr>`).join('')}</tbody>
    </table></div>`;
}
