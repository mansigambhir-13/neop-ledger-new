// The NEOS desk — platform-owned, one for every app (WP §8 "block renderer, My Desk: once, on
// the platform"). The NEOP's concepts come first:
//  · the job is the unit — ask, "on it", steps, waiting, carried out, reported;
//  · the gate and the switchboard — floor, company setting, in force; skills; company rules; caps;
//  · proposals bound to a fingerprint, with a clock, answered once, carried out exactly once;
//  · standing yeses, doors and the key vault, packages and skills, other apps, one audit trail.
// Each app's own screens are its blocks (data, never JavaScript), drawn by the renderer below.
// Nothing here writes to an app's book: a change is an ask; the assistant proposes; a person answers.
// Governance (the platform's rows) is changed directly by admins. The page holds no credential.
'use strict';

// ── helpers ────────────────────────────────────────────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const INR2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
const money = (minor, exact = false) => (minor == null || minor === '' || Number.isNaN(Number(minor)) ? '—' : (exact ? INR2 : INR).format(Number(minor) / 100));
const usd = (n) => `$${Number(n ?? 0).toFixed(Number(n) < 1 ? 3 : 2)}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const day = (d) => (d ? `${Number(String(d).slice(8, 10))} ${MONTHS[Number(String(d).slice(5, 7)) - 1]}` : '—');
const longDay = (d) => (d ? `${day(d)} ${String(d).slice(0, 4)}` : '—');
const monthLabel = (p) => `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
const monthFull = (p) => `${FULL[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
const when = (t) => {
  if (!t) return '—';
  const d = new Date(t);
  return `${day(iso(d))} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const addMonths = (p, n) => {
  const [y, m] = p.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const ago = (t) => {
  if (!t) return '—';
  const s = Math.round((Date.now() - new Date(t).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return day(iso(new Date(t)));
};
const left = (t) => {
  const s = Math.round((new Date(t).getTime() - Date.now()) / 1000);
  if (s <= 0) return 'expired';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min left`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min left`;
  return `${Math.floor(s / 86400)} d ${Math.round((s % 86400) / 3600)} h left`;
};
const plural = (n, w, many = w.endsWith('y') ? `${w.slice(0, -1)}ies` : `${w}s`) => `${n} ${n === 1 ? w : many}`;
const short = (h) => (h ? `${String(h).slice(0, 4)}…${String(h).slice(-4)}` : '—');

// ── icons ──────────────────────────────────────────────────────────────────
const P = {
  home: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  find: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  list: '<path d="M4 6h16M4 12h10M4 18h13"/>',
  swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14.5h2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>',
  rules: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.4 8 9 4.6-.6 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  tax: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 17l6-6M9.5 11.5h.01M14.5 16.5h.01"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.8 1c0 1.7-2.3 2-2.3 3.5M12 17h.01"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9M10 20a2 2 0 0 0 4 0"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.7 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  send: '<path d="m22 2-9.5 9.5M22 2 15 22l-3.5-8.5L3 10z"/>',
  down: '<path d="M12 4v12m0 0-4.5-4.5M12 16l4.5-4.5M5 20h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  arrow: '<path d="m9 6 6 6-6 6"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3"/>',
  jobs: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h6M7 13h10M7 17h4"/>',
  inbox: '<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 5h14l2 8v6H3v-6z"/>',
  book: '<path d="M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-5a3 3 0 0 0-3 3"/><path d="M20 4v14h-6"/>',
  sliders: '<path d="M4 6h8M16 6h4M4 12h2M10 12h10M4 18h12"/><circle cx="14" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  apps: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/><path d="M15 7h6M18 4v6M3 17h8"/>',
  scroll: '<path d="M8 3h11v15a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-2h11v2a3 3 0 0 0 3 3"/><path d="M8 3a3 3 0 0 0-3 3v10M11 8h5M11 12h5"/>',
  fp: '<path d="M12 11c0 3-1 6-3 8M8 8a5 5 0 0 1 9 3c0 2 0 4-1 6M5 12a7 7 0 0 1 12.5-5M12 15c0 2-.5 3.5-1.5 5M16 19c.5-1 .8-2 1-3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
};
const ic = (n, s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] ?? P.book}</svg>`;

// ── state ──────────────────────────────────────────────────────────────────
const S = {
  me: null,
  apps: [], // installed apps: { key, name, subject }
  app: null, // the app the governance pages and subject pages are looking at
  lines: {}, // per app: switchboard lines, skills, doors, version
  blocks: {}, // per app: its blocks
  period: today().slice(0, 7),
  route: ['today'],
  query: new URLSearchParams(),
  pending: [],
  tasks: [],
  conv: sessionStorage.getItem('neos.conv') || null,
  lastMsg: 0,
  es: null,
  seq: 0,
  sig: '',
};
const isAdmin = () => S.me?.role === 'admin';
const appName = (k) => S.apps.find((a) => a.key === k)?.name ?? k;
const L = (app = S.app) => S.lines[app] ?? { abilities: [], skills: [], doors: [], switchboard_version: 0 };
const line = (k, app) => {
  for (const a of app ? [app] : Object.keys(S.lines)) {
    const l = S.lines[a]?.abilities.find((x) => x.key === k);
    if (l) return l;
  }
  return null;
};
const titleOf = (k, app) => line(k, app)?.title ?? k.replace(/^[a-z]+\./, '');

// ── API ────────────────────────────────────────────────────────────────────
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
async function api(path, opts = {}) {
  const init = { method: opts.method ?? 'GET', headers: { 'x-neos-web': '1' } };
  if (opts.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, init).catch(() => null);
  if (!r) throw new ApiError(0, 'offline', 'Cannot reach the server. Check your connection.');
  if (r.status === 401) {
    location.replace('/login');
    throw new ApiError(401, 'unauthenticated', 'Signed out');
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, body.error?.code ?? 'error', body.error?.message ?? `Request failed (${r.status})`);
  return body;
}
const read = async (app, ability, args = {}) => (await api(`/api/apps/${encodeURIComponent(app)}/read/${ability}`, { method: 'POST', body: args })).result;
async function loadLines(app = S.app) {
  if (!app) return L();
  S.lines[app] = await api(`/api/apps/${encodeURIComponent(app)}/abilities`);
  return S.lines[app];
}
async function loadBlocks(app) {
  if (!S.blocks[app]) S.blocks[app] = (await api(`/api/apps/${encodeURIComponent(app)}/blocks`)).blocks ?? {};
  return S.blocks[app];
}

// ── toasts ─────────────────────────────────────────────────────────────────
function toast(text, bad = false) {
  const t = document.createElement('div');
  t.className = `toast${bad ? ' bad' : ''}`;
  t.textContent = text;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), bad ? 7000 : 4200);
}
const fail = (e) => toast(e instanceof ApiError ? e.message : String(e?.message ?? e), true);

// ── layout ─────────────────────────────────────────────────────────────────
const WORK = [['today', 'Today', 'home'], ['jobs', 'Jobs', 'jobs'], ['approvals', 'Approvals', 'inbox']];
const GOVERN = [['switchboard', 'Switchboard', 'sliders'], ['grants', 'Standing yes', 'check'], ['connections', 'Doors', 'key'], ['packages', 'Packages', 'box'], ['apps', 'Apps', 'apps'], ['audit', 'Audit', 'scroll'], ['team', 'Team', 'team']];

function paintRail() {
  const item = ([k, label, i], extra = '') => `<button class="rail-item" data-go="${esc(k)}" title="${esc(label)}">${ic(i, 17)}<span>${esc(label)}</span>${extra}</button>`;
  $('#rail').innerHTML =
    `<h6>WORK</h6>${WORK.map((w) => item(w, w[0] === 'approvals' ? '<i class="dot hidden" id="appr-dot"></i>' : '')).join('')}<div class="sep"></div>` +
    `<h6>APPS</h6>${S.apps.map((a) => item([`app/${a.key}`, a.name, 'book'])).join('')}<div class="sep"></div>` +
    `<h6>GOVERN</h6>${GOVERN.map((g) => item(g)).join('')}` +
    `<div class="grow"></div>${item(['help', 'Help', 'help'])}<button class="avatar" id="me-btn" title="You"></button>`;
  $('#me-btn').onclick = meMenu;
  $('#me-btn').textContent = S.me.name.replace(/\(.*\)/, '').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

function shell() {
  $('#btn-search').innerHTML = ic('find', 17);
  $('#btn-bell').innerHTML = `${ic('bell', 17)}<span class="badge hidden" id="bell-n"></span>`;
  $('#fab').innerHTML = ic('chat', 22);
  $('#chat-x').innerHTML = ic('x', 15);
  $('#chat-ico').innerHTML = ic('sparkle', 16);
  themeIcon();
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (!go) return;
    e.preventDefault();
    if (go.dataset.go === 'help') return help();
    location.hash = `#/${go.dataset.go}`;
  });
  $('#ask-form').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#ask-in').value.trim();
    if (!v) return;
    $('#ask-in').value = '';
    askNeos(v, S.route[0] === 'app' ? S.route[1] : undefined);
  };
  $('#live').onclick = () => (location.hash = '#/jobs');
  $('#btn-search').onclick = openSearch;
  $('#btn-bell').onclick = () => (location.hash = '#/approvals');
  $('#btn-theme').onclick = toggleTheme;
  $('#fab').onclick = () => toggleChat();
  $('#chat-x').onclick = () => toggleChat(false);
  $('#chat-new').onclick = newConversation;
  $('#chat-form').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#chat-in').value.trim();
    if (v) sendAsk(v);
  };
  $('#co').onclick = periodPicker;
  $('#co').setAttribute('role', 'button');
  $('#co').tabIndex = 0;
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '');
    if (e.key === '/' && !typing) {
      e.preventDefault();
      $('#ask-in').focus();
    }
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      openSearch();
    }
    if (e.key === 'Escape') closeLayer();
  });
  window.addEventListener('hashchange', route);
}

