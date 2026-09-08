/* Views: forum, leaderboard, messages, profile, certificates, admin. */
import {
  api, store, session, router, t, i18n, esc, toast, modal, confirmDialog, avatar,
  markdown, applyTheme, barChart, LANGS
} from '../core.js';

/* ----------------------------------------------------------------- forum */

export async function forumView(_p, out) {
  let sort = 'recent';
  const load = async () => {
    const { threads } = await api.get(`/social/threads?sort=${sort}`);
    out.innerHTML = `
      <div class="between mb">
        <h1>${t('forum.title')}</h1>
        <button class="btn btn-primary" id="new">+ ${t('forum.newThread')}</button>
      </div>
      <div class="row mb">
        ${['recent', 'popular', 'unanswered'].map(s =>
          `<button class="chip ${sort === s ? 'selected' : ''}" data-sort="${s}">${t('forum.' + s)}</button>`).join('')}
      </div>
      <div class="stack">${threads.map(th => `
        <a class="card card-hover" href="/forum/${th.id}" style="color:inherit">
          <div class="between">
            <div>
              <div class="row mb">
                ${th.pinned ? '<span class="badge badge-warning">📌</span>' : ''}
                ${th.solved ? `<span class="badge badge-success">✓ ${t('forum.solved')}</span>` : ''}
                ${th.course ? `<span class="badge badge-primary">${esc(th.course)}</span>` : ''}
                ${(th.tags || []).map(tg => `<span class="badge">${esc(tg)}</span>`).join('')}
              </div>
              <strong>${esc(th.title)}</strong>
              <div class="tiny muted mt">${esc(th.author?.name || '')} · ${i18n.date(th.createdAt)}</div>
            </div>
            <div class="center">
              <div style="font-size:1.3rem;font-weight:700">${th.replies}</div>
              <div class="tiny muted">${t('forum.replies')}</div>
            </div>
          </div>
        </a>`).join('') || `<div class="empty-state"><span class="ic">💬</span>${t('common.empty')}</div>`}</div>`;

    out.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => { sort = b.dataset.sort; load(); });
    out.querySelector('#new').onclick = async () => {
      const { courses } = await api.get('/courses?mine=1');
      modal(`
        <h2>${t('forum.newThread')}</h2>
        <div class="field"><label>Title</label><input id="ti"></div>
        <div class="field"><label>Body</label><textarea id="bo"></textarea></div>
        <div class="field"><label>${t('nav.courses')}</label>
          <select id="co"><option value="">—</option>
            ${courses.map(c => `<option value="${c.id}">${esc(c.title)}</option>`).join('')}</select></div>
        <button class="btn btn-primary" id="sv">${t('common.create')}</button>`,
        { onMount: (root, close) => root.querySelector('#sv').onclick = async () => {
            const { thread } = await api.post('/social/threads', {
              title: root.querySelector('#ti').value,
              body: root.querySelector('#bo').value,
              courseId: root.querySelector('#co').value || null
            });
            close();
            router.go('/forum/' + thread.id);
          } });
    };
  };
  await load();
}

