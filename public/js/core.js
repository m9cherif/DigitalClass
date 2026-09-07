/* Client core: i18n, API client, session store, router, small UI helpers. */

/* ------------------------------------------------------------------ i18n */

export const LANGS = { fr: 'Français', en: 'English', ar: 'العربية' };
const RTL = new Set(['ar']);

export const i18n = {
  lang: localStorage.getItem('dc_lang') || 'fr',
  dict: {},

  async load(lang) {
    this.lang = LANGS[lang] ? lang : 'fr';
    const res = await fetch(`/locales/${this.lang}.json`);
    this.dict = await res.json();
    localStorage.setItem('dc_lang', this.lang);
    document.documentElement.lang = this.lang;
    document.documentElement.dir = RTL.has(this.lang) ? 'rtl' : 'ltr';
  },

  /** t('dash.welcome', { name: 'Lina' }) */
  t(key, vars) {
    let s = this.dict[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
    return s;
  },

  get rtl() { return RTL.has(this.lang); },

  /** Pick the caller's language out of an i18n map, falling back to the original. */
  pick(obj, field, fallback) {
    return obj?.i18n?.[this.lang]?.[field] ?? fallback;
  },

  date(iso, opts = { dateStyle: 'medium' }) {
    if (!iso) return '—';
    const locale = { fr: 'fr-FR', en: 'en-GB', ar: 'ar-TN' }[this.lang];
    return new Intl.DateTimeFormat(locale, opts).format(new Date(iso));
  },

  num(n) {
    return new Intl.NumberFormat({ fr: 'fr-FR', en: 'en-GB', ar: 'ar-TN' }[this.lang]).format(n ?? 0);
  }
};
export const t = (k, v) => i18n.t(k, v);

/* ------------------------------------------------------------ API client */

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || 'request_failed');
    this.status = status;
    this.body = body;
  }
}

export const api = {
  token: localStorage.getItem('dc_token') || null,

  setToken(tok) {
    this.token = tok;
    if (tok) localStorage.setItem('dc_token', tok);
    else localStorage.removeItem('dc_token');
  },

  async request(method, path, body) {
    const res = await fetch('/api' + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401 && store.user) session.logout();
      throw new ApiError(res.status, json);
    }
    return json;
  },

  get: (p) => api.request('GET', p),
  post: (p, b) => api.request('POST', p, b),
  patch: (p, b) => api.request('PATCH', p, b),
  del: (p) => api.request('DELETE', p),

  async upload(file) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/upload', {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}` }, body: fd
    });
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    return res.json();
  }
};

/* --------------------------------------------------------------- session */

export const store = {
  user: null, progress: null, badges: [], unread: 0, socket: null
};

export const session = {
  async refresh() {
    if (!api.token) return null;
    try {
      const me = await api.get('/auth/me');
      store.user = me.user;
      store.progress = me.progress;
      store.badges = me.badges;
      store.unread = me.unread;
      if (me.user.lang && me.user.lang !== i18n.lang) await i18n.load(me.user.lang);
      applyTheme(me.user.theme || 'dark');
      return me.user;
    } catch {
      api.setToken(null);
      store.user = null;
      return null;
    }
  },

  async login(email, password) {
    const r = await api.post('/auth/login', { email, password });
    api.setToken(r.token);
    await this.refresh();
    connectSocket();
    return r.user;
  },

  /** Returns { pendingVerification, userId, email } — no session yet until
   *  the emailed code is confirmed via verifyEmail(). */
  async register(payload) {
    return api.post('/auth/register', { ...payload, lang: i18n.lang });
  },

  async verifyEmail(userId, code) {
    const r = await api.post('/auth/verify-email', { userId, code });
    api.setToken(r.token);
    await this.refresh();
    connectSocket();
    return r.user;
  },

  resendOtp(userId) {
    return api.post('/auth/resend-otp', { userId });
  },

  /** Returns { needsRole, name, email } on a first-ever Google sign-in
   *  (nothing created yet — call again with `role` to finish), or logs
   *  straight in and returns the user otherwise. */
  async google(credential, role) {
    const r = await api.post('/auth/google', { credential, role });
    if (r.needsRole) return r;
    api.setToken(r.token);
    await this.refresh();
    connectSocket();
    return r.user;
  },

  logout() {
    api.setToken(null);
    store.user = null;
    store.socket?.disconnect();
    store.socket = null;
    router.go('/login');
  }
};

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('dc_theme', theme);
}

