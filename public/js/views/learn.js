/* Views: login/register, dashboards, course catalogue, course page, lessons. */
import {
  api, store, session, router, t, i18n, esc, toast, modal, confirmDialog, avatar, markdown,
  barChart, sparkline, percentColor, LANGS, connectSocket
} from '../core.js';

const title = c => i18n.pick(c, 'title', c.title);
const desc = c => i18n.pick(c, 'description', c.description);

/* ------------------------------------------------------------------ auth */

/** Generic poll for an SDK loaded via a plain <script> tag in index.html,
 *  since module code can run before it finishes. Mobile networks are slower
 *  and less reliable than the desktop connections this was first tested on,
 *  so this allows more time and doesn't give up after a single failed
 *  attempt at fetching /config below. */
function waitFor(ready, timeoutMs = 10000) {
  return new Promise(resolve => {
    const start = Date.now();
    (function poll() {
      if (ready()) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(poll, 100);
    })();
  });
}
const waitForGoogleSdk = async () => (await waitFor(() => window.google?.accounts?.id)) ? window.google : null;
const waitForMsalSdk = async () => (await waitFor(() => window.msal?.PublicClientApplication)) ? window.msal : null;
const waitForFbSdk = async () => (await waitFor(() => window.FB)) ? window.FB : null;

/** A single flaky request shouldn't permanently hide the SSO buttons for
 *  the rest of the page load — retry once before giving up on it. */
async function fetchConfig() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await api.get('/config');
    } catch (err) {
      if (attempt === 0) await new Promise(r => setTimeout(r, 500));
      else console.warn('[auth] /config failed twice, hiding SSO sign-in', err);
    }
  }
  return { googleClientId: null, microsoftClientId: null, facebookAppId: null, facebookConfigId: null };
}

let msalInstance = null;
async function getMsalInstance(clientId) {
  if (msalInstance) return msalInstance;
  const msal = await waitForMsalSdk();
  if (!msal) return null;
  msalInstance = new msal.PublicClientApplication({
    auth: { clientId, authority: 'https://login.microsoftonline.com/common', redirectUri: window.location.origin }
  });
  await msalInstance.initialize();
  return msalInstance;
}

let fbInitialized = false;
async function getFbSdk(appId) {
  const FB = await waitForFbSdk();
  if (!FB) return null;
  if (!fbInitialized) {
    FB.init({ appId, version: 'v20.0', xfbml: false });
    fbInitialized = true;
  }
  return FB;
}

