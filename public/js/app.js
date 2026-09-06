/* Application shell: boot, chrome (topbar + sidebar), route table. */
import {
  api, store, session, router, i18n, t, esc, avatar, toast,
  connectSocket, applyTheme, LANGS
} from './core.js';
import * as Learn from './views/learn.js';
import * as Quiz from './views/quiz.js';
import * as Party from './views/party.js';
import * as Community from './views/community.js';

/* ----------------------------------------------------------------- chrome */

function chrome() {
  const u = store.user;
  const shell = document.getElementById('app');

  if (!u) {
    shell.innerHTML = `<div id="outlet"></div>`;
    return;
  }

  // One entry per destination, and only what this role actually uses:
  // admins administer, parents observe, students learn, teachers teach.
  const plays = u.role === 'student' || u.role === 'teacher';
  const nav = [
    { href: '/', icon: u.role === 'admin' ? '⚙️' : '🏠',
      label: u.role === 'admin' ? t('nav.admin') : t('nav.dashboard'), primary: true },
    { href: '/courses', icon: '📚', label: t('nav.courses'), primary: true },
    ...(plays ? [{ href: '/party', icon: '🎉', label: t('nav.party'), primary: true }] : []),
    { href: '/forum', icon: '💬', label: t('nav.forum'), primary: !plays },
    { href: '/messages', icon: '✉️', label: t('nav.messages'), primary: true },
    ...(u.role === 'student' ? [{ href: '/flashcards', icon: '🃏', label: t('nav.flashcards') }] : []),
    ...(u.role === 'teacher' ? [{ href: '/review', icon: '📝', label: t('review.queue') }] : []),
    ...(plays ? [
      { href: '/leaderboard', icon: '🏆', label: t('nav.leaderboard') },
      { href: '/playground', icon: '⌨️', label: t('nav.playground') }
    ] : [])
  ];

  shell.innerHTML = `
    <header class="topbar">
      <button class="btn btn-sm" id="burger" style="display:none">☰</button>
      <a class="brand" href="/"><span class="brand-mark">DC</span> ${t('app.name')}</a>
      <span class="topbar-spacer"></span>

      <div class="dropdown" id="langDrop">
        <button class="btn btn-sm">🌐 <span class="lang-label">${LANGS[i18n.lang]}</span></button>
        <div class="dropdown-menu hidden">
          ${Object.entries(LANGS).map(([code, label]) =>
            `<div class="dropdown-item" data-lang="${code}">${label}${i18n.lang === code ? ' ✓' : ''}</div>`).join('')}
        </div>
      </div>

      <button class="btn btn-sm" id="themeBtn" title="${t('profile.theme')}">
        ${document.documentElement.dataset.theme === 'light' ? '🌙' : '☀️'}</button>

      <div class="dropdown" id="notifDrop" style="position:relative">
        <button class="btn btn-sm" style="position:relative">🔔
          ${store.unread ? `<span class="dot-badge">${store.unread}</span>` : ''}</button>
        <div class="dropdown-menu hidden" id="notifList"></div>
      </div>

      <div class="dropdown" id="userDrop">
        <button class="btn btn-sm row">${avatar(u)} <span class="small user-name">${esc(u.name.split(' ')[0])}</span></button>
        <div class="dropdown-menu hidden">
          <div class="dropdown-item" style="pointer-events:none">
            <strong>${esc(u.name)}</strong>
            <div class="tiny muted">${t('lb.level')} ${store.progress?.level} · ${i18n.num(u.xp)} XP · 🔥 ${u.streak || 0}</div>
          </div>
          <a class="dropdown-item" href="/profile">👤 ${t('nav.profile')}</a>
          ${u.role === 'parent' ? `<a class="dropdown-item" href="/">👨‍👩‍👧 ${t('nav.children')}</a>` : ''}
          <div class="dropdown-item" id="logout">🚪 ${t('nav.logout')}</div>
        </div>
      </div>
    </header>

    <div class="layout">
      <aside class="sidebar">
        ${nav.map(n =>
          `<a class="side-link" href="${n.href}"><span class="ic">${n.icon}</span> ${esc(n.label)}</a>`).join('')}
      </aside>
      <main id="outlet"></main>
    </div>

    <nav class="tabbar">
      ${nav.filter(n => n.primary).slice(0, 5).map(n => `
        <a class="tabbar-link" href="${n.href}">
          <span class="ic">${n.icon}</span><span class="lbl">${esc(n.label)}</span>
        </a>`).join('')}
    </nav>`;

  // Dropdown open/close
  shell.querySelectorAll('.dropdown').forEach(d => {
    d.querySelector('button').onclick = e => {
      e.stopPropagation();
      const menu = d.querySelector('.dropdown-menu');
      shell.querySelectorAll('.dropdown-menu').forEach(m => m !== menu && m.classList.add('hidden'));
      menu.classList.toggle('hidden');
      if (d.id === 'notifDrop' && !menu.classList.contains('hidden')) loadNotifications();
    };
  });
  document.addEventListener('click', () =>
    shell.querySelectorAll('.dropdown-menu').forEach(m => m.classList.add('hidden')));

  shell.querySelectorAll('[data-lang]').forEach(item => item.onclick = async () => {
    await i18n.load(item.dataset.lang);
    if (store.user) api.patch('/auth/me', { lang: item.dataset.lang }).catch(() => {});
    chrome();
    router.resolve();
  });

  shell.querySelector('#themeBtn').onclick = () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    api.patch('/auth/me', { theme: next }).catch(() => {});
    chrome();
    router.resolve();
  };

  shell.querySelector('#logout').onclick = () => session.logout();

  const burger = shell.querySelector('#burger');
  if (window.innerWidth <= 900) burger.style.display = 'inline-flex';
  burger.onclick = e => {
    e.stopPropagation();
    shell.querySelector('.sidebar').classList.toggle('open');
  };
}