function route() {
  const raw = location.hash.replace(/^#\/?/, '') || 'today';
  const [path, q] = raw.split('?');
  S.route = path.split('/').filter(Boolean).map(decodeURIComponent);
  S.query = new URLSearchParams(q ?? '');
  if (!VIEWS[S.route[0]]) S.route = ['today'];
  if (S.route[0] === 'app' && S.apps.some((a) => a.key === S.route[1])) S.app = S.route[1];
  const cur = S.route[0] === 'app' ? `app/${S.route[1]}` : S.route[0];
  for (const b of $$('.rail [data-go]')) {
    if (b.dataset.go === cur) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  render();
}

async function render(quiet = false) {
  const seq = ++S.seq;
  const main = $('#main');
  if (!quiet) {
    main.innerHTML = `<div class="card"><div class="card-b"><br><div class="skel"></div><br><div class="skel"></div><br><div class="skel"></div></div></div>`;
    window.scrollTo(0, 0);
  }
  try {
    const html = await VIEWS[S.route[0]](...S.route.slice(1));
    if (seq !== S.seq) return;
    const y = window.scrollY;
    main.innerHTML = html;
    after(main);
    if (quiet) window.scrollTo(0, y);
  } catch (e) {
    if (seq !== S.seq) return;
    main.innerHTML = `<div class="head"><div><h1>Something went wrong</h1><p>${esc(e.message)}</p></div></div><button class="btn" id="retry">${ic('refresh', 15)} Try again</button>`;
    $('#retry').onclick = () => render();
  }
}
// Handlers bind through markers in their own HTML, so an overtaken view never binds into its successor.
const binders = new Map();
let bindSeq = 0;
const bind = (fn) => {
  const id = ++bindSeq;
  binders.set(id, fn);
  return `<template data-b="${id}"></template>`;
};
function after(root) {
  for (const el of $$('[data-w]', root)) el.style.width = `${Math.max(0, Math.min(100, Number(el.dataset.w)))}%`;
  const ids = $$('template[data-b]', root).map((t) => Number(t.dataset.b));
  for (const id of ids) {
    const fn = binders.get(id);
    binders.delete(id);
    fn?.();
  }
  if (root.id === 'main' && ids.length) for (const id of [...binders.keys()]) if (id < ids[0]) binders.delete(id);
  tickClocks();
}
const head = (title, sub, right = '', live = false) => `<div class="head"><div><h1>${live ? '<i class="live"></i>' : ''}${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="right">${right}</div></div>`;
const empty = (title, text = '') => `<div class="empty"><b>${esc(title)}</b>${esc(text)}</div>`;
const pill = (text, tone = 'gray') => `<span class="pill ${tone}">${esc(text)}</span>`;
const src = (r) => (r?.sources ? `<div class="src">${ic('book', 11)} ${esc(r.sources.basis)} · ${plural(r.sources.entries ?? 0, 'entry')} · generated ${esc(when(r.generatedAt))}${r.empty ? ' · nothing recorded yet' : ''}</div>` : '');
const SETTING = { on: 'Automatic', ask_first: 'Ask first', off: 'Off' };
const settingPill = (s) => pill(SETTING[s] ?? s, s === 'on' ? 'green' : s === 'ask_first' ? 'amber' : 'gray');
// Governance pages look at one app; with several installed, the head carries a switcher.
const appSwitch = (view) =>
  S.apps.length > 1 ? `<span class="toggle">${S.apps.map((a) => `<button data-app-switch="${esc(a.key)}" data-view="${view}" aria-pressed="${a.key === S.app}">${esc(a.name)}</button>`).join('')}</span>` + bind(() => {
    for (const b of $$('[data-app-switch]')) b.onclick = () => ((S.app = b.dataset.appSwitch), render());
  }) : pill(appName(S.app), 'violet');

// ── live state: jobs and the desk ─────────────────────────────────────────
const LIVE = ['OPEN', 'ACKNOWLEDGED', 'WAITING'];
async function refreshLive() {
  try {
    const [{ cards }, { tasks }] = await Promise.all([api('/api/desk'), api('/api/tasks?limit=60')]);
    S.pending = cards.filter((c) => c.status === 'PENDING');
    S.tasks = tasks;
    const n = S.pending.length;
    $('#bell-n').textContent = n;
    $('#bell-n').classList.toggle('hidden', !n);
    $('#appr-dot')?.classList.toggle('hidden', !n);
    const working = tasks.filter((t) => LIVE.includes(t.status));
    $('#live').classList.toggle('on', working.length > 0);
    $('#live-t').textContent = working.length ? `${working.length} working${n ? ` · ${n} for you` : ''}` : n ? `${n} for you` : 'All quiet';
    const sig = JSON.stringify([tasks.slice(0, 20).map((t) => [t.id, t.status, t.steps, t.pending_approvals]), cards.slice(0, 40).map((c) => [c.id, c.status])]);
    if (sig !== S.sig) {
      const first = !S.sig;
      S.sig = sig;
      if (!first && ['today', 'jobs', 'approvals'].includes(S.route[0]) && !$('#layer').children.length && !$('.prop textarea:not(.hidden)')) render(true);
    }
  } catch {
    /* the next tick retries */
  }
}

// ── the job lifecycle (WP §3, §5) ──────────────────────────────────────────
function stages(t, approvals) {
  const pend = approvals ? approvals.filter((a) => a.status === 'PENDING').length : Number(t.pending_approvals ?? 0);
  const had = approvals ? approvals.length > 0 : pend > 0 || t.status === 'WAITING';
  const executed = (approvals ?? []).filter((a) => a.status === 'EXECUTED');
  const outcome = executed.some((a) => a.proof?.outcome === 'FAILED') ? 'bad' : executed.some((a) => a.proof?.outcome === 'UNKNOWN') ? 'now' : executed.length ? 'done' : '';
  const end = t.status === 'COMPLETED' ? 'done' : ['FAILED', 'CANCELLED'].includes(t.status) ? 'bad' : '';
  const st = [
    ['Asked', 'done'],
    ['On it', t.status === 'OPEN' ? 'now' : 'done'],
    ['Working', t.status === 'OPEN' ? '' : end || had ? 'done' : 'now'],
  ];
  if (had) {
    st.push(['Waiting on you', pend ? 'now wait' : 'done']);
    const answeredNo = approvals && !pend && !executed.length && approvals.every((a) => (a.decision && a.decision !== 'yes') || a.status === 'EXPIRED');
    if (answeredNo) st.push(['Nothing carried out', 'done']);
    else st.push(['Carried out', outcome || (!pend && (end === 'done' || (approvals && t.status === 'ACKNOWLEDGED' && executed.length)) ? 'done' : '')]);
  }
  st.push([t.status === 'CANCELLED' ? 'Cancelled' : t.status === 'FAILED' ? 'Failed' : 'Reported', end || (had && !pend && t.status === 'ACKNOWLEDGED' ? 'now' : '')]);
  return st;
}
const stepper = (t, approvals) =>
  `<div class="stepper">${stages(t, approvals)
    .map(([label, cls], i, a) => `<span class="st ${cls}"><i>${cls === 'done' ? ic('check', 11) : cls === 'bad' ? ic('x', 11) : ''}</i>${esc(label)}</span>${i < a.length - 1 ? `<span class="ln ${cls === 'done' ? 'done' : ''}"></span>` : ''}`)
    .join('')}</div>`;
const STATUS = { COMPLETED: ['reported', 'green'], FAILED: ['failed', 'red'], CANCELLED: ['cancelled', 'gray'], ACKNOWLEDGED: ['working', 'blue'], OPEN: ['received', 'gray'], WAITING: ['waiting on you', 'amber'] };
const statusPill = (s) => pill(...(STATUS[s] ?? [String(s).toLowerCase(), 'gray']));
const who = (req) => (String(req).startsWith('app:') ? `the ${appName(req.slice(4))} app` : String(req).startsWith('user:') ? (req.slice(5) === S.me.id ? 'you' : 'a colleague') : req);

// ── asking: the one way anything changes an app's book ────────────────────
// Without an app, NeuralChat picks the right one from the registry (user flow step 3).
function askNeos(text, app) {
  toggleChat(true);
  return sendAsk(text, app);
}
async function sendAsk(text, app) {
  $('#chat-in').value = '';
  $('#chat-sugg').innerHTML = '';
  addMsg({ author: `user:${S.me.id}`, kind: 'message', body: text });
  typing(true);
  try {
    const r = await api('/api/ask', { method: 'POST', body: { text, ...(app ? { app } : {}), conversation_id: S.conv ?? undefined } });
    if (r.conversation_id && r.conversation_id !== S.conv) {
      S.conv = r.conversation_id;
      sessionStorage.setItem('neos.conv', S.conv);
      S.lastMsg = 0;
    }
    stream();
    refreshLive();
    return r;
  } catch (e) {
    typing(false);
    addMsg({ author: 'system', kind: 'notice', body: e.message });
    throw e;
  }
}
function toggleChat(force) {
  const c = $('#chat');
  const open = force ?? c.classList.contains('hidden');
  c.classList.toggle('hidden', !open);
  if (open) {
    if (!$('#chat-log').children.length) greet();
    if (S.conv && !S.es) stream();
    setTimeout(() => $('#chat-in').focus(), 30);
  }
}
function greet() {
  $('#chat-log').innerHTML = '';
  addMsg({ author: 'app:neos', kind: 'message', body: `Hi ${S.me.name.split(' ')[0]}. Ask for anything — NEOS hands it to the right app (${S.apps.map((a) => a.name).join(', ')}). Each ask becomes a job; anything that changes the books or leaves the company waits for your yes, and a yes covers exactly what you saw.` });
}
function newConversation() {
  S.es?.close();
  S.es = null;
  S.conv = null;
  S.lastMsg = 0;
  sessionStorage.removeItem('neos.conv');
  greet();
}
function typing(on) {
  $('#chat-typing')?.remove();
  if (!on) return;
  const d = document.createElement('div');
  d.id = 'chat-typing';
  d.className = 'msg them';
  d.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  $('#chat-log').append(d);
  $('#chat-log').scrollTop = 1e9;
}
function addMsg(m) {
  const d = document.createElement('div');
  const mine = String(m.author).startsWith('user:');
  let cls = mine ? 'me' : 'them';
  if (['ack', 'handoff', 'notice', 'waiting'].includes(m.kind)) cls = 'sys';
  if (m.kind === 'result') cls = `them result${/fail|could not|couldn't|stopped/i.test(m.body) ? ' failed' : ''}`;
  d.className = `msg ${cls}`;
  d.textContent = m.body;
  if (m.task_id && (m.kind === 'result' || m.kind === 'ack')) {
    const a = document.createElement('a');
    a.href = `#/jobs/${m.task_id}`;
    a.className = 'note';
    a.textContent = m.kind === 'ack' ? ' · watch this job' : ' · see the record';
    d.append(a);
  }
  $('#chat-typing')?.remove();
  $('#chat-log').append(d);
  // Same answer from anywhere (WP §5): a card raised in the conversation can be answered here.
  if ((m.kind === 'card' || m.kind === 'waiting') && m.task_id) inlineCards(m.task_id);
  $('#chat-log').scrollTop = 1e9;
}
async function inlineCards(taskId) {
  try {
    const { cards } = await api('/api/desk');
    for (const c of cards.filter((x) => x.task_id === taskId && x.status === 'PENDING')) {
      if ($(`#chat-log [data-card="${c.id}"]`)) continue;
      const w = document.createElement('div');
      w.className = 'msg them card';
      w.innerHTML = cardHtml(c, { compact: true });
      $('#chat-log').append(w);
      bindCards([c], w);
    }
    $('#chat-log').scrollTop = 1e9;
  } catch {
    /* the desk still has it */
  }
}
function stream() {
  if (!S.conv) return;
  S.es?.close();
  const es = new EventSource(`/api/conversations/${encodeURIComponent(S.conv)}/events?after=${S.lastMsg}`);
  S.es = es;
  const on = (ev) => {
    const m = JSON.parse(ev.data);
    if (!m.id || Number(m.id) <= S.lastMsg) return;
    S.lastMsg = Number(m.id);
    if (String(m.author).startsWith('user:')) return;
    addMsg(m);
    if (m.kind === 'ack' || m.kind === 'handoff') typing(true);
    refreshLive();
  };
  for (const k of ['message', 'handoff', 'ack', 'waiting', 'card', 'result', 'notice']) es.addEventListener(k, on);
  es.onerror = () => {
    es.close();
    if (S.es === es) S.es = null;
    setTimeout(() => S.conv && !S.es && stream(), 3000);
  };
}

// ── proposals: exact content, a fingerprint, a clock (WP §5) ──────────────
function argsChips(a) {
  const chips = [];
  for (const k of ['customer', 'vendor', 'document_number', 'number', 'code', 'name', 'pattern', 'period', 'to']) if (a[k] && typeof a[k] !== 'object') chips.push(k === 'to' ? `to ${a[k]}` : String(a[k]));
  if (a.month) chips.push(monthLabel(String(a.month).slice(0, 7)));
  if (a.amount_minor != null) chips.push(money(a.amount_minor, true));
  else if (Array.isArray(a.lines) && a.lines[0]?.amount_minor != null) chips.push(`${money(a.lines.reduce((s, l) => s + Number(l.amount_minor || 0), 0), true)}${a.gst_rate_bps ? ` + GST ${a.gst_rate_bps / 100}%` : ''}`);
  if (a.account_code) chips.push(`→ ${a.account_code}`);
  return chips.slice(0, 5);
}
function cardHtml(c, { compact = false } = {}) {
  const card = c.card ?? {};
  const l = line(c.ability_key, c.app_key);
  const canGrant = isAdmin() && l?.kind === 'write';
  const shownArgs = Object.fromEntries(Object.entries(c.args ?? {}).filter(([k]) => k !== 'card'));
  return `<article class="prop" data-card="${esc(c.id)}">
    <div class="chips"><span class="chip">${ic('bolt', 13)} ${esc(appName(c.app_key))} · ${esc(titleOf(c.ability_key, c.app_key))}</span>${l?.effects?.external ? pill('leaves the company', 'violet') : ''}${l?.effects?.money ? pill('money', 'amber') : ''}
      ${argsChips(c.args ?? {}).map((x) => `<span class="chip">${esc(x)}</span>`).join('')}
      <span class="conf">${c.expires_at ? `<span class="clock" data-exp="${esc(c.expires_at)}">${ic('clock', 12)}<span> ${esc(left(c.expires_at))}</span></span>` : ''}</span></div>
    <h4>${esc(card.what ?? titleOf(c.ability_key, c.app_key))}</h4>
    ${compact ? '' : `<dl>${card.why ? `<dt>Why</dt><dd>${esc(card.why)}</dd>` : ''}${card.changes ? `<dt>What changes</dt><dd>${esc(card.changes)}</dd>` : ''}${card.if_no_answer ? `<dt>If nobody answers</dt><dd>${esc(card.if_no_answer)}</dd>` : ''}${c.task_ask ? `<dt>From the job</dt><dd><a href="#/jobs/${esc(c.task_id)}">${esc(c.task_ask)}</a></dd>` : ''}</dl>`}
    <details><summary class="note">Exactly what you are approving</summary><pre class="mono">${esc(JSON.stringify(shownArgs, null, 2))}</pre></details>
    <textarea class="i hidden" rows="2" placeholder="What should change? The app writes a new proposal; this one is superseded."></textarea>
    <div class="foot">
      <span class="fp" title="A yes binds to this fingerprint. If the proposal changes, it must be asked again.">${ic('fp', 12)} ${esc(short(c.fingerprint))}</span>
      <span class="bind">your yes covers exactly this version</span><span class="grow"></span>
      <button class="btn sm" data-a="no">Decline</button>
      <button class="btn sm" data-a="change">Change first</button>
      ${canGrant && !compact ? `<button class="btn sm" data-a="always" title="Approve, and let the app do this within limits without asking">Approve &amp; always allow…</button>` : ''}
      <button class="btn sm lime" data-a="yes">${ic('check', 14)} Approve</button>
    </div>
  </article>`;
}
function bindCards(cards, root = document) {
  for (const el of $$('[data-card]', root)) {
    const c = cards.find((x) => x.id === el.dataset.card);
    if (!c) continue;
    for (const b of $$('[data-a]', el)) {
      b.onclick = async () => {
        const decision = b.dataset.a;
        if (decision === 'always') return grantForm({ app: c.app_key, ability_key: c.ability_key, args: c.args, card: c });
        const ta = $('textarea', el);
        if (decision === 'change' && ta.classList.contains('hidden')) {
          ta.classList.remove('hidden');
          ta.focus();
          b.textContent = 'Send change';
          return;
        }
        if (decision === 'change' && !ta.value.trim()) return toast('Say what should change.', true);
        for (const x of $$('button', el)) x.disabled = true;
        try {
          await answer(c, decision, ta.value.trim());
          el.closest('.msg')?.remove();
          setTimeout(() => render(true), 700);
        } catch (e) {
          for (const x of $$('button', el)) x.disabled = false;
          fail(e);
          if (e.code === 'stale_fingerprint') render(true);
        }
      };
    }
  }
}
async function answer(c, decision, feedback = '') {
  await api(`/api/desk/${encodeURIComponent(c.id)}/answer`, { method: 'POST', body: { decision, fingerprint_seen: c.fingerprint, ...(decision === 'change' ? { feedback } : {}) } });
  toast(decision === 'yes' ? 'Approved. The app carries it out once, reads it back, then reports.' : decision === 'no' ? 'Declined. Nothing changed.' : 'Sent back. A new proposal will follow.');
  await refreshLive();
}
function outcomePill(a) {
  if (a.status === 'PENDING') return pill('waiting on you', 'amber');
  if (a.status === 'RECORDED' || a.status === 'RESOLVED') return pill('carrying out', 'blue');
  if (a.status === 'EXECUTED') {
    const o = a.proof?.outcome;
    if (o === 'DONE') return pill(a.proof?.read_back ? 'done · verified' : 'done', 'green');
    if (o === 'UNKNOWN') return pill('checking whether it happened', 'amber');
    if (o === 'FAILED') return pill('failed', 'red');
    return pill('done', 'green');
  }
  if (a.status === 'CLOSED') return pill(a.decision === 'no' ? 'declined' : a.decision === 'change' ? 'superseded by a new proposal' : a.decision === 'withdraw' ? 'withdrawn' : 'closed', 'gray');
  if (a.status === 'EXPIRED') return pill('expired · nothing done', 'gray');
  if (a.status === 'REFUSED') return pill('refused at carry-out', 'red');
  return pill(String(a.status).toLowerCase());
}
function tickClocks() {
  for (const el of $$('[data-exp]')) {
    const span = el.lastElementChild;
    if (span) span.textContent = ` ${left(el.dataset.exp)}`;
    el.classList.toggle('late', new Date(el.dataset.exp).getTime() - Date.now() < 3600e3);
  }
}

// ══ THE BLOCK RENDERER — one for every app (WP §8, §13) ════════════════════
// Blocks are validated data (packages/contracts/src/blocks.ts): sources are reads, the only
// effect is an ask, strings are text. Everything below escapes what it draws.
function params() {
  const p = S.period;
  const [y, m] = p.split('-').map(Number);
  const q0 = Math.floor((m - 1) / 3) * 3 + 1;
  return {
    today: today(),
    today_plus_30: iso(new Date(Date.now() + 30 * 864e5)),
    month: p,
    month_label: monthFull(p),
    month_from: `${p}-01`,
    month_to: iso(new Date(y, m, 0)),
    quarter_from: `${y}-${pad(q0)}-01`,
    quarter_to: iso(new Date(y, q0 + 2, 0)),
    quarter_label: `${MONTHS[q0 - 1]}–${MONTHS[q0 + 1]} ${y}`,
    company: S.me.company?.name ?? '',
  };
}
const ptr = (obj, p) => (p === '' || p == null ? obj : String(p).split('/').slice(1).reduce((o, k) => (o == null ? undefined : o[k.replace(/~1/g, '/').replace(/~0/g, '~')]), obj));
const dot = (obj, p) => String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const FILTERS = {
  money: (v) => money(v),
  money_exact: (v) => money(v, true),
  rupees: (v) => (v == null ? '' : (Number(v) / 100).toFixed(2)),
  inr: (v) => (v === '' || v == null ? '' : money(Math.round(Number(v) * 100), true)),
  date: (v) => longDay(v),
  month: (v) => (v ? monthLabel(String(v)) : ''),
};
const truthy = (v) => !(v == null || v === false || v === '' || v === 0 || (Array.isArray(v) && !v.length));
/** Mustache-like templates: {{a.b|filter}}, {{#a}}…{{/a}} (if), {{^a}}…{{/a}} (unless). Output is text. */
function tpl(s, ctx) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (let guard = 0; guard < 20; guard++) {
    const m = /\{\{([#^])([\w.]+)\}\}([\s\S]*?)\{\{\/\2\}\}/.exec(out);
    if (!m) break;
    const on = truthy(dot(ctx, m[2]));
    out = out.slice(0, m.index) + ((m[1] === '#') === on ? m[3] : '') + out.slice(m.index + m[0].length);
  }
  return out.replace(/\{\{([\w.]+)(?:\|(\w+))?\}\}/g, (_, k, f) => {
    const v = dot(ctx, k);
    return f && FILTERS[f] ? FILTERS[f](v) : v == null ? '' : String(v);
  });
}
const argsOf = (source, ctx) => Object.fromEntries(Object.entries(source.args ?? {}).map(([k, v]) => [k, typeof v === 'string' ? tpl(v, ctx) : v]));
function fmt(v, f) {
  if (v == null || v === '') return '—';
  switch (f) {
    case 'money_minor':
      return money(v);
    case 'money_minor_exact':
      return money(v, true);
    case 'signed_money_minor':
      return `<span class="num ${v > 0 ? 'pos' : 'neg'}">${v > 0 ? '+' : v < 0 ? '−' : ''}${money(Math.abs(v), true)}</span>`;
    case 'date':
      return esc(longDay(v));
    case 'datetime':
      return esc(when(v));
    case 'month':
      return esc(monthLabel(String(v)));
    case 'number':
      return esc(Number(v).toLocaleString('en-IN'));
    case 'days':
      return Number(v) > 0 ? esc(`${v} d`) : '—';
    default:
      return esc(String(v));
  }
}
// One reader per render: the same source is read once even if several blocks show it.
function reader(app) {
  const cache = new Map();
  return (source, ctx) => {
    const args = argsOf(source, ctx);
    const key = `${source.ability}:${JSON.stringify(args)}`;
    if (!cache.has(key)) cache.set(key, read(app, source.ability, args));
    return cache.get(key);
  };
}
const TONE = { green: 'c-green', red: 'c-red', amber: 'c-orange', violet: 'c-violet', blue: 'c-blue', teal: 'c-teal', gray: '', dark: '' };
const actionVisible = (a, row) => [a.when ?? []].flat().every((p) => truthy(ptr(row, p))) && [a.unless ?? []].flat().every((p) => !truthy(ptr(row, p)));

/** Draw one block. ctx: params (+ row when opened from a row). Returns HTML (with binders). */
async function block(app, b, ctx, R) {
  if (!b) return '';
  const title = b.title ? tpl(b.title, ctx) : '';
  const cardHead = (t, extra = '') => (t ? `<div class="card-h"><h3>${esc(t)}</h3>${extra}</div>` : '');
  try {
    switch (b.block) {
      case 'page': {
        const kids = await Promise.all(b.children.map((c) => block(app, c, ctx, R)));
        return head(tpl(b.title, ctx), esc(tpl(b.description ?? '', ctx)), `${(b.params ?? []).length ? `<button class="btn" data-pp>${ic('calendar', 15)} ${esc(b.params.includes('quarter') ? ctx.quarter_label : monthLabel(ctx.month))}</button>` : ''}${actionsHtml(app, b.actions ?? [], ctx)}`) + kids.join('') + bind(() => {
          for (const x of $$('[data-pp]')) x.onclick = periodPicker;
        });
      }
      case 'stats':
      case 'stat': {
        const items = b.block === 'stat' ? [{ ...b, title: b.title }] : b.items;
        const cells = await Promise.all(
          items.map(async (it) => {
            const s = it.source ?? b.source;
            const data = await R(s, ctx);
            const v = ptr(data, it.value.path);
            const shown = v == null && it.empty_text ? esc(it.empty_text) : fmt(v, it.value.format);
            const link = it.link ? `#/app/${encodeURIComponent(app)}/${encodeURIComponent(it.link)}` : null;
            return `<div class="card kpi">${link ? `<a href="${link}" class="well ${TONE[it.tone] ?? ''}">${shown}</a>` : `<div class="well ${TONE[it.tone] ?? ''}">${shown}</div>`}<div class="lbl">${esc(tpl(it.title, ctx))}</div>${it.sub ? `<div class="sub">${esc(tpl(it.sub, { ...ctx, ...data }))}</div>` : ''}${src(data)}</div>`;
          }),
        );
        return `${title ? `<h3 class="blk-title">${esc(title)}</h3>` : ''}<div class="grid g${Math.min(cells.length, 4)}">${cells.join('')}</div>`;
      }
      case 'table': {
        const data = await R(b.source, ctx);
        const rows = ptr(data, b.rows) ?? [];
        const acts = b.row_actions ?? [];
        const id = `t${++bindSeq}`;
        const cell = (c, r) => {
          const raw = c.template ? tpl(c.template, { ...ctx, row: r }) : ptr(r, c.path);
          if (c.pill) return raw == null || raw === '' ? '—' : pill(String(raw), c.pill[String(raw)] ?? 'gray');
          const h = c.template ? esc(raw) : fmt(raw, c.format);
          return c.strong ? `<b>${h}</b>` : h;
        };
        return `<div class="card">${cardHead(title, `<span class="count">${rows.length}</span>`)}${
          rows.length
            ? `<table class="t" id="${id}"><thead><tr>${b.columns.map((c) => `<th${c.align === 'right' ? ' class="r"' : c.hide_small ? ' class="hide-sm"' : ''}>${esc(c.label)}</th>`).join('')}${acts.length ? '<th></th>' : ''}</tr></thead><tbody>${rows
                .map((r, i) => `<tr>${b.columns.map((c) => `<td class="${c.align === 'right' ? 'r num' : ''}${c.hide_small ? ' hide-sm' : ''}">${cell(c, r)}</td>`).join('')}${acts.length ? `<td class="r">${acts.map((a, j) => (actionVisible(a, r) ? `<button class="btn sm${a.style === 'primary' ? ' lime' : a.style === 'danger' ? ' danger' : ''}" data-ra="${i}:${j}">${esc(tpl(a.label, { ...ctx, row: r }))}</button>` : '')).join(' ')}</td>` : ''}</tr>`)
                .join('')}</tbody></table>`
            : `<div class="card-b">${empty(tpl(b.empty_text ?? 'Nothing here', ctx))}</div>`
        }<div class="card-b">${b.summary ? `<p class="note">${esc(tpl(b.summary, { ...ctx, ...data }))}</p>` : ''}${src(data)}</div></div>` +
          bind(() => {
            for (const btn of $$(`#${id} [data-ra]`)) {
              const [i, j] = btn.dataset.ra.split(':').map(Number);
              btn.onclick = () => runAction(app, acts[j], { ...ctx, row: rows[i] });
            }
          });
      }
      case 'statement': {
        const data = await R(b.source, ctx);
        const body = b.sections
          .map((s) => `<tr class="section"><td colspan="2">${esc(s.label)}</td></tr>${(ptr(data, s.rows) ?? []).map((r) => `<tr><td>${esc(tpl(s.label_template, r))}</td><td class="r num">${fmt(ptr(r, s.amount), 'money_minor_exact')}</td></tr>`).join('')}`)
          .join('');
        const totals = b.totals.map((t) => `<tr class="strong"><td>${esc(t.label)}</td><td class="r num">${fmt(ptr(data, t.path), 'money_minor_exact')}</td></tr>`).join('');
        return `<div class="card">${cardHead(title)}<table class="t"><tbody>${body}${totals}</tbody></table><div class="card-b">${src(data)}</div></div>`;
      }
      case 'kv': {
        const data = await R(b.source, ctx);
        return `<div class="card">${cardHead(title)}<div class="card-b">${b.items.map((x) => `<div class="kv"><span>${esc(x.label)}</span>${x.strong ? `<b>${fmt(ptr(data, x.path), x.format)}</b>` : `<b>${fmt(ptr(data, x.path), x.format)}</b>`}</div>`).join('')}${src(data)}</div></div>`;
      }
      case 'checklist': {
        const data = await R(b.source, ctx);
        const rows = ptr(data, b.rows) ?? [];
        const n = rows.filter((r) => ptr(r, b.item.ok)).length;
        return `<div class="card checklist">${cardHead(title, `<span class="count">${n} of ${rows.length}</span>`)}${rows
          .map((r) => {
            const ok = truthy(ptr(r, b.item.ok));
            const link = b.item.link ? ptr(r, b.item.link) : null;
            return `<div class="row${ok ? ' done' : ''}"><span class="box${ok ? ' on' : ''}">${ok ? ic('check', 13) : ''}</span><div><b>${esc(ptr(r, b.item.title))}</b><span>${esc(b.item.detail ? ptr(r, b.item.detail) : '')}</span></div>${link && !ok ? `<span class="right"><a class="btn sm" href="#/app/${encodeURIComponent(app)}/${encodeURIComponent(link)}">Fix</a></span>` : ''}</div>`;
          })
          .join('')}<div class="card-b">${src(data)}</div></div>`;
      }
      case 'list': {
        const f = b.source.filter ?? {};
        const cards = S.pending.filter((c) => Object.entries(f).every(([k, v]) => String(c[k]) === String(v)));
        return `<div class="card">${cardHead(title, `<span class="count">${cards.length}</span>`)}<div class="card-b">${cards.length ? cards.map((c) => cardHtml(c)).join('') : empty('Nothing waiting')}</div></div>` + bind(() => bindCards(cards));
      }
      case 'tiles': {
        const id = `ti${++bindSeq}`;
        return `<div class="grid g3" id="${id}">${b.items.map((t, i) => `<button class="report-tile" data-tile="${i}"><span class="ico lime">${ic(t.icon ?? 'chart', 18)}</span><h4>${esc(tpl(t.title, ctx))}</h4><p>${esc(tpl(t.description ?? '', ctx))}</p><span class="open">${ic('arrow', 12)} Open</span></button>`).join('')}</div>` +
          bind(() => {
            for (const x of $$(`#${id} [data-tile]`)) {
              const t = b.items[Number(x.dataset.tile)];
              x.onclick = () => (t.open ? openBlock(app, t.open, ctx) : (location.hash = `#/app/${encodeURIComponent(app)}/${encodeURIComponent(t.page)}`));
            }
          });
      }
      case 'form':
        return '';
    }
  } catch (e) {
    return `<div class="card"><div class="card-b"><div class="err">${esc(title || b.block)}: ${esc(e.message)}</div></div></div>`;
  }
  return '';
}
function actionsHtml(app, actions, ctx) {
  if (!actions.length) return '';
  const id = `a${++bindSeq}`;
  return `<span id="${id}">${actions.map((a, i) => `<button class="btn${a.style === 'primary' ? ' lime' : a.style === 'danger' ? ' danger' : ''}" data-act="${i}">${esc(tpl(a.label, ctx))}</button>`).join(' ')}</span>` + bind(() => {
    for (const x of $$(`#${id} [data-act]`)) x.onclick = () => runAction(app, actions[Number(x.dataset.act)], ctx);
  });
}
async function runAction(app, a, ctx) {
  if (a.ask) return askNeos(tpl(a.ask, ctx), app);
  if (a.form) return openForm(app, a.form, ctx);
  if (a.open) return openBlock(app, a.open, ctx);
  if (a.page) location.hash = `#/app/${encodeURIComponent(app)}/${encodeURIComponent(a.page)}`;
}
async function openBlock(app, key, ctx) {
  const blocks = await loadBlocks(app);
  const b = blocks[key];
  modal(tpl(b?.title ?? key, ctx), '<div class="skel"></div>', '', true);
  const html = await block(app, { ...b, title: undefined }, ctx, reader(app));
  const mb = $('.modal .mb');
  if (!mb) return;
  mb.innerHTML = html;
  after(mb);
}
async function optionsFor(app, f, ctx, R) {
  if (f.options) return f.options.map((o) => ({ value: tpl(o.value, ctx), label: tpl(o.label, ctx) }));
  if (!f.options_source) return [];
  const data = await R(f.options_source.source, ctx);
  return (ptr(data, f.options_source.rows) ?? []).map((r) => ({ value: tpl(f.options_source.value, r), label: tpl(f.options_source.label, r) }));
}
async function fieldHtml(app, f, ctx, R, name = f.name, withLabel = true, inRepeat = false) {
  const req = f.required ? ' required' : '';
  const def = f.default != null ? tpl(f.default, ctx) : '';
  const lbl = withLabel ? `<label class="f" for="f_${esc(name)}">${esc(f.label)}</label>` : '';
  const common = `class="i" id="f_${esc(name)}" name="${esc(name)}"${req}${f.pattern ? ` pattern="${esc(f.pattern)}"` : ''}${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}`;
  switch (f.type) {
    case 'textarea':
      return `${lbl}<textarea ${common} rows="5">${esc(def)}</textarea>`;
    case 'select': {
      const opts = await optionsFor(app, f, ctx, R);
      // In a repeated line a select starts on its first real option; a line counts only when typed into.
      return `${lbl}<select ${common}>${f.required || inRepeat ? '' : '<option value=""></option>'}${opts.map((o) => `<option value="${esc(o.value)}"${o.value === def ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    }
    case 'checkbox':
      return `<label class="f"><input type="checkbox" name="${esc(name)}" value="1"${def ? ' checked' : ''}> ${esc(f.label)}</label>`;
    case 'money':
      return `${lbl}<input ${common} type="number" min="0.01" step="0.01" value="${esc(def)}">`;
    case 'number':
      return `${lbl}<input ${common} type="number"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''} value="${esc(def)}">`;
    default:
      return `${lbl}<input ${common} type="${f.type === 'email' ? 'email' : f.type === 'date' ? 'date' : 'text'}" value="${esc(def)}">`;
  }
}
/** A form turns into ONE sentence to the app's assistant; the gate decides what happens next. */
async function openForm(app, key, ctx) {
  const f = (await loadBlocks(app))[key];
  if (!f) return toast(`No form ${key}`, true);
  const R = reader(app);
  modal(tpl(f.title, ctx), '<div class="skel"></div>', `<span class="grow">This becomes a job. ${esc(appName(app))} prepares it; the gate decides whether it waits for your yes.</span><button class="btn" id="fc">Cancel</button><button class="btn lime" id="fs">${esc(f.submit_label ?? 'Ask')}</button>`);
  const fields = (await Promise.all(f.fields.map((x) => fieldHtml(app, x, ctx, R)))).join('');
  let rep = '';
  if (f.repeat) {
    const rows = [];
    for (let i = 0; i < f.repeat.count; i++) rows.push(`<div class="repeat-row">${(await Promise.all(f.repeat.fields.map((x) => fieldHtml(app, { ...x, required: false }, ctx, R, `${f.repeat.name}_${i}_${x.name}`, i === 0, true)))).join('')}</div>`);
    rep = `<div class="repeat cols-${f.repeat.fields.length}">${rows.join('')}</div>`;
  }
  const mb = $('.modal .mb');
  if (!mb) return;
  mb.innerHTML = `${f.description ? `<p class="muted">${esc(tpl(f.description, ctx))}</p>` : ''}<form id="bf">${fields}${rep}</form>`;
  $('#fc').onclick = closeLayer;
  const submit = (e) => {
    e?.preventDefault();
    const form = $('#bf');
    if (!form.reportValidity()) return;
    const d = new FormData(form);
    const values = {};
    for (const x of f.fields) values[x.name] = x.type === 'checkbox' ? (d.get(x.name) ? '1' : '') : String(d.get(x.name) ?? '').trim();
    if (f.repeat) {
      const lines = [];
      for (let i = 0; i < f.repeat.count; i++) {
        const lv = Object.fromEntries(f.repeat.fields.map((x) => [x.name, String(d.get(`${f.repeat.name}_${i}_${x.name}`) ?? '').trim()]));
        // A line counts when any typed-in field is filled (selects always carry a value).
        if (f.repeat.fields.some((x) => x.type !== 'select' && lv[x.name])) lines.push(tpl(f.repeat.template, lv));
      }
      if (lines.length < (f.repeat.min ?? 1)) return toast(`Fill in at least ${f.repeat.min ?? 1} line${(f.repeat.min ?? 1) > 1 ? 's' : ''}.`, true);
      values[f.repeat.name] = lines.join(f.repeat.join ?? '; ');
    }
    const text = tpl(f.ask, { ...ctx, ...values });
    closeLayer();
    askNeos(text, app);
  };
  $('#fs').onclick = submit;
  $('#bf').onsubmit = submit;
  setTimeout(() => $('#bf input, #bf select, #bf textarea')?.focus(), 20);
}

// ── views ──────────────────────────────────────────────────────────────────
const VIEWS = {};

// An app's own screens: its page blocks, in nav order, drawn by the renderer.
VIEWS.app = async (key, pageKey) => {
  const app = S.apps.find((a) => a.key === key) ? key : S.apps[0]?.key;
  if (!app) return head('No apps', 'Nothing is installed for your company yet.');
  S.app = app;
  const blocks = await loadBlocks(app);
  const pages = Object.entries(blocks).filter(([, b]) => b.block === 'page').sort((a, b) => (a[1].nav?.order ?? 99) - (b[1].nav?.order ?? 99));
  if (!pages.length) return head(appName(app), 'This app has no screens yet. Ask it anything from the bar at the top.');
  const [cur, page] = pages.find(([k]) => k === pageKey) ?? pages[0];
  const nav = `<div class="seg books-nav">${pages.map(([k, b]) => `<button data-page="${esc(k)}" aria-pressed="${k === cur}">${esc(b.nav?.label ?? b.title)}</button>`).join('')}</div>`;
  return nav + (await block(app, page, params(), reader(app))) + bind(() => {
    for (const b of $$('[data-page]')) b.onclick = () => (location.hash = `#/app/${encodeURIComponent(app)}/${encodeURIComponent(b.dataset.page)}`);
  });
};

VIEWS.today = async () => {
  const [usage, grants, vault] = await Promise.all([api(`/api/usage/${S.app}`), api('/api/grants'), isAdmin() ? api('/api/vault').catch(() => null) : null, refreshLive(), loadLines()]);
  const working = S.tasks.filter((x) => LIVE.includes(x.status));
  const finished = S.tasks.filter((x) => !LIVE.includes(x.status)).slice(0, 4);
  const askFirst = L().abilities.filter((l) => l.kind === 'write' && l.setting === 'ask_first').length;
  const activeGrants = grants.grants.filter((g) => g.status === 'ACTIVE' && !g.expired);
  const doors = vaultDoors(vault, S.app);
  const first = S.me.name.replace(/\(.*\)/, '').trim().split(' ')[0];
  const hr = new Date().getHours();
  // Each installed app contributes its `home` block (WP §13 home.tile).
  const homes = await Promise.all(
    S.apps.map(async (a) => {
      const b = (await loadBlocks(a.key)).home;
      return b ? `<h3 class="blk-title"><a href="#/app/${esc(a.key)}">${esc(a.name)}</a></h3>${await block(a.key, { ...b, title: undefined }, params(), reader(a.key))}` : '';
    }),
  );
  return (
    `<div class="card hero"><h2>Good ${hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : 'evening'}, ${esc(first)}</h2>
      <p>Ask for anything — NEOS hands it to the right app (${esc(S.apps.map((a) => a.name).join(', '))}). Each ask becomes a job, worked step by step; anything that changes the books or leaves the company waits for your yes.</p>
      <form id="hero-f" autocomplete="off"><input class="i" id="hero-in" placeholder="e.g. “record the Kapoor Traders payment” · “what needs my attention?”" maxlength="2000"><button class="btn lime" type="submit">${ic('send', 15)} Ask</button></form>
      <div class="sugg">${['What needs my attention?', 'How are the books this month?', 'Chase overdue invoices', `Draft the ${monthLabel(S.period)} close`].map((s) => `<button type="button" data-sugg>${esc(s)}</button>`).join('')}</div></div>` +
    bind(() => {
      $('#hero-f').onsubmit = (e) => {
        e.preventDefault();
        const v = $('#hero-in').value.trim();
        if (v) askNeos(v);
      };
      for (const b of $$('[data-sugg]')) b.onclick = () => askNeos(b.textContent);
    }) +
    `<div class="trust" aria-label="Why you can trust what ${esc(appName(S.app))} does">
      <a href="#/switchboard">${ic('sliders', 14)} ${esc(appName(S.app))} switchboard <b>v${L().switchboard_version}</b></a>
      <a href="#/switchboard">${ic('shield', 14)} <b>${askFirst}</b> actions ask first</a>
      <a href="#/grants">${ic('check', 14)} <b>${activeGrants.length}</b> standing ${activeGrants.length === 1 ? 'yes' : 'yeses'}</a>
      ${vault ? `<a href="#/connections">${ic('key', 14)} Doors: ${L().doors.map((d) => `${esc(d.key.replace('_', ' '))} ${doors.has(d.key) ? '✓' : '✗'}`).join(' · ')}</a>` : ''}
      <a href="#/switchboard">${ic('sparkle', 14)} Assistant today <b>${usd(usage.today_usd)}</b> of ${usd(usage.per_day_cap_usd)}</a>
      <span class="t">${ic('lock', 14)} Keys held by any assistant: <b>none</b></span>
    </div>` +
    `<div class="card" id="needs"><div class="card-h"><span class="ico violet">${ic('inbox', 18)}</span><h3>Waiting on you</h3><span class="count">${S.pending.length}</span><div class="right"><a class="btn sm" href="#/approvals">All approvals ${ic('arrow', 13)}</a></div></div>
      <div class="card-b">${S.pending.length ? S.pending.slice(0, 3).map((c) => cardHtml(c)).join('') + (S.pending.length > 3 ? `<p class="note"><a href="#/approvals">${S.pending.length - 3} more waiting</a></p>` : '') : empty('Nothing waiting on you', 'When an app proposes something — an invoice, a payment, closing a month — the job pauses here until you answer.')}</div></div>` +
    bind(() => bindCards(S.pending)) +
    `<div class="card"><div class="card-h"><span class="ico blue">${ic('jobs', 18)}</span><h3>Working now</h3><span class="count">${working.length}</span><div class="right"><a class="btn sm" href="#/jobs">All jobs ${ic('arrow', 13)}</a></div></div>
      ${working.length ? working.map(jobCard).join('') : `<div class="card-b">${empty('No jobs running', 'Ask above; you’ll see it here — on it, working, waiting, carried out, reported.')}</div>`}</div>` +
    homes.join('') +
    (finished.length ? `<div class="card"><div class="card-h"><span class="ico teal">${ic('check', 18)}</span><h3>Recently reported</h3></div>${finished.map(jobCard).join('')}</div>` : '')
  );
};
function jobCard(t) {
  return `<div class="jobcard"><div class="top"><b><a href="#/jobs/${esc(t.id)}">${esc(t.ask)}</a></b>${pill(appName(t.app_key), 'violet')} ${statusPill(t.status)}</div>
    <div class="meta">asked by ${esc(who(t.requester))} · ${esc(ago(t.created_at))} · ${plural(Number(t.steps ?? 0), 'step')}${Number(t.cost_micros) ? ` · ${usd(Number(t.cost_micros) / 1e6)}` : ''}${t.origin && t.origin !== 'app' ? ` · via ${esc(t.origin)}` : ''}</div>
    ${stepper(t)}${t.result?.summary ? `<div class="meta">${esc(t.result.summary)}</div>` : ''}</div>`;
}

VIEWS.jobs = async (id) => {
  if (id) return jobDetail(id);
  await refreshLive();
  const f = S.query.get('f') ?? 'all';
  const groups = { all: () => true, working: (t) => ['OPEN', 'ACKNOWLEDGED'].includes(t.status), waiting: (t) => t.status === 'WAITING' || t.pending_approvals > 0, done: (t) => t.status === 'COMPLETED', failed: (t) => ['FAILED', 'CANCELLED'].includes(t.status), apps: (t) => String(t.requester).startsWith('app:') };
  const labels = { all: 'All', working: 'Working', waiting: 'Waiting on you', done: 'Reported', failed: 'Failed', apps: 'From other apps' };
  const rows = S.tasks.filter(groups[f] ?? groups.all);
  return (
    head('Jobs', 'The record book. Every ask becomes a job in the app that owns it: “on it” at once, one step at a time, a pause for a yes when the gate says so, and a report of what it did, what changed and what it could not do.', '', true) +
    `<div class="seg">${Object.keys(labels).map((k) => `<button data-f="${k}" aria-pressed="${k === f}">${labels[k]} · ${S.tasks.filter(groups[k]).length}</button>`).join('')}</div>` +
    `<div class="card">${
      rows.length
        ? `<table class="t"><thead><tr><th>Job</th><th>App</th><th class="hide-sm">Asked by</th><th>State</th><th class="r hide-sm">Steps</th><th class="r hide-sm">Assistant cost</th><th class="hide-sm">When</th></tr></thead><tbody>${rows
            .map((t) => `<tr class="click" data-job="${esc(t.id)}"><td><b>${esc(t.ask)}</b>${t.result?.summary ? `<div class="note">${esc(t.result.summary.slice(0, 140))}</div>` : ''}</td><td>${esc(appName(t.app_key))}</td><td class="hide-sm">${esc(who(t.requester))}</td><td>${statusPill(t.status)}${t.pending_approvals ? ` ${pill(`${t.pending_approvals} for you`, 'amber')}` : ''}</td><td class="r hide-sm">${t.steps}</td><td class="r hide-sm num">${usd(Number(t.cost_micros) / 1e6)}</td><td class="hide-sm">${esc(ago(t.created_at))}</td></tr>`)
            .join('')}</tbody></table>`
        : `<div class="card-b">${empty('No jobs here', 'Ask something with the bar at the top.')}</div>`
    }</div>` +
    bind(() => {
      for (const b of $$('[data-f]')) b.onclick = () => (location.hash = `#/jobs?f=${b.dataset.f}`);
      for (const r of $$('[data-job]')) r.onclick = () => (location.hash = `#/jobs/${r.dataset.job}`);
    })
  );
};

async function jobDetail(id) {
  const d = await api(`/api/tasks/${encodeURIComponent(id)}`);
  const t = d.task;
  if (!S.lines[t.app_key]) await loadLines(t.app_key).catch(() => {});
  const live = LIVE.includes(t.status);
  const ev = [{ at: t.created_at, cls: 'me', text: `Asked by ${who(t.requester)}`, sub: t.ask }];
  const KIND = { ack: 'On it', handoff: `Handed to ${appName(t.app_key)}`, waiting: 'Waiting for a yes', card: 'Asked a question', result: 'Reported', notice: 'Note' };
  for (const m of d.messages) if (!(m.kind === 'message' && String(m.author).startsWith('user:'))) ev.push({ at: m.at, cls: m.kind === 'result' ? (t.status === 'COMPLETED' ? 'ok' : 'bad') : m.kind === 'card' ? 'ask' : '', text: KIND[m.kind] ?? 'Message', sub: m.body });
  for (const a of d.activity) ev.push({ at: a.at, cls: /refus|denied|error|failed/i.test(a.summary) ? 'bad' : '', text: `Step ${a.seq}`, sub: a.summary });
  for (const a of d.approvals) {
    ev.push({ at: a.created_at, cls: 'ask', text: `Proposed: ${titleOf(a.ability_key, t.app_key)}`, sub: `${a.card?.what ?? ''} · fingerprint ${short(a.fingerprint)} · answer by ${when(a.expires_at)}` });
    if (a.decided_at) ev.push({ at: a.decided_at, cls: a.decision === 'yes' ? 'ok' : a.decision === 'change' ? 'ask' : 'bad', text: `${{ yes: 'Approved', no: 'Declined', change: 'Change requested', withdraw: 'Withdrawn' }[a.decision] ?? a.decision} by ${a.decided_by_name ?? 'a person'}`, sub: `against fingerprint ${short(a.fingerprint_seen)} ${a.fingerprint_seen === a.fingerprint ? '✓ exactly what was shown' : '✗ not what was shown'}${a.feedback ? ` · “${a.feedback}”` : ''}` });
    if (a.proof) ev.push({ at: a.proof.at ?? a.decided_at, cls: a.proof.outcome === 'DONE' ? 'ok' : a.proof.outcome === 'UNKNOWN' ? 'ask' : 'bad', text: a.proof.outcome === 'DONE' ? 'Carried out once, and read back' : a.proof.outcome === 'UNKNOWN' ? 'Carried out — checking whether it happened' : 'Carry-out failed', sub: [a.proof.external_ref ? `ref ${a.proof.external_ref}` : '', a.proof.error ?? '', a.proof.reconcile_attempts ? `checked ${a.proof.reconcile_attempts} times` : ''].filter(Boolean).join(' · ') || 'by the app itself, on the platform’s say-so — no model in the loop' });
  }
  for (const g of d.grant_uses) ev.push({ at: g.at, cls: 'ok', text: `Allowed by a standing yes: ${titleOf(g.ability_key, t.app_key)}`, sub: g.detail?.amount_minor ? money(g.detail.amount_minor, true) : 'within its limits' });
  ev.sort((a, b) => new Date(a.at) - new Date(b.at));
  const r = t.result ?? {};
  const pend = d.approvals.filter((a) => a.status === 'PENDING').map((a) => ({ ...a, task_id: t.id, app_key: t.app_key }));
  const text = (x) => (typeof x === 'string' ? x : x?.what ?? x?.summary ?? x?.ref ?? x?.basis ?? x?.ability ?? JSON.stringify(x));
  return (
    head(t.ask, `${esc(appName(t.app_key))} · asked by ${esc(who(t.requester))} ${esc(ago(t.created_at))}${t.origin ? ` · via ${esc(t.origin)}` : ''}`, `${statusPill(t.status)}${live ? `<button class="btn danger" id="cancel">Cancel job</button>` : ''}<a class="btn" href="#/jobs">All jobs</a>`) +
    `<div class="card"><div class="card-b">${stepper(t, d.approvals)}</div></div>` +
    (t.result
      ? `<div class="card"><div class="card-h"><span class="ico ${t.status === 'COMPLETED' ? 'green' : 'amber'}">${ic('check', 18)}</span><h3>What it reported</h3></div><div class="card-b"><p>${esc(r.summary ?? '')}</p>
          <div class="kv"><span>What changed</span><b>${r.changed?.length ? esc(r.changed.map(text).join(' · ')) : 'nothing in the books'}</b></div>
          ${r.could_not?.length ? `<div class="kv"><span>What it could not do</span><b class="c-red">${esc(r.could_not.map(text).join(' · '))}</b></div>` : ''}
          ${r.sources?.length ? `<div class="kv"><span>Where facts came from</span><b>${esc(r.sources.map(text).join(' · '))}</b></div>` : ''}</div></div>`
      : '') +
    (pend.length ? `<div class="card"><div class="card-h"><span class="ico violet">${ic('inbox', 18)}</span><h3>Waiting on you</h3></div><div class="card-b">${pend.map((a) => cardHtml(a)).join('')}</div></div>` : '') +
    `<div class="grid g2"><div class="card"><div class="card-h"><span class="ico violet">${ic('book', 18)}</span><h3>The record</h3><span class="count">${plural(ev.length, 'entry')}</span></div><div class="card-b"><ul class="tl">${ev.map((e) => `<li class="${e.cls}"><b>${esc(e.text)}</b><span class="t">${esc(when(e.at))}</span>${e.sub ? `<small>${esc(e.sub)}</small>` : ''}</li>`).join('')}</ul></div></div>
     <div class="card"><div class="card-h"><h3>This job</h3></div><div class="card-b">
      <div class="kv"><span>Assistant cost</span><b>${usd(d.cost.usd)}</b></div><div class="kv"><span>Model calls</span><b>${d.cost.calls}</b></div><div class="kv"><span>Tokens</span><b>${Number(d.cost.tokens).toLocaleString('en-IN')}</b></div>
      <div class="kv"><span>Approvals</span><b>${d.approvals.length}</b></div><div class="kv"><span>Standing yeses used</span><b>${d.grant_uses.length}</b></div><div class="kv"><span>Job id</span><b class="mono">${esc(String(t.job_id ?? '—').slice(0, 13))}</b></div>
      <p class="note">The assistant that worked this job held no keys and no database access. Every effect went through the app’s gate; every yes was carried out by the app itself.</p></div></div></div>` +
    bind(() => {
      bindCards(pend);
      const c = $('#cancel');
      if (c)
        c.onclick = async () => {
          try {
            await api(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: { reason: 'cancelled from the desk' } });
            toast('Cancelled. Nothing further will run for this job.');
            render();
          } catch (e) {
            fail(e);
          }
        };
    })
  );
}

VIEWS.approvals = async () => {
  const { cards } = await api('/api/desk');
  await Promise.all([...new Set(cards.map((c) => c.app_key))].filter((a) => !S.lines[a]).map((a) => loadLines(a).catch(() => {})));
  const pend = cards.filter((c) => c.status === 'PENDING');
  const hist = cards.filter((c) => c.status !== 'PENDING');
  const tab = S.query.get('t') ?? (pend.length ? 'waiting' : 'history');
  return (
    head('Approvals', 'Every change an app wants to make that its switchboard marks “ask first”. A yes binds to the fingerprint of exactly what you saw — if the proposal changes, you are asked again. The app carries out a yes once, itself, and reads it back.') +
    `<div class="seg"><button data-t="waiting" aria-pressed="${tab === 'waiting'}">Waiting on you · ${pend.length}</button><button data-t="history" aria-pressed="${tab === 'history'}">Who said yes to what · ${hist.length}</button></div>` +
    (tab === 'waiting'
      ? `<div class="card"><div class="card-b">${pend.length ? pend.map((c) => cardHtml(c)).join('') : empty('Nothing waiting on you')}</div></div>`
      : `<div class="card">${
          hist.length
            ? `<table class="t"><thead><tr><th>Proposed</th><th>App</th><th>Action</th><th>Answer</th><th class="hide-sm">Fingerprint seen</th><th>Outcome</th><th></th></tr></thead><tbody>${hist
                .map((a) => `<tr><td>${esc(when(a.created_at))}</td><td>${esc(appName(a.app_key))}</td><td><b>${esc(a.card?.what ?? titleOf(a.ability_key, a.app_key))}</b><div class="note mono">${esc(a.ability_key)}</div></td><td>${a.decision ? `${esc({ yes: 'Yes', no: 'No', change: 'Change first', withdraw: 'Withdrawn' }[a.decision] ?? a.decision)} · ${esc(a.decided_by_name ?? '—')}<div class="note">${esc(when(a.decided_at))}</div>` : '<span class="faint">nobody</span>'}</td><td class="hide-sm">${a.fingerprint_seen ? `<span class="fp">${esc(short(a.fingerprint_seen))}</span> ${a.fingerprint_seen === a.fingerprint ? '✓' : '✗'}` : '—'}</td><td>${outcomePill(a)}</td><td class="r">${a.task_id ? `<a class="btn sm" href="#/jobs/${esc(a.task_id)}">Job</a>` : ''}</td></tr>`)
                .join('')}</tbody></table>`
            : `<div class="card-b">${empty('No answered approvals yet')}</div>`
        }</div>`) +
    bind(() => {
      bindCards(pend);
      for (const b of $$('[data-t]')) b.onclick = () => (location.hash = `#/approvals?t=${b.dataset.t}`);
    })
  );
};

// ── the switchboard (WP §4, §10): floor · company · in force; skills; rules; budget ──
const rank = (s) => ({ on: 0, ask_first: 1, off: 2 })[s] ?? 0;
function toggleHtml(name, opts, cur, disabled, lockedValues = []) {
  return `<span class="toggle">${opts.map(([v, l]) => `<button data-tg="${esc(name)}" data-v="${v}" aria-pressed="${v === cur}"${disabled || lockedValues.includes(v) ? ' disabled' : ''}${lockedValues.includes(v) ? ' title="Looser than the app’s floor — a company can only tighten"' : ''}>${l}</button>`).join('')}</span>`;
}
const grantLimits = (g) => [g.limits?.per_call_minor && `≤ ${money(g.limits.per_call_minor)} a time`, g.limits?.per_month_minor && `≤ ${money(g.limits.per_month_minor)} a month`, g.limits?.recipients_allow && `to ${g.limits.recipients_allow.join(', ')}`].filter(Boolean).join(' · ') || 'no amount limit';
VIEWS.switchboard = async () => {
  const app = S.app;
  const Ls = await loadLines(app);
  const [sb, usage, grants, vault] = await Promise.all([api(`/api/switchboards/${app}`), api(`/api/usage/${app}`), api('/api/grants'), isAdmin() ? api('/api/vault').catch(() => null) : null]);
  const admin = isAdmin();
  const activeGrant = (k) => grants.grants.find((g) => g.app_key === app && g.ability_key === k && g.status === 'ACTIVE' && !g.expired);
  const groups = [
    ['Look things up', (l) => l.kind === 'read' && l.from === 'own'],
    ['Change the books', (l) => l.kind === 'write' && l.from === 'own' && !l.effects?.external],
    ['Leave the company', (l) => l.kind === 'write' && l.from === 'own' && l.effects?.external],
    ['From installed packages', (l) => l.from !== 'own'],
  ];
  const row = (l) => {
    const opts = l.kind === 'read' ? [['on', 'On'], ['off', 'Off']] : [['on', 'Automatic'], ['ask_first', 'Ask first'], ['off', 'Off']];
    const locked = opts.map(([v]) => v).filter((v) => rank(v) < rank(l.floor));
    const g = activeGrant(l.key);
    return `<tr${l.setting === 'off' ? ' class="grey"' : ''}><td class="line"><b>${esc(l.title)}</b><small>${esc(l.description ?? '')}</small><small class="mono faint">${esc(l.key)}${l.from !== 'own' ? ` · from ${esc(l.from)}` : ''}${l.doors?.length ? ` · door: ${esc(l.doors.join(', '))}` : ''}</small></td>
      <td>${settingPill(l.floor)}</td><td>${toggleHtml(`s:${l.key}`, opts, l.company ?? l.floor, !admin, locked)}</td>
      <td class="force">${settingPill(l.setting)}${l.forced_by_rule ? `<div class="note">a company rule requires a person</div>` : ''}${g && l.setting === 'ask_first' ? `<div class="note">standing yes: ${esc(grantLimits(g))}</div>` : ''}</td></tr>`;
  };
  // Skill lines: on or off only; greyed out with the reason when a tool they need is off (WP §10).
  const skillRow = (s) => `<tr${s.loads ? '' : ' class="grey"'}><td class="line"><b>${esc(s.key.replace(/[-/]/g, ' '))}</b><small>skill · ${s.from === 'own' ? `${esc(appName(app))}’s know-how` : `from ${esc(s.from)}`}</small>
      <small>needs → ${s.needs.map((n) => `${esc(titleOf(n.key, app))} ${n.setting === 'off' ? '✗' : n.setting === 'elsewhere' ? '↗' : '✓'}`).join(' · ') || 'nothing'}</small></td>
      <td>${pill('on / off', 'gray')}</td><td>${toggleHtml(`s:skill:${s.key}`, [['on', 'On'], ['off', 'Off']], s.setting, !admin)}</td>
      <td class="force">${s.loads ? pill('loads at spawn', 'green') : s.setting === 'off' ? pill('switched off', 'gray') : pill(`not loaded · needs ${s.missing.map((k) => titleOf(k, app)).join(', ')}`, 'amber')}</td></tr>`;
  const doors = vaultDoors(vault, app);
  const star = sb.approvals?.['*'] ?? {};
  return (
    head('Switchboard', `What ${esc(appName(app))} may do at ${esc(S.me.company?.name ?? 'your company')}. The app sets a floor; you can only make it stricter. The gate checks this on every call — “off” means the assistant is not even shown it, and it is refused if asked by name.`, `${appSwitch('switchboard')}<button class="btn" id="hist">${ic('clock', 15)} History · v${sb.version}</button>${admin ? '' : pill('admins change the switchboard', 'amber')}`) +
    `<div class="card board"><table class="t"><thead><tr><th>Line</th><th>App’s floor</th><th>${esc(S.me.company?.name ?? 'Company')} set</th><th>In force today</th></tr></thead><tbody>
      ${groups.map(([label, fn]) => {
        const ls = Ls.abilities.filter(fn);
        return ls.length ? `<tr class="group"><td colspan="4">${esc(label)} · ${ls.length}</td></tr>${ls.map(row).join('')}` : '';
      }).join('')}
      ${Ls.skills?.length ? `<tr class="group"><td colspan="4">Skills · know-how, loaded only when every tool it needs is on · ${Ls.skills.length}</td></tr>${Ls.skills.map(skillRow).join('')}` : ''}
      <tr class="group"><td colspan="4">Doors · keys lent per call from the vault</td></tr>
      ${Ls.doors.map((d) => `<tr${vault && !doors.has(d.key) ? ' class="grey"' : ''}><td class="line"><b>${esc(d.key.replace('_', ' '))}</b><small>${d.declared_by === 'own' ? `declared by ${esc(appName(app))}` : 'declared by an installed package'}${d.scopes?.length ? ` · scopes: ${esc(d.scopes.join(', '))}` : ''}</small></td><td>${pill('needs a key')}</td><td>${vault ? (doors.has(d.key) ? pill('key in vault', 'green') : pill('no key')) : '—'}</td><td class="force">${vault ? (doors.has(d.key) ? pill('opens per call', 'green') : pill('closed — cannot open')) : '—'}</td></tr>`).join('')}
    </tbody></table></div>` +
    `<div class="grid g2"><div class="card"><div class="card-h"><span class="ico amber">${ic('rules', 18)}</span><h3>Company rules</h3><span class="count">checked by the gate on every call</span>${admin ? `<div class="right"><button class="btn sm lime" id="add-rule">${ic('plus', 14)} Add rule</button></div>` : ''}</div>
        <div class="card-b">${(sb.rules ?? []).length ? (sb.rules ?? []).map((r, i) => `<div class="kv"><span><b>${esc(ruleText(r))}</b><br><span class="faint mono">${esc(r.id)} · ${esc(r.type)}</span></span>${admin ? `<button class="btn sm danger" data-rm="${i}">Remove</button>` : ''}</div>`).join('') : '<p class="muted">No company rules yet. For example: nothing goes out on weekends · cap payments per month · only email our own domain · always ask a person before closing a month.</p>'}</div></div>
      <div class="card"><div class="card-h"><span class="ico teal">${ic('sparkle', 18)}</span><h3>The assistant’s budget</h3></div><div class="card-b">
        <div class="kv"><span>Spent today</span><b>${usd(usage.today_usd)} of ${usd(usage.per_day_cap_usd)}</b></div><div class="meter"><i data-w="${(100 * usage.today_usd) / Math.max(usage.per_day_cap_usd, 0.01)}"></i></div>
        <div class="kv"><span>This month</span><b>${usd(usage.month_usd)}</b></div><div class="kv"><span>Cap per job</span><b>${usd(usage.per_job_cap_usd)}</b></div>
        ${usage.refused_today ? `<div class="kv"><span>Calls refused today (over budget)</span><b class="c-red">${usage.refused_today}</b></div>` : ''}
        ${admin ? `<div class="row2"><div><label class="f" for="bj">Per job (USD)</label><input class="i" id="bj" type="number" min="0.1" step="0.5" value="${usage.per_job_cap_usd}"></div><div><label class="f" for="bd">Per day (USD)</label><input class="i" id="bd" type="number" min="1" step="5" value="${usage.per_day_cap_usd}"></div></div><p><button class="btn sm" id="save-budget">Save budget</button></p>` : ''}
        <p class="note">A job over its budget is refused before it calls the model. The cap is enforced by the LLM proxy, which holds the key — not by the assistant.</p></div></div></div>` +
    `<div class="card"><div class="card-h"><span class="ico violet">${ic('user', 18)}</span><h3>Who may say yes</h3><span class="count">only a person can approve — never another app</span></div><div class="card-b">
      <div class="kv"><span>Four eyes: whoever asked cannot approve their own request</span>${toggleHtml('fe', [['off', 'Off'], ['on', 'On']], star.four_eyes ? 'on' : 'off', !admin)}</div>
      <div class="kv"><span>Who may approve</span>${toggleHtml('roles', [['any', 'Anyone in the company'], ['admin', 'Admins only']], (star.roles ?? []).length === 1 && star.roles[0] === 'admin' ? 'admin' : 'any', !admin)}</div></div></div>` +
    bind(() => {
      $('#hist').onclick = () => historyModal(app);
      if (!admin) return;
      const save = async (patch, msg) => {
        try {
          await api(`/api/switchboards/${app}`, { method: 'PUT', body: patch });
          toast(`${msg} In force from the next call.`);
          render(true);
        } catch (e) {
          fail(e);
          render(true);
        }
      };
      for (const b of $$('[data-tg]'))
        b.onclick = () => {
          const [name, v] = [b.dataset.tg, b.dataset.v];
          if (name === 'fe') save({ approvals: { '*': { ...star, four_eyes: v === 'on' } } }, v === 'on' ? 'Four eyes on.' : 'Four eyes off.');
          else if (name === 'roles') save({ approvals: { '*': { ...star, roles: v === 'admin' ? ['admin'] : undefined } } }, v === 'admin' ? 'Only admins can approve.' : 'Anyone can approve.');
          else if (name.startsWith('s:skill:')) save({ settings: { [name.slice(2)]: v } }, `Skill ${name.slice(8)}: ${v}.`);
          else if (name.startsWith('s:')) save({ settings: { [name.slice(2)]: v } }, `${titleOf(name.slice(2), app)}: ${SETTING[v]}.`);
        };
      $('#save-budget').onclick = () => save({ budget: { per_job_usd: Number($('#bj').value), per_day_usd: Number($('#bd').value) } }, 'Budget saved.');
      $('#add-rule').onclick = () => ruleForm(app, sb.rules ?? [], save);
      for (const b of $$('[data-rm]')) b.onclick = () => save({ rules: (sb.rules ?? []).filter((_, i) => i !== Number(b.dataset.rm)) }, 'Rule removed.');
    })
  );
};
function scopeText(s, app) {
  if (!s || s === 'external') return 'Anything that leaves the company';
  if (s === 'all') return 'Every action';
  return s.map((k) => titleOf(k, app)).join(', ');
}
function ruleText(r, app = S.app) {
  if (r.type === 'time_window') return `${scopeText(r.applies_to, app)}: only ${r.days.map((d) => DAYS[d - 1]).join(', ')}, ${r.from}–${r.to}`;
  if (r.type === 'destination') return `${scopeText(r.applies_to, app)}: only to ${r.domains.join(', ')}`;
  if (r.type === 'amount_cap') return `${scopeText(r.applies_to, app)}: ${[r.per_call_minor && `at most ${money(r.per_call_minor)} per call`, r.per_day_minor && `${money(r.per_day_minor)} per day`, r.per_month_minor && `${money(r.per_month_minor)} per month`].filter(Boolean).join(', ')}`;
  if (r.type === 'recipient_cap') return `${scopeText(r.applies_to, app)}: at most ${plural(r.max, 'recipient')}`;
  if (r.type === 'require_person') return `Always ask a person before: ${r.abilities.map((k) => titleOf(k, app)).join(', ')}`;
  return r.type;
}
function ruleForm(app, rules, save) {
  const writes = L(app).abilities.filter((l) => l.kind === 'write');
  modal(
    'Add a company rule',
    `<form id="rf"><label class="f">Rule</label><select class="i" name="type" id="rt">
        <option value="time_window">Only at certain times (e.g. nothing on weekends)</option><option value="amount_cap">Cap amounts (per call / day / month)</option>
        <option value="destination">Only send to our own domains</option><option value="recipient_cap">Limit how many people an email goes to</option><option value="require_person">Always ask a person before…</option></select>
      <div id="rfields"></div>
      <div id="rscope-w"><label class="f">Applies to</label><select class="i" name="scope"><option value="external">Anything that leaves the company</option><option value="all">Every action</option>${writes.map((w) => `<option value="${esc(w.key)}">Only: ${esc(w.title)}</option>`).join('')}</select></div>
      <label class="f">Short name</label><input class="i mono" name="id" required pattern="[A-Za-z0-9][A-Za-z0-9_.\\-]{0,62}" placeholder="e.g. weekdays-only"></form>`,
    `<span class="grow">Checked on every call, and again just before an approved action is carried out.</span><button class="btn" id="rc">Cancel</button><button class="btn lime" id="rs">Add rule</button>`,
  );
  const fields = {
    time_window: `<label class="f">Days</label><div>${DAYS.map((d, i) => `<label class="chip"><input type="checkbox" name="d${i + 1}"${i < 5 ? ' checked' : ''}> ${d}</label>`).join(' ')}</div><div class="row2"><div><label class="f">From</label><input class="i" type="time" name="from" value="09:00" required></div><div><label class="f">To</label><input class="i" type="time" name="to" value="18:00" required></div></div>`,
    amount_cap: `<div class="row2"><div><label class="f">Per call (₹)</label><input class="i" name="pc" type="number" min="1" step="1"></div><div><label class="f">Per day (₹)</label><input class="i" name="pd" type="number" min="1" step="1"></div></div><label class="f">Per month (₹)</label><input class="i" name="pm" type="number" min="1" step="1">`,
    destination: `<label class="f">Allowed domains (comma separated)</label><input class="i mono" name="domains" required placeholder="acme.in, acme.co.in">`,
    recipient_cap: `<label class="f">Most recipients per email</label><input class="i" name="max" type="number" min="1" value="3" required>`,
    require_person: `<label class="f">Actions (hold ⌘ to pick several)</label><select class="i" name="abilities" multiple size="7" required>${writes.map((w) => `<option value="${esc(w.key)}">${esc(w.title)}</option>`).join('')}</select>`,
  };
  const paint = () => {
    $('#rfields').innerHTML = fields[$('#rt').value];
    $('#rscope-w').classList.toggle('hidden', $('#rt').value === 'require_person');
  };
  $('#rt').onchange = paint;
  paint();
  $('#rc').onclick = closeLayer;
  $('#rs').onclick = () => {
    const f = $('#rf');
    if (!f.reportValidity()) return;
    const d = new FormData(f);
    const type = d.get('type');
    const scope = d.get('scope');
    const applies_to = scope === 'external' || scope === 'all' ? scope : [scope];
    let rule = { id: d.get('id'), type };
    if (type === 'time_window') rule = { ...rule, days: [1, 2, 3, 4, 5, 6, 7].filter((i) => d.get(`d${i}`)), from: d.get('from'), to: d.get('to'), applies_to };
    if (type === 'amount_cap') {
      const m = (k) => (d.get(k) ? Math.round(Number(d.get(k)) * 100) : undefined);
      rule = { ...rule, currency: 'INR', per_call_minor: m('pc'), per_day_minor: m('pd'), per_month_minor: m('pm'), applies_to };
      for (const k of ['per_call_minor', 'per_day_minor', 'per_month_minor']) if (rule[k] === undefined) delete rule[k];
    }
    if (type === 'destination') rule = { ...rule, mode: 'allow_list', domains: String(d.get('domains')).split(',').map((x) => x.trim()).filter(Boolean), applies_to };
    if (type === 'recipient_cap') rule = { ...rule, max: Number(d.get('max')), applies_to };
    if (type === 'require_person') rule = { ...rule, abilities: d.getAll('abilities') };
    closeLayer();
    save({ rules: [...rules, rule] }, `Rule “${rule.id}” added.`);
  };
}
async function historyModal(app) {
  modal(`${appName(app)} switchboard history`, '<div class="skel"></div>', '', true);
  try {
    const { versions } = await api(`/api/switchboards/${app}/history`);
    const label = (k) => (k.startsWith('skill:') ? `skill ${k.slice(6)}` : titleOf(k, app));
    const diff = (a, b) => {
      if (!b) return 'first change from the app’s floor';
      const out = [];
      for (const k of new Set([...Object.keys(a.settings ?? {}), ...Object.keys(b.settings ?? {})])) if (a.settings?.[k] !== b.settings?.[k]) out.push(`${label(k)}: ${SETTING[b.settings?.[k]] ?? b.settings?.[k] ?? 'floor'} → ${SETTING[a.settings?.[k]] ?? a.settings?.[k] ?? 'floor'}`);
      if (JSON.stringify(a.rules) !== JSON.stringify(b.rules)) out.push(`company rules: ${(b.rules ?? []).length} → ${(a.rules ?? []).length}`);
      if (JSON.stringify(a.budget) !== JSON.stringify(b.budget)) out.push(`budget: ${Object.entries(a.budget ?? {}).map(([k, v]) => `${k.replace('_usd', '').replace('_', ' ')} $${v}`).join(', ')}`);
      if (JSON.stringify(a.approvals) !== JSON.stringify(b.approvals)) out.push(`who may approve: ${a.approvals?.['*']?.four_eyes ? 'four eyes' : 'one person'}${a.approvals?.['*']?.roles ? ', admins only' : ''}`);
      return out.join(' · ') || 'no change';
    };
    $('.modal .mb').innerHTML = versions.length ? `<table class="t"><thead><tr><th>Version</th><th>When</th><th>By</th><th>What changed</th></tr></thead><tbody>${versions.map((v, i) => `<tr><td><b>v${v.version}</b></td><td>${esc(when(v.updated_at))}</td><td>${esc(v.updated_by_name ?? '—')}</td><td>${esc(diff(v, versions[i + 1]))}</td></tr>`).join('')}</tbody></table>` : empty('No changes yet', 'The app is running on its floor.');
  } catch (e) {
    $('.modal .mb').innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

// ── standing yeses (WP §5) ─────────────────────────────────────────────────
VIEWS.grants = async () => {
  await Promise.all(S.apps.map((a) => (S.lines[a.key] ? null : loadLines(a.key))));
  const { grants } = await api('/api/grants');
  const admin = isAdmin();
  const state = (g) => (g.status === 'ACTIVE' && g.expired ? pill('expired') : g.status === 'ACTIVE' ? pill('active', 'green') : g.status === 'SUSPENDED' ? pill('suspended', 'red') : pill('withdrawn'));
  return (
    head('Standing yeses', 'Once you trust a routine action, let the app do it within limits without asking each time. A standing yes counts as a person’s yes because a person wrote it. It expires, can be withdrawn any moment, and suspends itself the moment something goes wrong under it.', admin ? `<button class="btn lime" id="new-g">${ic('plus', 15)} New standing yes</button>` : '') +
    `<div class="card">${
      grants.length
        ? `<table class="t"><thead><tr><th>The app may, without asking</th><th>Within</th><th class="hide-sm">Used</th><th>Until</th><th>State</th><th></th></tr></thead><tbody>${grants
            .map((g) => `<tr${g.status !== 'ACTIVE' || g.expired ? ' class="grey"' : ''}><td><b>${esc(titleOf(g.ability_key, g.app_key))}</b> ${pill(appName(g.app_key), 'violet')}<div class="note">set by ${esc(g.created_by_name ?? '—')} ${esc(ago(g.created_at))}</div></td><td>${esc(grantLimits(g))}</td>
              <td class="hide-sm">${plural(g.uses, 'time')}${g.used_this_month_minor ? ` · ${money(g.used_this_month_minor)} this month` : ''}${g.last_used_at ? `<div class="note">last ${esc(ago(g.last_used_at))}</div>` : ''}</td>
              <td>${esc(longDay(new Date(g.expires_at).toISOString().slice(0, 10)))}</td><td>${state(g)}${g.suspended_reason ? `<div class="note c-red">${esc(g.suspended_reason)}</div>` : ''}</td>
              <td class="r">${admin && g.status !== 'REVOKED' ? `<button class="btn sm danger" data-rev="${esc(g.id)}">Withdraw</button>` : ''}</td></tr>`)
            .join('')}</tbody></table>`
        : `<div class="card-b">${empty('No standing yeses', 'Every ask-first action waits for a person. On an approval card, “Approve & always allow…” creates one.')}</div>`
    }</div>` +
    bind(() => {
      const n = $('#new-g');
      if (n) n.onclick = () => grantForm({ app: S.app });
      for (const b of $$('[data-rev]'))
        b.onclick = async () => {
          try {
            await api(`/api/grants/${b.dataset.rev}`, { method: 'DELETE' });
            toast('Withdrawn. From the next call the app asks a person again.');
            render(true);
          } catch (e) {
            fail(e);
          }
        };
    })
  );
};
function grantForm({ app, ability_key, args, card }) {
  const writes = L(app).abilities.filter((l) => l.kind === 'write' && l.setting === 'ask_first');
  const amt = args?.amount_minor ?? (Array.isArray(args?.lines) ? args.lines.reduce((s, l) => s + Number(l.amount_minor || 0), 0) : null);
  const to = typeof args?.to === 'string' && /@/.test(args.to) ? args.to : '';
  modal(
    card ? 'Approve & always allow' : `New standing yes · ${appName(app)}`,
    `<form id="gf">${card ? `<p class="muted">This approves the card in front of you <b>and</b> lets ${esc(appName(app))} do the same kind of thing within these limits without asking, until the date below.</p>` : ''}
      <label class="f">${esc(appName(app))} may, without asking</label><select class="i" name="ability"${card ? ' disabled' : ''}>${writes.map((w) => `<option value="${esc(w.key)}"${w.key === ability_key ? ' selected' : ''}>${esc(w.title)}</option>`).join('')}${card && !writes.some((w) => w.key === ability_key) ? `<option selected value="${esc(ability_key)}">${esc(titleOf(ability_key, app))}</option>` : ''}</select>
      <div class="row2"><div><label class="f">At most per time (₹)</label><input class="i" name="pc" type="number" min="1" step="1" value="${amt ? Math.ceil(amt / 100) : ''}"></div><div><label class="f">At most per month (₹)</label><input class="i" name="pm" type="number" min="1" step="1"></div></div>
      <label class="f">Only to these recipients (optional, comma separated)</label><input class="i" name="rcpt" value="${esc(to)}" placeholder="finance@customer.example">
      <label class="f">Until</label><input class="i" name="exp" type="date" value="${iso(new Date(Date.now() + 30 * 864e5))}" required></form>
      <p class="note">Money actions need an amount limit. If a carry-out under this standing yes fails or cannot be confirmed, it suspends itself until a person looks.</p>`,
    `<button class="btn" id="gc">Cancel</button><button class="btn lime" id="gs">${card ? 'Approve & allow' : 'Create'}</button>`,
  );
  $('#gc').onclick = closeLayer;
  $('#gs').onclick = async () => {
    const f = $('#gf');
    if (!f.reportValidity()) return;
    const d = new FormData(f);
    const limits = {};
    if (d.get('pc')) limits.per_call_minor = Math.round(Number(d.get('pc')) * 100);
    if (d.get('pm')) limits.per_month_minor = Math.round(Number(d.get('pm')) * 100);
    if (limits.per_call_minor || limits.per_month_minor) limits.currency = 'INR';
    const rc = String(d.get('rcpt') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (rc.length) limits.recipients_allow = rc;
    try {
      await api('/api/grants', { method: 'POST', body: { app_key: app, ability_key: card ? ability_key : d.get('ability'), limits, expires_at: new Date(`${d.get('exp')}T23:59:59`).toISOString() } });
      if (card) await answer(card, 'yes');
      else toast('Standing yes created.');
      closeLayer();
      render(true);
    } catch (e) {
      fail(e);
    }
  };
}

// ── doors and the key vault ────────────────────────────────────────────────
const DOOR_INFO = { email: ['Email', 'Sends invoices, reminders and reports.', 'send'], gst_portal: ['GST portal (GSP)', 'Files GST returns through your GST Suvidha Provider.', 'tax'] };
VIEWS.connections = async () => {
  const app = S.app;
  const Ls = await loadLines(app);
  const admin = isAdmin();
  const [v, lends] = await Promise.all([admin ? api('/api/vault') : { doors: [] }, admin ? api('/api/audit?action=vault.lend&limit=300').catch(() => ({ rows: [] })) : { rows: [] }]);
  // WP §12: a key is per (company, app, door); a company-wide key (app null) serves any app without its own.
  const has = (k) => v.doors.find((x) => x.door === k && x.app === app) ?? v.doors.find((x) => x.door === k && !x.app);
  return (
    head('Doors', 'Connections to the outside. Keys live in the platform’s vault, sealed and write-only: an app borrows one for a single call and forgets it; no assistant ever sees it. A door without a key cannot be opened — not discouraged, impossible.', `${appSwitch('connections')}${admin ? '' : pill('admins connect doors', 'amber')}`) +
    Ls.doors
      .map((d) => {
        const [title, text, icon] = DOOR_INFO[d.key] ?? [d.key, '', 'key'];
        const users = Ls.abilities.filter((l) => l.doors?.includes(d.key));
        const n = lends.rows.filter((r) => r.ability_key === d.key && r.app_key === app);
        const refused = n.filter((r) => /refused/.test(r.outcome ?? '')).length;
        const on = has(d.key);
        return `<div class="card"><div class="card-h"><span class="ico ${on ? 'green' : 'amber'}">${ic(icon, 18)}</span><h3>${esc(title)}</h3>${on ? pill(`${on.app ? `${esc(appName(app))}’s own key` : 'company-wide key'} · set ${ago(on.updated_at)}`, 'green') : pill('no key · closed', 'amber')}
          <div class="right">${admin && d.key === 'gst_portal' && on ? `<button class="btn sm" data-otp="${esc(d.key)}">Enter OTP</button>` : ''}${admin ? `<button class="btn sm${on ? '' : ' lime'}" data-door="${esc(d.key)}">${on ? 'Replace key' : 'Connect'}</button>` : ''}</div></div>
          <div class="card-b"><p class="muted">${esc(text)}</p><div class="kv"><span>Declared by</span><b>${d.declared_by === 'own' ? esc(appName(app)) : 'an installed package'}${d.scopes?.length ? ` · scopes ${esc(d.scopes.join(', '))}` : ''}</b></div>
          <div class="kv"><span>Used by</span><b>${users.length ? esc(users.map((u) => u.title).join(', ')) : 'the package’s abilities'}</b></div>
          ${admin ? `<div class="kv"><span>Keys lent (recent)</span><b>${n.length - refused}${refused ? ` · ${refused} refused` : ''}</b></div>` : ''}</div></div>`;
      })
      .join('') +
    bind(() => {
      for (const b of $$('[data-door]')) b.onclick = () => doorForm(b.dataset.door, app);
      for (const b of $$('[data-otp]')) b.onclick = () => otpForm(b.dataset.otp, app);
    })
  );
};
/** Doors an app can open at this company: its own keys and the company-wide ones (WP §12). */
function vaultDoors(vault, app) {
  return new Set((vault?.doors ?? []).filter((d) => !d.app || d.app === app).map((d) => d.door));
}
/** Where a key is saved: this app only (default), or company-wide for every app that declares the door. */
const vaultPath = (door, app, only) => `/api/vault/${door}${only && app ? `?app=${encodeURIComponent(app)}` : ''}`;

function doorForm(door, app) {
  const email = door === 'email';
  modal(
    email ? 'Connect email' : 'Connect the GST portal',
    `<form id="df">${
      email
        ? `<label class="f">Provider</label><select class="i" name="provider" id="prov"><option value="resend">Resend</option><option value="dev-mailbox">Development mailbox (files on the backend)</option></select>
           <div id="p-real"><label class="f">API key</label><input class="i mono" name="api_key" type="password" autocomplete="off"><label class="f">From</label><input class="i" name="from" placeholder="Acme Books &lt;books@acme.in&gt;"></div>
           <div id="p-dev" class="hidden"><label class="f">Directory on the backend</label><input class="i mono" name="dir" value="/srv/var/mailbox"></div>`
        : `<label class="f">Provider</label><select class="i" name="provider" id="prov"><option value="gsp">Your GST Suvidha Provider (GSTN taxpayer API)</option><option value="dev-file">Development (files on the backend)</option></select>
           <div id="p-real"><label class="f">GSP base URL</label><input class="i mono" name="base_url" type="url" placeholder="https://gsp.example">
           <div class="row2"><div><label class="f">Client id</label><input class="i mono" name="client_id" autocomplete="off"></div><div><label class="f">Client secret</label><input class="i mono" name="client_secret" type="password" autocomplete="off"></div></div>
           <div class="row2"><div><label class="f">GST portal username (API access on)</label><input class="i mono" name="username" autocomplete="off"></div><div><label class="f">GSTIN</label><input class="i mono" name="gstin" placeholder="27AAPFU0939F1ZV" pattern="[0-9A-Z]{15}"></div></div>
           <div class="row2"><div><label class="f">Signatory PAN (EVC filing)</label><input class="i mono" name="signatory_pan" placeholder="AAPFU0939F"></div><div><label class="f">When the books cannot tell intra/inter-state</label><select class="i" name="assume_supply"><option value="">Refuse to guess</option><option value="intra_state">Assume intra-state (CGST+SGST)</option><option value="inter_state">Assume inter-state (IGST)</option></select></div></div>
           <details><summary class="muted">Paths and headers (defaults follow the GSTN taxpayer API)</summary>
           <div class="row2"><div><label class="f">Authenticate path</label><input class="i mono" name="p_auth" placeholder="/taxpayerapi/v1.0/authenticate"></div><div><label class="f">GSTR-3B path</label><input class="i mono" name="p_3b" placeholder="/taxpayerapi/v1.1/returns/gstr3b"></div></div>
           <label class="f">Returns path</label><input class="i mono" name="p_ret" placeholder="/taxpayerapi/v0.3/returns">
           <label class="f">Extra headers (JSON)</label><input class="i mono" name="headers" placeholder='{"x-gsp-key":"…"}'></details>
           <p class="note">OTPs are never stored here: when the portal sends one, an admin enters it with “Enter OTP”.</p></div>
           <div id="p-dev" class="hidden"><label class="f">Directory on the backend</label><input class="i mono" name="dir" value="/srv/var/gst-portal"></div>`
    }<label class="f"><input type="checkbox" name="only_app" checked> Only for ${esc(appName(app))} (unticked: company-wide, for every app that declares this door and has no key of its own)</label></form><p class="note">Write-only: once saved, nobody can read it back — not even an admin.</p>`,
    `<button class="btn" id="dc">Cancel</button><button class="btn lime" id="ds">Save to vault</button>`,
  );
  const prov = $('#prov');
  const dev = () => prov.value.startsWith('dev');
  prov.onchange = () => ($('#p-real').classList.toggle('hidden', dev()), $('#p-dev').classList.toggle('hidden', !dev()));
  $('#dc').onclick = closeLayer;
  $('#ds').onclick = async () => {
    const d = Object.fromEntries(new FormData($('#df')).entries());
    let body;
    if (dev()) body = { provider: d.provider, dir: d.dir };
    else if (email) body = { provider: 'resend', api_key: d.api_key, from: d.from };
    else {
      body = { provider: 'gsp', base_url: d.base_url, client_id: d.client_id, client_secret: d.client_secret, username: d.username, gstin: (d.gstin || '').toUpperCase() };
      if (Object.values(body).some((x) => !x)) return toast('Base URL, client id and secret, username and GSTIN are required.', true);
      if (d.signatory_pan) body.signatory_pan = d.signatory_pan.toUpperCase();
      if (d.assume_supply) body.assume_supply = d.assume_supply;
      const paths = Object.fromEntries([['authenticate', d.p_auth], ['gstr3b', d.p_3b], ['returns', d.p_ret]].filter(([, v]) => v));
      if (Object.keys(paths).length) body.paths = paths;
      if (d.headers) {
        try {
          body.headers = JSON.parse(d.headers);
        } catch {
          return toast('Extra headers must be JSON.', true);
        }
      }
    }
    if (email && !dev() && Object.values(body).some((x) => !x)) return toast('Fill in every field.', true);
    try {
      await api(vaultPath(door, app, !!d.only_app), { method: 'PUT', body });
      closeLayer();
      toast('Saved to the vault. The app borrows it per call.');
      render(true);
    } catch (e) {
      fail(e);
    }
  };
}

// A one-time code the portal sent a person (login OTP, or the signatory's EVC OTP): written straight
// to the write-only OTP slot, never to a card, a note or the assistant.
function otpForm(door, app) {
  modal(
    'Enter a GST portal OTP',
    `<form id="of"><label class="f">Which code</label><select class="i" name="kind"><option value="auth_otp">Login OTP (the portal asked to sign in)</option><option value="evc_otp">EVC OTP (the signatory, before a filing)</option></select>
     <label class="f">Code</label><input class="i mono" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4,8}"></form><p class="note">Used once by the app for the next portal call, then discarded. Never shown to the assistant.</p>`,
    `<button class="btn" id="oc">Cancel</button><button class="btn lime" id="os">Save code</button>`,
  );
  $('#oc').onclick = closeLayer;
  $('#os').onclick = async () => {
    const d = Object.fromEntries(new FormData($('#of')).entries());
    if (!/^[0-9]{4,8}$/.test(d.code || '')) return toast('Enter the 4–8 digit code.', true);
    try {
      await api(vaultPath(`${door}_otp`, app, true), { method: 'PUT', body: { provider: 'person', [d.kind]: d.code } });
      closeLayer();
      toast('Code saved for the next portal call.');
    } catch (e) {
      fail(e);
    }
  };
}

// ── packages and skills (WP §10) ───────────────────────────────────────────
VIEWS.packages = async () => {
  const app = S.app;
  await loadLines(app);
  const [{ entries }, reviews] = await Promise.all([api('/api/registry/catalog'), S.me.role === 'operator' ? api('/api/registry/reviews').catch(() => ({ reviews: [] })) : { reviews: [] }]);
  const admin = isAdmin();
  const card = (e) => {
    const inst = e.installs.find((i) => i.host_app === app && i.status !== 'disabled');
    const wasOff = e.installs.find((i) => i.host_app === app && i.status === 'disabled');
    const offers = Array.isArray(e.offers) ? e.offers : [];
    const on = offers.filter((o) => line(o.key, app)?.setting !== 'off').length;
    return `<div class="card"><div class="card-h"><span class="ico ${inst ? 'green' : 'blue'}">${ic(e.kind === 'package' ? 'box' : 'book', 18)}</span><h3>${esc(e.key)}</h3>
      ${pill(e.kind, 'violet')} ${pill(`v${e.latest}`)} ${e.signed ? pill('signed ✓', 'green') : pill('unsigned', 'red')} ${e.status === 'deprecated' ? pill('deprecated', 'amber') : ''}
      <div class="right">${inst ? pill(inst.status === 'active' ? `installed · pinned v${inst.pinned_version}` : 'installed · migration pending', inst.status === 'active' ? 'green' : 'amber') : wasOff ? pill('uninstalled · tables kept', 'gray') : ''}${e.update_available ? pill('update available', 'blue') : ''}
        ${admin && !inst ? `<button class="btn sm lime" data-inst="${esc(e.key)}">${wasOff ? 'Re-install' : 'Review & install'}</button>` : ''}${admin && inst ? `<button class="btn sm danger" data-uninst="${esc(e.key)}">Uninstall</button>` : ''}</div></div>
      <div class="card-b">
        ${offers.length ? `<div class="kv"><span>Adds to ${esc(appName(app))}’s switchboard</span><b>${offers.map((o) => `${esc(o.key)} (${esc(o.kind)}, floor ${esc(SETTING[o.floor] ?? o.floor)})`).join(' · ')}</b></div>` : ''}
        ${inst?.status === 'active' && offers.length ? `<div class="kv"><span>Switched on at your company</span><b>${on} of ${offers.length} · <a href="#/switchboard">change</a></b></div>` : ''}
        ${(e.requires ?? []).length ? `<div class="kv"><span>Needs</span><b>${(e.requires ?? []).map((r) => esc(r)).join(' · ')}</b></div>` : ''}
        <div class="kv"><span>Published</span><b>${esc(when(e.published_at))}${e.versions.length > 1 ? ` · versions ${esc(e.versions.join(', '))}` : ''}</b></div>
        <div class="kv"><span>Content fingerprint</span><b class="mono">${esc(short(e.content_hash))}</b></div>
        ${inst?.status === 'pending_migration' ? `<p class="note c-red">Its tables are created by the migration runner (your operator runs <span class="mono">migrate</span>). Its abilities go live after that.</p>` : ''}</div></div>`;
  };
  return (
    head('Packages & skills', 'Know-how plus the tools it needs, signed and versioned in the platform registry. A package installs into an app: its tools run behind that app’s gate in a sandbox, its lines land on that app’s switchboard, and its code is loaded by hash — never run from a row. Uninstalling disables it and keeps its tables.', appSwitch('packages')) +
    (reviews.reviews.length ? `<div class="card"><div class="card-h"><span class="ico amber">${ic('shield', 18)}</span><h3>Waiting for operator review</h3><span class="count">${reviews.reviews.length}</span></div><div class="card-b">${reviews.reviews.map((r) => `<div class="kv"><span><b>${esc(r.key)} v${esc(r.version)}</b><br><span class="faint">submitted ${esc(ago(r.created_at))}</span></span><span><button class="btn sm" data-diff="${esc(r.id)}">Read the diff</button> <button class="btn sm lime" data-pub="${esc(r.id)}">Sign & publish</button></span></div>`).join('')}</div></div>` : '') +
    (entries.length ? entries.map(card).join('') : `<div class="card"><div class="card-b">${empty('The registry is empty', 'Packages appear here once a platform operator has reviewed and signed them.')}</div></div>`) +
    bind(() => {
      for (const b of $$('[data-inst]')) b.onclick = () => installReview(app, entries.find((e) => e.key === b.dataset.inst));
      for (const b of $$('[data-uninst]'))
        b.onclick = () => {
          modal(`Uninstall ${b.dataset.uninst}`, `<p>Its lines leave ${esc(appName(app))}’s switchboard at once and its skills stop loading. <b>Its tables and data are kept</b>; re-installing brings it back. Dropping the tables is a separate, audited platform action.</p>`, `<button class="btn" id="uc">Cancel</button><button class="btn danger" id="us">Uninstall</button>`);
          $('#uc').onclick = closeLayer;
          $('#us').onclick = async () => {
            try {
              await api('/api/registry/installs', { method: 'DELETE', body: { host_app: app, entry_key: b.dataset.uninst } });
              closeLayer();
              toast('Uninstalled. Tables kept.');
              S.lines[app] = null;
              render(true);
            } catch (e) {
              fail(e);
            }
          };
        };
      for (const b of $$('[data-diff]')) b.onclick = () => modal('Diff to review', `<pre class="mono">${esc(reviews.reviews.find((r) => r.id === b.dataset.diff)?.diff ?? '')}</pre>`, '', true);
      for (const b of $$('[data-pub]'))
        b.onclick = async () => {
          const r = reviews.reviews.find((x) => x.id === b.dataset.pub);
          try {
            await api(`/api/registry/reviews/${r.id}/answer`, { method: 'POST', body: { decision: 'yes', fingerprint_seen: r.fingerprint } });
            toast('Signed and published.');
            render(true);
          } catch (e) {
            fail(e);
          }
        };
    })
  );
};
function installReview(app, e) {
  const offers = Array.isArray(e.offers) ? e.offers : [];
  modal(
    `Install ${e.key} v${e.latest} into ${appName(app)}`,
    `<p>Nothing is added silently. Installing will:</p><ul>${offers.map((o) => `<li>add <b>${esc(o.key)}</b> to ${esc(appName(app))}’s switchboard as a ${esc(o.kind)}, starting at <b>${esc(SETTING[o.floor] ?? o.floor)}</b> — you can tighten it, never loosen it</li>`).join('')}
     ${(e.requires ?? []).map((r) => `<li>let it use <b>${esc(r)}</b></li>`).join('')}
     ${e.kind === 'package' ? `<li>create its own tables inside ${esc(appName(app))}’s book (the migration runner does this; nothing runs until it has)</li><li>run its code in a sandbox with no network, files or environment — only its own tables and the doors it was granted</li>` : `<li>load its know-how into the assistant only while every tool it needs is switched on</li>`}</ul>
     <p class="note">Signed ${e.signed ? '✓' : '✗'} · content ${esc(short(e.content_hash))}</p>`,
    `<button class="btn" id="ic">Cancel</button><button class="btn lime" id="is">Install</button>`,
  );
  $('#ic').onclick = closeLayer;
  $('#is').onclick = async () => {
    try {
      const r = await api('/api/registry/installs', { method: 'POST', body: { host_app: app, entry_key: e.key, version: e.latest } });
      closeLayer();
      toast(r.status === 'pending_migration' ? 'Installed — waiting for its migration to run.' : 'Installed.');
      S.lines[app] = null;
      render(true);
    } catch (err) {
      fail(err);
    }
  };
}

// ── other apps (WP §9) ─────────────────────────────────────────────────────
VIEWS.apps = async () => {
  const app = S.app;
  await loadLines(app);
  if (!isAdmin()) return head('Apps', 'Which apps may ask which for what.') + `<div class="card"><div class="card-b">${empty('Admins only')}</div></div>`;
  const { acl, installed_apps } = await api(`/api/acl?app=${encodeURIComponent(app)}`);
  await refreshLive();
  const others = installed_apps.filter((a) => a.key !== app);
  const toApp = acl.filter((a) => a.target_app === app);
  const fromApps = S.tasks.filter((t) => t.app_key === app && String(t.requester).startsWith('app:'));
  const borrowable = [...L(app).abilities.filter((l) => l.kind === 'read' && l.from === 'own').map((l) => [l.key, l.title]), ['tasks.open', `Hand ${appName(app)} a whole task`]];
  return (
    head('Apps', `Other NEOS apps at your company can ask ${esc(appName(app))} things — through the gateway, typed and signed, written in both record books. Another app can never approve anything: a yes always comes from a person.`, `${appSwitch('apps')}${others.length ? `<button class="btn lime" id="new-acl">${ic('plus', 15)} Allow an app</button>` : ''}`) +
    `<div class="card"><div class="card-h"><span class="ico violet">${ic('apps', 18)}</span><h3>Who may ask ${esc(appName(app))}</h3><span class="count">${toApp.length}</span></div>
      ${toApp.length ? `<table class="t"><thead><tr><th>App</th><th>May ask for</th><th class="hide-sm">Granted</th><th></th></tr></thead><tbody>${toApp.map((a, i) => `<tr><td><b>${esc(appName(a.caller_app))}</b></td><td>${esc(a.ability_key === 'tasks.open' ? 'whole tasks' : titleOf(a.ability_key, app))}</td><td class="hide-sm">${esc(a.granted_by_name ?? '—')} · ${esc(ago(a.granted_at))}</td><td class="r"><button class="btn sm danger" data-revoke="${i}">Revoke</button></td></tr>`).join('')}</tbody></table>` : `<div class="card-b">${empty(others.length ? `No app may ask ${appName(app)} anything yet` : `${appName(app)} is the only app installed`, others.length ? '' : 'When another NEOS app is installed, you decide here what it may ask for.')}</div>`}</div>` +
    `<div class="card"><div class="card-h"><span class="ico blue">${ic('jobs', 18)}</span><h3>Jobs other apps gave ${esc(appName(app))}</h3><span class="count">${fromApps.length}</span></div>${fromApps.length ? fromApps.map(jobCard).join('') : `<div class="card-b"><p class="muted">None yet. A task from another app is opened as a job like any other, runs on the stricter of the two switchboards, and any yes still comes from a person.</p></div>`}</div>` +
    bind(() => {
      for (const b of $$('[data-revoke]'))
        b.onclick = async () => {
          const a = toApp[Number(b.dataset.revoke)];
          try {
            await api('/api/acl', { method: 'DELETE', body: { caller_app: a.caller_app, target_app: a.target_app, ability_key: a.ability_key } });
            toast('Revoked.');
            render(true);
          } catch (e) {
            fail(e);
          }
        };
      const n = $('#new-acl');
      if (n)
        n.onclick = () => {
          modal(`Allow an app to ask ${appName(app)}`, `<form id="af"><label class="f">App</label><select class="i" name="caller">${others.map((o) => `<option value="${esc(o.key)}">${esc(o.name ?? o.key)}</option>`).join('')}</select><label class="f">May ask for</label><select class="i" name="ability">${borrowable.map(([k, t]) => `<option value="${esc(k)}">${esc(t)}</option>`).join('')}</select></form><p class="note">Only reads can be borrowed. Anything that changes the book is a task — the owner’s gate and your approvals still apply.</p>`, `<button class="btn" id="ac">Cancel</button><button class="btn lime" id="as">Allow</button>`);
          $('#ac').onclick = closeLayer;
          $('#as').onclick = async () => {
            const d = new FormData($('#af'));
            try {
              await api('/api/acl', { method: 'POST', body: { caller_app: d.get('caller'), target_app: app, ability_key: d.get('ability') } });
              closeLayer();
              toast('Allowed.');
              render(true);
            } catch (e) {
              fail(e);
            }
          };
        };
    })
  );
};

// ── the audit trail (WP §8) ────────────────────────────────────────────────
const AUDIT_FILTERS = [['', 'Everything'], ['desk.answer', 'Answers'], ['proposal.executed', 'Carried out'], ['grant.', 'Standing yeses'], ['switchboard.changed', 'Switchboard'], ['vault.', 'Keys'], ['l3.', 'Calls into apps'], ['app.operation', 'Operations'], ['gateway.denied', 'Refused'], ['acl.', 'App permissions'], ['registry.', 'Registry']];
const actorOf = (x) => x.actor_name ?? String(x.actor ?? '').replace(/^app:(.*)/, (_, a) => `app · ${appName(a)}`).replace(/^grant:.*/, 'standing yes').replace(/^user:.*/, 'a person');
const auditTable = (rows) =>
  rows.length
    ? `<table class="t"><thead><tr><th>When</th><th>Who</th><th>App</th><th>What</th><th class="hide-sm">Ability / door</th><th>Outcome</th></tr></thead><tbody>${rows.map((x) => `<tr title="${esc(JSON.stringify(x.detail ?? {}))}"><td>${esc(when(x.at))}</td><td>${esc(actorOf(x))}</td><td>${esc(x.app_key ? appName(x.app_key) : '—')}</td><td class="mono">${esc(x.action)}</td><td class="hide-sm mono">${esc(x.ability_key ?? '')}</td><td>${esc(x.outcome ?? '')}</td></tr>`).join('')}</tbody></table>`
    : `<div class="card-b">${empty('Nothing recorded for this filter')}</div>`;
VIEWS.audit = async () => {
  if (!isAdmin()) return head('Audit', 'Every action taken on your data.') + `<div class="card"><div class="card-b">${empty('Admins only')}</div></div>`;
  const f = S.query.get('a') ?? '';
  const q = (before) => `/api/audit?limit=150${f ? `&action=${encodeURIComponent(f)}` : ''}${before ? `&before=${before}` : ''}`;
  const r = await api(q());
  const rows = [...r.rows];
  return (
    head('Audit trail', 'One trail for every app: every call through the gateway, every yes, every carry-out, every key lent, every change to a switchboard. Written once; nobody can edit it.', `<button class="btn" id="csv">${ic('down', 15)} Export CSV</button>`) +
    `<div class="seg">${AUDIT_FILTERS.map(([k, l]) => `<button data-af="${esc(k)}" aria-pressed="${k === f}">${esc(l)}</button>`).join('')}</div>` +
    `<div class="card"><div id="audit-rows">${auditTable(rows)}</div>${r.next_before ? `<div class="card-b"><button class="btn sm" id="more">Load older</button></div>` : ''}</div>` +
    bind(() => {
      for (const b of $$('[data-af]')) b.onclick = () => (location.hash = `#/audit${b.dataset.af ? `?a=${encodeURIComponent(b.dataset.af)}` : ''}`);
      $('#csv').onclick = () => csv(`neos-audit-${today()}.csv`, [['at', 'who', 'app', 'action', 'ability', 'outcome', 'idempotency_key', 'detail'], ...rows.map((x) => [x.at, actorOf(x), x.app_key ?? '', x.action, x.ability_key ?? '', x.outcome ?? '', x.idem_key ?? '', JSON.stringify(x.detail ?? {})])]);
      let before = r.next_before;
      const more = $('#more');
      if (more)
        more.onclick = async () => {
          const next = await api(q(before));
          rows.push(...next.rows);
          before = next.next_before;
          $('#audit-rows').innerHTML = auditTable(rows);
          if (!before) more.remove();
        };
    })
  );
};

VIEWS.team = async () => {
  if (!isAdmin()) return head('Team', 'People who use NEOS.') + `<div class="card"><div class="card-b">${empty('Admins only')}</div></div>`;
  const { users } = await api('/api/users');
  return (
    head('Team', 'People who can ask the apps and answer their requests. Who may approve is set per app on its switchboard.') +
    `<div class="card"><table class="t"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th class="hide-sm">Since</th></tr></thead><tbody>${users.map((u) => `<tr><td><b>${esc(u.name)}</b>${u.id === S.me.id ? ` ${pill('you', 'blue')}` : ''}</td><td class="muted">${esc(u.email)}</td><td>${pill(u.role, u.role === 'admin' ? 'violet' : 'gray')}</td><td class="hide-sm">${esc(longDay(new Date(u.created_at).toISOString().slice(0, 10)))}</td></tr>`).join('')}</tbody></table></div>
     <p class="note">People are added by your NEOS operator (<span class="mono">scripts/ops.ts create-user</span>); each gets a desk token shown once and stored only as a hash.</p>`
  );
};

// ── modals, csv, period, help, find, theme ─────────────────────────────────
function modal(title, body, foot = '', wide = false) {
  $('#layer').innerHTML = `<div class="scrim" id="scrim"><div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="mh"><h2>${esc(title)}</h2><button class="icon-btn x" id="mx" aria-label="Close">${ic('x', 15)}</button></div><div class="mb">${body}</div>${foot ? `<div class="mf">${foot}</div>` : ''}</div></div>`;
  $('#mx').onclick = closeLayer;
  $('#scrim').onclick = (e) => e.target.id === 'scrim' && closeLayer();
  setTimeout(() => $('.modal input:not([type=hidden]), .modal select, .modal textarea')?.focus(), 20);
}
function closeLayer() {
  $('#layer').innerHTML = '';
}
function csv(name, rows) {
  const text = rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function periodPicker() {
  const now = today().slice(0, 7);
  const months = Array.from({ length: 15 }, (_, i) => addMonths(now, -i));
  modal('Choose the month you are looking at', `<div class="grid g3">${months.map((m) => `<button class="btn${m === S.period ? ' lime' : ''}" data-m="${m}">${esc(monthFull(m))}</button>`).join('')}</div>`);
  for (const b of $$('[data-m]'))
    b.onclick = () => {
      S.period = b.dataset.m;
      sessionStorage.setItem('neos.period', S.period);
      closeLayer();
      paintCompany();
      render();
    };
}
function meMenu() {
  modal(S.me.name, `<div class="kv"><span>Company</span><b>${esc(S.me.company?.name ?? '')}</b></div><div class="kv"><span>Role</span><b>${esc(S.me.role)}</b></div><div class="kv"><span>Time zone</span><b>${esc(S.me.company?.time_zone ?? '')}</b></div><div class="kv"><span>Apps</span><b>${esc(S.apps.map((a) => a.name).join(', '))}</b></div>`, `<button class="btn" id="lo">${ic('logout', 15)} Sign out</button>`);
  $('#lo').onclick = async () => {
    await fetch('/auth/logout', { method: 'POST', headers: { 'x-neos-web': '1' } });
    location.replace('/login');
  };
}
function help() {
  modal(
    'How NEOS apps work',
    `<p><b>One app per subject, one assistant you can talk to — and a book it cannot lie to.</b></p>
     <ol><li><b>You ask.</b> NEOS hands it to the right app; it becomes a <a href="#/jobs">job</a> in that app’s record book, and the app says “on it” at once.</li>
     <li><b>A fresh assistant works it</b>, one step at a time, writing every step down. It holds no keys and no database access; it can only ask the app’s gate.</li>
     <li><b>The gate decides</b> from the <a href="#/switchboard">switchboard</a>: on → do it; ask first → write a proposal and pause; off → refuse. Company rules and spend caps are checked here too.</li>
     <li><b>You answer</b> under <a href="#/approvals">Approvals</a> or in the chat. A yes binds to the fingerprint of exactly what you saw, and has a clock.</li>
     <li><b>The app carries it out once</b>, itself, on the platform’s say-so — no model in the loop — and reads it back.</li>
     <li><b>A fresh assistant is woken</b> with the proof, checks it, and reports what it did, what changed and what it could not do.</li></ol>
     <p class="note">Each app’s screens are its own blocks — descriptions, never code — drawn here by the desk. Shortcuts: <span class="mono">/</span> ask · <span class="mono">⌘K</span> find · <span class="mono">Esc</span> close</p>`,
  );
  for (const a of $$('#layer a')) a.addEventListener('click', closeLayer);
}
async function openSearch() {
  const pages = [...WORK, ...GOVERN].map(([k, l]) => ({ label: l, hint: 'page', go: () => (location.hash = `#/${k}`) }));
  for (const a of S.apps) {
    const blocks = await loadBlocks(a.key).catch(() => ({}));
    for (const [k, b] of Object.entries(blocks)) if (b.block === 'page') pages.push({ label: `${a.name} · ${b.nav?.label ?? k}`, hint: 'app page', go: () => (location.hash = `#/app/${a.key}/${k}`) });
  }
  $('#layer').innerHTML = `<div class="search" id="sx"><div class="box"><input id="sq" placeholder="Find a page or a job…" autocomplete="off"><ul id="sr"></ul></div></div>`;
  $('#sx').onclick = (e) => e.target.id === 'sx' && closeLayer();
  const items = pages.concat(S.tasks.slice(0, 40).map((t) => ({ label: t.ask, hint: `job · ${appName(t.app_key)} · ${String(t.status).toLowerCase()}`, go: () => (location.hash = `#/jobs/${t.id}`) })));
  const paint = () => {
    const q = $('#sq').value.trim().toLowerCase();
    const hits = items.filter((i) => !q || i.label.toLowerCase().includes(q) || i.hint.toLowerCase().includes(q)).slice(0, 12);
    $('#sr').innerHTML = hits.map((h, i) => `<li><button data-i="${i}"${i === 0 ? ' class="on"' : ''}><span>${esc(h.label)}</span><span class="faint">${esc(h.hint)}</span></button></li>`).join('') || `<li class="empty">Nothing found. Press Enter to ask.</li>`;
    for (const b of $$('#sr [data-i]')) b.onclick = () => (closeLayer(), hits[Number(b.dataset.i)].go());
    return hits;
  };
  $('#sq').oninput = paint;
  $('#sq').onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const hits = paint();
    const q = $('#sq').value.trim();
    closeLayer();
    if (hits[0]) hits[0].go();
    else if (q) askNeos(q);
  };
  $('#sq').focus();
  paint();
}
const currentTheme = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function themeIcon() {
  $('#btn-theme').innerHTML = ic(currentTheme() === 'dark' ? 'sun' : 'moon', 17);
}
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('neos.theme', next);
  } catch {
    /* private mode */
  }
  themeIcon();
}

// ── boot ───────────────────────────────────────────────────────────────────
function paintCompany() {
  $('#co').innerHTML = `<b>${esc(S.me.company?.name ?? 'Company')}</b><span>${esc(monthLabel(S.period))} ⌄</span>`;
}
(async function boot() {
  try {
    const t = localStorage.getItem('neos.theme');
    if (t) document.documentElement.dataset.theme = t;
  } catch {
    /* ignore */
  }
  S.period = sessionStorage.getItem('neos.period') || S.period;
  shell();
  try {
    S.me = await api('/api/me');
    paintCompany();
    S.apps = (await api('/api/registry')).apps.map((a) => ({ key: a.key, name: a.name, subject: a.subject }));
    S.app = S.apps[0]?.key ?? null;
    paintRail();
    if (S.app) await loadLines(S.app);
  } catch (e) {
    $('#main').innerHTML = `<div class="head"><div><h1>NEOS is not available</h1><p>${esc(e.message)}</p></div></div>`;
    return;
  }
  route();
  refreshLive();
  setInterval(refreshLive, 4000);
  setInterval(tickClocks, 30_000);
  if (S.conv) stream();
})();