/* -------------------------------------------------------------- realtime */

export function connectSocket() {
  if (store.socket?.connected || !api.token || !window.io) return store.socket;
  store.socket = window.io({ auth: { token: api.token } });
  store.socket.on('connect_error', e => console.warn('socket:', e.message));
  return store.socket;
}

/* ---------------------------------------------------------------- router */

const routes = [];
export const router = {
  add(pattern, handler, opts = {}) {
    // '/courses/:id' -> /^\/courses\/([^/]+)$/
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:([\w]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ rx, keys, handler, ...opts });
  },

  go(path, replace = false) {
    if (replace) history.replaceState({}, '', path);
    else history.pushState({}, '', path);
    this.resolve();
  },

  async resolve() {
    const path = location.pathname;
    const outlet = document.getElementById('outlet');
    for (const r of routes) {
      const m = path.match(r.rx);
      if (!m) continue;
      if (r.auth !== false && !store.user) return this.go('/login', true);
      if (r.roles && !r.roles.includes(store.user?.role)) return this.go('/', true);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      outlet.innerHTML = '<div class="stack"><div class="skeleton"></div><div class="skeleton"></div></div>';
      try {
        await r.handler(params, outlet);
      } catch (err) {
        console.error(err);
        outlet.innerHTML = `<div class="empty-state"><span class="ic">⚠️</span>${
          err.status === 403 ? '403 — ' + t('common.error') : t('common.error')}<div class="small mt">${esc(err.message || '')}</div></div>`;
      }
      window.scrollTo(0, 0);
      document.querySelectorAll('.side-link, .tabbar-link').forEach(a => {
        const href = a.getAttribute('href');
        a.classList.toggle('active', href === path || (href !== '/' && path.startsWith(href)));
      });
      document.querySelector('.sidebar')?.classList.remove('open');
      return;
    }
    outlet.innerHTML = `<div class="empty-state"><span class="ic">🧭</span>404</div>`;
  }
};

/** Intercept in-app links so navigation stays client-side. */
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="/"]');
  if (!a || a.target === '_blank' || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  router.go(a.getAttribute('href'));
});
window.addEventListener('popstate', () => router.resolve());