export function authView(mode) {
  return async (_p, out) => {
    const isLogin = mode === 'login';
    const { googleClientId, microsoftClientId, facebookAppId } = await fetchConfig();
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

    /** First-ever sign-in through either provider: the account can't be
     *  created until we know which role it should have. */
    const renderOAuthRole = (provider, { credential, name, email }) => {
      card.innerHTML = `
        <h2>${t('auth.chooseRole')}</h2>
        <p class="small muted">${esc(name || email)}</p>
        <div class="stack" id="roleList">
          ${['student', 'teacher'].map(r =>
            `<button class="btn btn-block" data-role="${r}">${t('auth.role.' + r)}</button>`).join('')}
        </div>
        <div id="roleErr" class="small mt" style="color:var(--danger)"></div>`;

      out.querySelectorAll('[data-role]').forEach(b => b.onclick = async () => {
        const err = out.querySelector('#roleErr');
        err.textContent = '';
        try {
          await session[provider](credential, b.dataset.role);
          document.dispatchEvent(new CustomEvent('dc:auth'));
          router.go('/');
        } catch (ex) {
          err.textContent = t('auth.' + (ex.body?.error || 'bad_credentials'));
        }
      });
    };

    const onOAuthCredential = async (provider, credential) => {
      const err = out.querySelector('#authErr');
      try {
        const r = await session[provider](credential);
        if (r?.needsRole) return renderOAuthRole(provider, { credential, name: r.name, email: r.email });
        document.dispatchEvent(new CustomEvent('dc:auth'));
        router.go('/');
      } catch (ex) {
        console.error(`[auth] ${provider} sign-in failed`, ex);
        if (err) {
          err.textContent = t('auth.' + (ex.body?.error || provider + '_auth_failed'));
          if (ex.body?.detail) err.textContent += ` (${ex.body.detail})`;
        }
      }
    };

    const mountGoogleButton = async () => {
      if (!googleClientId) return;
      const container = out.querySelector('#googleBtn');
      if (!container) return;
      const google = await waitForGoogleSdk();
      if (!google) return console.warn('[auth] Google Identity Services script never loaded — hiding the button');
      google.accounts.id.initialize({
        client_id: googleClientId,
        callback: ({ credential }) => onOAuthCredential('google', credential)
      });
      // renderButton's width is a fixed pixel value, not responsive — a
      // constant here overflowed narrow phone screens and pushed the button
      // off-screen. Size it to whatever room the container actually has.
      // (Deliberately not deferred to requestAnimationFrame: rAF never
      // fires while the page isn't being actively painted — a backgrounded
      // tab, a screen that just turned off — which silently kept the
      // button from ever rendering at all.)
      const width = container.getBoundingClientRect().width || 300;
      google.accounts.id.renderButton(container, {
        theme: document.documentElement.dataset.theme === 'light' ? 'outline' : 'filled_black',
        size: 'large', width: Math.min(360, width), locale: i18n.lang
      });
    };

    const mountMicrosoftButton = () => {
      if (!microsoftClientId) return;
      const btn = out.querySelector('#msBtn');
      if (!btn) return;
      btn.onclick = async () => {
        const err = out.querySelector('#authErr');
        try {
          const instance = await getMsalInstance(microsoftClientId);
          if (!instance) return console.warn('[auth] MSAL script never loaded — the Microsoft button is inert');
          const result = await instance.loginPopup({ scopes: ['openid', 'profile', 'email'] });
          await onOAuthCredential('microsoft', result.idToken);
        } catch (ex) {
          if (ex?.errorCode === 'user_cancelled') return;
          console.error('[auth] microsoft loginPopup failed', ex);
          if (err) {
            err.textContent = t('auth.microsoft_auth_failed');
            const detail = ex?.errorMessage || ex?.message;
            if (detail) err.textContent += ` (${ex.errorCode || ''} ${detail})`;
          }
        }
      };
    };

    const mountFacebookButton = () => {
      if (!facebookAppId) return;
      const btn = out.querySelector('#fbBtn');
      if (!btn) return;
      btn.onclick = async () => {
        const err = out.querySelector('#authErr');
        try {
          const FB = await getFbSdk(facebookAppId);
          if (!FB) return console.warn('[auth] Facebook SDK never loaded — the Facebook button is inert');
          // Classic Facebook Login (no config_id): "Facebook Login for
          // Business" configurations only ever offer business/asset
          // permissions (Pages, ad accounts, WhatsApp Business...) — never
          // plain email — since they're meant for granting a business app
          // access to those assets, not for signing a person in. Asking for
          // the scope directly is the right tool for that instead.
          const accessToken = await new Promise((resolve, reject) => {
            FB.login(response => {
              if (response.authResponse?.accessToken) resolve(response.authResponse.accessToken);
              else reject(new Error('cancelled'));
            }, { scope: 'public_profile,email' });
          });
          await onOAuthCredential('facebook', accessToken);
        } catch (ex) {
          if (ex.message === 'cancelled') return;
          if (err) err.textContent = t('auth.facebook_auth_failed');
        }
      };
    };

    const renderForm = () => {
      card.innerHTML = `
        <h2>${t(isLogin ? 'auth.login' : 'auth.register')}</h2>
        ${googleClientId ? `<div id="googleBtn" class="center mb"></div>` : ''}
        ${microsoftClientId ? `
          <button type="button" class="btn btn-block mb" id="msBtn">
            <svg width="18" height="18" viewBox="0 0 21 21"><rect width="10" height="10" x="1" y="1" fill="#f25022"/><rect width="10" height="10" x="11" y="1" fill="#7fba00"/><rect width="10" height="10" x="1" y="11" fill="#00a4ef"/><rect width="10" height="10" x="11" y="11" fill="#ffb900"/></svg>
            ${t('auth.continueWithMicrosoft')}
          </button>` : ''}
        ${facebookAppId ? `
          <button type="button" class="btn btn-block mb" id="fbBtn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#1877F2"><path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.09 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.7 4.53-4.7 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.95.93-1.95 1.89v2.26h3.32l-.53 3.49h-2.79V24C19.61 23.09 24 18.1 24 12.07"/></svg>
            ${t('auth.continueWithFacebook')}
          </button>` : ''}
        ${(googleClientId || microsoftClientId || facebookAppId) ? `<div class="center tiny muted mb">${t('auth.or')}</div>` : ''}
        <form id="authForm">
          ${isLogin ? '' : `
            <div class="field"><label>${t('auth.name')}</label><input name="name" required></div>
            <div class="field"><label>${t('auth.role')}</label>
              <select name="role">
                <option value="student">${t('auth.role.student')}</option>
                <option value="teacher">${t('auth.role.teacher')}</option>
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
      mountMicrosoftButton();
      mountFacebookButton();

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

  const isTeacher = d.role === 'teacher' || d.role === 'admin';
  const s = d.stats;

  out.innerHTML = `
    <div class="between mb">
      <div>
        <h1>${t('dash.welcome', { name: esc(u.name.split(' ')[0]) })}</h1>
        <p class="muted">${isTeacher ? t('nav.dashboard') : `${t('dash.level')} ${store.progress?.level} · ${i18n.num(u.xp)} ${t('dash.xp')}`}</p>
      </div>
      ${isTeacher
        ? `<div class="row"><a class="btn" href="/party">🎉 ${t('party.host')}</a></div>`
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
          <a class="small" href="/classes">${t('common.all')} →</a></div>
        ${d.courses.length ? d.courses.map(c => `
          <a href="/classes/${c.classId}/courses/${c.id}" class="row" style="padding:.55rem 0;color:inherit;border-block-end:1px solid var(--border)">
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

/* --------------------------------------------------------------- courses */

export async function courseView({ classId, id }, out) {
  const c = await api.get(`/courses/${id}`);
  const course = c.course;
  const cid = course.class?.id || classId;
  const done = key => c.progress?.[key]?.done;
  const total = c.lessons.length || 1;
  const pct = Math.round((c.lessons.filter(l => done(l.id)).length / total) * 100);

  out.innerHTML = `
    ${course.class ? `<a href="/classes/${cid}" class="small">← ${esc(course.class.title)}</a>` : ''}
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
            <a class="btn" href="/classes/${cid}/courses/${id}/roster">👥 ${t('course.roster')}</a>
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
            : `<a class="btn btn-sm" href="/classes/${cid}/courses/${id}/lessons/${l.id}">${t('common.start')}</a>`}
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
    tabEl.querySelectorAll('[data-submit-assign]').forEach(b => b.onclick = () =>
      submitAssignment(c.assignments.find(a => a.id === b.dataset.submitAssign)));
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
          if (!await confirmDialog(t('course.confirmDelete'), { danger: true })) return;
          await api.del(`/courses/${id}`);
          close();
          router.go(`/classes/${cid}`);
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

const fmtBytes = n => {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
};
const attIcon = name => {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return '🖼️';
  if (ext === 'pdf') return '📄';
  if (ext === 'zip') return '🗜️';
  if (['js', 'py', 'c', 'cpp', 'java', 'sql', 'json'].includes(ext)) return '💻';
  return '📎';
};

/** Renders into `host` and keeps `onChange` fed the current file list —
 *  upload happens immediately (matching how a lesson's video/image
 *  uploads already work elsewhere), so what's shown is always what an
 *  eventual save will actually send. */
function attachmentsEditor(host, initial, onChange) {
  const files = [...(initial || [])];
  const draw = () => {
    host.innerHTML = `
      <div class="stack">${files.map((f, i) => `
        <div class="row between" style="align-items:center">
          <a href="${esc(f.url)}" target="_blank" rel="noopener">${attIcon(f.name)} ${esc(f.name)}</a>
          <span class="row" style="align-items:center">
            <span class="tiny muted">${fmtBytes(f.size)}</span>
            <button type="button" class="btn btn-sm btn-danger" data-remove-att="${i}" title="${t('lesson.removeAttachment')}">✕</button>
          </span>
        </div>`).join('') || `<div class="muted small">${t('lesson.noAttachments')}</div>`}</div>
      <button type="button" class="btn btn-sm mt" data-add-att>⬆ ${t('lesson.addAttachment')}</button>
      <input type="file" data-file-input hidden>`;
    host.querySelectorAll('[data-remove-att]').forEach(b => b.onclick = () => {
      files.splice(Number(b.dataset.removeAtt), 1);
      onChange(files);
      draw();
    });
    host.querySelector('[data-add-att]').onclick = () => host.querySelector('[data-file-input]').click();
    host.querySelector('[data-file-input]').onchange = async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const r = await api.upload(file);
        files.push({ name: r.name, url: r.url, size: r.size });
        onChange(files);
        draw();
      } catch (err) {
        toast(err.body?.error === 'rejected_file_type_or_size' ? t('build.imageRejected') : t('common.error'), 'error');
      }
    };
  };
  draw();
}

function lessonModal(courseId) {
  let attachments = [];
  modal(`
    <h2>${t('course.lessons')}</h2>
    <div class="field"><label>Title</label><input id="ti"></div>
    <div class="field"><label>Markdown</label><textarea id="bo" class="code-editor"></textarea></div>
    <div class="row"><div class="field"><label>${t('common.minutes')}</label><input id="du" type="number" value="15" style="inline-size:100px"></div>
      <label class="row small"><input type="checkbox" id="pv" style="inline-size:auto"> preview</label></div>
    <div class="field"><label>${t('lesson.attachments')}</label><div id="attHost"></div></div>
    <button class="btn btn-primary" id="sv">${t('common.save')}</button>`,
    { onMount: (root, close) => {
        attachmentsEditor(root.querySelector('#attHost'), [], list => { attachments = list; });
        root.querySelector('#sv').onclick = async () => {
          await api.post(`/courses/${courseId}/lessons`, {
            title: root.querySelector('#ti').value,
            body: root.querySelector('#bo').value,
            durationMin: Number(root.querySelector('#du').value),
            preview: root.querySelector('#pv').checked,
            attachments
          });
          close(); router.resolve();
        };
      } });
}

export function quizModal(courseId) {
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
  let attachments = [];
  modal(`
    <h2>${t('course.assignments')}</h2>
    <div class="field"><label>Title</label><input id="ti"></div>
    <div class="field"><label>Brief</label><textarea id="br"></textarea></div>
    <div class="row"><div class="field"><label>Due</label><input id="du" type="date"></div>
      <div class="field"><label>${t('common.points')}</label><input id="pt" type="number" value="20"></div></div>
    <div class="field"><label>${t('lesson.attachments')}</label><div id="attHost"></div></div>
    <button class="btn btn-primary" id="sv">${t('common.create')}</button>`,
    { onMount: (root, close) => {
        attachmentsEditor(root.querySelector('#attHost'), [], list => { attachments = list; });
        root.querySelector('#sv').onclick = async () => {
          await api.post(`/courses/${courseId}/assignments`, {
            title: root.querySelector('#ti').value,
            brief: root.querySelector('#br').value,
            dueAt: root.querySelector('#du').value || null,
            points: Number(root.querySelector('#pt').value),
            attachments
          });
          close(); router.resolve();
        };
      } });
}

function submitAssignment(assignment) {
  let files = [];
  modal(`
    <h2>${esc(assignment.title)}</h2>
    ${assignment.brief ? `<p class="muted small">${esc(assignment.brief)}</p>` : ''}
    ${assignment.attachments?.length ? `
      <div class="card mb" style="background:var(--surface-2)">
        <div class="stack">${assignment.attachments.map(f => `
          <a class="row between" style="padding:.2rem 0" href="${esc(f.url)}" target="_blank" rel="noopener">
            <span>${attIcon(f.name)} ${esc(f.name)}</span><span class="tiny muted">${fmtBytes(f.size)}</span>
          </a>`).join('')}</div>
      </div>` : ''}
    <div class="field"><label>Text</label><textarea id="tx"></textarea></div>
    <div class="field"><label>Code</label><textarea id="cd" class="code-editor"></textarea></div>
    <div class="field"><label>${t('lesson.attachments')}</label><div id="attHost"></div></div>
    <button class="btn btn-primary" id="sv">${t('common.submit')}</button>`,
    { onMount: (root, close) => {
        attachmentsEditor(root.querySelector('#attHost'), [], list => { files = list; });
        root.querySelector('#sv').onclick = async () => {
          await api.post(`/courses/assignments/${assignment.id}/submit`, {
            text: root.querySelector('#tx').value, code: root.querySelector('#cd').value, files
          });
          close();
          toast('✅ ' + t('common.submit'), 'success');
          router.resolve();
        };
      } });
}

export async function lessonView({ classId, id, lessonId }, out) {
  const c = await api.get(`/courses/${id}`);
  const cid = c.course.class?.id || classId;
  const idx = c.lessons.findIndex(l => l.id === lessonId);
  const lesson = c.lessons[idx];
  if (!lesson || lesson.locked) {
    out.innerHTML = `<div class="empty-state"><span class="ic">🔒</span>${t('course.locked')}</div>`;
    return;
  }
  const isDone = c.progress?.[lesson.id]?.done;

  out.innerHTML = `
    <a href="/classes/${cid}/courses/${id}" class="small">← ${esc(title(c.course))}</a>
    <h1 class="mt">${esc(i18n.pick(lesson, 'title', lesson.title))}</h1>
    <div class="row muted small mb">
      <span>${t('quiz.question')} ${idx + 1}/${c.lessons.length}</span>
      <span>· ${lesson.durationMin} ${t('common.minutes')}</span>
    </div>
    ${lesson.videoUrl ? `<video controls src="${esc(lesson.videoUrl)}" style="inline-size:100%;border-radius:var(--radius)"></video>` : ''}
    <div class="card">${markdown(i18n.pick(lesson, 'body', lesson.body))}</div>
    ${lesson.attachments?.length ? `
      <div class="card mt">
        <h3 class="small">📎 ${t('lesson.attachments')}</h3>
        <div class="stack">${lesson.attachments.map(f => `
          <a class="row between" style="padding:.3rem 0" href="${esc(f.url)}" target="_blank" rel="noopener">
            <span>${attIcon(f.name)} ${esc(f.name)}</span>
            <span class="tiny muted">${fmtBytes(f.size)}</span>
          </a>`).join('')}</div>
      </div>` : ''}
    <div class="between mt">
      ${idx > 0 ? `<a class="btn" href="/classes/${cid}/courses/${id}/lessons/${c.lessons[idx - 1].id}">← ${t('common.previous')}</a>` : '<span></span>'}
      ${c.enrolled ? `<button class="btn ${isDone ? 'btn-success' : 'btn-primary'}" id="done" ${isDone ? 'disabled' : ''}>
        ${isDone ? '✓ ' + t('course.done') : t('course.markDone')}</button>` : ''}
      ${idx < c.lessons.length - 1 ? `<a class="btn" href="/classes/${cid}/courses/${id}/lessons/${c.lessons[idx + 1].id}">${t('common.next')} →</a>` : '<span></span>'}
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
/** The reference files a teacher attached to the assignment brief itself —
 *  distinct from what's rendered further down for a student's submission. */
const assignmentAttachments = a => a.attachments?.length ? `
  <div class="card mb" style="background:var(--surface-2)">
    <div class="stack">${a.attachments.map(f => `
      <a class="row between" style="padding:.2rem 0" href="${esc(f.url)}" target="_blank" rel="noopener">
        <span>${attIcon(f.name)} ${esc(f.name)}</span><span class="tiny muted">${fmtBytes(f.size)}</span>
      </a>`).join('')}</div>
  </div>` : '';

const submissionFiles = s => s.files?.length ? `<div class="row mb">${s.files.map(f =>
  `<a class="btn btn-sm" href="${esc(f.url)}" target="_blank" rel="noopener">📎 ${esc(f.name || t('assignment.files'))}</a>`).join('')}</div>` : '';

export async function assignmentGradeView({ id }, out) {
  const data = await api.get(`/courses/assignments/${id}`);
  const a = data.assignment;

  if (!data.editable) {
    // A student who follows their own submission link sees a read-only recap.
    const s = data.mySubmission;
    out.innerHTML = `
      <a href="/classes/${a.course.classId}/courses/${a.course.id}" class="small">← ${esc(a.course.title)}</a>
      <h1 class="mt">${esc(a.title)}</h1>
      <p class="muted">${esc(a.brief || '')}</p>
      ${assignmentAttachments(a)}
      ${s ? `
        <div class="card mt">
          <div class="between mb">
            <span class="badge badge-${s.status === 'graded' ? 'success' : 'primary'}">${
              s.status === 'graded' ? t('assignment.graded') : t('assignment.submitted')}</span>
            ${s.late ? `<span class="badge badge-warning">${t('assignment.late')}</span>` : ''}
          </div>
          ${s.text ? `<div class="card small" style="white-space:pre-wrap;background:var(--surface-2)">${esc(s.text)}</div>` : ''}
          ${s.code ? `<pre class="mt">${esc(s.code)}</pre>` : ''}
          ${submissionFiles(s)}
          ${s.grade != null ? `<div class="mt"><strong>${t('assignment.grade')}:</strong> ${s.grade}/${a.points}</div>` : ''}
          ${s.feedback ? `<div class="card mt small" style="background:var(--surface-2)">${esc(s.feedback)}</div>` : ''}
        </div>` : `<div class="empty-state mt">${t('assignment.notSubmitted')}</div>`}`;
    return;
  }

  const rows = data.submissions;
  out.innerHTML = `
    <a href="/classes/${a.course.classId}/courses/${a.course.id}" class="small">← ${esc(a.course.title)}</a>
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
    ${assignmentAttachments(a)}
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
          ${submissionFiles(s)}
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

export async function rosterView({ classId, id }, out) {
  const { roster } = await api.get(`/courses/${id}/roster`);
  out.innerHTML = `
    <a href="/classes/${classId}/courses/${id}" class="small">← ${t('common.back')}</a>
    <h1 class="mt">${t('course.roster')}</h1>
    <div class="card table-wrap"><table>
      <thead><tr><th>${t('lb.student')}</th><th>${t('course.progress')}</th>
        <th>${t('quiz.attempts')}</th><th>${t('gradebook.average')}</th><th>${t('common.lastActive')}</th><th></th></tr></thead>
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
