// Ledger · a NEOP console. Built from the NEOP plan, not from the old operator app:
//  · the job is the unit — ask, "on it", steps, waiting, carried out, reported;
//  · the gate and the switchboard — floor, company setting, in force; company rules; spend caps;
//  · proposals bound to a fingerprint, with a clock, answered once, carried out exactly once;
//  · standing yeses, doors and the key vault, packages and skills, other apps, one audit trail;
//  · every figure says where it came from.
// Nothing here writes to the books: a change is an ask; the assistant proposes; a person answers.
// Governance (the platform's rows) is changed directly by admins. The page holds no credential.
'use strict';

// ── helpers ────────────────────────────────────────────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const INR2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
const money = (minor, exact = false) => (minor == null ? '—' : (exact ? INR2 : INR).format(Number(minor) / 100));
const usd = (n) => `$${Number(n ?? 0).toFixed(Number(n) < 1 ? 3 : 2)}`;
const signed = (minor) => `<span class="num ${minor > 0 ? 'pos' : 'neg'}">${minor > 0 ? '+' : minor < 0 ? '−' : ''}${money(Math.abs(minor), true)}</span>`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const day = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}` : '—');
const longDay = (iso) => (iso ? `${day(iso)} ${iso.slice(0, 4)}` : '—');
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
const range = (p) => {
  const [y, m] = p.split('-').map(Number);
  return { from: `${p}-01`, to: iso(new Date(y, m, 0)) };
};
const addMonths = (p, n) => {
  const [y, m] = p.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const quarterOf = (p) => {
  const [y, m] = p.split('-').map(Number);
  const q0 = Math.floor((m - 1) / 3) * 3 + 1;
  return { from: `${y}-${pad(q0)}-01`, to: iso(new Date(y, q0 + 2, 0)), label: `${MONTHS[q0 - 1]}–${MONTHS[q0 + 1]} ${y}` };
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
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
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
  bank: '<path d="M3 10 12 4l9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
  send: '<path d="m22 2-9.5 9.5M22 2 15 22l-3.5-8.5L3 10z"/>',
  file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
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
const ic = (n, s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] ?? ''}</svg>`;

// ── state ──────────────────────────────────────────────────────────────────
const S = {
  me: null,
  lines: [], // switchboard lines: own + package abilities, with floor / company / in force
  doors: [],
  sbVersion: 0,
  period: today().slice(0, 7),
  route: ['today'],
  query: new URLSearchParams(),
  pending: [],
  tasks: [],
  conv: sessionStorage.getItem('ledger.conv') || null,
  lastMsg: 0,
  es: null,
  seq: 0,
  sig: '',
};
const isAdmin = () => S.me?.role === 'admin';
const line = (k) => S.lines.find((a) => a.key === k);
const titleOf = (k) => line(k)?.title ?? k.replace(/^ledger\./, '');

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
const read = async (ability, args = {}) => (await api(`/api/apps/ledger/read/${ability}`, { method: 'POST', body: args })).result;

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
const RAIL = [
  ['WORK', [['today', 'Today', 'home'], ['jobs', 'Jobs', 'jobs'], ['approvals', 'Approvals', 'inbox']]],
  ['SUBJECT', [['books', 'Books', 'book']]],
  ['GOVERN', [['switchboard', 'Switchboard', 'sliders'], ['grants', 'Standing yes', 'check'], ['connections', 'Doors', 'key'], ['packages', 'Packages', 'box'], ['apps', 'Apps', 'apps'], ['audit', 'Audit', 'scroll'], ['team', 'Team', 'team']]],
];
const BOOKS = [
  ['overview', 'Overview'],
  ['transactions', 'Transactions'],
  ['reconcile', 'Reconcile'],
  ['money', 'Money'],
  ['close', 'Close'],
  ['reports', 'Reports'],
  ['tax', 'GST'],
  ['accounts', 'Accounts'],
  ['rules', 'Coding rules'],
];

function shell() {
  $('#rail').innerHTML =
    RAIL.map(([h, items], n) => `${n ? '<div class="sep"></div>' : ''}<h6>${h}</h6>${items.map(([k, label, i]) => `<button class="rail-item" data-go="${k}" title="${label}">${ic(i, 17)}<span>${label}</span>${k === 'approvals' ? '<i class="dot hidden" id="appr-dot"></i>' : ''}</button>`).join('')}`).join('') +
    `<div class="grow"></div><button class="rail-item" data-go="help" title="How Ledger works">${ic('help', 17)}<span>Help</span></button><button class="avatar" id="me-btn" title="You"></button>`;
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
    askLedger(v);
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
  $('#me-btn').onclick = meMenu;
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
  S.route = path.split('/').filter(Boolean);
  S.query = new URLSearchParams(q ?? '');
  if (!VIEWS[S.route[0]]) S.route = ['today'];
  for (const b of $$('.rail [data-go]')) {
    if (b.dataset.go === S.route[0]) b.setAttribute('aria-current', 'page');
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
    after();
    if (quiet) window.scrollTo(0, y);
  } catch (e) {
    if (seq !== S.seq) return;
    main.innerHTML = `<div class="head"><div><h1>Something went wrong</h1><p>${esc(e.message)}</p></div></div><button class="btn" id="retry">${ic('refresh', 15)} Try again</button>`;
    $('#retry').onclick = () => render();
  }
}
// A view binds its handlers through markers in its own HTML, so a slow view that a newer
// navigation has overtaken can never bind into the page that replaced it.
const binders = new Map();
let bindSeq = 0;
const bind = (fn) => {
  const id = ++bindSeq;
  binders.set(id, fn);
  return `<template data-b="${id}"></template>`;
};
function after() {
  for (const el of $$('[data-w]')) el.style.width = `${Math.max(0, Math.min(100, Number(el.dataset.w)))}%`;
  const ids = $$('#main template[data-b]').map((t) => Number(t.dataset.b));
  for (const id of ids) {
    const fn = binders.get(id);
    binders.delete(id);
    fn?.();
  }
  if (ids.length) for (const id of [...binders.keys()]) if (id < ids[0]) binders.delete(id); // stale views' handlers
  tickClocks();
}
const head = (title, sub, right = '', live = false) => `<div class="head"><div><h1>${live ? '<i class="live"></i>' : ''}${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="right">${right}</div></div>`;
const empty = (title, text = '') => `<div class="empty"><b>${esc(title)}</b>${text}</div>`;
const pill = (text, tone = 'gray') => `<span class="pill ${tone}">${esc(text)}</span>`;
const src = (r) => (r?.sources ? `<div class="src">${ic('book', 11)} ${esc(r.sources.basis)} · ${plural(r.sources.entries ?? 0, 'entry')} · generated ${esc(when(r.generatedAt))}${r.empty ? ' · nothing recorded yet' : ''}</div>` : '');
const SETTING = { on: 'Automatic', ask_first: 'Ask first', off: 'Off' };
const settingPill = (s) => pill(SETTING[s] ?? s, s === 'on' ? 'green' : s === 'ask_first' ? 'amber' : 'gray');

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
    // Re-draw the pages that show live work when it changed.
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

// ── the job lifecycle (WP §3, §5: asked · on it · working · waiting · carried out · reported) ──
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
    const answeredNo = approvals && !pend && !executed.length && approvals.every((a) => a.decision && a.decision !== 'yes' || a.status === 'EXPIRED');
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
const who = (req) => (String(req).startsWith('app:') ? `the ${req.slice(4)} app` : String(req).startsWith('user:') ? (req.slice(5) === S.me.id ? 'you' : 'a colleague') : req);