export async function threadView({ id }, out) {
  const load = async () => {
    const { thread, posts } = await api.get(`/social/threads/${id}`);
    const canModerate = ['teacher', 'admin'].includes(store.user.role);
    out.innerHTML = `
      <a href="/forum" class="small">← ${t('forum.title')}</a>
      <div class="card mt">
        <div class="row mb">
          ${thread.solved ? `<span class="badge badge-success">✓ ${t('forum.solved')}</span>` : ''}
          <span class="tiny muted">${thread.views} ${t('forum.views')}</span>
        </div>
        <h1>${esc(thread.title)}</h1>
        <div class="row small muted mb">${avatar(thread.author)} ${esc(thread.author?.name || '')} · ${i18n.date(thread.createdAt)}</div>
        ${markdown(thread.body)}
        ${canModerate ? `<div class="row mt">
          <button class="btn btn-sm" data-mod="pinned">${thread.pinned ? '📌 unpin' : '📌 pin'}</button>
          <button class="btn btn-sm" data-mod="locked">${thread.locked ? '🔓 unlock' : '🔒 lock'}</button>
        </div>` : ''}
      </div>

      <h3 class="mt">${posts.length} ${t('forum.replies')}</h3>
      <div class="stack">${posts.map(p => `
        <div class="card" ${p.accepted ? 'style="border-color:var(--success)"' : ''}>
          ${p.accepted ? `<span class="badge badge-success mb">✓ ${t('forum.accepted')}</span>` : ''}
          <div class="between mb">
            <span class="row">${avatar(p.author)} <strong>${esc(p.author?.name || '')}</strong>
              ${p.author?.role === 'teacher' ? '<span class="badge badge-primary">👩‍🏫</span>' : ''}
              <span class="tiny muted">${i18n.date(p.createdAt)}</span></span>
            <span class="row">
              <button class="btn btn-sm" data-vote="${p.id}">▲ ${p.votes}</button>
              ${!p.accepted && (thread.authorId === store.user.id || ['teacher', 'admin'].includes(store.user.role))
                ? `<button class="btn btn-sm btn-success" data-accept="${p.id}">✓</button>` : ''}
            </span>
          </div>
          ${markdown(p.body)}
          ${p.code ? `<pre>${esc(p.code)}</pre>` : ''}
        </div>`).join('')}</div>

      ${thread.locked ? `<div class="empty-state">🔒</div>` : `
        <div class="card mt">
          <label>${t('forum.reply')}</label>
          <textarea id="reply"></textarea>
          <button class="btn btn-primary mt" id="send">${t('forum.reply')}</button>
        </div>`}`;

    out.querySelector('#send')?.addEventListener('click', async () => {
      const body = out.querySelector('#reply').value.trim();
      if (!body) return;
      await api.post(`/social/threads/${id}/posts`, { body });
      load();
    });
    out.querySelectorAll('[data-vote]').forEach(b => b.onclick = async () => {
      const r = await api.post(`/social/posts/${b.dataset.vote}/vote`, { dir: 1 });
      b.textContent = `▲ ${r.votes}`;
    });
    out.querySelectorAll('[data-accept]').forEach(b => b.onclick = async () => {
      await api.post(`/social/posts/${b.dataset.accept}/accept`);
      load();
    });
    out.querySelectorAll('[data-mod]').forEach(b => b.onclick = async () => {
      await api.patch(`/social/threads/${id}/moderate`, { [b.dataset.mod]: !thread[b.dataset.mod] });
      load();
    });
  };
  await load();
}

/* ----------------------------------------------------------- leaderboard */

export async function leaderboardView(_p, out) {
  const { leaderboard, me } = await api.get('/social/leaderboard');
  out.innerHTML = `
    <h1>${t('lb.title')}</h1>
    ${me ? `<div class="card mb between" style="border-color:var(--primary)">
      <span class="row"><span class="avatar">${me.rank}</span> ${avatar(store.user)} <strong>${esc(me.name)}</strong>
        <span class="badge badge-primary">${t('party.you')}</span></span>
      <span class="row"><span class="badge">${t('lb.level')} ${me.level}</span>
        <span class="badge badge-primary">${i18n.num(me.xp)} XP</span></span>
    </div>` : ''}
    <div class="card table-wrap"><table>
      <thead><tr><th>${t('lb.rank')}</th><th>${t('lb.student')}</th><th>${t('lb.level')}</th>
        <th>XP</th><th>🔥</th><th>${t('dash.badges')}</th></tr></thead>
      <tbody>${leaderboard.map(r => `
        <tr style="${r.id === store.user.id ? 'font-weight:700;background:var(--primary-soft)' : ''}">
          <td>${r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank}</td>
          <td><a href="/profile/${r.id}" class="row" style="color:inherit">${avatar(r)} ${esc(r.name)}</a></td>
          <td><span class="badge">${r.level}</span></td>
          <td>${i18n.num(r.xp)}</td>
          <td>${r.streak}</td>
          <td>${r.badges}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;
}

