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

  async register(payload) {
    const r = await api.post('/auth/register', { ...payload, lang: i18n.lang });
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