/* ------------------------------------------------------------ UI helpers */

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function toast(message, kind = '') {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

export function modal(html, { onMount } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal">${html}</div>`;
  back.addEventListener('click', e => { if (e.target === back) close(); });
  const close = () => back.remove();
  document.body.appendChild(back);
  back.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  onMount?.(back.querySelector('.modal'), close);
  return { close, root: back.querySelector('.modal') };
}

export const initials = name => (name || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

export function avatar(user, cls = '') {
  if (!user) return '';
  return user.avatar
    ? `<img class="avatar ${cls}" src="${esc(user.avatar)}" alt="">`
    : `<div class="avatar ${cls}">${esc(initials(user.name))}</div>`;
}

/**
 * Small stroke-style icon set — 24x24, currentColor, 1.6 stroke — replacing
 * emoji in the nav and topbar so they take the accent tint like everything
 * else in the theme instead of rendering as a stray coloured glyph.
 */
const ICON_PATHS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9a1 1 0 0 0 1 1H9a1 1 0 0 0 1-1v-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4a1 1 0 0 0 1 1h2.5a1 1 0 0 0 1-1v-9"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21V5.5Z"/><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20"/>',
  classes: '<rect x="3.5" y="4" width="17" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  party: '<path d="M4 20 15 9"/><path d="m14 4 1 3 3 1-3 1-1 3-1-3-3-1 3-1Z"/><path d="M18 12.5c.6.6.6 1.5 0 2s-1.5.6-2 0"/><circle cx="6" cy="18" r="1.4"/>',
  forum: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7A2.5 2.5 0 0 1 17.5 15H10l-4.5 4v-4h-1A2.5 2.5 0 0 1 2 12.5v0"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>',
  cards: '<rect x="4" y="7" width="13" height="13" rx="2"/><path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4H18a1.5 1.5 0 0 1 1.5 1.5V15a1.5 1.5 0 0 1-1.5 1.5H17"/>',
  review: '<path d="M8 3.5h8v3H8z"/><path d="M6 6h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z"/><path d="m9 13 2 2 4-4.5"/>',
  trophy: '<path d="M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M7 5.5H4.5A1.5 1.5 0 0 0 3 7c0 2 1.3 3.3 3.2 3.5M17 5.5h2.5A1.5 1.5 0 0 1 21 7c0 2-1.3 3.3-3.2 3.5"/><path d="M12 14v3M9 20.5h6M9.5 20.5 10 17h4l.5 3.5"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9.5 3 2.5-3 2.5M13 15h4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .35 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.35 1.7 1.7 0 0 0-1.05 1.57V19.5a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.05-1.57 1.7 1.7 0 0 0-1.87.35l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .35-1.87 1.7 1.7 0 0 0-1.57-1.05H4.5a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 6.16 9.4a1.7 1.7 0 0 0-.35-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 10.5 5.05H10.6a1.7 1.7 0 0 0 1.05-1.57V4.5a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.05 1.57 1.7 1.7 0 0 0 1.87-.35l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.35 1.87v.1a1.7 1.7 0 0 0 1.57 1.05h.09a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.57 1.05Z"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M2.5 19a6.5 6.5 0 0 1 13 0"/><circle cx="17.5" cy="8.5" r="2.5"/><path d="M15 6.2A4 4 0 0 1 21.5 9"/>',
  logout: '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><path d="M14 8l4 4-4 4M18 12H9"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.2 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.2-3.6-8.5S9.6 5.8 12 3.5Z"/>',
  bell: '<path d="M6 9.5a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 13.5 6 9.5Z"/><path d="M10 18.5a2 2 0 0 0 4 0"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v1.6M12 19.4V21M4.9 4.9l1.15 1.15M17.95 17.95l1.15 1.15M3 12h1.6M19.4 12H21M4.9 19.1l1.15-1.15M17.95 6.05l1.15-1.15"/>',
  moon: '<path d="M20 14.2A8.5 8.5 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2Z"/>',
  menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>'
};
export const icon = (name, cls = 'ic') =>
  `<span class="${cls}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
     stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ''}</svg></span>`;

/** Very small Markdown subset — enough for lesson bodies, and it escapes first. */
export function markdown(src) {
  const blocks = [];
  let html = esc(src || '').replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code class="lang-${lang}">${code.replace(/\n$/, '')}</code></pre>`);
    return ` ${blocks.length - 1} `;
  });

  html = html
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Tables
  html = html.replace(/((?:^\|.*\|\s*$\n?)+)/gm, block => {
    const rows = block.trim().split('\n').filter(r => !/^\|[\s|:-]+\|$/.test(r));
    const cells = rows.map(r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
    if (cells.length < 2) return block;
    const head = `<tr>${cells[0].map(c => `<th>${c}</th>`).join('')}</tr>`;
    const body = cells.slice(1).map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  });

  html = html
    .replace(/^(?:\d+\.) (.*)$/gm, '<li>$1</li>')
    .replace(/^[-*] (.*)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>')
    .split(/\n{2,}/).map(p => /^\s*<(h\d|ul|ol|pre|div|blockquote|table)/.test(p) ? p : `<p>${p.trim()}</p>`)
    .join('\n')
    .replace(/ (\d+) /g, (_, i) => blocks[i]);

  return `<div class="markdown">${html}</div>`;
}

export const fmtDuration = sec => {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

export const percentColor = p =>
  p >= 80 ? 'success' : p >= 60 ? 'primary' : p >= 40 ? 'warning' : 'danger';

/** Renders a tiny inline bar chart from [{label, value, max}] rows. */
export function barChart(rows) {
  if (!rows.length) return `<div class="muted small">${t('common.empty')}</div>`;
  const max = Math.max(...rows.map(r => r.max ?? r.value), 1);
  return rows.map(r => `
    <div class="bar-row">
      <span class="muted" title="${esc(r.label)}">${esc(r.label)}</span>
      <span class="bar"><i style="inline-size:${Math.round((r.value / max) * 100)}%${r.color ? `;background:${r.color}` : ''}"></i></span>
      <span class="tiny">${r.display ?? r.value}</span>
    </div>`).join('');
}

export function sparkline(values, format = v => v) {
  if (!values.length) return `<div class="muted small">${t('common.empty')}</div>`;
  const max = Math.max(...values, 1);
  return `<div class="spark">${values.map(v =>
    `<i style="block-size:${Math.max(3, (v / max) * 100)}%" title="${format(v)}"></i>`).join('')}</div>`;
}