/* -------------------------------------------------------------- messages */

export async function messagesView({ id }, out) {
  const { conversations } = await api.get('/social/conversations');
  const thread = id ? await api.get(`/social/messages/${id}`) : null;

  out.innerHTML = `
    <h1>${t('msg.title')}</h1>
    <div class="grid" style="grid-template-columns:260px 1fr">
      <div class="card stack">
        ${conversations.length ? conversations.map(c => `
          <a class="row" href="/messages/${c.peer?.id}" style="color:inherit;padding:.4rem;border-radius:var(--radius-sm);
             ${c.peer?.id === id ? 'background:var(--primary-soft)' : ''}">
            ${avatar(c.peer)}
            <span style="flex:1;min-inline-size:0">
              <strong class="small">${esc(c.peer?.name || '')}</strong>
              <div class="tiny muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.lastMessage)}</div>
            </span>
            ${c.unread ? `<span class="badge badge-danger">${c.unread}</span>` : ''}
          </a>`).join('') : `<div class="muted small">${t('msg.noConversations')}</div>`}
      </div>
      <div class="card">
        ${thread ? `
          <div class="row mb">${avatar(thread.peer)}<strong>${esc(thread.peer?.name || '')}</strong></div>
          <div class="stack" style="max-block-size:420px;overflow-y:auto" id="log">
            ${thread.messages.map(m => `
              <div style="align-self:${m.authorId === store.user.id ? 'flex-end' : 'flex-start'};max-inline-size:75%">
                <div class="card small" style="background:${m.authorId === store.user.id ? 'var(--primary-soft)' : 'var(--surface-2)'}">
                  ${esc(m.text)}
                </div>
                <div class="tiny muted">${i18n.date(m.at, { timeStyle: 'short' })}</div>
              </div>`).join('')}
          </div>
          <div class="row mt">
            <input id="txt" placeholder="${t('msg.placeholder')}" style="flex:1">
            <button class="btn btn-primary" id="send">${t('msg.send')}</button>
          </div>`
        : `<div class="empty-state"><span class="ic">✉️</span>${t('msg.noConversations')}</div>`}
      </div>
    </div>`;

  const send = async () => {
    const input = out.querySelector('#txt');
    if (!input?.value.trim()) return;
    await api.post(`/social/messages/${id}`, { text: input.value });
    router.resolve();
  };
  out.querySelector('#send')?.addEventListener('click', send);
  out.querySelector('#txt')?.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  const log = out.querySelector('#log');
  if (log) log.scrollTop = log.scrollHeight;
}

/* --------------------------------------------------------------- profile */