async function loadNotifications() {
  const list = document.getElementById('notifList');
  if (!list) return;
  list.innerHTML = `<div class="dropdown-item muted">${t('common.loading')}</div>`;
  const { notifications, unread } = await api.get('/social/notifications');
  store.unread = unread;

  const text = n => {
    const d = n.data || {};
    switch (n.kind) {
      case 'badge': return `${d.icon} ` + t('notif.badge', { badge: d.badgeId });
      case 'level_up': return t('notif.level_up', { level: d.level });
      case 'reply': return t('notif.reply', { by: d.by });
      case 'announcement': return t('notif.announcement', { title: d.title });
      case 'graded': return t('notif.graded');
      case 'attempt_reviewed': return t('notif.attempt_reviewed', { percent: d.percent });
      case 'party_result': return t('notif.party_result', { rank: d.rank });
      case 'assignment': return t('notif.assignment', { title: d.title });
      case 'new_student': return t('notif.new_student');
      case 'dm': return t('notif.dm', { from: d.from });
      case 'guardian_linked': return t('notif.guardian_linked');
      default: return n.kind;
    }
  };
  const href = n => n.kind === 'dm' ? `/messages/${n.data.fromId}`
    : n.kind === 'reply' ? `/forum/${n.data.threadId}`
    : n.kind === 'attempt_reviewed' ? `/attempt/${n.data.attemptId}` : null;

  list.innerHTML = `
    <div class="between" style="padding:.35rem .6rem">
      <strong class="small">${t('notif.title')}</strong>
      <button class="btn btn-sm" id="readAll">${t('notif.markAllRead')}</button>
    </div>
    ${notifications.length ? notifications.slice(0, 25).map(n => {
      const link = href(n);
      const body = `<div class="tiny muted">${i18n.date(n.createdAt, { dateStyle: 'short', timeStyle: 'short' })}</div>${esc(text(n))}`;
      return link
        ? `<a class="dropdown-item ${n.read ? '' : 'unread'}" href="${link}">${body}</a>`
        : `<div class="dropdown-item ${n.read ? '' : 'unread'}">${body}</div>`;
    }).join('') : `<div class="dropdown-item muted">${t('common.empty')}</div>`}`;

  list.querySelector('#readAll').onclick = async e => {
    e.stopPropagation();
    await api.post('/social/notifications/read', {});
    store.unread = 0;
    chrome();
    router.resolve();
  };
}

/* ----------------------------------------------------------------- routes */

router.add('/login', Learn.authView('login'), { auth: false });
router.add('/register', Learn.authView('register'), { auth: false });

// Admins land on the admin console, never on a learner dashboard.
router.add('/', (p, out) =>
  store.user?.role === 'admin' ? Community.adminView(p, out) : Learn.dashboardView(p, out));
router.add('/courses', Learn.coursesView);
router.add('/courses/new', Learn.courseNewView, { roles: ['teacher', 'admin'] });
router.add('/courses/:id', Learn.courseView);
router.add('/courses/:id/roster', Learn.rosterView, { roles: ['teacher', 'admin'] });
router.add('/courses/:id/lessons/:lessonId', Learn.lessonView);
router.add('/assignments/:id', Learn.assignmentGradeView);
router.add('/children/:id', Learn.childReportView, { roles: ['parent', 'admin'] });

router.add('/quiz/:id', Quiz.quizView);
router.add('/quiz/:id/edit', Quiz.quizEditView, { roles: ['teacher', 'admin'] });
router.add('/attempt/:id', Quiz.attemptView);
router.add('/review', Quiz.reviewQueueView, { roles: ['teacher', 'admin'] });
router.add('/gradebook/:courseId', Quiz.gradebookView, { roles: ['teacher', 'admin'] });
router.add('/analytics/:quizId', Quiz.analyticsView, { roles: ['teacher', 'admin'] });
router.add('/flashcards', Quiz.flashcardsView);
router.add('/playground', Quiz.playgroundView);

router.add('/party', Party.partyView);
router.add('/party/:pin', Party.partyRoomView);

router.add('/forum', Community.forumView);
router.add('/forum/:id', Community.threadView);
router.add('/leaderboard', Community.leaderboardView);
router.add('/messages', Community.messagesView);
router.add('/messages/:id', Community.messagesView);
router.add('/profile', Community.profileView);
router.add('/profile/:id', Community.profileView);
router.add('/admin', Community.adminView, { roles: ['admin'] });

/* ------------------------------------------------------------------- boot */

document.addEventListener('dc:auth', () => chrome());
document.addEventListener('dc:relang', () => chrome());

(async function boot() {
  applyTheme(localStorage.getItem('dc_theme') || 'dark');
  await i18n.load(localStorage.getItem('dc_lang') || 'fr');
  await session.refresh();
  chrome();

  if (store.user) {
    connectSocket();
    // Live nudges: badges, replies, party invites all arrive as notifications.
    store.socket?.on('notify', () => { store.unread++; chrome(); router.resolve(); });
    store.socket?.on('party:kicked', () => { toast(t('party.notFound'), 'error'); router.go('/party'); });
  }

  if (!store.user && !['/login', '/register'].includes(location.pathname)) router.go('/login', true);
  else router.resolve();
})();