// ── asking: the one way anything changes ──────────────────────────────────
function askLedger(text, { open = true } = {}) {
  if (open) toggleChat(true);
  return sendAsk(text);
}
async function sendAsk(text) {
  $('#chat-in').value = '';
  $('#chat-sugg').innerHTML = '';
  addMsg({ author: `user:${S.me.id}`, kind: 'message', body: text });
  typing(true);
  try {
    const r = await api('/api/ask', { method: 'POST', body: { text, app: 'ledger', conversation_id: S.conv ?? undefined } });
    if (r.conversation_id && r.conversation_id !== S.conv) {
      S.conv = r.conversation_id;
      sessionStorage.setItem('ledger.conv', S.conv);
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
  addMsg({ author: 'app:ledger', kind: 'message', body: `Hi ${S.me.name.split(' ')[0]}. Each thing you ask becomes a job in my record book. I work it step by step; anything that changes the books or leaves the company waits for a yes — and a yes covers exactly what you saw.` });
  $('#chat-sugg').innerHTML = ['How are the books this month?', 'What do customers owe us?', 'Chase overdue invoices', `Close ${monthLabel(S.period)}`].map((s) => `<button type="button">${esc(s)}</button>`).join('');
  for (const b of $$('#chat-sugg button')) b.onclick = () => sendAsk(b.textContent);
}
function newConversation() {
  S.es?.close();
  S.es = null;
  S.conv = null;
  S.lastMsg = 0;
  sessionStorage.removeItem('ledger.conv');
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
  // Same answer from anywhere (WP §5): a card raised in the conversation can be answered right here.
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
  const l = line(c.ability_key);
  const canGrant = isAdmin() && l?.kind === 'write';
  const shownArgs = Object.fromEntries(Object.entries(c.args ?? {}).filter(([k]) => k !== 'card'));
  return `<article class="prop" data-card="${esc(c.id)}">
    <div class="chips"><span class="chip">${ic('bolt', 13)} ${esc(titleOf(c.ability_key))}</span>${l?.effects?.external ? pill('leaves the company', 'violet') : ''}${l?.effects?.money ? pill('money', 'amber') : ''}
      ${argsChips(c.args ?? {}).map((x) => `<span class="chip">${esc(x)}</span>`).join('')}
      <span class="conf">${c.expires_at ? `<span class="clock" data-exp="${esc(c.expires_at)}">${ic('clock', 12)}<span> ${esc(left(c.expires_at))}</span></span>` : ''}</span></div>
    <h4>${esc(card.what ?? titleOf(c.ability_key))}</h4>
    ${compact ? '' : `<dl>${card.why ? `<dt>Why</dt><dd>${esc(card.why)}</dd>` : ''}${card.changes ? `<dt>What changes</dt><dd>${esc(card.changes)}</dd>` : ''}${card.if_no_answer ? `<dt>If nobody answers</dt><dd>${esc(card.if_no_answer)}</dd>` : ''}${c.task_ask ? `<dt>From the job</dt><dd><a href="#/jobs/${esc(c.task_id)}">${esc(c.task_ask)}</a></dd>` : ''}</dl>`}
    <details><summary class="note">Exactly what you are approving</summary><pre class="mono">${esc(JSON.stringify(shownArgs, null, 2))}</pre></details>
    <textarea class="i hidden" rows="2" placeholder="What should change? Ledger writes a new proposal; this one is superseded."></textarea>
    <div class="foot">
      <span class="fp" title="A yes binds to this fingerprint. If the proposal changes, it must be asked again.">${ic('fp', 12)} ${esc(short(c.fingerprint))}</span>
      <span class="bind">your yes covers exactly this version</span><span class="grow"></span>
      <button class="btn sm" data-a="no">Decline</button>
      <button class="btn sm" data-a="change">Change first</button>
      ${canGrant && !compact ? `<button class="btn sm" data-a="always" title="Approve, and let Ledger do this within limits without asking">Approve &amp; always allow…</button>` : ''}
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
        if (decision === 'always') return grantForm({ ability_key: c.ability_key, args: c.args, card: c });
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
        }
      };
    }
  }
}
async function answer(c, decision, feedback = '') {
  await api(`/api/desk/${encodeURIComponent(c.id)}/answer`, { method: 'POST', body: { decision, fingerprint_seen: c.fingerprint, ...(decision === 'change' ? { feedback } : {}) } });
  toast(decision === 'yes' ? 'Approved. Ledger carries it out once, reads it back, then reports.' : decision === 'no' ? 'Declined. Nothing changed.' : 'Sent back. Ledger will write a new proposal.');
  await refreshLive();
}
// What happened to an approval, in the words of the trail: answered → done · verified / dropped.
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

// ── views ──────────────────────────────────────────────────────────────────
const VIEWS = {};

VIEWS.today = async () => {
  const t = today();
  const [accts, bank, ar, bills, usage, grants, vault, periods] = await Promise.all([
    read('ledger.accounts.list', {}),
    read('ledger.bank.unreconciled', {}),
    read('ledger.report.aging', { kind: 'receivable', as_of: t }),
    read('ledger.documents.list', { kind: 'bill', status: 'open' }),
    api('/api/usage/ledger'),
    api('/api/grants'),
    isAdmin() ? api('/api/vault').catch(() => null) : null,
    read('ledger.periods.status', {}),
    refreshLive(),
  ]);
  const cash = accts.accounts.filter((a) => ['bank', 'cash'].includes(a.subtype)).reduce((s, a) => s + a.balance_minor, 0);
  const overdue = ar.items.filter((i) => i.days_past_due > 0);
  const in7 = iso(new Date(Date.now() + 7 * 864e5));
  const apDue = bills.documents.filter((d) => d.due_date <= in7);
  const working = S.tasks.filter((x) => LIVE.includes(x.status));
  const finished = S.tasks.filter((x) => !LIVE.includes(x.status)).slice(0, 4);
  const askFirst = S.lines.filter((l) => l.kind === 'write' && l.setting === 'ask_first').length;
  const activeGrants = grants.grants.filter((g) => g.status === 'ACTIVE' && !g.expired);
  const doors = new Set((vault?.doors ?? []).map((d) => d.door));
  const first = S.me.name.replace(/\(.*\)/, '').trim().split(' ')[0];
  const hr = new Date().getHours();
  const setupLeft = [accts.accounts.length === 0, bank.transactions.length === 0 && cash === 0, vault && !doors.has('email'), periods.closed.length === 0].filter(Boolean).length;
  return (
    `<div class="card hero"><h2>Good ${hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : 'evening'}, ${esc(first)}</h2>
      <p>Ledger keeps ${esc(S.me.company?.name ?? 'your')} books. Ask for anything — it opens a job, works it step by step, and asks you before it changes the books or sends anything out.</p>
      <form id="hero-f" autocomplete="off"><input class="i" id="hero-in" placeholder="e.g. “record the Kapoor Traders payment” · “how much cash will we have next month?” · “close ${monthLabel(S.period)}”" maxlength="2000"><button class="btn lime" type="submit">${ic('send', 15)} Ask</button></form>
      <div class="sugg">${['How are the books this month?', 'Chase overdue invoices', 'Reconcile the bank', `Draft the ${monthLabel(S.period)} close`, 'What needs my attention?'].map((s) => `<button type="button" data-sugg>${esc(s)}</button>`).join('')}</div></div>` +
    bind(() => {
      $('#hero-f').onsubmit = (e) => {
        e.preventDefault();
        const v = $('#hero-in').value.trim();
        if (v) askLedger(v);
      };
      for (const b of $$('[data-sugg]')) b.onclick = () => askLedger(b.textContent);
    }) +
    `<div class="trust" aria-label="Why you can trust what Ledger does">
      <a href="#/switchboard">${ic('sliders', 14)} Switchboard <b>v${S.sbVersion}</b></a>
      <a href="#/switchboard">${ic('shield', 14)} <b>${askFirst}</b> actions ask first</a>
      <a href="#/grants">${ic('check', 14)} <b>${activeGrants.length}</b> standing ${activeGrants.length === 1 ? 'yes' : 'yeses'}</a>
      ${vault ? `<a href="#/connections">${ic('key', 14)} Doors: ${S.doors.map((d) => `${esc(d.key.replace('_', ' '))} ${doors.has(d.key) ? '✓' : '✗'}`).join(' · ')}</a>` : ''}
      <a href="#/switchboard">${ic('sparkle', 14)} Assistant today <b>${usd(usage.today_usd)}</b> of ${usd(usage.per_day_cap_usd)}</a>
      <span class="t">${ic('lock', 14)} Keys held by the assistant: <b>none</b></span>
    </div>` +
    `<div class="card" id="needs"><div class="card-h"><span class="ico violet">${ic('inbox', 18)}</span><h3>Waiting on you</h3><span class="count">${S.pending.length}</span>
      <div class="right"><a class="btn sm" href="#/approvals">All approvals ${ic('arrow', 13)}</a></div></div>
      <div class="card-b">${S.pending.length ? S.pending.slice(0, 3).map((c) => cardHtml(c)).join('') + (S.pending.length > 3 ? `<p class="note"><a href="#/approvals">${S.pending.length - 3} more waiting</a></p>` : '') : empty('Nothing waiting on you', 'When Ledger proposes something — an invoice, a payment, closing a month — the job pauses here until you answer.')}</div></div>` +
    bind(() => bindCards(S.pending)) +
    `<div class="card"><div class="card-h"><span class="ico blue">${ic('jobs', 18)}</span><h3>Working now</h3><span class="count">${working.length}</span><div class="right"><a class="btn sm" href="#/jobs">All jobs ${ic('arrow', 13)}</a></div></div>
      ${working.length ? working.map(jobCard).join('') : `<div class="card-b">${empty('No jobs running', 'Ask Ledger something above; you’ll see it here — on it, working, waiting, carried out, reported.')}</div>`}</div>` +
    `<div class="grid g4">
      ${kpi(money(cash), 'c-green', 'bank', 'Cash on hand', `${plural(accts.accounts.filter((a) => a.subtype === 'bank').length, 'bank account')}`, 'books/accounts', accts)}
      ${kpi(bank.transactions.length, 'c-orange', 'swap', 'Bank lines to match', 'Imported, not yet in the books', 'books/reconcile', bank)}
      ${kpi(money(overdue.reduce((s, i) => s + i.outstanding_minor, 0)), 'c-red', 'send', 'Overdue from customers', `${plural(overdue.length, 'invoice')} past due`, 'books/money', ar)}
      ${kpi(money(apDue.reduce((s, d) => s + d.outstanding_minor, 0)), 'c-violet', 'wallet', 'Bills due in 7 days', `${plural(apDue.length, 'bill')}`, 'books/money?bills', bills)}
    </div>` +
    (finished.length ? `<div class="card"><div class="card-h"><span class="ico teal">${ic('check', 18)}</span><h3>Recently reported</h3></div>${finished.map(jobCard).join('')}</div>` : '') +
    (setupLeft ? `<div class="card setup"><span class="ico lime">${ic('gear', 18)}</span><div class="grow"><h3>Finish setting up <small>${plural(setupLeft, 'step')} left</small></h3><p>Import a statement, connect email, close your first month.</p></div><a class="btn dark" href="#/setup">Continue ${ic('arrow', 14)}</a></div>` : '')
  );
};
function kpi(value, tone, icon, label, sub, go, r) {
  return `<div class="card kpi"><a href="#/${go}" class="well ${tone}">${esc(value)}</a><div class="lbl">${ic(icon, 15)} ${esc(label)}</div><div class="sub">${esc(sub)}</div>${src(r)}</div>`;
}
function jobCard(t) {
  const res = t.result;
  return `<div class="jobcard"><div class="top"><b><a href="#/jobs/${esc(t.id)}">${esc(t.ask)}</a></b>${statusPill(t.status)}</div>
    <div class="meta">asked by ${esc(who(t.requester))} · ${esc(ago(t.created_at))} · ${plural(Number(t.steps ?? 0), 'step')}${Number(t.cost_micros) ? ` · ${usd(Number(t.cost_micros) / 1e6)}` : ''}${t.origin && t.origin !== 'app' ? ` · via ${esc(t.origin)}` : ''}</div>
    ${stepper(t)}
    ${res?.summary ? `<div class="meta">${esc(res.summary)}</div>` : ''}</div>`;
}

VIEWS.jobs = async (id) => {
  if (id) return jobDetail(id);
  await refreshLive();
  const f = S.query.get('f') ?? 'all';
  const groups = {
    all: () => true,
    working: (t) => ['OPEN', 'ACKNOWLEDGED'].includes(t.status),
    waiting: (t) => t.status === 'WAITING' || t.pending_approvals > 0,
    done: (t) => t.status === 'COMPLETED',
    failed: (t) => ['FAILED', 'CANCELLED'].includes(t.status),
    apps: (t) => String(t.requester).startsWith('app:'),
  };
  const labels = { all: 'All', working: 'Working', waiting: 'Waiting on you', done: 'Reported', failed: 'Failed', apps: 'From other apps' };
  const rows = S.tasks.filter(groups[f] ?? groups.all);
  return (
    head('Jobs', 'The record book. Every ask becomes a job: Ledger replies “on it” at once, works one step at a time, pauses for a yes when the gate says so, and reports what it did, what changed and what it could not do.', '', true) +
    `<div class="seg">${Object.keys(labels).map((k) => `<button data-f="${k}" aria-pressed="${k === f}">${labels[k]} · ${S.tasks.filter(groups[k]).length}</button>`).join('')}</div>` +
    `<div class="card">${
      rows.length
        ? `<table class="t"><thead><tr><th>Job</th><th class="hide-sm">Asked by</th><th>State</th><th class="r hide-sm">Steps</th><th class="r hide-sm">Assistant cost</th><th class="hide-sm">When</th></tr></thead><tbody>${rows
            .map((t) => `<tr class="click" data-job="${esc(t.id)}"><td><b>${esc(t.ask)}</b>${t.result?.summary ? `<div class="note">${esc(t.result.summary.slice(0, 140))}</div>` : ''}</td><td class="hide-sm">${esc(who(t.requester))}</td><td>${statusPill(t.status)}${t.pending_approvals ? ` ${pill(`${t.pending_approvals} for you`, 'amber')}` : ''}</td><td class="r hide-sm">${t.steps}</td><td class="r hide-sm num">${usd(Number(t.cost_micros) / 1e6)}</td><td class="hide-sm">${esc(ago(t.created_at))}</td></tr>`)
            .join('')}</tbody></table>`
        : `<div class="card-b">${empty('No jobs here', 'Ask Ledger something with the bar at the top.')}</div>`
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
  const live = LIVE.includes(t.status);
  // One timeline from the platform's rows: the conversation, the mirrored steps, and every approval's trail.
  const ev = [{ at: t.created_at, cls: 'me', text: `Asked by ${who(t.requester)}`, sub: t.ask }];
  const KIND = { ack: 'On it', handoff: 'Handed to Ledger', waiting: 'Waiting for a yes', card: 'Asked a question', result: 'Reported', notice: 'Note' };
  for (const m of d.messages) if (!(m.kind === 'message' && String(m.author).startsWith('user:'))) ev.push({ at: m.at, cls: m.kind === 'result' ? (t.status === 'COMPLETED' ? 'ok' : 'bad') : m.kind === 'card' ? 'ask' : '', text: KIND[m.kind] ?? 'Message', sub: m.body });
  for (const a of d.activity) ev.push({ at: a.at, cls: /refus|denied|error|failed/i.test(a.summary) ? 'bad' : '', text: `Step ${a.seq}`, sub: a.summary });
  for (const a of d.approvals) {
    ev.push({ at: a.created_at, cls: 'ask', text: `Proposed: ${titleOf(a.ability_key)}`, sub: `${a.card?.what ?? ''} · fingerprint ${short(a.fingerprint)} · answer by ${when(a.expires_at)}` });
    if (a.decided_at)
      ev.push({
        at: a.decided_at,
        cls: a.decision === 'yes' ? 'ok' : a.decision === 'change' ? 'ask' : 'bad',
        text: `${{ yes: 'Approved', no: 'Declined', change: 'Change requested', withdraw: 'Withdrawn' }[a.decision] ?? a.decision} by ${a.decided_by_name ?? 'a person'}`,
        sub: `against fingerprint ${short(a.fingerprint_seen)} ${a.fingerprint_seen === a.fingerprint ? '✓ exactly what was shown' : '✗ not what was shown'}${a.feedback ? ` · “${a.feedback}”` : ''}`,
      });
    if (a.proof)
      ev.push({
        at: a.proof.at ?? a.decided_at,
        cls: a.proof.outcome === 'DONE' ? 'ok' : a.proof.outcome === 'UNKNOWN' ? 'ask' : 'bad',
        text: a.proof.outcome === 'DONE' ? 'Carried out once, and read back' : a.proof.outcome === 'UNKNOWN' ? 'Carried out — checking whether it happened' : 'Carry-out failed',
        sub: [a.proof.external_ref ? `ref ${a.proof.external_ref}` : '', a.proof.error ?? '', a.proof.reconcile_attempts ? `checked ${a.proof.reconcile_attempts} times` : ''].filter(Boolean).join(' · ') || 'by Ledger itself, on the platform’s say-so — no model in the loop',
      });
  }
  for (const g of d.grant_uses) ev.push({ at: g.at, cls: 'ok', text: `Allowed by a standing yes: ${titleOf(g.ability_key)}`, sub: g.detail?.amount_minor ? money(g.detail.amount_minor, true) : 'within its limits' });
  ev.sort((a, b) => new Date(a.at) - new Date(b.at));
  const r = t.result ?? {};
  const pend = d.approvals.filter((a) => a.status === 'PENDING').map((a) => ({ ...a, task_id: t.id }));
  const text = (x) => (typeof x === 'string' ? x : x?.what ?? x?.summary ?? x?.ref ?? x?.basis ?? x?.ability ?? JSON.stringify(x));
  return (
    head(t.ask, `asked by ${esc(who(t.requester))} ${esc(ago(t.created_at))}${t.origin ? ` · via ${esc(t.origin)}` : ''}`, `${statusPill(t.status)}${live ? `<button class="btn danger" id="cancel">Cancel job</button>` : ''}<a class="btn" href="#/jobs">All jobs</a>`) +
    `<div class="card"><div class="card-b">${stepper(t, d.approvals)}</div></div>` +
    (t.result
      ? `<div class="card"><div class="card-h"><span class="ico ${t.status === 'COMPLETED' ? 'green' : 'amber'}">${ic('check', 18)}</span><h3>What it reported</h3></div><div class="card-b">
          <p>${esc(r.summary ?? '')}</p>
          <div class="kv"><span>What changed</span><b>${r.changed?.length ? esc(r.changed.map(text).join(' · ')) : 'nothing in the books'}</b></div>
          ${r.could_not?.length ? `<div class="kv"><span>What it could not do</span><b class="c-red">${esc(r.could_not.map(text).join(' · '))}</b></div>` : ''}
          ${r.sources?.length ? `<div class="kv"><span>Where facts came from</span><b>${esc(r.sources.map(text).join(' · '))}</b></div>` : ''}
        </div></div>`
      : '') +
    (pend.length ? `<div class="card"><div class="card-h"><span class="ico violet">${ic('inbox', 18)}</span><h3>Waiting on you</h3></div><div class="card-b">${pend.map((a) => cardHtml(a)).join('')}</div></div>` : '') +
    `<div class="grid g2"><div class="card"><div class="card-h"><span class="ico violet">${ic('book', 18)}</span><h3>The record</h3><span class="count">${plural(ev.length, 'entry')}</span></div><div class="card-b">
      <ul class="tl">${ev.map((e) => `<li class="${e.cls}"><b>${esc(e.text)}</b><span class="t">${esc(when(e.at))}</span>${e.sub ? `<small>${esc(e.sub)}</small>` : ''}</li>`).join('')}</ul></div></div>
     <div class="card"><div class="card-h"><h3>This job</h3></div><div class="card-b">
      <div class="kv"><span>Assistant cost</span><b>${usd(d.cost.usd)}</b></div>
      <div class="kv"><span>Model calls</span><b>${d.cost.calls}</b></div>
      <div class="kv"><span>Tokens</span><b>${Number(d.cost.tokens).toLocaleString('en-IN')}</b></div>
      <div class="kv"><span>Approvals</span><b>${d.approvals.length}</b></div>
      <div class="kv"><span>Standing yeses used</span><b>${d.grant_uses.length}</b></div>
      <div class="kv"><span>Job id</span><b class="mono">${esc(String(t.job_id ?? '—').slice(0, 13))}</b></div>
      <p class="note">The assistant that worked this job held no keys and no database access. Every effect went through Ledger’s gate; every yes was carried out by Ledger itself.</p>
     </div></div></div>` +
    bind(() => {
      bindCards(pend);
      const c = $('#cancel');
      if (c)
        c.onclick = async () => {
          try {
            await api(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: { reason: 'cancelled from the console' } });
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
  await loadLines();
  const { cards } = await api('/api/desk');
  const pend = cards.filter((c) => c.status === 'PENDING');
  const hist = cards.filter((c) => c.status !== 'PENDING');
  const tab = S.query.get('t') ?? (pend.length ? 'waiting' : 'history');
  return (
    head('Approvals', 'Every change Ledger wants to make that the switchboard marks “ask first”. A yes binds to the fingerprint of exactly what you saw — if the proposal changes, you are asked again. Ledger carries out a yes once, itself, and reads it back.') +
    `<div class="seg"><button data-t="waiting" aria-pressed="${tab === 'waiting'}">Waiting on you · ${pend.length}</button><button data-t="history" aria-pressed="${tab === 'history'}">Who said yes to what · ${hist.length}</button></div>` +
    (tab === 'waiting'
      ? `<div class="card"><div class="card-b">${pend.length ? pend.map((c) => cardHtml(c)).join('') : empty('Nothing waiting on you')}</div></div>`
      : `<div class="card">${
          hist.length
            ? `<table class="t"><thead><tr><th>Proposed</th><th>Action</th><th>Answer</th><th class="hide-sm">Fingerprint seen</th><th>Outcome</th><th></th></tr></thead><tbody>${hist
                .map(
                  (a) => `<tr><td>${esc(when(a.created_at))}</td><td><b>${esc(a.card?.what ?? titleOf(a.ability_key))}</b><div class="note mono">${esc(a.ability_key)}</div></td>
                  <td>${a.decision ? `${esc({ yes: 'Yes', no: 'No', change: 'Change first', withdraw: 'Withdrawn' }[a.decision] ?? a.decision)} · ${esc(a.decided_by_name ?? '—')}<div class="note">${esc(when(a.decided_at))}</div>` : '<span class="faint">nobody</span>'}</td>
                  <td class="hide-sm">${a.fingerprint_seen ? `<span class="fp">${esc(short(a.fingerprint_seen))}</span> ${a.fingerprint_seen === a.fingerprint ? '✓' : '✗'}` : '—'}</td>
                  <td>${outcomePill(a)}</td><td class="r">${a.task_id ? `<a class="btn sm" href="#/jobs/${esc(a.task_id)}">Job</a>` : ''}</td></tr>`,
                )
                .join('')}</tbody></table>`
            : `<div class="card-b">${empty('No answered approvals yet')}</div>`
        }</div>`) +
    bind(() => {
      bindCards(pend);
      for (const b of $$('[data-t]')) b.onclick = () => (location.hash = `#/approvals?t=${b.dataset.t}`);
    })
  );
};

// ── the switchboard (WP §4): floor · company · in force ────────────────────
const rank = (s) => ({ on: 0, ask_first: 1, off: 2 })[s] ?? 0;
function toggleHtml(name, opts, cur, disabled, lockedValues = []) {
  return `<span class="toggle">${opts.map(([v, l]) => `<button data-tg="${esc(name)}" data-v="${v}" aria-pressed="${v === cur}"${disabled || lockedValues.includes(v) ? ' disabled' : ''}${lockedValues.includes(v) ? ' title="Looser than the app’s floor — a company can only tighten"' : ''}>${l}</button>`).join('')}</span>`;
}
const grantLimits = (g) => [g.limits?.per_call_minor && `≤ ${money(g.limits.per_call_minor)} a time`, g.limits?.per_month_minor && `≤ ${money(g.limits.per_month_minor)} a month`, g.limits?.recipients_allow && `to ${g.limits.recipients_allow.join(', ')}`].filter(Boolean).join(' · ') || 'no amount limit';
VIEWS.switchboard = async () => {
  await loadLines();
  const [sb, usage, grants, vault] = await Promise.all([api('/api/switchboards/ledger'), api('/api/usage/ledger'), api('/api/grants'), isAdmin() ? api('/api/vault').catch(() => null) : null]);
  const admin = isAdmin();
  const activeGrant = (k) => grants.grants.find((g) => g.ability_key === k && g.status === 'ACTIVE' && !g.expired);
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
      <td>${settingPill(l.floor)}</td>
      <td>${toggleHtml(`s:${l.key}`, opts, l.company ?? l.floor, !admin, locked)}</td>
      <td class="force">${settingPill(l.setting)}${l.forced_by_rule ? `<div class="note">a company rule requires a person</div>` : ''}${g && l.setting === 'ask_first' ? `<div class="note">standing yes: ${esc(grantLimits(g))}</div>` : ''}</td></tr>`;
  };
  const doors = new Set((vault?.doors ?? []).map((d) => d.door));
  const star = sb.approvals?.['*'] ?? {};
  return (
    head('Switchboard', `What Ledger may do at ${esc(S.me.company?.name ?? 'your company')}. The app sets a floor; you can only make it stricter. The gate checks this on every call — “off” means the assistant is not even shown it, and it is refused if asked by name.`, `<button class="btn" id="hist">${ic('clock', 15)} History · v${sb.version}</button>${admin ? '' : pill('admins change the switchboard', 'amber')}`) +
    `<div class="card board"><table class="t"><thead><tr><th>Line</th><th>App’s floor</th><th>${esc(S.me.company?.name ?? 'Company')} set</th><th>In force today</th></tr></thead><tbody>
      ${groups
        .map(([label, fn]) => {
          const ls = S.lines.filter(fn);
          return ls.length ? `<tr class="group"><td colspan="4">${esc(label)} · ${ls.length}</td></tr>${ls.map(row).join('')}` : '';
        })
        .join('')}
      <tr class="group"><td colspan="4">Doors · keys lent per call from the vault</td></tr>
      ${S.doors.map((d) => `<tr${vault && !doors.has(d.key) ? ' class="grey"' : ''}><td class="line"><b>${esc(d.key.replace('_', ' '))}</b><small>${d.declared_by === 'own' ? 'declared by Ledger' : 'declared by an installed package'}${d.scopes?.length ? ` · scopes: ${esc(d.scopes.join(', '))}` : ''}</small></td><td>${pill('needs a key')}</td><td>${vault ? (doors.has(d.key) ? pill('key in vault', 'green') : pill('no key')) : '—'}</td><td class="force">${vault ? (doors.has(d.key) ? pill('opens per call', 'green') : pill('closed — cannot open')) : '—'}</td></tr>`).join('')}
    </tbody></table></div>` +
    `<div class="grid g2"><div class="card"><div class="card-h"><span class="ico amber">${ic('rules', 18)}</span><h3>Company rules</h3><span class="count">checked by the gate on every call</span>${admin ? `<div class="right"><button class="btn sm lime" id="add-rule">${ic('plus', 14)} Add rule</button></div>` : ''}</div>
        <div class="card-b">${(sb.rules ?? []).length ? (sb.rules ?? []).map((r, i) => `<div class="kv"><span><b>${esc(ruleText(r))}</b><br><span class="faint mono">${esc(r.id)} · ${esc(r.type)}</span></span>${admin ? `<button class="btn sm danger" data-rm="${i}">Remove</button>` : ''}</div>`).join('') : '<p class="muted">No company rules yet. For example: nothing goes out on weekends · cap payments per month · only email our own domain · always ask a person before closing a month.</p>'}</div></div>
      <div class="card"><div class="card-h"><span class="ico teal">${ic('sparkle', 18)}</span><h3>The assistant’s budget</h3></div><div class="card-b">
        <div class="kv"><span>Spent today</span><b>${usd(usage.today_usd)} of ${usd(usage.per_day_cap_usd)}</b></div><div class="meter"><i data-w="${(100 * usage.today_usd) / Math.max(usage.per_day_cap_usd, 0.01)}"></i></div>
        <div class="kv"><span>This month</span><b>${usd(usage.month_usd)}</b></div>
        <div class="kv"><span>Cap per job</span><b>${usd(usage.per_job_cap_usd)}</b></div>
        ${usage.refused_today ? `<div class="kv"><span>Calls refused today (over budget)</span><b class="c-red">${usage.refused_today}</b></div>` : ''}
        ${admin ? `<div class="row2"><div><label class="f" for="bj">Per job (USD)</label><input class="i" id="bj" type="number" min="0.1" step="0.5" value="${usage.per_job_cap_usd}"></div><div><label class="f" for="bd">Per day (USD)</label><input class="i" id="bd" type="number" min="1" step="5" value="${usage.per_day_cap_usd}"></div></div><p><button class="btn sm" id="save-budget">Save budget</button></p>` : ''}
        <p class="note">A job over its budget is refused before it calls the model. The cap is enforced by the LLM proxy, which holds the key — not by the assistant.</p>
      </div></div></div>` +
    `<div class="card"><div class="card-h"><span class="ico violet">${ic('user', 18)}</span><h3>Who may say yes</h3><span class="count">only a person can approve — never another app</span></div><div class="card-b">
      <div class="kv"><span>Four eyes: whoever asked cannot approve their own request</span>${toggleHtml('fe', [['off', 'Off'], ['on', 'On']], star.four_eyes ? 'on' : 'off', !admin)}</div>
      <div class="kv"><span>Who may approve</span>${toggleHtml('roles', [['any', 'Anyone in the company'], ['admin', 'Admins only']], (star.roles ?? []).length === 1 && star.roles[0] === 'admin' ? 'admin' : 'any', !admin)}</div>
    </div></div>` +
    bind(() => {
      $('#hist').onclick = historyModal;
      if (!admin) return;
      const save = async (patch, msg) => {
        try {
          await api('/api/switchboards/ledger', { method: 'PUT', body: patch });
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
          else if (name.startsWith('s:')) save({ settings: { [name.slice(2)]: v } }, `${titleOf(name.slice(2))}: ${SETTING[v]}.`);
        };
      $('#save-budget').onclick = () => save({ budget: { per_job_usd: Number($('#bj').value), per_day_usd: Number($('#bd').value) } }, 'Budget saved.');
      $('#add-rule').onclick = () => ruleForm(sb.rules ?? [], save);
      for (const b of $$('[data-rm]')) b.onclick = () => save({ rules: (sb.rules ?? []).filter((_, i) => i !== Number(b.dataset.rm)) }, 'Rule removed.');
    })
  );
};
function scopeText(s) {
  if (!s || s === 'external') return 'Anything that leaves the company';
  if (s === 'all') return 'Every action';
  return s.map(titleOf).join(', ');
}
function ruleText(r) {
  if (r.type === 'time_window') return `${scopeText(r.applies_to)}: only ${r.days.map((d) => DAYS[d - 1]).join(', ')}, ${r.from}–${r.to}`;
  if (r.type === 'destination') return `${scopeText(r.applies_to)}: only to ${r.domains.join(', ')}`;
  if (r.type === 'amount_cap') return `${scopeText(r.applies_to)}: ${[r.per_call_minor && `at most ${money(r.per_call_minor)} per call`, r.per_day_minor && `${money(r.per_day_minor)} per day`, r.per_month_minor && `${money(r.per_month_minor)} per month`].filter(Boolean).join(', ')}`;
  if (r.type === 'recipient_cap') return `${scopeText(r.applies_to)}: at most ${plural(r.max, 'recipient')}`;
  if (r.type === 'require_person') return `Always ask a person before: ${r.abilities.map(titleOf).join(', ')}`;
  return r.type;
}
function ruleForm(rules, save) {
  const writes = S.lines.filter((l) => l.kind === 'write');
  modal(
    'Add a company rule',
    `<form id="rf"><label class="f">Rule</label><select class="i" name="type" id="rt">
        <option value="time_window">Only at certain times (e.g. nothing on weekends)</option>
        <option value="amount_cap">Cap amounts (per call / day / month)</option>
        <option value="destination">Only send to our own domains</option>
        <option value="recipient_cap">Limit how many people an email goes to</option>
        <option value="require_person">Always ask a person before…</option></select>
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
async function historyModal() {
  modal('Switchboard history', '<div class="skel"></div>', '', true);
  try {
    const { versions } = await api('/api/switchboards/ledger/history');
    const diff = (a, b) => {
      if (!b) return 'first change from the app’s floor';
      const out = [];
      for (const k of new Set([...Object.keys(a.settings ?? {}), ...Object.keys(b.settings ?? {})])) if (a.settings?.[k] !== b.settings?.[k]) out.push(`${titleOf(k)}: ${SETTING[b.settings?.[k]] ?? 'floor'} → ${SETTING[a.settings?.[k]] ?? 'floor'}`);
      if (JSON.stringify(a.rules) !== JSON.stringify(b.rules)) out.push(`company rules: ${(b.rules ?? []).length} → ${(a.rules ?? []).length}`);
      if (JSON.stringify(a.budget) !== JSON.stringify(b.budget)) out.push(`budget: ${Object.entries(a.budget ?? {}).map(([k, v]) => `${k.replace('_usd', '').replace('_', ' ')} $${v}`).join(', ')}`);
      if (JSON.stringify(a.approvals) !== JSON.stringify(b.approvals)) out.push(`who may approve: ${a.approvals?.['*']?.four_eyes ? 'four eyes' : 'one person'}${a.approvals?.['*']?.roles ? ', admins only' : ''}`);
      return out.join(' · ') || 'no change';
    };
    $('.modal .mb').innerHTML = versions.length
      ? `<table class="t"><thead><tr><th>Version</th><th>When</th><th>By</th><th>What changed</th></tr></thead><tbody>${versions.map((v, i) => `<tr><td><b>v${v.version}</b></td><td>${esc(when(v.updated_at))}</td><td>${esc(v.updated_by_name ?? '—')}</td><td>${esc(diff(v, versions[i + 1]))}</td></tr>`).join('')}</tbody></table>`
      : empty('No changes yet', 'Ledger is running on the app’s floor.');
  } catch (e) {
    $('.modal .mb').innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

// ── standing yeses (WP §5) ─────────────────────────────────────────────────
VIEWS.grants = async () => {
  await loadLines();
  const { grants } = await api('/api/grants');
  const admin = isAdmin();
  const state = (g) => (g.status === 'ACTIVE' && g.expired ? pill('expired') : g.status === 'ACTIVE' ? pill('active', 'green') : g.status === 'SUSPENDED' ? pill('suspended', 'red') : pill('withdrawn'));
  return (
    head('Standing yeses', 'Once you trust a routine action, let Ledger do it within limits without asking each time. A standing yes counts as a person’s yes because a person wrote it. It expires, can be withdrawn any moment, and suspends itself the moment something goes wrong under it.', admin ? `<button class="btn lime" id="new-g">${ic('plus', 15)} New standing yes</button>` : '') +
    `<div class="card">${
      grants.length
        ? `<table class="t"><thead><tr><th>Ledger may, without asking</th><th>Within</th><th class="hide-sm">Used</th><th>Until</th><th>State</th><th></th></tr></thead><tbody>${grants
            .map(
              (g) => `<tr${g.status !== 'ACTIVE' || g.expired ? ' class="grey"' : ''}><td><b>${esc(titleOf(g.ability_key))}</b><div class="note">set by ${esc(g.created_by_name ?? '—')} ${esc(ago(g.created_at))}</div></td><td>${esc(grantLimits(g))}</td>
              <td class="hide-sm">${plural(g.uses, 'time')}${g.used_this_month_minor ? ` · ${money(g.used_this_month_minor)} this month` : ''}${g.last_used_at ? `<div class="note">last ${esc(ago(g.last_used_at))}</div>` : ''}</td>
              <td>${esc(longDay(new Date(g.expires_at).toISOString().slice(0, 10)))}</td><td>${state(g)}${g.suspended_reason ? `<div class="note c-red">${esc(g.suspended_reason)}</div>` : ''}</td>
              <td class="r">${admin && g.status !== 'REVOKED' ? `<button class="btn sm danger" data-rev="${esc(g.id)}">Withdraw</button>` : ''}</td></tr>`,
            )
            .join('')}</tbody></table>`
        : `<div class="card-b">${empty('No standing yeses', 'Every ask-first action waits for a person. On an approval card, “Approve & always allow…” creates one.')}</div>`
    }</div>` +
    bind(() => {
      const n = $('#new-g');
      if (n) n.onclick = () => grantForm({});
      for (const b of $$('[data-rev]'))
        b.onclick = async () => {
          try {
            await api(`/api/grants/${b.dataset.rev}`, { method: 'DELETE' });
            toast('Withdrawn. From the next call Ledger asks a person again.');
            render(true);
          } catch (e) {
            fail(e);
          }
        };
    })
  );
};
function grantForm({ ability_key, args, card }) {
  const writes = S.lines.filter((l) => l.kind === 'write' && l.setting === 'ask_first');
  const amt = args?.amount_minor ?? (Array.isArray(args?.lines) ? args.lines.reduce((s, l) => s + Number(l.amount_minor || 0), 0) : null);
  const exp = iso(new Date(Date.now() + 30 * 864e5));
  const to = typeof args?.to === 'string' && /@/.test(args.to) ? args.to : '';
  modal(
    card ? 'Approve & always allow' : 'New standing yes',
    `<form id="gf">${card ? `<p class="muted">This approves the card in front of you <b>and</b> lets Ledger do the same kind of thing within these limits without asking, until the date below.</p>` : ''}
      <label class="f">Ledger may, without asking</label><select class="i" name="ability"${card ? ' disabled' : ''}>${writes.map((w) => `<option value="${esc(w.key)}"${w.key === ability_key ? ' selected' : ''}>${esc(w.title)}</option>`).join('')}${card && !writes.some((w) => w.key === ability_key) ? `<option selected value="${esc(ability_key)}">${esc(titleOf(ability_key))}</option>` : ''}</select>
      <div class="row2"><div><label class="f">At most per time (₹)</label><input class="i" name="pc" type="number" min="1" step="1" value="${amt ? Math.ceil(amt / 100) : ''}"></div><div><label class="f">At most per month (₹)</label><input class="i" name="pm" type="number" min="1" step="1"></div></div>
      <label class="f">Only to these recipients (optional, comma separated)</label><input class="i" name="rcpt" value="${esc(to)}" placeholder="finance@customer.example">
      <label class="f">Until</label><input class="i" name="exp" type="date" value="${exp}" required></form>
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
      await api('/api/grants', { method: 'POST', body: { app_key: 'ledger', ability_key: card ? ability_key : d.get('ability'), limits, expires_at: new Date(`${d.get('exp')}T23:59:59`).toISOString() } });
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
VIEWS.connections = async () => {
  await loadLines();
  const admin = isAdmin();
  const [v, lends] = await Promise.all([admin ? api('/api/vault') : { doors: [] }, admin ? api('/api/audit?action=vault.lend&limit=300').catch(() => ({ rows: [] })) : { rows: [] }]);
  const has = (k) => v.doors.find((x) => x.door === k);
  const INFO = { email: ['Email', 'Sends invoices, reminders and the close pack.', 'send'], gst_portal: ['GST portal (GSP)', 'Files GST returns through your GST Suvidha Provider.', 'tax'] };
  return (
    head('Doors', 'Connections to the outside. Keys live in the platform’s vault, sealed and write-only: Ledger borrows one for a single call and forgets it; the assistant never sees it. A door without a key cannot be opened — not discouraged, impossible.', admin ? '' : pill('admins connect doors', 'amber')) +
    S.doors
      .map((d) => {
        const [title, text, icon] = INFO[d.key] ?? [d.key, '', 'key'];
        const users = S.lines.filter((l) => l.doors?.includes(d.key));
        const n = lends.rows.filter((r) => r.ability_key === d.key);
        const refused = n.filter((r) => /refused/.test(r.outcome ?? '')).length;
        const on = has(d.key);
        return `<div class="card"><div class="card-h"><span class="ico ${on ? 'green' : 'amber'}">${ic(icon, 18)}</span><h3>${esc(title)}</h3>${on ? pill(`key in vault · set ${ago(on.updated_at)}`, 'green') : pill('no key · closed', 'amber')}
          <div class="right">${admin ? `<button class="btn sm${on ? '' : ' lime'}" data-door="${esc(d.key)}">${on ? 'Replace key' : 'Connect'}</button>` : ''}</div></div>
          <div class="card-b"><p class="muted">${esc(text)}</p>
          <div class="kv"><span>Declared by</span><b>${d.declared_by === 'own' ? 'Ledger' : 'an installed package'}${d.scopes?.length ? ` · scopes ${esc(d.scopes.join(', '))}` : ''}</b></div>
          <div class="kv"><span>Used by</span><b>${users.length ? esc(users.map((u) => u.title).join(', ')) : 'the package’s abilities'}</b></div>
          ${admin ? `<div class="kv"><span>Keys lent (recent)</span><b>${n.length - refused}${refused ? ` · ${refused} refused` : ''}</b></div>` : ''}</div></div>`;
      })
      .join('') +
    bind(() => {
      for (const b of $$('[data-door]')) b.onclick = () => doorForm(b.dataset.door);
    })
  );
};
function doorForm(door) {
  const email = door === 'email';
  modal(
    email ? 'Connect email' : 'Connect the GST portal',
    `<form id="df">${
      email
        ? `<label class="f">Provider</label><select class="i" name="provider" id="prov"><option value="resend">Resend</option><option value="dev-mailbox">Development mailbox (files on the backend)</option></select>
           <div id="p-real"><label class="f">API key</label><input class="i mono" name="api_key" type="password" autocomplete="off"><label class="f">From</label><input class="i" name="from" placeholder="Acme Books &lt;books@acme.in&gt;"></div>
           <div id="p-dev" class="hidden"><label class="f">Directory on the backend</label><input class="i mono" name="dir" value="/srv/var/mailbox"></div>`
        : `<label class="f">Provider</label><select class="i" name="provider" id="prov"><option value="http">Your GSP (HTTP API)</option><option value="dev-file">Development (files on the backend)</option></select>
           <div id="p-real"><label class="f">GSP base URL</label><input class="i mono" name="base_url" type="url" placeholder="https://gsp.example"><label class="f">API token</label><input class="i mono" name="token" type="password" autocomplete="off">
           <div class="row2"><div><label class="f">File path</label><input class="i mono" name="send_path" value="/v1/gstr3b/file"></div><div><label class="f">Look-up path</label><input class="i mono" name="lookup_path" value="/v1/gstr3b/filings/{key}"></div></div></div>
           <div id="p-dev" class="hidden"><label class="f">Directory on the backend</label><input class="i mono" name="dir" value="/srv/var/gst-portal"></div>`
    }</form><p class="note">Write-only: once saved, nobody can read it back — not even an admin.</p>`,
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
    else body = { provider: 'http', base_url: d.base_url, token: d.token, send_path: d.send_path, lookup_path: d.lookup_path };
    if (!dev() && Object.values(body).some((x) => !x)) return toast('Fill in every field.', true);
    try {
      await api(`/api/vault/${door}`, { method: 'PUT', body });
      closeLayer();
      toast('Saved to the vault. Ledger borrows it per call.');
      render(true);
    } catch (e) {
      fail(e);
    }
  };
}

// ── packages and skills (WP §10) ───────────────────────────────────────────
VIEWS.packages = async () => {
  await loadLines();
  const [{ entries }, reviews] = await Promise.all([api('/api/registry/catalog'), S.me.role === 'operator' ? api('/api/registry/reviews').catch(() => ({ reviews: [] })) : { reviews: [] }]);
  const admin = isAdmin();
  const card = (e) => {
    const inst = e.installs.find((i) => i.host_app === 'ledger');
    const offers = Array.isArray(e.offers) ? e.offers : [];
    const on = offers.filter((o) => line(o.key)?.setting !== 'off').length;
    return `<div class="card"><div class="card-h"><span class="ico ${inst ? 'green' : 'blue'}">${ic(e.kind === 'package' ? 'box' : 'book', 18)}</span><h3>${esc(e.key)}</h3>
      ${pill(e.kind, 'violet')} ${pill(`v${e.latest}`)} ${e.signed ? pill('signed ✓', 'green') : pill('unsigned', 'red')} ${e.status === 'deprecated' ? pill('deprecated', 'amber') : ''}
      <div class="right">${inst ? pill(inst.status === 'active' ? `installed · pinned v${inst.pinned_version}` : 'installed · migration pending', inst.status === 'active' ? 'green' : 'amber') : ''}${e.update_available ? pill('update available', 'blue') : ''}${admin && !inst ? `<button class="btn sm lime" data-inst="${esc(e.key)}">Review & install</button>` : ''}</div></div>
      <div class="card-b">
        ${offers.length ? `<div class="kv"><span>Adds to Ledger’s switchboard</span><b>${offers.map((o) => `${esc(o.key)} (${esc(o.kind)}, floor ${esc(SETTING[o.floor] ?? o.floor)})`).join(' · ')}</b></div>` : ''}
        ${inst?.status === 'active' ? `<div class="kv"><span>Switched on at your company</span><b>${on} of ${offers.length} · <a href="#/switchboard">change</a></b></div>` : ''}
        ${(e.requires ?? []).length ? `<div class="kv"><span>Needs</span><b>${(e.requires ?? []).map((r) => esc(r)).join(' · ')}</b></div>` : ''}
        <div class="kv"><span>Published</span><b>${esc(when(e.published_at))}${e.versions.length > 1 ? ` · versions ${esc(e.versions.join(', '))}` : ''}</b></div>
        <div class="kv"><span>Content fingerprint</span><b class="mono">${esc(short(e.content_hash))}</b></div>
        ${inst?.status === 'pending_migration' ? `<p class="note c-red">Its tables are created by the migration runner (your operator runs <span class="mono">migrate</span>). Its abilities go live after that.</p>` : ''}
      </div></div>`;
  };
  return (
    head('Packages & skills', 'Know-how plus the tools it needs, signed and versioned in the platform registry. A package installs into Ledger: its tools run behind Ledger’s gate in a sandbox, its lines land on Ledger’s switchboard, and its code is loaded by hash — never run from a row.') +
    (reviews.reviews.length
      ? `<div class="card"><div class="card-h"><span class="ico amber">${ic('shield', 18)}</span><h3>Waiting for operator review</h3><span class="count">${reviews.reviews.length}</span></div><div class="card-b">${reviews.reviews.map((r) => `<div class="kv"><span><b>${esc(r.key)} v${esc(r.version)}</b><br><span class="faint">submitted ${esc(ago(r.created_at))}</span></span><span><button class="btn sm" data-diff="${esc(r.id)}">Read the diff</button> <button class="btn sm lime" data-pub="${esc(r.id)}">Sign & publish</button></span></div>`).join('')}</div></div>`
      : '') +
    (entries.length ? entries.map(card).join('') : `<div class="card"><div class="card-b">${empty('The registry is empty', 'Packages appear here once a platform operator has reviewed and signed them.')}</div></div>`) +
    bind(() => {
      for (const b of $$('[data-inst]')) b.onclick = () => installReview(entries.find((e) => e.key === b.dataset.inst));
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
function installReview(e) {
  const offers = Array.isArray(e.offers) ? e.offers : [];
  modal(
    `Install ${e.key} v${e.latest} into Ledger`,
    `<p>Nothing is added silently. Installing will:</p>
     <ul>${offers.map((o) => `<li>add <b>${esc(o.key)}</b> to Ledger’s switchboard as a ${esc(o.kind)}, starting at <b>${esc(SETTING[o.floor] ?? o.floor)}</b> — you can tighten it, never loosen it</li>`).join('')}
     ${(e.requires ?? []).map((r) => `<li>let it use <b>${esc(r)}</b></li>`).join('')}
     <li>create its own tables inside Ledger’s book (the migration runner does this; nothing runs until it has)</li>
     <li>run its code in a sandbox with no network, files or environment — only its own tables and the doors it was granted</li></ul>
     <p class="note">Signed ${e.signed ? '✓' : '✗'} · content ${esc(short(e.content_hash))}</p>`,
    `<button class="btn" id="ic">Cancel</button><button class="btn lime" id="is">Install</button>`,
  );
  $('#ic').onclick = closeLayer;
  $('#is').onclick = async () => {
    try {
      const r = await api('/api/registry/installs', { method: 'POST', body: { host_app: 'ledger', entry_key: e.key, version: e.latest } });
      closeLayer();
      toast(r.status === 'pending_migration' ? 'Installed — waiting for its migration to run.' : 'Installed.');
      await loadLines();
      render(true);
    } catch (err) {
      fail(err);
    }
  };
}

// ── other apps (WP §9: talk in rooms, act through the gateway) ─────────────
VIEWS.apps = async () => {
  await loadLines();
  if (!isAdmin()) return head('Apps', 'Which other apps may ask Ledger for what.') + `<div class="card"><div class="card-b">${empty('Admins only')}</div></div>`;
  const { acl, installed_apps } = await api('/api/acl?app=ledger');
  await refreshLive();
  const others = installed_apps.filter((a) => a.key !== 'ledger');
  const toLedger = acl.filter((a) => a.target_app === 'ledger');
  const fromApps = S.tasks.filter((t) => String(t.requester).startsWith('app:'));
  const borrowable = [...S.lines.filter((l) => l.kind === 'read' && l.from === 'own').map((l) => [l.key, l.title]), ['tasks.open', 'Hand Ledger a whole task']];
  return (
    head('Apps', 'Other NEOS apps at your company can ask Ledger things — through the gateway, typed and signed, written in both record books. Another app can never approve anything: a yes always comes from a person.', others.length ? `<button class="btn lime" id="new-acl">${ic('plus', 15)} Allow an app</button>` : '') +
    `<div class="card"><div class="card-h"><span class="ico violet">${ic('apps', 18)}</span><h3>Who may ask Ledger</h3><span class="count">${toLedger.length}</span></div>
      ${
        toLedger.length
          ? `<table class="t"><thead><tr><th>App</th><th>May ask Ledger for</th><th class="hide-sm">Granted</th><th></th></tr></thead><tbody>${toLedger
              .map((a, i) => `<tr><td><b>${esc(a.caller_app)}</b></td><td>${esc(a.ability_key === 'tasks.open' ? 'whole tasks' : titleOf(a.ability_key))}</td><td class="hide-sm">${esc(a.granted_by_name ?? '—')} · ${esc(ago(a.granted_at))}</td><td class="r"><button class="btn sm danger" data-revoke="${i}">Revoke</button></td></tr>`)
              .join('')}</tbody></table>`
          : `<div class="card-b">${empty(others.length ? 'No app may ask Ledger anything yet' : 'Ledger is the only app installed', others.length ? '' : 'When another NEOS app is installed (Wage, Marketing…), you decide here what it may ask Ledger for.')}</div>`
      }</div>` +
    `<div class="card"><div class="card-h"><span class="ico blue">${ic('jobs', 18)}</span><h3>Jobs other apps gave Ledger</h3><span class="count">${fromApps.length}</span></div>${fromApps.length ? fromApps.map(jobCard).join('') : `<div class="card-b"><p class="muted">None yet. A task from another app is opened as a job like any other, runs on the stricter of the two switchboards, and any yes still comes from a person.</p></div>`}</div>` +
    bind(() => {
      for (const b of $$('[data-revoke]'))
        b.onclick = async () => {
          const a = toLedger[Number(b.dataset.revoke)];
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
          modal(
            'Allow an app to ask Ledger',
            `<form id="af"><label class="f">App</label><select class="i" name="caller">${others.map((o) => `<option value="${esc(o.key)}">${esc(o.name ?? o.key)}</option>`).join('')}</select>
             <label class="f">May ask Ledger for</label><select class="i" name="ability">${borrowable.map(([k, t]) => `<option value="${esc(k)}">${esc(t)}</option>`).join('')}</select></form>
             <p class="note">Only reads can be borrowed. Anything that changes Ledger’s books is a task — Ledger’s own gate and your approvals still apply.</p>`,
            `<button class="btn" id="ac">Cancel</button><button class="btn lime" id="as">Allow</button>`,
          );
          $('#ac').onclick = closeLayer;
          $('#as').onclick = async () => {
            const d = new FormData($('#af'));
            try {
              await api('/api/acl', { method: 'POST', body: { caller_app: d.get('caller'), target_app: 'ledger', ability_key: d.get('ability') } });
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
const AUDIT_FILTERS = [
  ['', 'Everything'],
  ['desk.answer', 'Answers'],
  ['proposal.executed', 'Carried out'],
  ['grant.', 'Standing yeses'],
  ['switchboard.changed', 'Switchboard'],
  ['vault.', 'Keys'],
  ['l3.', 'Calls into Ledger'],
  ['app.operation', 'Ledger’s operations'],
  ['gateway.denied', 'Refused'],
  ['acl.', 'App permissions'],
  ['registry.', 'Registry'],
];
const actorOf = (x) => x.actor_name ?? String(x.actor ?? '').replace(/^app:/, 'app · ').replace(/^grant:.*/, 'standing yes').replace(/^user:.*/, 'a person');
function auditTable(rows) {
  return rows.length
    ? `<table class="t"><thead><tr><th>When</th><th>Who</th><th>What</th><th class="hide-sm">Ability / door</th><th>Outcome</th></tr></thead><tbody>${rows
        .map((x) => `<tr title="${esc(JSON.stringify(x.detail ?? {}))}"><td>${esc(when(x.at))}</td><td>${esc(actorOf(x))}</td><td class="mono">${esc(x.action)}</td><td class="hide-sm mono">${esc(x.ability_key ?? '')}</td><td>${esc(x.outcome ?? '')}</td></tr>`)
        .join('')}</tbody></table>`
    : `<div class="card-b">${empty('Nothing recorded for this filter')}</div>`;
}
VIEWS.audit = async () => {
  if (!isAdmin()) return head('Audit', 'Every action taken on your data.') + `<div class="card"><div class="card-b">${empty('Admins only')}</div></div>`;
  const f = S.query.get('a') ?? '';
  const q = (before) => `/api/audit?limit=150${f ? `&action=${encodeURIComponent(f)}` : ''}${before ? `&before=${before}` : ''}`;
  const r = await api(q());
  const rows = [...r.rows];
  return (
    head('Audit trail', 'One trail for everything: every call into Ledger through the gateway, every yes, every carry-out, every key lent, every change to the switchboard. Written once; nobody can edit it.', `<button class="btn" id="csv">${ic('down', 15)} Export CSV</button>`) +
    `<div class="seg">${AUDIT_FILTERS.map(([k, l]) => `<button data-a="${esc(k)}" aria-pressed="${k === f}">${esc(l)}</button>`).join('')}</div>` +
    `<div class="card"><div id="audit-rows">${auditTable(rows)}</div>${r.next_before ? `<div class="card-b"><button class="btn sm" id="more">Load older</button></div>` : ''}</div>` +
    bind(() => {
      for (const b of $$('[data-a]')) b.onclick = () => (location.hash = `#/audit${b.dataset.a ? `?a=${encodeURIComponent(b.dataset.a)}` : ''}`);
      $('#csv').onclick = () => csv(`ledger-audit-${today()}.csv`, [['at', 'who', 'action', 'ability', 'outcome', 'idempotency_key', 'detail'], ...rows.map((x) => [x.at, actorOf(x), x.action, x.ability_key ?? '', x.outcome ?? '', x.idem_key ?? '', JSON.stringify(x.detail ?? {})])]);
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
  if (!isAdmin()) return head('Team', 'People who use Ledger.') + `<div class="card"><div class="card-b">${empty('Admins only')}</div></div>`;
  const { users } = await api('/api/users');
  return (
    head('Team', 'People who can ask Ledger and answer its requests. Who may approve is set on the switchboard.') +
    `<div class="card"><table class="t"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th class="hide-sm">Since</th></tr></thead><tbody>${users.map((u) => `<tr><td><b>${esc(u.name)}</b>${u.id === S.me.id ? ` ${pill('you', 'blue')}` : ''}</td><td class="muted">${esc(u.email)}</td><td>${pill(u.role, u.role === 'admin' ? 'violet' : 'gray')}</td><td class="hide-sm">${esc(longDay(new Date(u.created_at).toISOString().slice(0, 10)))}</td></tr>`).join('')}</tbody></table></div>
     <p class="note">People are added by your NEOS operator (<span class="mono">scripts/ops.ts create-user</span>); each gets a desk token shown once and stored only as a hash.</p>`
  );
};

VIEWS.setup = async () => {
  const [accts, bank, periods, vault, rules] = await Promise.all([read('ledger.accounts.list', {}), read('ledger.bank.unreconciled', {}), read('ledger.periods.status', {}), isAdmin() ? api('/api/vault').catch(() => null) : null, read('ledger.coding_rules.list', {})]);
  const doors = new Set((vault?.doors ?? []).map((d) => d.door));
  const cash = accts.accounts.filter((a) => ['bank', 'cash'].includes(a.subtype)).reduce((s, a) => s + a.balance_minor, 0);
  const steps = [
    ['Ledger installed for your company', true, 'Done by your NEOS operator.', null],
    ['Chart of accounts', accts.accounts.length > 0, `${accts.accounts.length} accounts.`, 'books/accounts'],
    ['Import a bank statement', bank.transactions.length > 0 || cash !== 0, 'Paste it; Ledger proposes the import and matches each line.', 'books/reconcile'],
    ['Coding rules', rules.rules.length > 0, `${plural(rules.rules.length, 'rule')}.`, 'books/rules'],
    ['Connect email', vault ? doors.has('email') : null, 'So Ledger can send invoices and reminders.', 'connections'],
    ['Review the switchboard', true, 'Decide what Ledger may do automatically and what asks first.', 'switchboard'],
    ['Close your first month', periods.closed.length > 0, 'Work the close checklist.', 'books/close'],
  ].filter((s) => s[1] !== null);
  const n = steps.filter((s) => s[1]).length;
  return (
    head('Set up Ledger', `${n} of ${steps.length} done.`) +
    `<div class="card setup"><span class="ico lime">${ic('gear', 18)}</span><div class="grow"><h3>${n === steps.length ? 'Ledger is fully set up' : 'Almost there'}</h3><div class="bar"><i data-w="${(100 * n) / steps.length}"></i></div></div></div>` +
    `<div class="card checklist">${steps.map(([t, ok, sub, go]) => `<div class="row${ok ? ' done' : ''}"><span class="box${ok ? ' on' : ''}">${ok ? ic('check', 13) : ''}</span><div><b>${esc(t)}</b><span>${esc(sub)}</span></div>${go ? `<span class="right"><a class="btn sm${ok ? '' : ' lime'}" href="#/${go}">${ok ? 'Open' : 'Start'}</a></span>` : ''}</div>`).join('')}</div>`
  );
};

// ── BOOKS: the subject ─────────────────────────────────────────────────────
const BOOK_VIEWS = {};
VIEWS.books = async (sub = 'overview') => {
  const k = BOOK_VIEWS[sub] ? sub : 'overview';
  const nav = `<div class="seg books-nav">${BOOKS.map(([key, l]) => `<button data-bk="${key}" aria-pressed="${key === k}">${esc(l)}</button>`).join('')}</div>`;
  const body = await BOOK_VIEWS[k]();
  return (
    nav +
    body +
    bind(() => {
      for (const b of $$('[data-bk]')) b.onclick = () => (location.hash = `#/books/${b.dataset.bk}`);
    })
  );
};

BOOK_VIEWS.overview = async () => {
  const { from, to } = range(S.period);
  const [pnl, cf, bs, periods] = await Promise.all([read('ledger.report.pnl', { from, to }), read('ledger.report.cash_flow', { from, to }), read('ledger.report.balance_sheet', { as_of: to }), read('ledger.periods.status', {})]);
  const closed = periods.closed.some((c) => c.month === S.period);
  return (
    head(`Books · ${monthFull(S.period)}`, 'The subject Ledger looks after. Every figure is read live from the book and says where it came from.', `<button class="btn" id="pp">${ic('calendar', 15)} ${esc(monthLabel(S.period))}</button>${closed ? pill('month closed', 'dark') : `<a class="btn lime" href="#/books/close">${ic('calendar', 15)} Close ${esc(monthLabel(S.period))}</a>`}`) +
    `<div class="grid g4">
      ${kpi(money(pnl.totals.revenue_minor), 'c-green', 'chart', 'Revenue', monthLabel(S.period), 'books/reports', pnl)}
      ${kpi(money(pnl.totals.net_profit_minor), pnl.totals.net_profit_minor < 0 ? 'c-red' : 'c-green', 'chart', 'Net profit', `gross ${money(pnl.totals.gross_profit_minor)}`, 'books/reports', pnl)}
      ${kpi(money(cf.closing_cash_minor), 'c-teal', 'wallet', 'Cash at month end', `moved ${money(cf.closing_cash_minor - cf.opening_cash_minor)}`, 'books/reports', cf)}
      ${kpi(bs.balanced ? 'Balanced' : 'Off', bs.balanced ? 'c-green' : 'c-red', 'table', 'Balance sheet', `assets ${money(bs.totals.assets_minor)}`, 'books/reports', bs)}
    </div>` +
    bind(() => ($('#pp').onclick = periodPicker))
  );
};

BOOK_VIEWS.transactions = async () => {
  const { from, to } = range(S.period);
  const search = S.query.get('q') ?? '';
  const j = await read('ledger.journal.list', { from, to, limit: 200, ...(search ? { search } : {}) });
  const srcF = S.query.get('src') ?? 'all';
  const sources = [...new Set(j.entries.map((e) => e.source))];
  const rows = j.entries.filter((e) => srcF === 'all' || e.source === srcF);
  return (
    head('Transactions', `Every journal entry in ${esc(monthFull(S.period))}. Entries are never edited — a mistake is reversed by a new entry.`, `<button class="btn" id="new-journal">${ic('plus', 15)} Manual journal</button>`) +
    `<div class="seg">${['all', ...sources].map((s) => `<button data-src="${esc(s)}" aria-pressed="${s === srcF}">${esc(s === 'all' ? `All · ${j.entries.length}` : `${s} · ${j.entries.filter((e) => e.source === s).length}`)}</button>`).join('')}<span class="grow"></span><input class="i" id="tx-q" placeholder="Search memo or reference" value="${esc(search)}"></div>` +
    `<div class="card">${
      rows.length
        ? `<table class="t"><thead><tr><th>Date</th><th>Description</th><th class="hide-sm">Accounts</th><th class="r">Amount</th><th class="hide-sm">Source</th></tr></thead><tbody>${rows
            .map((e) => `<tr class="click" data-entry="${esc(e.id)}"><td>${esc(day(e.date))}</td><td><b>${esc(e.memo)}</b>${e.reverses ? ` ${pill('reversal', 'amber')}` : ''}</td><td class="hide-sm muted">${esc(e.lines.map((l) => `${l.account_code} ${l.account_name}`).slice(0, 2).join(' · '))}${e.lines.length > 2 ? ' …' : ''}</td><td class="r num">${money(e.lines.reduce((s, l) => s + l.debit_minor, 0), true)}</td><td class="hide-sm">${pill(e.source, e.source === 'seed' ? 'gray' : 'green')}</td></tr>`)
            .join('')}</tbody></table>`
        : `<div class="card-b">${empty('No entries', search ? 'Nothing matches that search this month.' : `Nothing posted in ${monthFull(S.period)} yet.`)}</div>`
    }<div class="card-b">${src(j)}</div></div>` +
    bind(() => {
      for (const b of $$('[data-src]')) b.onclick = () => (location.hash = `#/books/transactions?src=${encodeURIComponent(b.dataset.src)}${search ? `&q=${encodeURIComponent(search)}` : ''}`);
      $('#tx-q').onkeydown = (e) => e.key === 'Enter' && (location.hash = `#/books/transactions?q=${encodeURIComponent(e.target.value.trim())}`);
      for (const r of $$('[data-entry]')) r.onclick = () => entryModal(j.entries.find((e) => e.id === r.dataset.entry));
      $('#new-journal').onclick = journalForm;
    })
  );
};

BOOK_VIEWS.reconcile = async () => {
  const [bank, periods] = await Promise.all([read('ledger.bank.unreconciled', {}), read('ledger.periods.status', {})]);
  const withDoc = bank.transactions.filter((t) => t.suggestions?.documents?.length);
  const withRule = bank.transactions.filter((t) => t.suggestions?.rule);
  return (
    head('Reconcile', 'Match every bank line to the books. Ledger suggests; anything that records money is proposed to you.', `<button class="btn" id="import">${ic('bank', 15)} Import statement</button>${bank.transactions.length ? `<button class="btn lime" id="rec-all">${ic('sparkle', 15)} Reconcile all</button>` : ''}`) +
    `<div class="grid g3"><div class="card stat"><div class="well c-orange">${bank.transactions.length}</div><div class="lbl">Unmatched lines</div></div><div class="card stat"><div class="well c-blue">${withDoc.length}</div><div class="lbl">Match an invoice or bill</div></div><div class="card stat"><div class="well c-green">${withRule.length}</div><div class="lbl">A coding rule applies</div></div></div>` +
    `<div class="card"><div class="card-h"><span class="ico teal">${ic('swap', 18)}</span><h3>Unmatched lines</h3><span class="count">${bank.transactions.length}</span></div>${
      bank.transactions.length
        ? `<table class="t"><thead><tr><th>Date</th><th>Bank line</th><th>Suggestion</th><th class="r">Amount</th><th></th></tr></thead><tbody>${bank.transactions
            .map((t) => {
              const d = t.suggestions?.documents?.[0];
              const r = t.suggestions?.rule;
              const sug = d ? `${pill(d.kind, 'violet')} ${esc(d.number)} · ${esc(d.party)}` : r ? `${pill('rule', 'green')} → ${esc(r.account_code)}` : '<span class="faint">no suggestion</span>';
              return `<tr><td>${esc(day(t.date))}</td><td><b>${esc(t.description)}</b><div class="note mono">${esc(t.bank_account_code)}</div></td><td>${sug}</td><td class="r">${signed(t.amount_minor)}</td><td class="r"><button class="btn sm${d || r ? ' lime' : ''}" data-line="${esc(t.id)}">${d ? 'Match' : r ? 'Code it' : 'Find match'}</button></td></tr>`;
            })
            .join('')}</tbody></table>`
        : `<div class="card-b">${empty('Every bank line is matched')}</div>`
    }<div class="card-b">${src(bank)}${periods.unreconciled_by_month.map((m) => `<div class="kv"><span>${esc(monthFull(m.month))}</span><b>${plural(m.n, 'line')} to match</b></div>`).join('')}</div></div>` +
    bind(() => {
      $('#import').onclick = importForm;
      const all = $('#rec-all');
      if (all) all.onclick = () => askLedger('Reconcile all unmatched bank lines: match receipts and payments to their invoices and bills, code the rest with our coding rules, and tell me which lines you could not place.');
      for (const b of $$('[data-line]'))
        b.onclick = () => {
          const t = bank.transactions.find((x) => x.id === b.dataset.line);
          const d = t.suggestions?.documents?.[0];
          const r = t.suggestions?.rule;
          const l = `bank line ${t.id} (${t.date}, "${t.description}", ${money(t.amount_minor, true)} on account ${t.bank_account_code})`;
          if (d) askLedger(`Record the ${t.amount_minor > 0 ? 'receipt' : 'payment'} for ${d.kind} ${d.number} (${d.party}) using ${l}.`);
          else if (r) askLedger(`Categorize ${l} to account ${r.account_code} as the coding rule suggests.`);
          else askLedger(`Find the right match for ${l}. If it settles an invoice or bill, record that; otherwise suggest the account and ask me.`);
        };
    })
  );
};

BOOK_VIEWS.money = async () => {
  const kind = S.query.has('bills') ? 'bill' : 'invoice';
  const status = S.query.get('status') ?? 'open';
  const [docs, parties] = await Promise.all([read('ledger.documents.list', { kind, ...(status !== 'all' ? { status } : {}) }), read('ledger.parties.list', { kind: kind === 'bill' ? 'vendor' : 'customer' })]);
  const open = docs.documents.filter((d) => d.outstanding_minor > 0);
  const total = open.reduce((s, d) => s + d.outstanding_minor, 0);
  const overdue = open.filter((d) => d.overdue_days > 0);
  return (
    head('Money', 'Collect what you’re owed and pay what you owe. Every invoice, payment and email is proposed to you first.', `<button class="btn" id="new-bill">${ic('plus', 15)} New bill</button><button class="btn lime" id="new-inv">${ic('send', 15)} New invoice</button>`) +
    `<div class="seg"><button data-k="invoice" aria-pressed="${kind === 'invoice'}">Invoices · AR</button><button data-k="bills" aria-pressed="${kind === 'bill'}">Bills · AP</button><span class="grow"></span>${['open', 'paid', 'all'].map((s) => `<button data-st="${s}" aria-pressed="${s === status}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>` +
    `<div class="card"><div class="card-h"><span class="ico ${kind === 'bill' ? 'violet' : 'blue'}">${ic(kind === 'bill' ? 'wallet' : 'send', 18)}</span><h3>${kind === 'bill' ? 'Accounts payable' : 'Accounts receivable'}</h3><span class="count">${money(total)} outstanding${overdue.length ? ` · ${overdue.length} overdue` : ''}</span></div>${
      docs.documents.length
        ? `<table class="t"><thead><tr><th>${kind === 'bill' ? 'Vendor' : 'Customer'}</th><th>Number</th><th class="hide-sm">Issued</th><th>Due</th><th class="r">Total</th><th class="r">Outstanding</th><th>Status</th><th></th></tr></thead><tbody>${docs.documents
            .map((d) => {
              const st = d.outstanding_minor === 0 ? pill('paid', 'green') : d.overdue_days > 0 ? pill(`${d.overdue_days} d overdue`, 'red') : d.paid_minor > 0 ? pill('part paid', 'blue') : pill(kind === 'invoice' ? (d.sent_at ? 'sent' : 'not sent') : 'open', kind === 'invoice' && !d.sent_at ? 'amber' : 'gray');
              const acts = d.outstanding_minor === 0 ? '' : kind === 'invoice' ? `${!d.sent_at ? `<button class="btn sm" data-act="send" data-n="${esc(d.number)}">Send</button>` : d.overdue_days > 0 ? `<button class="btn sm" data-act="remind" data-n="${esc(d.number)}">Remind</button>` : ''} <button class="btn sm lime" data-act="receipt" data-n="${esc(d.number)}">Record receipt</button>` : `<button class="btn sm lime" data-act="pay" data-n="${esc(d.number)}">Record payment</button>`;
              return `<tr><td><b>${esc(d.party)}</b></td><td class="mono">${esc(d.number)}</td><td class="hide-sm">${esc(day(d.issue_date))}</td><td>${esc(day(d.due_date))}</td><td class="r num">${money(d.total_minor, true)}</td><td class="r num"><b>${money(d.outstanding_minor, true)}</b></td><td>${st}</td><td class="r">${acts}</td></tr>`;
            })
            .join('')}</tbody></table>`
        : `<div class="card-b">${empty(status === 'open' ? 'Nothing outstanding' : 'Nothing here')}</div>`
    }<div class="card-b">${src(docs)}</div></div>` +
    `<div class="card"><div class="card-h"><span class="ico teal">${ic('team', 18)}</span><h3>${kind === 'bill' ? 'Vendors' : 'Customers'}</h3><span class="count">${parties.parties.length}</span><div class="right"><button class="btn sm" id="new-party">${ic('plus', 14)} Add ${kind === 'bill' ? 'vendor' : 'customer'}</button></div></div>
      ${parties.parties.length ? `<table class="t"><thead><tr><th>Name</th><th class="hide-sm">Email</th><th class="hide-sm">GSTIN</th><th class="r">Open docs</th><th class="r">Outstanding</th></tr></thead><tbody>${parties.parties.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td class="hide-sm muted">${esc(p.email ?? '—')}</td><td class="hide-sm mono">${esc(p.gstin ?? '—')}</td><td class="r">${p.open_documents}</td><td class="r num">${money(p.outstanding_minor, true)}</td></tr>`).join('')}</tbody></table>` : `<div class="card-b">${empty('None yet')}</div>`}</div>` +
    bind(() => {
      for (const b of $$('[data-k]')) b.onclick = () => (location.hash = b.dataset.k === 'bills' ? '#/books/money?bills' : '#/books/money');
      for (const b of $$('[data-st]')) b.onclick = () => (location.hash = `#/books/money?${kind === 'bill' ? 'bills&' : ''}status=${b.dataset.st}`);
      $('#new-inv').onclick = () => docForm('invoice');
      $('#new-bill').onclick = () => docForm('bill');
      $('#new-party').onclick = () => partyForm(kind === 'bill' ? 'vendor' : 'customer');
      for (const b of $$('[data-act]')) {
        const d = docs.documents.find((x) => x.number === b.dataset.n);
        b.onclick = () => {
          if (b.dataset.act === 'send') askLedger(`Email invoice ${d.number} to ${d.party}.`);
          if (b.dataset.act === 'remind') askLedger(`Send a payment reminder for invoice ${d.number} to ${d.party}; it is ${d.overdue_days} days overdue with ${money(d.outstanding_minor, true)} outstanding.`);
          if (b.dataset.act === 'receipt' || b.dataset.act === 'pay') paymentForm(d, kind);
        };
      }
    })
  );
};

BOOK_VIEWS.close = async () => {
  const p = S.period;
  const { from, to } = range(p);
  const [periods, pnl, cf, tb, bs, inv] = await Promise.all([read('ledger.periods.status', {}), read('ledger.report.pnl', { from, to }), read('ledger.report.cash_flow', { from, to }), read('ledger.report.trial_balance', { as_of: to }), read('ledger.report.balance_sheet', { as_of: to }), read('ledger.documents.list', { kind: 'invoice', status: 'open' })]);
  const closed = periods.closed.find((c) => c.month === p);
  const unrec = periods.unreconciled_by_month.find((m) => m.month === p)?.n ?? 0;
  const unsent = inv.documents.filter((d) => !d.sent_at && d.issue_date >= from && d.issue_date <= to);
  const earlier = periods.unreconciled_by_month.filter((m) => m.month < p);
  const items = [
    ['Import and match every bank line', unrec === 0, unrec ? `${plural(unrec, 'line')} still unmatched in ${monthLabel(p)}` : 'All matched', unrec ? 'books/reconcile' : null],
    ['Earlier months reconciled', earlier.length === 0, earlier.length ? earlier.map((m) => `${monthLabel(m.month)}: ${m.n}`).join(', ') : 'Nothing carried over', earlier.length ? 'books/reconcile' : null],
    ['Send this month’s invoices', unsent.length === 0, unsent.length ? `${plural(unsent.length, 'invoice')} not sent: ${unsent.map((d) => d.number).join(', ')}` : 'All sent', unsent.length ? 'books/money' : null],
    ['Trial balance balances', tb.balanced, `Debits ${money(tb.total_debit_minor)} · credits ${money(tb.total_credit_minor)}`, null],
    ['Balance sheet balances', bs.balanced, `Assets ${money(bs.totals.assets_minor)}`, null],
    ['Lock the month', !!closed, closed ? `Closed ${ago(closed.locked_at)}${closed.reason ? ` · ${closed.reason}` : ''}` : 'Ledger proposes the close; you approve it', null],
  ];
  const n = items.filter((i) => i[1]).length;
  return (
    head(`Month-end close · ${monthLabel(p)}`, 'Work the checklist top to bottom. Ledger drafts each step; you approve; then the month is locked and takes no more postings.', `<button class="btn" id="pp">${ic('calendar', 15)} ${esc(monthLabel(p))}</button>${closed ? `<button class="btn" id="reopen">${ic('lock', 15)} Reopen</button>` : ''}<button class="btn lime" id="draft">${ic('sparkle', 15)} ${closed ? 'Email close pack' : 'Draft the close'}</button>`) +
    `<div class="grid g2"><div class="card checklist"><div class="card-h"><span class="ico lime">${ic('calendar', 18)}</span><h3>Close checklist</h3><span class="count">${n} of ${items.length}</span>${closed ? `<div class="right">${pill('closed', 'dark')}</div>` : ''}</div>
      ${items.map(([t, ok, sub, go]) => `<div class="row${ok ? ' done' : ''}"><span class="box${ok ? ' on' : ''}">${ok ? ic('check', 13) : ''}</span><div><b>${esc(t)}</b><span>${esc(sub)}</span></div>${go && !ok ? `<span class="right"><a class="btn sm" href="#/${go}">Fix</a></span>` : ''}</div>`).join('')}
      <div class="row"><span class="right">${closed ? '' : `<button class="btn dark" id="lock">${ic('lock', 15)} Close ${esc(monthLabel(p))}</button>`}</span></div></div>
     <div class="card"><div class="card-h"><h3>This month at a glance</h3></div><div class="card-b">
      <div class="kv"><span>Revenue</span><b>${money(pnl.totals.revenue_minor)}</b></div><div class="kv"><span>Expenses</span><b>${money(pnl.totals.expenses_minor)}</b></div>
      <div class="kv"><span>Net profit</span><b class="${pnl.totals.net_profit_minor < 0 ? 'c-red' : 'c-green'}">${money(pnl.totals.net_profit_minor)}</b></div>
      <div class="kv"><span>Cash at month end</span><b>${money(cf.closing_cash_minor)}</b></div><div class="kv"><span>Bank lines to match</span><b>${unrec}</b></div>
      <div class="kv"><span>Closed months</span><b>${periods.closed.length ? esc(periods.closed.map((c) => monthLabel(c.month)).join(', ')) : 'none'}</b></div>${src(pnl)}
     </div></div></div>` +
    bind(() => {
      $('#pp').onclick = periodPicker;
      const lock = $('#lock');
      if (lock) lock.onclick = () => askLedger(`Close the books for ${monthFull(p)} (month ${p}). If anything blocks the close, tell me what first.`);
      $('#draft').onclick = () => (closed ? closePackForm(p) : askLedger(`Draft the month-end close for ${monthFull(p)}: go through the checklist, tell me what is left, and propose the steps.`));
      const re = $('#reopen');
      if (re) re.onclick = () => reopenForm(p);
    })
  );
};

const REPORTS = [
  ['pnl', 'Profit & Loss', 'Revenue − expenses for the month', 'chart', 'lime'],
  ['balance_sheet', 'Balance Sheet', 'Assets, liabilities & equity', 'table', 'violet'],
  ['cash_flow', 'Cash Flow', 'Where cash moved this month', 'wallet', 'teal'],
  ['trial_balance', 'Trial Balance', 'Every account, debit & credit', 'list', 'blue'],
  ['aging', 'AR / AP Aging', 'What you’re owed and owe, by age', 'clock', 'amber'],
  ['vat_summary', 'GST summary', 'Output tax, input credit, net payable', 'tax', 'green'],
];
BOOK_VIEWS.reports = async () =>
  head('Reports', `Statements built from your live books for ${esc(monthFull(S.period))}. Export any of them, or have Ledger email the close pack.`, `<button class="btn" id="pp">${ic('calendar', 15)} ${esc(monthLabel(S.period))}</button><button class="btn lime" id="pack">${ic('send', 15)} Email close pack</button>`) +
  `<div class="grid g3">${REPORTS.map(([k, t, d, i, tone]) => `<button class="report-tile" data-r="${k}"><span class="ico ${tone}">${ic(i, 18)}</span><h4>${esc(t)}</h4><p>${esc(d)}</p><span class="open">${ic('arrow', 12)} Open</span></button>`).join('')}</div>` +
  bind(() => {
    $('#pp').onclick = periodPicker;
    $('#pack').onclick = () => closePackForm(S.period);
    for (const b of $$('[data-r]')) b.onclick = () => reportModal(b.dataset.r);
  });

BOOK_VIEWS.tax = async () => {
  await loadLines();
  const q = quarterOf(S.period);
  const [g, periods, bank] = await Promise.all([read('ledger.report.vat_summary', { from: q.from, to: q.to }), read('ledger.periods.status', {}), read('ledger.bank.unreconciled', {})]);
  const months = [0, 1, 2].map((i) => addMonths(q.from.slice(0, 7), i));
  const closedAll = months.every((m) => periods.closed.some((c) => c.month === m));
  const unrec = bank.transactions.filter((t) => t.date >= q.from && t.date <= q.to).length;
  const pkg = S.lines.some((l) => l.from === 'nep-gst');
  const checks = [
    ['All bank lines in the quarter matched', unrec === 0, unrec ? `${plural(unrec, 'line')} to match` : 'Done'],
    ['All three months closed', closedAll, months.map((m) => `${monthLabel(m)} ${periods.closed.some((c) => c.month === m) ? '✓' : '·'}`).join('  ')],
    ['GST filing package installed', pkg, pkg ? 'nep-gst is on Ledger’s switchboard' : 'Install nep-gst under Packages'],
  ];
  return (
    head('GST', `Prepared straight from your books for ${esc(q.label)}. Filing goes through the nep-gst package and your GSP — and always asks first.`, `<button class="btn" id="pp">${ic('calendar', 15)} ${esc(q.label)}</button><button class="btn lime" id="file"${pkg ? '' : ' disabled title="Install the nep-gst package first"'}>${ic('send', 15)} File GSTR-3B</button>`) +
    `<div class="grid g3">${kpi(money(g.output_tax_minor), 'c-violet', 'send', 'GST collected', 'Output tax on sales', 'books/reports', g)}${kpi(money(g.input_tax_minor), 'c-teal', 'wallet', 'Input credit', 'GST paid on purchases', 'books/reports', g)}${kpi(money(g.net_payable_minor), 'c-orange', 'tax', 'Net GST payable', g.net_payable_minor >= 0 ? 'Due with the return' : 'Credit carried forward', 'books/reports', g)}</div>` +
    `<div class="card checklist"><div class="card-h"><span class="ico lime">${ic('check', 18)}</span><h3>Before filing</h3><span class="count">${esc(q.label)}</span></div>${checks.map(([t, ok, sub]) => `<div class="row${ok ? ' done' : ''}"><span class="box${ok ? ' on' : ''}">${ok ? ic('check', 13) : ''}</span><div><b>${esc(t)}</b><span>${esc(sub)}</span></div></div>`).join('')}</div>` +
    bind(() => {
      $('#pp').onclick = periodPicker;
      $('#file').onclick = () => askLedger(`Prepare the GSTR-3B for ${q.label} from our books and show me the figures; then propose filing it.`);
    })
  );
};

BOOK_VIEWS.accounts = async () => {
  const a = await read('ledger.accounts.list', { include_inactive: true });
  const tones = { asset: 'green', liability: 'amber', equity: 'violet', income: 'dark', expense: 'gray' };
  return (
    head('Chart of accounts', `Balances as of ${esc(longDay(a.as_of))}. Click an account for its ledger.`, `<button class="btn lime" id="add">${ic('plus', 15)} Add account</button>`) +
    `<div class="card"><table class="t"><thead><tr><th>Code</th><th>Account</th><th>Type</th><th class="hide-sm">Subtype</th><th class="r">Balance</th></tr></thead><tbody>${a.accounts.map((x) => `<tr class="click" data-acct="${esc(x.code)}"><td class="mono">${esc(x.code)}</td><td><b>${esc(x.name)}</b>${x.active ? '' : ` ${pill('inactive')}`}</td><td>${pill(x.type, tones[x.type] ?? 'gray')}</td><td class="hide-sm muted">${esc(x.subtype)}</td><td class="r num">${money(x.balance_minor, true)}</td></tr>`).join('')}</tbody></table><div class="card-b">${src(a)}</div></div>` +
    bind(() => {
      $('#add').onclick = accountForm;
      for (const r of $$('[data-acct]')) r.onclick = () => ledgerModal(r.dataset.acct, a.accounts.find((x) => x.code === r.dataset.acct)?.name);
    })
  );
};

BOOK_VIEWS.rules = async () => {
  const r = await read('ledger.coding_rules.list', {});
  return (
    head('Coding rules', 'Teach Ledger how to code recurring bank lines. Tried in order; anything ambiguous still comes to you.', `<button class="btn lime" id="add">${ic('plus', 15)} New rule</button>`) +
    `<div class="card">${r.rules.length ? `<table class="t"><thead><tr><th>When a bank line…</th><th>Code it to</th><th class="hide-sm">Direction</th><th>Activity</th></tr></thead><tbody>${r.rules.map((x) => `<tr><td>description contains <b>“${esc(x.pattern)}”</b></td><td>→ <span class="mono">${esc(x.account_code)}</span> · ${esc(x.account_name)}</td><td class="hide-sm">${pill(x.direction === 'in' ? 'money in' : x.direction === 'out' ? 'money out' : 'either')}</td><td>${pill(`${x.matched} matched`, x.matched ? 'green' : 'gray')}</td></tr>`).join('')}</tbody></table>` : `<div class="card-b">${empty('No rules yet')}</div>`}<div class="card-b">${src(r)}</div></div>` +
    bind(() => ($('#add').onclick = codingRuleForm))
  );
};

// ── modals & forms ─────────────────────────────────────────────────────────
function modal(title, body, foot = '', wide = false) {
  $('#layer').innerHTML = `<div class="scrim" id="scrim"><div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="mh"><h2>${esc(title)}</h2><button class="icon-btn x" id="mx" aria-label="Close">${ic('x', 15)}</button></div><div class="mb">${body}</div>${foot ? `<div class="mf">${foot}</div>` : ''}</div></div>`;
  $('#mx').onclick = closeLayer;
  $('#scrim').onclick = (e) => e.target.id === 'scrim' && closeLayer();
  setTimeout(() => $('.modal input:not([type=hidden]), .modal select, .modal textarea')?.focus(), 20);
}
function closeLayer() {
  $('#layer').innerHTML = '';
}
const gateNote = '<span class="grow">This becomes a job. Ledger prepares it; the gate decides whether it waits for your yes.</span>';

async function reportModal(kind, opts = {}) {
  const p = opts.period ?? S.period;
  const { from, to } = kind === 'vat_summary' ? quarterOf(p) : range(p);
  const title = REPORTS.find((r) => r[0] === kind)[1];
  modal(`${title} · ${kind === 'vat_summary' ? quarterOf(p).label : ['balance_sheet', 'trial_balance', 'aging'].includes(kind) ? `as of ${longDay(to)}` : monthFull(p)}`, '<div class="skel"></div>', '', true);
  const agingKind = opts.agingKind ?? 'receivable';
  try {
    const args = { pnl: { from, to }, cash_flow: { from, to }, vat_summary: { from, to }, balance_sheet: { as_of: to }, trial_balance: { as_of: to }, aging: { kind: agingKind, as_of: to } }[kind];
    const r = await read(`ledger.report.${kind}`, args);
    const rows = [];
    const sec = (t) => rows.push(['section', t]);
    const ln = (a, b, strong = false) => rows.push([strong ? 'strong' : '', a, b]);
    if (kind === 'pnl') {
      sec('Income');
      r.income.forEach((x) => ln(`${x.code} ${x.name}`, x.amount_minor));
      ln('Total income', r.totals.income_minor, true);
      sec('Expenses');
      r.expenses.forEach((x) => ln(`${x.code} ${x.name}`, x.amount_minor));
      ln('Total expenses', r.totals.expenses_minor, true);
      ln('Gross profit', r.totals.gross_profit_minor, true);
      ln('Net profit', r.totals.net_profit_minor, true);
    } else if (kind === 'balance_sheet') {
      for (const [k, t] of [['assets', 'Assets'], ['liabilities', 'Liabilities'], ['equity', 'Equity']]) {
        sec(t);
        r[k].forEach((x) => ln(`${x.code} ${x.name}`, x.amount_minor));
        if (k === 'equity') ln('Earnings to date', r.totals.earnings_to_date_minor);
        ln(`Total ${t.toLowerCase()}`, k === 'equity' ? r.totals.equity_minor + r.totals.earnings_to_date_minor : r.totals[`${k}_minor`], true);
      }
    } else if (kind === 'cash_flow') {
      ln('Opening cash', r.opening_cash_minor, true);
      ln('Operating activities', r.operating_minor);
      ln('Investing activities', r.investing_minor);
      ln('Financing activities', r.financing_minor);
      ln('Closing cash', r.closing_cash_minor, true);
    } else if (kind === 'trial_balance') {
      r.rows.forEach((x) => rows.push(['tb', `${x.code} ${x.name}`, x.debit_minor, x.credit_minor]));
      rows.push(['tbs', 'Totals', r.total_debit_minor, r.total_credit_minor]);
    } else if (kind === 'aging') {
      for (const [k, t] of [['current', 'Not yet due'], ['d1_30', '1–30 days'], ['d31_60', '31–60 days'], ['d61_90', '61–90 days'], ['d90_plus', 'Over 90 days']]) ln(t, r.buckets[k]);
      ln('Total outstanding', r.total_outstanding_minor, true);
      sec(agingKind === 'receivable' ? 'Invoices' : 'Bills');
      r.items.forEach((x) => ln(`${x.number} · ${x.party} · due ${day(x.due_date)}${x.days_past_due > 0 ? ` (${x.days_past_due} d late)` : ''}`, x.outstanding_minor));
    } else if (kind === 'vat_summary') {
      ln('Output GST on sales', r.output_tax_minor);
      ln('Input GST credit on purchases', -r.input_tax_minor);
      ln('Net GST payable', r.net_payable_minor, true);
    }
    const tb = kind === 'trial_balance';
    $('.modal .mb').innerHTML =
      (kind === 'aging' ? `<div class="seg"><button data-ak="receivable" aria-pressed="${agingKind === 'receivable'}">Receivable (AR)</button><button data-ak="payable" aria-pressed="${agingKind === 'payable'}">Payable (AP)</button></div>` : '') +
      `<table class="t"><thead><tr><th>${tb ? 'Account' : 'Line'}</th>${tb ? '<th class="r">Debit</th><th class="r">Credit</th>' : '<th class="r">Amount</th>'}</tr></thead><tbody>${rows
        .map((x) => (x[0] === 'section' ? `<tr class="section"><td colspan="${tb ? 3 : 2}">${esc(x[1])}</td></tr>` : x[0] === 'tb' || x[0] === 'tbs' ? `<tr${x[0] === 'tbs' ? ' class="strong"' : ''}><td>${esc(x[1])}</td><td class="r num">${x[2] ? money(x[2], true) : ''}</td><td class="r num">${x[3] ? money(x[3], true) : ''}</td></tr>` : `<tr${x[0] ? ` class="${x[0]}"` : ''}><td>${esc(x[1])}</td><td class="r num">${money(x[2], true)}</td></tr>`))
        .join('')}</tbody></table>${src(r)}${r.balanced === false ? `<p>${pill('does not balance', 'red')}</p>` : ''}`;
    $('.modal').insertAdjacentHTML('beforeend', `<div class="mf"><span class="grow">Read live from the book</span><button class="btn" id="csv">${ic('down', 15)} Export CSV</button></div>`);
    $('#csv').onclick = () => csv(`${kind}-${kind === 'vat_summary' ? from.slice(0, 7) : p}.csv`, [tb ? ['Account', 'Debit', 'Credit'] : ['Line', 'Amount'], ...rows.filter((x) => x[0] !== 'section').map((x) => (tb ? [x[1], (x[2] ?? 0) / 100, (x[3] ?? 0) / 100] : [x[1], x[2] / 100]))]);
    for (const b of $$('[data-ak]')) b.onclick = () => reportModal('aging', { period: p, agingKind: b.dataset.ak });
  } catch (e) {
    $('.modal .mb').innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}
function csv(name, rows) {
  const text = rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function ledgerModal(code, name) {
  const { from, to } = range(S.period);
  modal(`${code} · ${name ?? ''} · ${monthFull(S.period)}`, '<div class="skel"></div>', '', true);
  try {
    const r = await read('ledger.account.ledger', { account_code: code, from, to });
    $('.modal .mb').innerHTML = `<div class="kv"><span>Opening balance</span><b>${money(r.opening_minor, true)}</b></div><table class="t"><thead><tr><th>Date</th><th>Memo</th><th class="r">Debit</th><th class="r">Credit</th><th class="r">Balance</th></tr></thead><tbody>${r.rows.map((x) => `<tr><td>${esc(day(x.date))}</td><td>${esc(x.memo)}</td><td class="r num">${x.debit_minor ? money(x.debit_minor, true) : ''}</td><td class="r num">${x.credit_minor ? money(x.credit_minor, true) : ''}</td><td class="r num">${money(x.balance_minor, true)}</td></tr>`).join('') || `<tr><td colspan="5" class="muted">No lines this month.</td></tr>`}</tbody></table><div class="kv"><span>Closing balance</span><b>${money(r.closing_minor, true)}</b></div>${src(r)}`;
  } catch (e) {
    $('.modal .mb').innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}
function entryModal(e) {
  modal(e.memo, `<div class="kv"><span>Date</span><b>${esc(longDay(e.date))}</b></div><div class="kv"><span>Reference</span><b class="mono">${esc(e.reference ?? '—')}</b></div><div class="kv"><span>Source</span><b>${esc(e.source)}</b></div><table class="t"><thead><tr><th>Account</th><th class="r">Debit</th><th class="r">Credit</th></tr></thead><tbody>${e.lines.map((l) => `<tr><td><span class="mono">${esc(l.account_code)}</span> ${esc(l.account_name)}</td><td class="r num">${l.debit_minor ? money(l.debit_minor, true) : ''}</td><td class="r num">${l.credit_minor ? money(l.credit_minor, true) : ''}</td></tr>`).join('')}</tbody></table>`, `<span class="grow mono">${esc(e.id)}</span><button class="btn danger" id="rev">Reverse this entry</button>`);
  $('#rev').onclick = () => {
    closeLayer();
    askLedger(`Reverse journal entry ${e.id} ("${e.memo}", dated ${e.date}) with a reversing entry dated ${today()}.`);
  };
}
function formModal(title, fields, submitLabel, toText) {
  modal(title, `<form id="mf">${fields}</form>`, `${gateNote}<button class="btn" id="mcancel">Cancel</button><button class="btn lime" id="msubmit">${esc(submitLabel)}</button>`);
  $('#mcancel').onclick = closeLayer;
  const go = (e) => {
    e?.preventDefault();
    const form = $('#mf');
    if (!form.reportValidity()) return;
    const text = toText(Object.fromEntries(new FormData(form).entries()), form);
    if (!text) return;
    closeLayer();
    askLedger(text);
  };
  $('#msubmit').onclick = go;
  $('#mf').onsubmit = go;
}
const rupees = (v) => money(Math.round(Number(v) * 100), true);
async function docForm(kind) {
  const [parties, accts] = await Promise.all([read('ledger.parties.list', { kind: kind === 'invoice' ? 'customer' : 'vendor' }).catch(() => ({ parties: [] })), read('ledger.accounts.list', {}).catch(() => ({ accounts: [] }))]);
  const la = accts.accounts.filter((a) => (kind === 'invoice' ? a.type === 'income' : ['expense', 'asset'].includes(a.type)));
  const due = iso(new Date(Date.now() + 30 * 864e5));
  const lineF = (i) => `<div class="row3"><div><label class="f">Description</label><input class="i" name="d${i}" ${i === 0 ? 'required' : ''} maxlength="200"></div><div><label class="f">Amount (₹, before GST)</label><input class="i" name="a${i}" type="number" min="0.01" step="0.01" ${i === 0 ? 'required' : ''}></div><div><label class="f">Account</label><select class="i" name="c${i}">${la.map((a) => `<option value="${esc(a.code)}"${(kind === 'invoice' ? '4000' : '5000') === a.code ? ' selected' : ''}>${esc(a.code)} ${esc(a.name)}</option>`).join('')}</select></div><div></div></div>`;
  formModal(
    kind === 'invoice' ? 'New invoice' : 'Record a supplier bill',
    `<label class="f">${kind === 'invoice' ? 'Customer' : 'Vendor'}</label><input class="i" name="party" list="plist" required maxlength="120"><datalist id="plist">${parties.parties.map((p) => `<option value="${esc(p.name)}">`).join('')}</datalist>
     ${kind === 'bill' ? '<label class="f">Supplier’s bill number</label><input class="i" name="number" required maxlength="40">' : ''}
     <div class="row2"><div><label class="f">Issue date</label><input class="i" name="issue" type="date" value="${today()}" required></div><div><label class="f">Due date</label><input class="i" name="due" type="date" value="${due}" required></div></div>
     <label class="f">GST rate</label><select class="i" name="gst">${[0, 5, 12, 18, 28].map((r) => `<option value="${r}"${r === 18 ? ' selected' : ''}>${r}%</option>`).join('')}</select>${lineF(0)}${lineF(1)}${lineF(2)}
     ${kind === 'invoice' ? '<label class="f"><input type="checkbox" name="send" value="1" checked> Email it to the customer once created</label>' : ''}`,
    'Ask Ledger',
    (d) => {
      const lines = [0, 1, 2].filter((i) => d[`d${i}`] && Number(d[`a${i}`]) > 0).map((i) => `"${d[`d${i}`]}" ${rupees(d[`a${i}`])} (account ${d[`c${i}`]})`);
      if (!lines.length) return toast('Add at least one line with an amount.', true), null;
      if (d.due < d.issue) return toast('The due date is before the issue date.', true), null;
      const known = parties.parties.some((p) => p.name.toLowerCase() === d.party.trim().toLowerCase());
      const np = known ? '' : ` ${d.party} is new: add them as a ${kind === 'invoice' ? 'customer' : 'vendor'} first.`;
      return kind === 'invoice' ? `Create an invoice for customer "${d.party}", issued ${d.issue}, due ${d.due}, in INR at ${d.gst}% GST, with lines: ${lines.join('; ')}.${np}${d.send ? ' Then email it to them.' : ''}` : `Record supplier bill ${d.number} from vendor "${d.party}", issued ${d.issue}, due ${d.due}, in INR at ${d.gst}% GST, with lines: ${lines.join('; ')}.${np}`;
    },
  );
}
function paymentForm(d, kind) {
  formModal(
    kind === 'bill' ? `Record payment · ${d.number}` : `Record receipt · ${d.number}`,
    `<p class="muted">${esc(d.party)} · outstanding <b>${money(d.outstanding_minor, true)}</b></p><div class="row2"><div><label class="f">Date</label><input class="i" name="date" type="date" value="${today()}" required></div><div><label class="f">Amount (₹)</label><input class="i" name="amt" type="number" min="0.01" step="0.01" max="${d.outstanding_minor / 100}" value="${d.outstanding_minor / 100}" required></div></div><label class="f">Bank account</label><input class="i" name="bank" value="1010" maxlength="10" required>`,
    'Ask Ledger',
    (x) => `Record a ${kind === 'bill' ? 'payment' : 'receipt'} of ${rupees(x.amt)} on ${x.date} against ${kind} ${d.number} (${d.party}) through bank account ${x.bank}.`,
  );
}
function partyForm(kind) {
  formModal(`Add ${kind}`, `<label class="f">Name</label><input class="i" name="name" required maxlength="120"><div class="row2"><div><label class="f">Email</label><input class="i" name="email" type="email" maxlength="200"></div><div><label class="f">GSTIN</label><input class="i mono" name="gstin" maxlength="15" pattern="[0-9A-Z]{15}"></div></div>`, 'Ask Ledger', (d) => `Add ${kind} "${d.name}"${d.email ? ` with email ${d.email}` : ''}${d.gstin ? ` and GSTIN ${d.gstin}` : ''}.`);
}
function accountForm() {
  formModal(
    'Add account',
    `<div class="row2"><div><label class="f">Code</label><input class="i mono" name="code" required pattern="[0-9]{4}"></div><div><label class="f">Name</label><input class="i" name="name" required maxlength="80"></div></div><div class="row2"><div><label class="f">Type</label><select class="i" name="type">${['asset', 'liability', 'equity', 'income', 'expense'].map((t) => `<option>${t}</option>`).join('')}</select></div><div><label class="f">Subtype</label><select class="i" name="subtype">${['bank', 'cash', 'receivable', 'inventory', 'fixed_asset', 'payable', 'loan', 'equity', 'revenue', 'other_income', 'cogs', 'opex', 'other_expense'].map((t) => `<option>${t}</option>`).join('')}</select></div></div>`,
    'Ask Ledger',
    (d) => `Create account ${d.code} "${d.name}" of type ${d.type}, subtype ${d.subtype}.`,
  );
}
async function codingRuleForm() {
  const accts = await read('ledger.accounts.list', {}).catch(() => ({ accounts: [] }));
  formModal('New coding rule', `<label class="f">When the bank line description contains</label><input class="i" name="pattern" required minlength="2" maxlength="100"><label class="f">Code it to</label><select class="i" name="code">${accts.accounts.map((a) => `<option value="${esc(a.code)}">${esc(a.code)} ${esc(a.name)}</option>`).join('')}</select><label class="f">For</label><select class="i" name="dir"><option value="out">money out</option><option value="in">money in</option><option value="any">either</option></select>`, 'Ask Ledger', (d) => `Add a coding rule: bank lines whose description contains "${d.pattern}" (${d.dir === 'any' ? 'in or out' : d.dir === 'in' ? 'money in' : 'money out'}) go to account ${d.code}.`);
}
function journalForm() {
  const lf = (i) => `<div class="row3"><div><label class="f">Account code</label><input class="i mono" name="c${i}" pattern="[0-9]{4}" ${i < 2 ? 'required' : ''}></div><div><label class="f">Debit (₹)</label><input class="i" name="dr${i}" type="number" min="0" step="0.01"></div><div><label class="f">Credit (₹)</label><input class="i" name="cr${i}" type="number" min="0" step="0.01"></div><div></div></div>`;
  formModal('Manual journal entry', `<div class="row2"><div><label class="f">Date</label><input class="i" name="date" type="date" value="${today()}" required></div><div><label class="f">Memo</label><input class="i" name="memo" required maxlength="200"></div></div>${lf(0)}${lf(1)}${lf(2)}${lf(3)}`, 'Ask Ledger', (d) => {
    const ls = [0, 1, 2, 3].filter((i) => d[`c${i}`]).map((i) => ({ c: d[`c${i}`], dr: Number(d[`dr${i}`] || 0), cr: Number(d[`cr${i}`] || 0) }));
    const dr = ls.reduce((s, l) => s + l.dr, 0);
    const cr = ls.reduce((s, l) => s + l.cr, 0);
    if (Math.round(dr * 100) !== Math.round(cr * 100) || !dr) return toast(`Debits (${rupees(dr)}) must equal credits (${rupees(cr)}).`, true), null;
    return `Post a journal entry dated ${d.date}, memo "${d.memo}", in INR: ${ls.map((l) => (l.dr ? `debit ${l.c} ${rupees(l.dr)}` : `credit ${l.c} ${rupees(l.cr)}`)).join('; ')}.`;
  });
}
function importForm() {
  formModal('Import bank statement', `<p class="muted">Paste CSV rows as <span class="mono">date,description,amount</span> (money in positive, out negative). Up to 200 lines.</p><label class="f">Bank account</label><input class="i mono" name="bank" value="1010" required pattern="[0-9]{4}"><label class="f">Statement lines</label><textarea class="i mono" name="rows" rows="8" required placeholder="2026-09-30,NEFT CR SHARMA RETAIL,210000.00&#10;2026-09-30,UPI OFFICE SUPPLIES,-2450.00"></textarea>`, 'Ask Ledger', (d) => {
    const rows = d.rows.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const bad = rows.find((l) => !/^\d{4}-\d{2}-\d{2},.+,-?\d+(\.\d{1,2})?$/.test(l));
    if (bad) return toast(`Not a date,description,amount row: ${bad}`, true), null;
    if (rows.length > 200) return toast('Up to 200 lines at a time.', true), null;
    return `Import these ${rows.length} bank statement lines into bank account ${d.bank} (INR). Each is date, description, amount in rupees:\n${rows.join('\n')}`;
  });
}
function closePackForm(p) {
  formModal(`Email the close pack · ${monthLabel(p)}`, `<label class="f">Send to</label><input class="i" name="to" type="email" required placeholder="accountant@example.com"><label class="f">Note (optional)</label><textarea class="i" name="note" rows="3" maxlength="500"></textarea>`, 'Ask Ledger', (d) => `Email the close pack for ${monthFull(p)} (period ${p}) to ${d.to}.${d.note ? ` Include this note: "${d.note}"` : ''}`);
}
function reopenForm(p) {
  formModal(`Reopen ${monthLabel(p)}`, `<p class="muted">A closed month takes no postings. Reopening is recorded with your reason.</p><label class="f">Reason</label><textarea class="i" name="reason" rows="3" required minlength="5" maxlength="300"></textarea>`, 'Ask Ledger', (d) => `Reopen the period ${p} (${monthFull(p)}). Reason: ${d.reason}`);
}
function periodPicker() {
  const now = today().slice(0, 7);
  const months = Array.from({ length: 15 }, (_, i) => addMonths(now, -i));
  modal('Choose the month you are looking at', `<div class="grid g3">${months.map((m) => `<button class="btn${m === S.period ? ' lime' : ''}" data-m="${m}">${esc(monthFull(m))}</button>`).join('')}</div>`);
  for (const b of $$('[data-m]'))
    b.onclick = () => {
      S.period = b.dataset.m;
      sessionStorage.setItem('ledger.period', S.period);
      closeLayer();
      paintCompany();
      render();
    };
}
function meMenu() {
  modal(S.me.name, `<div class="kv"><span>Company</span><b>${esc(S.me.company?.name ?? '')}</b></div><div class="kv"><span>Role</span><b>${esc(S.me.role)}</b></div><div class="kv"><span>Time zone</span><b>${esc(S.me.company?.time_zone ?? '')}</b></div>`, `<button class="btn" id="lo">${ic('logout', 15)} Sign out</button>`);
  $('#lo').onclick = async () => {
    await fetch('/auth/logout', { method: 'POST', headers: { 'x-neos-web': '1' } });
    location.replace('/login');
  };
}
function help() {
  modal(
    'How Ledger works',
    `<p><b>One app, one subject, one assistant you can talk to — and a book it cannot lie to.</b></p>
     <ol><li><b>You ask.</b> It becomes a <a href="#/jobs">job</a> in Ledger’s record book, and Ledger says “on it” at once.</li>
     <li><b>A fresh assistant works it</b>, one step at a time, writing every step down. It holds no keys and no database access; it can only ask the gate.</li>
     <li><b>The gate decides</b> from the <a href="#/switchboard">switchboard</a>: on → do it; ask first → write a proposal and pause; off → refuse. Company rules and spend caps are checked here too.</li>
     <li><b>You answer</b> under <a href="#/approvals">Approvals</a> or in the chat. A yes binds to the fingerprint of exactly what you saw, and has a clock.</li>
     <li><b>Ledger carries it out once</b>, itself, on the platform’s say-so — no model in the loop — and reads it back.</li>
     <li><b>A fresh assistant is woken</b> with the proof, checks it, and reports what it did, what changed and what it could not do.</li></ol>
     <p class="note">Shortcuts: <span class="mono">/</span> ask · <span class="mono">⌘K</span> find · <span class="mono">Esc</span> close</p>`,
  );
  for (const a of $$('#layer a')) a.addEventListener('click', closeLayer);
}

// ── find ───────────────────────────────────────────────────────────────────
async function openSearch() {
  const pages = [...RAIL.flatMap(([, items]) => items.map(([k, l]) => [k, l])), ...BOOKS.map(([k, l]) => [`books/${k}`, `Books · ${l}`]), ['setup', 'Set up']];
  $('#layer').innerHTML = `<div class="search" id="sx"><div class="box"><input id="sq" placeholder="Find a page, job, account, invoice or party…" autocomplete="off"><ul id="sr"></ul></div></div>`;
  $('#sx').onclick = (e) => e.target.id === 'sx' && closeLayer();
  let items = pages.map(([k, l]) => ({ label: l, hint: 'page', go: () => (location.hash = `#/${k}`) })).concat(S.tasks.slice(0, 30).map((t) => ({ label: t.ask, hint: `job · ${String(t.status).toLowerCase()}`, go: () => (location.hash = `#/jobs/${t.id}`) })));
  const paint = () => {
    const q = $('#sq').value.trim().toLowerCase();
    const hits = items.filter((i) => !q || i.label.toLowerCase().includes(q) || i.hint.toLowerCase().includes(q)).slice(0, 12);
    $('#sr').innerHTML = hits.map((h, i) => `<li><button data-i="${i}"${i === 0 ? ' class="on"' : ''}><span>${esc(h.label)}</span><span class="faint">${esc(h.hint)}</span></button></li>`).join('') || `<li class="empty">Nothing found. Press Enter to ask Ledger.</li>`;
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
    else if (q) askLedger(q);
  };
  $('#sq').focus();
  paint();
  try {
    const [a, inv, bills, parties] = await Promise.all([read('ledger.accounts.list', {}), read('ledger.documents.list', { kind: 'invoice' }), read('ledger.documents.list', { kind: 'bill' }), read('ledger.parties.list', {})]);
    items = items.concat(
      a.accounts.map((x) => ({ label: `${x.code} ${x.name}`, hint: `account · ${money(x.balance_minor)}`, go: () => ledgerModal(x.code, x.name) })),
      inv.documents.map((x) => ({ label: `${x.number} · ${x.party}`, hint: `invoice · ${money(x.outstanding_minor)} open`, go: () => (location.hash = '#/books/money?status=all') })),
      bills.documents.map((x) => ({ label: `${x.number} · ${x.party}`, hint: `bill · ${money(x.outstanding_minor)} open`, go: () => (location.hash = '#/books/money?bills&status=all') })),
      parties.parties.map((x) => ({ label: x.name, hint: x.kind, go: () => (location.hash = x.kind === 'vendor' ? '#/books/money?bills' : '#/books/money') })),
    );
    if ($('#sq')) paint();
  } catch {
    /* pages and jobs are still searchable */
  }
}

// ── theme ──────────────────────────────────────────────────────────────────
const currentTheme = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function themeIcon() {
  $('#btn-theme').innerHTML = ic(currentTheme() === 'dark' ? 'sun' : 'moon', 17);
}
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('ledger.theme', next);
  } catch {
    /* private mode */
  }
  themeIcon();
}

// ── boot ───────────────────────────────────────────────────────────────────
function paintCompany() {
  $('#co').innerHTML = `<b>${esc(S.me.company?.name ?? 'Company')}</b><span>${esc(monthLabel(S.period))} ⌄</span>`;
  $('#me-btn').textContent = S.me.name.replace(/\(.*\)/, '').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}
async function loadLines() {
  const r = await api('/api/apps/ledger/abilities');
  S.lines = r.abilities;
  S.doors = r.doors;
  S.sbVersion = r.switchboard_version;
}
(async function boot() {
  try {
    const t = localStorage.getItem('ledger.theme');
    if (t) document.documentElement.dataset.theme = t;
  } catch {
    /* ignore */
  }
  S.period = sessionStorage.getItem('ledger.period') || S.period;
  shell();
  try {
    S.me = await api('/api/me');
    paintCompany();
    await loadLines();
  } catch (e) {
    $('#main').innerHTML = `<div class="head"><div><h1>Ledger is not available</h1><p>${esc(e.message)}</p></div></div>`;
    return;
  }
  route();
  refreshLive();
  setInterval(refreshLive, 4000);
  setInterval(tickClocks, 30_000);
  if (S.conv) stream();
})();