export async function profileView({ id }, out) {
  const userId = id || store.user.id;
  const p = await api.get(`/social/profile/${userId}`);
  const isMe = userId === store.user.id;
  const certs = isMe ? (await api.get('/certificates')).certificates : p.certificates;

  out.innerHTML = `
    <div class="card mb row">
      ${avatar(p.user, 'avatar-lg')}
      <div style="flex:1">
        <h1 style="margin:0">${esc(p.user.name)}</h1>
        <div class="row small muted">
          <span class="badge badge-primary">${t('auth.role.' + p.user.role) || p.user.role}</span>
          <span class="badge">${t('lb.level')} ${p.user.level || 1}</span>
          <span class="badge">${i18n.num(p.user.xp)} XP</span>
          <span class="badge">🔥 ${p.user.streak || 0}</span>
        </div>
        <p class="small mt">${esc(p.user.bio || '')}</p>
      </div>
      ${!isMe ? `<a class="btn" href="/messages/${userId}">✉️ ${t('msg.newMessage')}</a>` : ''}
    </div>

    <div class="grid grid-2">
      <div class="card">
        <h3>${t('profile.stats')}</h3>
        <div class="grid grid-3">
          <div class="stat"><div class="v">${p.stats.attempts}</div><div class="k">${t('quiz.attempts')}</div></div>
          <div class="stat"><div class="v">${p.stats.averageScore ?? '—'}%</div><div class="k">${t('gradebook.average')}</div></div>
          <div class="stat"><div class="v">${p.stats.partyWins}</div><div class="k">🏆 ${t('nav.party')}</div></div>
        </div>
        <h3 class="mt">${t('dash.badges')} (${p.badges.length})</h3>
        <div class="row">${p.badges.map(b =>
          `<span class="badge badge-primary" title="${esc(b.badgeId)}">${b.icon} ${esc(b.badgeId)}</span>`).join('')
          || `<span class="muted small">${t('common.empty')}</span>`}</div>
      </div>

      <div class="card">
        ${isMe ? `
          <h3>${t('profile.title')}</h3>
          <div class="field"><label>${t('auth.name')}</label><input id="nm" value="${esc(p.user.name)}"></div>
          <div class="field"><label>${t('profile.bio')}</label><textarea id="bio">${esc(p.user.bio || '')}</textarea></div>
          <div class="row">
            <div class="field" style="flex:1"><label>${t('profile.language')}</label>
              <select id="lg">${Object.entries(LANGS).map(([k, v]) =>
                `<option value="${k}" ${p.user.lang === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
            <div class="field" style="flex:1"><label>${t('profile.theme')}</label>
              <select id="th">
                <option value="dark" ${p.user.theme === 'dark' ? 'selected' : ''}>${t('profile.theme.dark')}</option>
                <option value="light" ${p.user.theme === 'light' ? 'selected' : ''}>${t('profile.theme.light')}</option>
              </select></div>
          </div>
          <button class="btn btn-primary" id="save">${t('common.save')}</button>
          <button class="btn mt" id="pw">${t('profile.changePassword')}</button>
        ` : `<h3>${t('dash.certificates')}</h3>`}
      </div>
    </div>

    ${certs?.length ? `<div class="card mt"><h3>${t('dash.certificates')}</h3>
      <div class="grid grid-2">${certs.map(c => `
        <div class="cert">
          <div style="font-size:1.6rem">🎓</div>
          <strong>${esc(c.courseTitle)}</strong>
          <div class="small muted">${esc(c.studentName)} · ${i18n.date(c.issuedAt)}</div>
          <div class="tiny mono muted mt">${esc(c.serial)}</div>
        </div>`).join('')}</div></div>` : ''}`;

  out.querySelector('#save')?.addEventListener('click', async () => {
    const lang = out.querySelector('#lg').value;
    const theme = out.querySelector('#th').value;
    await api.patch('/auth/me', {
      name: out.querySelector('#nm').value, bio: out.querySelector('#bio').value, lang, theme
    });
    applyTheme(theme);
    await i18n.load(lang);
    await session.refresh();
    document.dispatchEvent(new CustomEvent('dc:relang'));
    toast('✅ ' + t('quiz.saved'), 'success');
    router.resolve();
  });

  out.querySelector('#pw')?.addEventListener('click', () => modal(`
    <h2>${t('profile.changePassword')}</h2>
    <div class="field"><label>${t('profile.currentPassword')}</label><input id="c" type="password"></div>
    <div class="field"><label>${t('profile.newPassword')}</label><input id="n" type="password" minlength="8"></div>
    <button class="btn btn-primary" id="go">${t('common.save')}</button>`,
    { onMount: (root, close) => root.querySelector('#go').onclick = async () => {
        try {
          await api.post('/auth/me/password', {
            current: root.querySelector('#c').value, next: root.querySelector('#n').value
          });
          close();
          toast('✅', 'success');
        } catch (e) { toast(t('auth.' + (e.body?.error || 'weak_password')), 'error'); }
      } }));
}

/* ----------------------------------------------------------------- admin */

/**
 * The admin home. Deliberately plain: three tabs, one job each, every number
 * labelled in words rather than jargon. Admins never see learner UI.
 */
export async function adminView(_p, out) {
  const [{ users }, stats, courses] = await Promise.all([
    api.get('/users'), api.get('/stats'), api.get('/courses')
  ]);

  const roleCount = r => users.filter(u => u.role === r).length;
  const newest = [...users].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 6);

  out.innerHTML = `
    <div class="between mb">
      <div>
        <h1>${t('admin.title')}</h1>
        <p class="muted small">${t('admin.notLearner')}</p>
      </div>
      <a class="btn btn-primary" href="/classes">${t('classes.hub')}</a>
    </div>

    <div class="tabs">
      <button class="tab active" data-atab="overview">📊 ${t('admin.overview')}</button>
      <button class="tab" data-atab="people">👥 ${t('admin.people')}</button>
      <button class="tab" data-atab="content">📚 ${t('admin.content')}</button>
      <button class="tab" data-atab="danger">⚠️ ${t('admin.dangerZone')}</button>
    </div>
    <div id="apane"></div>`;

  const panes = {
    overview: () => `
      <div class="grid grid-4 mb">
        <div class="stat"><div class="v">${stats.users.total}</div><div class="k">${t('admin.totalUsers')}</div></div>
        <div class="stat"><div class="v">${stats.users.active7d}</div><div class="k">${t('admin.activeWeek')}</div></div>
        <div class="stat"><div class="v">${courses.courses.length}</div><div class="k">${t('nav.courses')}</div></div>
        <div class="stat"><div class="v">${stats.counts.attempts || 0}</div><div class="k">${t('quiz.attempts')}</div></div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <h3>${t('admin.people')}</h3>
          ${[['student', stats.users.students], ['teacher', stats.users.teachers],
             ['admin', roleCount('admin')]]
            .map(([role, n]) => `
              <div class="between" style="padding:.4rem 0;border-block-end:1px solid var(--border)">
                <span>${t('auth.role.' + role)}</span><strong>${n}</strong>
              </div>`).join('')}
        </div>

        <div class="card">
          <h3>${t('admin.content')}</h3>
          ${[['nav.courses', courses.courses.length], ['course.lessons', stats.counts.lessons || 0],
             ['course.quizzes', stats.counts.quizzes || 0], ['quiz.question', stats.counts.questions || 0]]
            .map(([key, n]) => `
              <div class="between" style="padding:.4rem 0;border-block-end:1px solid var(--border)">
                <span>${t(key)}</span><strong>${n}</strong>
              </div>`).join('')}
          ${stats.liveParties ? `<div class="badge badge-success mt">🎉 ${stats.liveParties} ${t('party.live')}</div>` : ''}
        </div>
      </div>

      <div class="card mt">
        <h3>${t('admin.newestUsers')}</h3>
        ${newest.map(u => `
          <div class="between" style="padding:.35rem 0">
            <span class="row">${avatar(u)} <span>
              <strong class="small">${esc(u.name)}</strong>
              <div class="tiny muted">${esc(u.email)}</div></span></span>
            <span class="badge">${t('auth.role.' + u.role)}</span>
          </div>`).join('')}
      </div>`,

    people: () => `
      <div class="card">
        <input id="q" class="search-input mb" placeholder="${t('admin.searchUser')}">
        <p class="tiny muted">${t('admin.roleHint')} ${t('admin.suspendHint')}</p>
        <div id="ulist" class="stack"></div>
      </div>`,

    content: () => `
      <div class="card mb">
        <h3>${t('admin.questionTypes')}</h3>
        ${barChart(Object.entries(stats.questionTypes).filter(([, v]) => v > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => ({ label: t('qtype.' + k), value: v, display: v })))}
      </div>
      <div class="card">
        <h3>${t('nav.courses')}</h3>
        <div class="stack">
          ${courses.courses.map(c => `
            <a class="between course-row" href="/classes/${c.classId}/courses/${c.id}">
              <span class="row">
                <span class="dot-color" style="background:${esc(c.color || 'var(--primary)')}"></span>
                <span><strong>${esc(c.title)}</strong>
                  <div class="tiny muted">${esc(c.teacher?.name || '')} · ${c.studentCount} ${t('course.students')}</div>
                </span>
              </span>
              <span class="row">
                <span class="badge badge-${c.status === 'published' ? 'success' : 'warning'}">${esc(c.status)}</span>
              </span>
            </a>`).join('') || `<div class="muted small">${t('common.empty')}</div>`}
        </div>
      </div>`,

    danger: () => `
      <div class="card" style="border:1px solid var(--danger)">
        <h3>${t('admin.wipeAll')}</h3>
        <p class="small muted">${t('admin.wipeAllHint')}</p>
        <div class="field"><label>${t('admin.wipeConfirmLabel')}</label>
          <input id="wipeConfirm" autocomplete="off" placeholder="DELETE"></div>
        <button class="btn btn-danger" id="wipeBtn" disabled>${t('admin.wipeAll')}</button>
      </div>`
  };

  const pane = out.querySelector('#apane');

  const drawUsers = (filter = '') => {
    const list = out.querySelector('#ulist');
    if (!list) return;
    const rows = users.filter(u => (u.name + u.email).toLowerCase().includes(filter));
    list.innerHTML = rows.length ? rows.map(u => `
      <div class="user-row">
        <span class="row" style="flex:1;min-inline-size:0">
          ${avatar(u)}
          <span style="min-inline-size:0">
            <strong class="small">${esc(u.name)}</strong>
            <div class="tiny muted ellipsis">${esc(u.email)}</div>
          </span>
        </span>
        <select data-role="${u.id}" class="role-select">
          ${['student', 'teacher', 'admin'].map(r =>
            `<option value="${r}" ${u.role === r ? 'selected' : ''}>${t('auth.role.' + r)}</option>`).join('')}
        </select>
        <button class="btn btn-sm ${u.status === 'active' ? 'btn-danger' : 'btn-success'}" data-toggle="${u.id}">
          ${t(u.status === 'active' ? 'admin.suspend' : 'admin.activate')}
        </button>
      </div>`).join('') : `<div class="muted small">${t('admin.noResults')}</div>`;

    list.querySelectorAll('[data-role]').forEach(s => s.onchange = async () => {
      await api.patch(`/users/${s.dataset.role}`, { role: s.value });
      users.find(x => x.id === s.dataset.role).role = s.value;
      toast('✅ ' + t('quiz.saved'), 'success');
    });
    list.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
      const u = users.find(x => x.id === b.dataset.toggle);
      u.status = u.status === 'active' ? 'suspended' : 'active';
      await api.patch(`/users/${u.id}`, { status: u.status });
      drawUsers(out.querySelector('#q')?.value.toLowerCase() || '');
    });
  };

  const show = name => {
    pane.innerHTML = panes[name]();
    if (name === 'people') {
      out.querySelector('#q').oninput = e => drawUsers(e.target.value.toLowerCase());
      drawUsers();
    }
    if (name === 'danger') {
      const input = out.querySelector('#wipeConfirm');
      const btn = out.querySelector('#wipeBtn');
      input.oninput = () => { btn.disabled = input.value !== 'DELETE'; };
      btn.onclick = async () => {
        if (!await confirmDialog(t('admin.wipeAllHint'), { danger: true })) return;
        const r = await api.post('/wipe-all', {});
        api.setToken(r.token);
        await session.refresh();
        modal(`
          <h2>${t('admin.wipeAllDone')}</h2>
          <p class="small muted">${t('admin.wipeNewPasswordHint')}</p>
          <div class="code-value" style="user-select:all">${esc(r.temporaryPassword)}</div>
          <button class="btn btn-primary mt" data-close>${t('common.close')}</button>`);
        router.go('/');
      };
    }
  };

  out.querySelectorAll('[data-atab]').forEach(b => b.onclick = () => {
    out.querySelectorAll('[data-atab]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    show(b.dataset.atab);
  });
  show('overview');
}
