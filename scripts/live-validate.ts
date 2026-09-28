// Live validation of a deployed NEOP stack, through the person-facing API only (never the DB).
// It runs with the stack's REAL model, so it caps spend (task cost from /api/tasks/:id and the app's
// usage today), gives the assistant one precise instruction per change, and bounds every job.
//
//   NEOS_PLATFORM_URL=http://127.0.0.1:4500 NEOS_TOKEN_FILE=<admin token> [NEOS_MEMBER_TOKEN_FILE=<member token>] \
//     pnpm exec tsx scripts/live-validate.ts [--app ledger] [--only reads,writes,governance,questions,documents,schedules,blocks] \
//       [--out docs/LIVE-VALIDATION.md] [--budget-usd 12] [--email-to you@company.example] [--gst]
//       [--job-timeout-s 360] [--poll-ms 2000] [--schedule-lead-min 2]
//
// Sections (each yields PASS / FAIL / SKIPPED rows with evidence): reads, writes, governance, questions,
// documents, schedules, blocks. Output: a markdown report and a JSON copy (same path, .json). Exit 1 on any FAIL.
//
// The assistant is told what to do in plain words, followed by machine lines the in-process pilot's
// scripted brain obeys (apps/ledger/tests/live-validate.test.ts):
//   TOOL: <ability key>     ARGS: <one-line JSON>     CARD: required|none     QUESTION: <one-line JSON for job_ask>
// A real model reads the same lines as part of the instruction.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

export const SECTIONS = ['reads', 'writes', 'governance', 'questions', 'documents', 'schedules', 'blocks'] as const;
export type Section = (typeof SECTIONS)[number];
export type Result = 'PASS' | 'FAIL' | 'SKIPPED';

export interface Row {
  section: Section | 'setup';
  item: string;
  result: Result;
  evidence: string;
  cost_usd: number;
}

export interface Options {
  baseUrl: string;
  adminToken: string;
  memberToken?: string;
  app: string;
  only: Section[];
  out?: string;
  budgetUsd: number;
  /** Recipient for every external-effect write (never a real customer). Without it those writes are SKIPPED. */
  emailTo?: string;
  /** Doors connected at this company (v3: the secret store is not visible from here). */
  doors?: string[];
  /** Run GST portal writes of an installed nep-gst package (only against a sandbox portal). */
  gst: boolean;
  jobTimeoutMs: number;
  pollMs: number;
  scheduleLeadMin: number;
  /** Where to find apps/<app>/manifest.json and registry/<pkg>/manifest.json (output schemas). */
  repoRoot: string;
  /** A short unique tag for names this run creates. */
  tag?: string;
  /** Override "now" (tests). */
  now?: () => Date;
  log?: (line: string) => void;
}

export interface Report {
  app: string;
  base_url: string;
  tag: string;
  started_at: string;
  finished_at: string;
  company: { name: string; time_zone: string } | null;
  today: string;
  live_version: string | null;
  local_version: string | null;
  spent_usd: number;
  budget_usd: number;
  notes: string[];
  rows: Row[];
}

// ── small pure helpers (unit-tested) ─────────────────────────────────────────

export function ymdIn(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function hhmmIn(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}
export function addDays(ymd: string, n: number): string {
  const t = Date.parse(`${ymd}T00:00:00Z`) + n * 864e5;
  return new Date(t).toISOString().slice(0, 10);
}
export function monthEnd(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
export function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** Dates every read and block is run with, from "today" in the company's time zone. */
export interface Dates {
  today: string;
  month: string;
  monthFrom: string;
  monthTo: string;
  prevMonth: string;
  prevFrom: string;
  prevTo: string;
  quarterFrom: string;
  quarterTo: string;
  todayPlus30: string;
}
export function datesFor(today: string): Dates {
  const month = today.slice(0, 7);
  const prevMonth = shiftMonth(month, -1);
  const m = Number(month.slice(5, 7));
  const qStart = `${month.slice(0, 4)}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}`;
  return {
    today,
    month,
    monthFrom: `${month}-01`,
    monthTo: monthEnd(month),
    prevMonth,
    prevFrom: `${prevMonth}-01`,
    prevTo: monthEnd(prevMonth),
    quarterFrom: `${qStart}-01`,
    quarterTo: monthEnd(shiftMonth(qStart, 2)),
    todayPlus30: addDays(today, 30),
  };
}

/** Accounts the checks post to, picked from the live chart (never assumed). */
export interface Chart {
  bank: string;
  cash: string | null;
  expense: string;
  income: string;
  budget: string;
}

/** The read args table: one or more cases per read ability. Keys missing here are reported "not exercised". */
export function readCases(d: Dates, chart: Chart, extra: { documentSha?: string } = {}): Record<string, Record<string, unknown>[]> {
  const csv = Buffer.from(`date,description,amount\n${d.today},Live validation line,100.00\n`).toString('base64');
  return {
    'ledger.report.pnl': [{ from: d.prevFrom, to: d.today }],
    'ledger.report.balance_sheet': [{ as_of: d.today }],
    'ledger.report.cash_flow': [{ from: d.prevFrom, to: d.today }],
    'ledger.report.trial_balance': [{ as_of: d.today }],
    'ledger.report.aging': [
      { kind: 'receivable', as_of: d.today },
      { kind: 'payable', as_of: d.today },
    ],
    'ledger.report.vat_summary': [{ from: d.quarterFrom, to: d.quarterTo }],
    'ledger.budget.remaining': [{ account_code: chart.budget, month: d.month }],
    'ledger.accounts.list': [{ as_of: d.today }, { type: 'expense', include_inactive: true }],
    'ledger.account.ledger': [{ account_code: chart.bank, from: d.monthFrom, to: d.today }],
    'ledger.journal.list': [{ from: d.monthFrom, to: d.today, limit: 50 }],
    'ledger.documents.list': [
      { kind: 'invoice', status: 'all' },
      { kind: 'bill', status: 'open' },
    ],
    'ledger.parties.list': [{}, { kind: 'vendor' }],
    'ledger.bank.unreconciled': [{}],
    'ledger.periods.status': [{}],
    'ledger.coding_rules.list': [{}],
    'ledger.home.summary': [{ as_of: d.today }],
    'ledger.close.checklist': [{ month: d.month }],
    'ledger.settings.get': [{}],
    'ledger.report.aging_analysis': [{ kind: 'receivable', as_of: d.today }],
    'ledger.report.cash_forecast': [{ as_of: d.today, weeks: 4 }],
    'ledger.report.tax_return': [{ from: d.prevFrom, to: d.prevTo }],
    'ledger.report.export': [
      { report: 'trial_balance', format: 'md', as_of: d.today },
      { report: 'pnl', format: 'csv', from: d.prevFrom, to: d.prevTo },
    ],
    'ledger.document.extract': [{ filename: 'live-validate.csv', content_type: 'text/csv', content_base64: csv }],
    // A kept file when the documents section ran; otherwise an unknown id must come back honestly empty.
    'ledger.document.get': [{ sha256: extra.documentSha ?? 'f'.repeat(64) }],
    'gst.returns.list': [{}, { period: d.prevMonth }],
  };
}

/** Honesty of a read result beyond its schema: generatedAt, sources, and "empty" agreeing with what it cites. */
export function honestyProblem(result: any, now: Date): string | null {
  if (!result || typeof result !== 'object') return 'no result object';
  if ('generatedAt' in result) {
    const t = Date.parse(result.generatedAt);
    if (Number.isNaN(t)) return `generatedAt is not a date: ${String(result.generatedAt)}`;
    if (Math.abs(t - now.getTime()) > 15 * 60_000) return `generatedAt ${result.generatedAt} is not now`;
  } else return 'no generatedAt';
  if (!('sources' in result) || result.sources === null || result.sources === undefined) return 'no sources';
  const n = result.sources?.entries;
  if (typeof n === 'number' && typeof result.empty === 'boolean') {
    if (result.empty && n > 0) return `says empty but cites ${n} source entries`;
    if (!result.empty && n === 0) {
      const skip = new Set(['generatedAt', 'currency', 'sources', 'empty']);
      const content = Object.entries(result).some(([k, v]) => !skip.has(k) && ((Array.isArray(v) && v.length > 0) || (typeof v === 'string' && k === 'text' && v.trim() !== '') || (!!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0)));
      if (!content) return 'says not empty but cites no sources and carries no rows';
    }
    if (Array.isArray(result.sources.entry_ids) && result.sources.entry_ids.length > n) return `cites ${result.sources.entry_ids.length} entry ids but counts ${n}`;
  }
  return null;
}

/** Placeholders in blocks: {{month}}, {{month_from}}, … resolved from the dates and the chart. */
export function resolveBlockArgs(args: unknown, d: Dates, chart: Chart): { args: unknown; unresolved: string[] } {
  const map: Record<string, string> = {
    month: d.month,
    month_from: d.monthFrom,
    month_to: d.monthTo,
    quarter_from: d.quarterFrom,
    quarter_to: d.quarterTo,
    today: d.today,
    today_plus_30: d.todayPlus30,
    'row.code': chart.bank,
    code: chart.bank,
  };
  const unresolved: string[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(/\{\{\s*([\w.]+)(\|[\w]+)?\s*\}\}/g, (m, k: string) => {
        if (k in map) return map[k]!;
        unresolved.push(k);
        return m;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { args: walk(args ?? {}), unresolved };
}

/** Every {ability, args} a block tree reads. */
export function blockSources(block: unknown): { ability: string; args: unknown }[] {
  const out: { ability: string; args: unknown }[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.ability === 'string') out.push({ ability: o.ability, args: o.args ?? {} });
      Object.values(o).forEach(walk);
    }
  };
  walk(block);
  const seen = new Set<string>();
  return out.filter((s) => {
    const k = `${s.ability} ${JSON.stringify(s.args)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** expected ⊆ actual (objects by key, arrays by position and length, scalars equal). */
export function subsetMismatch(expected: unknown, actual: unknown, at = 'args'): string | null {
  if (expected === null || typeof expected !== 'object') return Object.is(expected, actual) ? null : `${at}: expected ${JSON.stringify(expected)}, card has ${JSON.stringify(actual)}`;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return `${at}: expected ${expected.length} items, card has ${Array.isArray(actual) ? actual.length : typeof actual}`;
    for (const [i, e] of expected.entries()) {
      const p = subsetMismatch(e, actual[i], `${at}[${i}]`);
      if (p) return p;
    }
    return null;
  }
  if (!actual || typeof actual !== 'object') return `${at}: expected an object`;
  for (const [k, e] of Object.entries(expected)) {
    const p = subsetMismatch(e, (actual as Record<string, unknown>)[k], `${at}.${k}`);
    if (p) return p;
  }
  return null;
}

export function cardProblem(a: any): string | null {
  const c = a?.card;
  if (!c || typeof c !== 'object') return 'no card';
  for (const k of ['what', 'why', 'changes', 'if_no_answer']) if (typeof c[k] !== 'string' || !c[k].trim()) return `card.${k} missing`;
  if (typeof a.fingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(a.fingerprint)) return `fingerprint ${String(a.fingerprint)} is not sha256:<hex>`;
  if (!a.expires_at || Date.parse(a.expires_at) <= Date.now()) return 'card has no future expiry';
  return null;
}

/** One plain-words instruction per change, with the machine lines the pilot's scripted brain reads. */
export function writeInstruction(tag: string, id: string, key: string, args: unknown, needsCard: boolean, what: string, extra = ''): string {
  return [
    `[live-validate ${tag}/${id}] This is an automated acceptance check. Do exactly what follows and nothing more.`,
    `Use the ability ${key} once, with exactly these arguments. Copy every value as given; add nothing and change nothing.`,
    `TOOL: ${key}`,
    `ARGS: ${JSON.stringify(args)}`,
    `CARD: ${needsCard ? 'required' : 'none'}`,
    needsCard
      ? `It asks first: fill its card plainly (what: "${what}"; why: "live validation check ${tag}"; changes: what it changes, concretely; if_no_answer: "nothing changes"). A person answers the card; wait for the answer.`
      : 'It runs straight away; no card is needed.',
    extra,
    'Do not use any other ability that changes anything, do not ask me questions, and if it is refused do not retry with other values. When it is done, declined or refused, finish the job with job_finish and quote the result.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function mdEscape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderMarkdown(r: Report): string {
  const secs = [...new Set(r.rows.map((x) => x.section))];
  const count = (s: string, res: Result) => r.rows.filter((x) => x.section === s && x.result === res).length;
  const fails = r.rows.filter((x) => x.result === 'FAIL').length;
  const out: string[] = [
    `# Live validation — ${r.app}`,
    '',
    `${fails ? `**${fails} FAIL**` : '**All checks pass**'} · ${r.base_url} · company ${r.company?.name ?? '?'} (${r.company?.time_zone ?? '?'}) · today ${r.today} · run tag \`${r.tag}\``,
    '',
    `Started ${r.started_at}, finished ${r.finished_at}. Assistant spend $${r.spent_usd.toFixed(4)} of a $${r.budget_usd} budget. Live manifest ${r.live_version ?? '?'} · local schemas ${r.local_version ?? '?'}.`,
    '',
    '| Section | Pass | Fail | Skipped |',
    '|---|---:|---:|---:|',
    ...secs.map((s) => `| ${s} | ${count(s, 'PASS')} | ${count(s, 'FAIL')} | ${count(s, 'SKIPPED')} |`),
    '',
  ];
  if (r.notes.length) out.push('## Notes', '', ...r.notes.map((n) => `- ${n}`), '');
  for (const s of secs) {
    out.push(`## ${s}`, '', '| Item | Result | Evidence | Cost |', '|---|---|---|---:|');
    for (const x of r.rows.filter((y) => y.section === s)) {
      out.push(`| ${mdEscape(x.item)} | ${x.result === 'FAIL' ? '**FAIL**' : x.result} | ${mdEscape(x.evidence)} | ${x.cost_usd ? `$${x.cost_usd.toFixed(4)}` : ''} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

// ── the API ──────────────────────────────────────────────────────────────────

export type Api = (method: string, p: string, body?: unknown, token?: string) => Promise<{ status: number; body: any }>;

export function httpApi(baseUrl: string, adminToken: string): Api {
  const base = baseUrl.replace(/\/$/, '');
  return async (method, p, body, token = adminToken) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60_000);
    try {
      const res = await fetch(base + p, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await res.text();
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { raw: text.slice(0, 500) };
      }
      return { status: res.status, body: parsed };
    } catch (e) {
      return { status: 0, body: { error: { code: 'network', message: String(e) } } };
    } finally {
      clearTimeout(timer);
    }
  };
}

interface Validators {
  output(key: string): ((v: unknown) => string | null) | null;
  input(key: string): ((v: unknown) => string | null) | null;
}

function loadValidators(schemas: Map<string, { input: unknown; output: unknown }>): Validators {
  // ajv lives with the template (the app's own validator); resolve it from there.
  const req = createRequire(path.join(REPO_ROOT, 'packages/neop-template/package.json'));
  const AjvMod = req('ajv');
  const AjvCtor = AjvMod.default ?? AjvMod.Ajv ?? AjvMod;
  const fm = req('ajv-formats');
  const addFormats = fm.default ?? fm;
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  addFormats(ajv);
  const cache = new Map<string, (v: unknown) => string | null>();
  const get = (key: string, which: 'input' | 'output') => {
    const id = `${which}:${key}`;
    if (cache.has(id)) return cache.get(id)!;
    const s = schemas.get(key)?.[which];
    if (!s) return null;
    const v = ajv.compile(s);
    const f = (x: unknown) => (v(x) ? null : ajv.errorsText(v.errors, { dataVar: which === 'input' ? 'args' : 'result' }));
    cache.set(id, f);
    return f;
  };
  return { output: (k) => get(k, 'output'), input: (k) => get(k, 'input') };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (id: unknown) => String(id ?? '').slice(0, 8);
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

interface Ability {
  key: string;
  kind: 'read' | 'write';
  floor: string;
  setting: string;
  from: string;
  effects: Record<string, unknown>;
  doors: string[];
}

interface JobRun {
  task_id: string;
  job_id: string;
  conversation_id: string | null;
  detail: any;
  status: string;
  cost: number;
  timedOut: boolean;
  budgetStop: boolean;
  error: string | null;
  cardsSeen: any[];
}

// ── the validator ────────────────────────────────────────────────────────────

export class LiveValidator {
  readonly rows: Row[] = [];
  readonly notes: string[] = [];
  private o: Options;
  private api: Api;
  private tag: string;
  private tz = 'UTC';
  private d!: Dates;
  private chart!: Chart;
  private company: { name: string; time_zone: string } | null = null;
  private abilities: Ability[] = [];
  private schemas = new Map<string, { input: unknown; output: unknown }>();
  private v!: Validators;
  private appName = '';
  private liveVersion: string | null = null;
  private localVersion: string | null = null;
  private taskCost = new Map<string, number>();
  private usageStart: number | null = null;
  private usageDelta = 0;
  private startedAt = new Date();
  private doors = new Set<string>();
  /** State later checks build on. */
  private s: Record<string, any> = {};

  constructor(o: Options, api?: Api) {
    this.o = o;
    this.api = api ?? httpApi(o.baseUrl, o.adminToken);
    this.tag = o.tag ?? `LV${Date.now().toString(36).slice(-5).toUpperCase()}${randomBytes(1).toString('hex').toUpperCase()}`;
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }
  private log(s: string) {
    this.o.log?.(s);
  }
  private add(section: Row['section'], item: string, result: Result, evidence: string, cost = 0) {
    this.rows.push({ section, item, result, evidence: evidence.slice(0, 1200), cost_usd: Math.round(cost * 1e6) / 1e6 });
    this.log(`${result.padEnd(7)} ${section} · ${item} — ${evidence.slice(0, 200)}`);
  }

  spent(): number {
    const tasks = [...this.taskCost.values()].reduce((a, b) => a + b, 0);
    return Math.max(tasks, this.usageDelta);
  }
  private async refreshUsage() {
    const u = await this.api('GET', `/api/usage/${this.o.app}`);
    if (u.status !== 200 || typeof u.body?.today_usd !== 'number') return;
    if (this.usageStart === null) this.usageStart = u.body.today_usd;
    else this.usageDelta = Math.max(this.usageDelta, u.body.today_usd - this.usageStart);
  }
  private overBudget(): boolean {
    return this.spent() >= this.o.budgetUsd;
  }

  // ── setup ──────────────────────────────────────────────────────────────────
  async init(): Promise<void> {
    const me = await this.api('GET', '/api/me');
    if (me.status !== 200) throw new Error(`GET /api/me: ${me.status} ${JSON.stringify(me.body)}`);
    if (me.body.role !== 'admin') throw new Error(`the token is a ${me.body.role}'s; an admin token is required`);
    this.s.me = me.body;
    this.company = me.body.company ? { name: me.body.company.name, time_zone: me.body.company.time_zone } : null;
    this.tz = me.body.company?.time_zone ?? 'UTC';
    this.d = datesFor(ymdIn(this.now(), this.tz));
    await this.refreshUsage();

    const ab = await this.api('GET', `/api/apps/${this.o.app}/abilities`);
    if (ab.status !== 200) throw new Error(`GET /api/apps/${this.o.app}/abilities: ${ab.status} ${JSON.stringify(ab.body)}`);
    this.abilities = ab.body.abilities;
    this.doors = new Set((ab.body.doors ?? []).map((x: any) => x.key));
    const reg = await this.api('GET', '/api/registry');
    const entry = (reg.body?.apps ?? []).find((a: any) => a.key === this.o.app);
    this.liveVersion = entry?.version ?? null;
    this.appName = entry?.name ?? this.o.app;

    // The person-facing API does not serve ability schemas; they come from the repo checkout.
    const mf = path.join(this.o.repoRoot, 'apps', this.o.app, 'manifest.json');
    if (existsSync(mf)) {
      const m = JSON.parse(readFileSync(mf, 'utf8'));
      this.localVersion = m.version ?? null;
      for (const a of m.abilities ?? []) this.schemas.set(a.key, { input: a.input, output: a.output });
    }
    for (const pkg of new Set(this.abilities.filter((a) => a.from !== 'own').map((a) => a.from))) {
      const pf = path.join(this.o.repoRoot, 'registry', pkg, 'manifest.json');
      if (!existsSync(pf)) continue;
      const m = JSON.parse(readFileSync(pf, 'utf8'));
      for (const a of m.abilities ?? []) this.schemas.set(a.key, { input: a.input, output: a.output });
    }
    this.v = loadValidators(this.schemas);
    this.notes.push('Ability output schemas are not served by the person-facing API; they are read from this checkout (apps/<app>/manifest.json, registry/<pkg>/manifest.json) and the versions compared.');
    if (this.liveVersion && this.localVersion && this.liveVersion !== this.localVersion) {
      this.add('setup', 'manifest version', 'FAIL', `live ${this.liveVersion} ≠ local ${this.localVersion}: schemas below may not be the deployed ones`);
    } else this.add('setup', 'manifest version', this.localVersion ? 'PASS' : 'FAIL', `live ${this.liveVersion ?? '?'} · local ${this.localVersion ?? 'missing'}`);
    const missingLocal = this.abilities.filter((a) => !this.schemas.has(a.key)).map((a) => a.key);
    const own = this.abilities.filter((a) => a.from === 'own').length;
    this.add('setup', 'ability list', missingLocal.length ? 'FAIL' : 'PASS', missingLocal.length ? `deployed abilities without a local schema: ${missingLocal.join(', ')}` : `${own} own abilities, ${this.abilities.length - own} from packages; every one has a local schema`);

    // The chart, read (never assumed).
    const acc = await this.read('ledger.accounts.list', { include_inactive: false });
    const accounts: any[] = acc.body?.result?.accounts ?? [];
    const pick = (f: (a: any) => boolean, fb: string) => accounts.find(f)?.code ?? fb;
    this.chart = {
      bank: pick((a) => a.subtype === 'bank', '1010'),
      cash: accounts.find((a) => a.subtype === 'cash')?.code ?? null,
      expense: accounts.some((a) => a.code === '6300' && a.type === 'expense') ? '6300' : pick((a) => a.type === 'expense' && a.subtype !== 'cogs', '6300'),
      income: accounts.some((a) => a.code === '4000' && a.type === 'income') ? '4000' : pick((a) => a.type === 'income', '4000'),
      budget: accounts.some((a) => a.code === '6400') ? '6400' : pick((a) => a.type === 'expense', '6400'),
    };
    // v3 (S8): door credentials live in the backend's secret store, which this remote check cannot see: the operator
    // names the connected doors (--doors / NEOS_VALIDATE_DOORS). The deprecated vault listing still counts.
    const vault = await this.api('GET', '/api/vault');
    this.s.vaultDoors = new Set([...(vault.body?.doors ?? []).map((x: any) => x.door), ...(this.o.doors ?? [])]);
    const mem = this.o.memberToken ? await this.api('GET', '/api/me', undefined, this.o.memberToken) : null;
    this.s.memberOk = mem?.status === 200 && mem.body.role === 'member';
    if (this.o.memberToken && !this.s.memberOk) this.notes.push(`The member token did not sign in as a member (${mem?.status} ${mem?.body?.role ?? ''}); member checks are skipped.`);
  }

  private ability(key: string): Ability | undefined {
    return this.abilities.find((a) => a.key === key);
  }
  private read(key: string, args: unknown, token?: string) {
    return this.api('POST', `/api/apps/${this.o.app}/read/${key}`, args, token);
  }
  private async result(key: string, args: unknown): Promise<any> {
    const r = await this.read(key, args);
    if (r.status !== 200) throw new Error(`${key} ${JSON.stringify(args)} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body.result;
  }

  /** One read, checked: 200, input and output schema, honesty. Returns a problem or null, and evidence. */
  private async checkRead(key: string, args: unknown): Promise<{ problem: string | null; evidence: string; result?: any }> {
    const inv = this.v.input(key)?.(args);
    if (inv) return { problem: `the check's own args are not valid for ${key}: ${inv}`, evidence: '' };
    const r = await this.read(key, args);
    if (r.status !== 200) return { problem: `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`, evidence: '' };
    const res = r.body?.result;
    const out = this.v.output(key);
    if (!out) return { problem: 'no output schema to check against', evidence: '200', result: res };
    const bad = out(res);
    if (bad) return { problem: `result fails its output schema: ${bad}`, evidence: '200', result: res };
    const h = honestyProblem(res, this.now());
    if (h) return { problem: h, evidence: '200, schema ok', result: res };
    const n = res?.sources?.entries;
    return { problem: null, evidence: `200 · schema ok · generatedAt ok · sources${typeof n === 'number' ? `.entries=${n}` : ' present'} · empty=${String(res?.empty)}`, result: res };
  }

  // ── 1. reads ───────────────────────────────────────────────────────────────
  async reads(): Promise<void> {
    const cases = readCases(this.d, this.chart, { documentSha: this.s.keptSha });
    for (const a of this.abilities.filter((x) => x.kind === 'read')) {
      if (a.setting === 'off') {
        this.add('reads', a.key, 'SKIPPED', 'switched off for this company (setting off)');
        continue;
      }
      const cs = cases[a.key];
      if (!cs?.length) {
        this.add('reads', a.key, 'FAIL', 'not exercised: no args in the validator’s read table');
        continue;
      }
      for (const args of cs) {
        const c = await this.checkRead(a.key, args);
        this.add('reads', `${a.key} ${JSON.stringify(args).slice(0, 120)}`, c.problem ? 'FAIL' : 'PASS', c.problem ? `${c.evidence ? `${c.evidence} · ` : ''}${c.problem}` : c.evidence);
      }
    }
    // Arguments outside the schema are refused before anything runs.
    const bad = await this.read('ledger.report.pnl', { from: 'last month' });
    this.add('reads', 'bad args refused (ledger.report.pnl {from:"last month"})', bad.status === 400 ? 'PASS' : 'FAIL', `HTTP ${bad.status}`);
  }

  // ── jobs ───────────────────────────────────────────────────────────────────
  private async answerCard(a: any, decision: 'yes' | 'no', fingerprint = a.fingerprint): Promise<{ status: number; body: any; by: string }> {
    let r = await this.api('POST', `/api/desk/${a.id}/answer`, { decision, fingerprint_seen: fingerprint });
    if (r.status === 403 && r.body?.error?.code === 'four_eyes' && this.s.memberOk) {
      r = await this.api('POST', `/api/desk/${a.id}/answer`, { decision, fingerprint_seen: fingerprint }, this.o.memberToken);
      return { ...r, by: 'member (four-eyes)' };
    }
    return { ...r, by: 'admin' };
  }

  /**
   * Ask, then follow the task until it settles, answering cards with onCard (default: decline).
   * Bounded by the job timeout and the budget; a job that overruns is cancelled.
   */
  private async runJob(
    text: string,
    opts: { attachments?: unknown[]; conversation_id?: string; onCard?: (a: any, d: any) => Promise<void>; onQuestion?: (q: any, d: any) => Promise<void>; timeoutMs?: number } = {},
  ): Promise<JobRun> {
    const r = await this.api('POST', '/api/ask', { text, app: this.o.app, ...(opts.attachments ? { attachments: opts.attachments } : {}), ...(opts.conversation_id ? { conversation_id: opts.conversation_id } : {}) });
    const run: JobRun = { task_id: r.body?.task_id ?? '', job_id: r.body?.job_id ?? '', conversation_id: r.body?.conversation_id ?? null, detail: null, status: 'NOT_STARTED', cost: 0, timedOut: false, budgetStop: false, error: null, cardsSeen: [] };
    if (r.status !== 200 || !r.body?.task_id) {
      run.error = `ask refused: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
      return run;
    }
    const until = Date.now() + (opts.timeoutMs ?? this.o.jobTimeoutMs);
    const handled = new Set<string>();
    const asked = new Set<string>();
    let polls = 0;
    while (true) {
      const t = await this.api('GET', `/api/tasks/${run.task_id}`);
      if (t.status === 200) {
        run.detail = t.body;
        run.status = t.body.task.status;
        run.job_id = t.body.task.job_id ?? run.job_id;
        run.cost = Number(t.body.cost?.usd ?? 0);
        this.taskCost.set(run.task_id, run.cost);
        for (const a of t.body.approvals ?? []) {
          if (a.status !== 'PENDING' || handled.has(a.id)) continue;
          handled.add(a.id);
          run.cardsSeen.push(a);
          if (opts.onCard) await opts.onCard(a, t.body);
          else await this.answerCard(a, 'no');
        }
        for (const q of t.body.questions ?? []) {
          if (q.status !== 'OPEN' || asked.has(q.id)) continue;
          asked.add(q.id);
          if (opts.onQuestion) await opts.onQuestion(q, t.body);
        }
        const pending = (t.body.approvals ?? []).some((a: any) => a.status === 'PENDING' || a.status === 'RECORDED' || a.status === 'RESOLVED' || a.status === 'APPROVED' || a.status === 'EXECUTING');
        if (TERMINAL.has(run.status) && !pending) break;
      }
      if (++polls % 5 === 0) await this.refreshUsage();
      if (this.overBudget()) {
        run.budgetStop = true;
        await this.api('POST', `/api/tasks/${run.task_id}/cancel`, { reason: 'live validation budget reached' });
        break;
      }
      if (Date.now() > until) {
        run.timedOut = true;
        await this.api('POST', `/api/tasks/${run.task_id}/cancel`, { reason: 'live validation job timeout' });
        break;
      }
      await sleep(this.o.pollMs);
    }
    await this.refreshUsage();
    return run;
  }

  private jobEvidence(run: JobRun): string {
    const res = run.detail?.task?.result;
    const refused = (run.detail?.activity ?? []).filter((x: any) => x.kind === 'refused').map((x: any) => x.summary);
    return `task ${short(run.task_id)} ${run.status}${run.timedOut ? ' (timed out, cancelled)' : ''}${run.budgetStop ? ' (budget reached, cancelled)' : ''}${res?.summary ? ` · "${String(res.summary).slice(0, 160)}"` : ''}${refused.length ? ` · refused: ${refused.join('; ').slice(0, 300)}` : ''}${run.error ? ` · ${run.error}` : ''}`;
  }

  private async operations(key: string, jobId: string): Promise<any[]> {
    const a = await this.api('GET', `/api/audit?action=app.operation&app=${this.o.app}&limit=500`);
    return (a.body?.rows ?? []).filter((x: any) => x.ability_key === key && x.detail?.job_id === jobId);
  }

  /**
   * One write, end to end: ask → card (fields, fingerprint, args) → yes → EXECUTED/DONE → exactly one
   * operation → the effect, read back. Returns the approval (with its proof) or null.
   */
  private async write(
    section: Section,
    id: string,
    key: string,
    args: Record<string, unknown>,
    what: string,
    verify: (approval: any | null, run: JobRun) => Promise<string>,
    opts: { wrongFingerprint?: boolean; external?: string; extra?: string } = {},
  ): Promise<{ ok: boolean; approval: any | null; run: JobRun | null }> {
    const label = `${key}${id !== key ? ` (${id})` : ''}`;
    const a = this.ability(key);
    if (!a) {
      this.add(section, label, 'SKIPPED', `${key} is not offered by ${this.o.app} here`);
      return { ok: false, approval: null, run: null };
    }
    if (a.setting === 'off') {
      this.add(section, label, 'SKIPPED', 'switched off for this company');
      return { ok: false, approval: null, run: null };
    }
    if (opts.external) {
      const door = opts.external;
      if (!this.doors.has(door) || !this.s.vaultDoors.has(door)) {
        this.add(section, label, 'SKIPPED', `the ${door} door is not connected (not named in --doors / NEOS_VALIDATE_DOORS)`);
        return { ok: false, approval: null, run: null };
      }
      if (door === 'email' && !this.o.emailTo) {
        this.add(section, label, 'SKIPPED', 'no --email-to given: external mail is only ever sent to a recipient you name');
        return { ok: false, approval: null, run: null };
      }
    }
    if (this.overBudget()) {
      this.add(section, label, 'SKIPPED', `budget of $${this.o.budgetUsd} reached ($${this.spent().toFixed(4)} spent)`);
      return { ok: false, approval: null, run: null };
    }
    const inv = this.v.input(key)?.(args);
    if (inv) {
      this.add(section, label, 'FAIL', `the check's own args are not valid: ${inv}`);
      return { ok: false, approval: null, run: null };
    }
    const needsCard = a.setting === 'ask_first';
    const problems: string[] = [];
    const ev: string[] = [];
    let yes: any = null;
    const run = await this.runJob(writeInstruction(this.tag, id, key, args, needsCard, what, opts.extra), {
      onCard: async (card, detail) => {
        if (card.ability_key !== key || yes) {
          problems.push(`unexpected card for ${card.ability_key}; declined`);
          await this.answerCard(card, 'no');
          return;
        }
        const cp = cardProblem(card) ?? subsetMismatch(args, card.args);
        if (cp) {
          problems.push(`card: ${cp}`);
          await this.answerCard(card, 'no');
          return;
        }
        ev.push(`card "${String(card.card.what).slice(0, 80)}" ${card.fingerprint.slice(0, 15)}…`);
        if (opts.wrongFingerprint) {
          const wrong = `sha256:${'0'.repeat(64)}`;
          const w = await this.answerCard(card, 'yes', wrong);
          const after = (await this.api('GET', `/api/tasks/${detail.task.id}`)).body;
          const still = (after?.approvals ?? []).find((x: any) => x.id === card.id)?.status;
          if (w.status === 409 && w.body?.error?.code === 'stale_fingerprint' && still === 'PENDING') ev.push('wrong fingerprint refused (409 stale_fingerprint, card still PENDING)');
          else problems.push(`a yes with a wrong fingerprint was not refused: HTTP ${w.status} ${JSON.stringify(w.body)} (card ${still})`);
        }
        const r = await this.answerCard(card, 'yes');
        if (r.status !== 200) problems.push(`yes refused: HTTP ${r.status} ${JSON.stringify(r.body)}`);
        else yes = card;
      },
    });
    if (run.error || run.timedOut || run.budgetStop) {
      this.add(section, label, run.budgetStop ? 'SKIPPED' : 'FAIL', this.jobEvidence(run), run.cost);
      return { ok: false, approval: null, run };
    }
    let approval: any = null;
    if (needsCard) {
      approval = yes ? (run.detail?.approvals ?? []).find((x: any) => x.id === yes.id) : null;
      if (!approval) problems.push(run.cardsSeen.length ? 'no card was approved' : 'no card was raised');
      else if (approval.status !== 'EXECUTED' || approval.proof?.outcome !== 'DONE') problems.push(`approval ${approval.status}, proof ${JSON.stringify(approval.proof ?? null).slice(0, 200)}`);
      else ev.push(`EXECUTED, proof DONE${approval.proof?.external_ref ? ` (${String(approval.proof.external_ref).slice(0, 40)})` : ''}`);
    } else if (run.cardsSeen.length) problems.push('a card was raised for a write that is on');
    if (run.status !== 'COMPLETED') problems.push(`task ${run.status}`);
    const ops = run.job_id ? await this.operations(key, run.job_id) : [];
    if (ops.length !== 1) problems.push(`${ops.length} recorded operations for ${key} in this job (want exactly 1)`);
    else ev.push(`1 operation (${ops[0].outcome})`);
    if (!problems.length) {
      try {
        ev.push(await verify(approval, run));
      } catch (e) {
        problems.push(`effect not found: ${(e as Error).message}`);
      }
    }
    const ok = !problems.length;
    this.add(section, label, ok ? 'PASS' : 'FAIL', ok ? `${ev.join(' · ')} · task ${short(run.task_id)}` : `${problems.join('; ')} · ${this.jobEvidence(run)}`, run.cost);
    return { ok, approval, run };
  }

  private skipDep(section: Section, label: string, dep: string) {
    this.add(section, label, 'SKIPPED', `needs ${dep}, which did not pass in this run`);
  }

  // ── 2. writes ──────────────────────────────────────────────────────────────
  async writes(): Promise<void> {
    const T = this.tag;
    const d = this.d;
    const c = this.chart;
    const S = this.s;
    const planned = new Set<string>();
    const W = async (id: string, key: string, args: Record<string, unknown>, what: string, verify: (ap: any, run: JobRun) => Promise<string>, opts: { wrongFingerprint?: boolean; external?: string } = {}) => {
      planned.add(key);
      return this.write('writes', id, key, args, what, verify, opts);
    };
    const need = (cond: unknown, id: string, key: string, dep: string) => {
      planned.add(key);
      if (!cond) this.skipDep('writes', `${key}${id !== key ? ` (${id})` : ''}`, dep);
      return !!cond;
    };

    // 1. A customer to invoice.
    S.customer = `LV Test Customer ${T}`;
    const party = await W('ledger.party.create', 'ledger.party.create', { kind: 'customer', name: S.customer, email: `lv-${T.toLowerCase()}@example.com` }, `Add customer ${S.customer}`, async () => {
      const ps = (await this.result('ledger.parties.list', { kind: 'customer' })).parties.filter((p: any) => p.name === S.customer);
      if (ps.length !== 1) throw new Error(`${ps.length} customers named ${S.customer}`);
      return `parties.list has ${S.customer} once`;
    });

    // 2. A chart account (kept: accounts are never deleted).
    const code = `LV${T.slice(2)}`.slice(0, 20);
    await W('ledger.account.create', 'ledger.account.create', { code, name: `Live validation ${T}`, type: 'expense', subtype: 'opex' }, `Add expense account ${code}`, async () => {
      const a = (await this.result('ledger.accounts.list', { include_inactive: true })).accounts.find((x: any) => x.code === code);
      if (!a) throw new Error(`account ${code} not listed`);
      return `accounts.list has ${code} "${a.name}"`;
    });

    // 3. A coding rule (suggestions only).
    const pattern = `LVTEST-${T}`;
    await W('ledger.coding_rule.add', 'ledger.coding_rule.add', { pattern, account_code: c.expense, direction: 'out' }, `Add coding rule ${pattern}`, async () => {
      const r = (await this.result('ledger.coding_rules.list', {})).rules.filter((x: any) => x.pattern === pattern);
      if (r.length !== 1) throw new Error(`${r.length} rules with pattern ${pattern}`);
      return `coding_rules.list has ${pattern} → ${r[0].account_code}`;
    });

    // 4. A journal entry (and a wrong fingerprint refused), 5. then its reversal.
    const memo = `Live validation entry ${T}`;
    const jp = await W(
      'ledger.journal.post',
      'ledger.journal.post',
      { date: d.today, memo, currency: 'INR', lines: [{ account_code: c.expense, debit_minor: 100, credit_minor: 0 }, { account_code: c.bank, debit_minor: 0, credit_minor: 100 }] },
      `Post ₹1.00 test entry ${T}`,
      async (ap) => {
        const es = (await this.result('ledger.journal.list', { from: d.today, to: d.today, search: memo })).entries;
        if (es.length !== 1) throw new Error(`${es.length} entries with memo ${memo}`);
        S.entryId = es[0].id;
        if (ap?.proof?.external_ref && ap.proof.external_ref !== S.entryId) throw new Error(`proof names ${ap.proof.external_ref}, journal has ${S.entryId}`);
        return `journal.list has entry ${short(S.entryId)}`;
      },
      { wrongFingerprint: true },
    );
    if (need(jp.ok && S.entryId, 'ledger.entry.reverse', 'ledger.entry.reverse', 'ledger.journal.post')) {
      await W('ledger.entry.reverse', 'ledger.entry.reverse', { entry: S.entryId, date: d.today, memo: `Reversal of live validation entry ${T}` }, `Reverse test entry ${T}`, async () => {
        const es = (await this.result('ledger.journal.list', { from: d.today, to: d.today, search: T })).entries;
        const rev = es.find((e: any) => e.reverses === S.entryId);
        if (!rev) throw new Error('no entry reverses the test entry');
        return `journal.list has reversal ${short(rev.id)} of ${short(S.entryId)}`;
      });
    }

    // 6. An invoice to the new customer (₹1.00 + 18% GST), 7. paid in full.
    if (need(party.ok, 'ledger.invoice.create', 'ledger.invoice.create', 'ledger.party.create')) {
      const inv = await W(
        'ledger.invoice.create',
        'ledger.invoice.create',
        { customer: S.customer, issue_date: d.today, due_date: d.todayPlus30, currency: 'INR', gst_rate_bps: 1800, lines: [{ description: `Live validation service ${T}`, amount_minor: 100, account_code: c.income }] },
        `Invoice ${S.customer} ₹1.18`,
        async () => {
          const ds = (await this.result('ledger.documents.list', { kind: 'invoice', status: 'all' })).documents.filter((x: any) => x.party === S.customer);
          if (ds.length !== 1) throw new Error(`${ds.length} invoices for ${S.customer}`);
          S.invoice = ds[0];
          if (ds[0].total_minor !== 118) throw new Error(`total ${ds[0].total_minor}, want 118`);
          return `documents.list has ${ds[0].number} for ₹1.18`;
        },
      );
      if (need(inv.ok, 'ledger.payment.record', 'ledger.payment.record', 'ledger.invoice.create')) {
        const pay = await W(
          'ledger.payment.record',
          'ledger.payment.record',
          { kind: 'invoice', document_number: S.invoice.number, date: d.today, amount_minor: 118, bank_account_code: c.bank },
          `Record ₹1.18 received on ${S.invoice.number}`,
          async (ap) => {
            const x = (await this.result('ledger.documents.list', { kind: 'invoice', status: 'all' })).documents.find((y: any) => y.number === S.invoice.number);
            if (x?.status !== 'paid') throw new Error(`${S.invoice.number} is ${x?.status}`);
            S.paymentEntry = ap?.proof?.read_back?.entry_id ?? null;
            return `${S.invoice.number} is paid`;
          },
        );
        S.paid = pay.ok;
      }
    } else need(false, 'ledger.payment.record', 'ledger.payment.record', 'ledger.invoice.create');

    // 8. Four statement lines, then 9–12: match, categorise, set aside, and expense them.
    const lines = [
      { external_id: `${T}-RCPT`, date: d.today, description: `${pattern} NEFT CR`, amount_minor: 118 },
      { external_id: `${T}-CHG`, date: d.today, description: `${pattern} CHARGES`, amount_minor: -100 },
      { external_id: `${T}-DUP`, date: d.today, description: `${pattern} DUPLICATE`, amount_minor: -50 },
      { external_id: `${T}-EXP`, date: d.today, description: `${pattern} STATIONERY`, amount_minor: -118 },
    ];
    const imp = await W('ledger.bank.import', 'ledger.bank.import', { bank_account_code: c.bank, currency: 'INR', lines }, `Import 4 test bank lines ${T}`, async () => {
      const tx = (await this.result('ledger.bank.unreconciled', { bank_account_code: c.bank })).transactions.filter((x: any) => String(x.description).startsWith(pattern));
      if (tx.length !== 4) throw new Error(`${tx.length} of 4 lines unreconciled`);
      S.lines = Object.fromEntries(tx.map((x: any) => [String(x.description).split(' ').pop(), x.id]));
      return `bank.unreconciled has the 4 lines`;
    });
    const unrec = async () => (await this.result('ledger.bank.unreconciled', { bank_account_code: c.bank })).transactions.map((x: any) => x.id);
    if (need(imp.ok && S.paid && S.paymentEntry, 'ledger.bank.match', 'ledger.bank.match', 'ledger.bank.import and ledger.payment.record')) {
      await W('ledger.bank.match', 'ledger.bank.match', { bank_transaction_id: S.lines.CR, entry: S.paymentEntry }, `Match the ₹1.18 receipt line`, async () => {
        if ((await unrec()).includes(S.lines.CR)) throw new Error('the receipt line is still unreconciled');
        return 'receipt line reconciled';
      });
    }
    if (need(imp.ok, 'ledger.bank.categorize', 'ledger.bank.categorize', 'ledger.bank.import')) {
      await W('ledger.bank.categorize', 'ledger.bank.categorize', { bank_transaction_id: S.lines.CHARGES, account_code: c.expense, memo: `Live validation charges ${T}` }, 'Categorise the ₹1.00 charges line', async () => {
        if ((await unrec()).includes(S.lines.CHARGES)) throw new Error('the charges line is still unreconciled');
        return 'charges line reconciled';
      });
    }
    if (need(imp.ok, 'ledger.bank.ignore', 'ledger.bank.ignore', 'ledger.bank.import')) {
      await W('ledger.bank.ignore', 'ledger.bank.ignore', { bank_transaction_id: S.lines.DUPLICATE, reason: 'duplicate', note: `live validation ${T}` }, 'Set aside the ₹0.50 duplicate line', async () => {
        if ((await unrec()).includes(S.lines.DUPLICATE)) throw new Error('the duplicate line is still unreconciled');
        return 'duplicate line set aside';
      });
    }
    if (need(imp.ok, 'ledger.expense.record', 'ledger.expense.record', 'ledger.bank.import')) {
      await W(
        'ledger.expense.record',
        'ledger.expense.record',
        { date: d.today, currency: 'INR', description: `Live validation stationery ${T}`, amount_minor: 100, gst_rate_bps: 1800, account_code: c.expense, bank_account_code: c.bank, bank_transaction_id: S.lines.STATIONERY },
        'Record the ₹1.18 stationery expense',
        async () => {
          if ((await unrec()).includes(S.lines.STATIONERY)) throw new Error('the expense line is still unreconciled');
          const es = (await this.result('ledger.journal.list', { from: d.today, to: d.today, search: `stationery ${T}` })).entries;
          if (es.length !== 1) throw new Error(`${es.length} expense entries`);
          return `entry ${short(es[0].id)}, bank line matched`;
        },
      );
    }

    // 13. A supplier bill from an existing vendor.
    const vendors = (await this.result('ledger.parties.list', { kind: 'vendor' })).parties;
    const vendor = vendors[0]?.name;
    const billNo = `LV-${T}`;
    if (need(vendor, 'ledger.bill.record', 'ledger.bill.record', 'a vendor in the books')) {
      await W(
        'ledger.bill.record',
        'ledger.bill.record',
        { vendor, number: billNo, issue_date: d.today, due_date: d.todayPlus30, currency: 'INR', gst_rate_bps: 1800, lines: [{ description: `Live validation supplies ${T}`, amount_minor: 100, account_code: c.expense }] },
        `Record bill ${billNo} from ${vendor}`,
        async () => {
          const b = (await this.result('ledger.documents.list', { kind: 'bill', status: 'all' })).documents.filter((x: any) => x.number === billNo);
          if (b.length !== 1) throw new Error(`${b.length} bills numbered ${billNo}`);
          return `documents.list has bill ${billNo} (₹${b[0].total_minor / 100})`;
        },
      );
    }

    // 14. A setting, changed and put back.
    const before = (await this.result('ledger.settings.get', {})).settings;
    const weeks = before.forecast_weeks === 13 ? 12 : 13;
    const set = await W('ledger.settings.update', 'ledger.settings.update', { forecast_weeks: weeks }, `Set cash forecast to ${weeks} weeks`, async () => {
      const now = (await this.result('ledger.settings.get', {})).settings;
      if (now.forecast_weeks !== weeks) throw new Error(`forecast_weeks is ${now.forecast_weeks}`);
      return `settings.get forecast_weeks=${weeks}`;
    });
    if (set.ok) {
      await W('restore settings', 'ledger.settings.update', { forecast_weeks: before.forecast_weeks }, `Put cash forecast back to ${before.forecast_weeks} weeks`, async () => {
        const now = (await this.result('ledger.settings.get', {})).settings;
        if (now.forecast_weeks !== before.forecast_weeks) throw new Error(`forecast_weeks is ${now.forecast_weeks}`);
        return `forecast_weeks back to ${before.forecast_weeks}`;
      });
    }

    // 15. Opening balances: a one-time write. Set a ₹1.00 balance and reverse it, or skip if already set.
    planned.add('ledger.opening_balances.set');
    const opening = (await this.result('ledger.journal.list', { from: '1900-01-01', to: d.today, search: 'Opening balances', limit: 5 })).entries.find((e: any) => e.reference === 'opening-balances');
    const first = (await this.result('ledger.journal.list', { from: '1900-01-01', to: d.today, limit: 1 })).entries[0];
    const obAcct = c.cash ?? c.bank;
    if (opening) this.add('writes', 'ledger.opening_balances.set', 'SKIPPED', `opening balances are already set (entry ${short(opening.id)} on ${opening.date}); it is a one-time write the app refuses a second time`);
    else {
      const date = first?.date ?? d.today;
      const ob = await W('ledger.opening_balances.set', 'ledger.opening_balances.set', { date, currency: 'INR', balances: [{ account_code: obAcct, amount_minor: 100 }] }, `Set a ₹1.00 opening balance on ${obAcct}`, async () => {
        const e = (await this.result('ledger.journal.list', { from: date, to: date, search: 'Opening balances' })).entries.find((x: any) => x.reference === 'opening-balances');
        if (!e) throw new Error('no opening-balances entry');
        S.openingId = e.id;
        return `opening entry ${short(e.id)} on ${date}`;
      });
      if (ob.ok && S.openingId) {
        await W('reverse opening balances', 'ledger.entry.reverse', { entry: S.openingId, date: d.today, memo: `Reversal of live validation opening balance ${T}` }, 'Reverse the ₹1.00 opening balance', async () => {
          const es = (await this.result('ledger.journal.list', { from: d.today, to: d.today, search: T })).entries;
          if (!es.some((e: any) => e.reverses === S.openingId)) throw new Error('no reversal of the opening entry');
          return 'opening balance reversed';
        });
      }
    }

    // 16–17. Close a past month with nothing to reconcile, then reopen it.
    const ps = await this.result('ledger.periods.status', {});
    const closed = new Set((ps.closed ?? []).map((x: any) => String(x.month ?? x).slice(0, 7)));
    const busy = new Set((ps.unreconciled_by_month ?? []).filter((x: any) => x.n > 0).map((x: any) => String(x.month).slice(0, 7)));
    let month: string | null = null;
    for (let i = 1; i <= 12 && !month; i++) {
      const m = shiftMonth(d.month, -i);
      if (!closed.has(m) && !busy.has(m)) month = m;
    }
    if (need(month, 'ledger.period.close', 'ledger.period.close', 'an open past month with nothing to reconcile')) {
      const pc = await W('ledger.period.close', 'ledger.period.close', { month: month!, reason: `live validation ${T}` }, `Close ${month}`, async () => {
        const st = await this.result('ledger.periods.status', {});
        if (!(st.closed ?? []).some((x: any) => String(x.month ?? x).startsWith(month!))) throw new Error(`${month} not listed as closed`);
        return `periods.status lists ${month} closed`;
      });
      if (need(pc.ok, 'ledger.period.reopen', 'ledger.period.reopen', 'ledger.period.close')) {
        await W('ledger.period.reopen', 'ledger.period.reopen', { month: month!, reason: `live validation ${T}: reopening what the check closed` }, `Reopen ${month}`, async () => {
          const st = await this.result('ledger.periods.status', {});
          if ((st.closed ?? []).some((x: any) => String(x.month ?? x).startsWith(month!))) throw new Error(`${month} still closed`);
          return `${month} open again`;
        });
      }
    } else need(false, 'ledger.period.reopen', 'ledger.period.reopen', 'ledger.period.close');

    // 18–20. External effects, only to the recipient named with --email-to.
    const to = this.o.emailTo ? [this.o.emailTo] : [];
    if (need(S.invoice, 'ledger.invoice.send', 'ledger.invoice.send', 'ledger.invoice.create')) {
      await W('ledger.invoice.send', 'ledger.invoice.send', { document_number: S.invoice.number, to, note: `Live validation ${T}` }, `Email ${S.invoice.number} to ${to.join(', ')}`, async () => {
        const x = (await this.result('ledger.documents.list', { kind: 'invoice', status: 'all' })).documents.find((y: any) => y.number === S.invoice.number);
        if (!x?.sent_at) throw new Error(`${S.invoice.number} has no sent_at`);
        return `${S.invoice.number} sent_at ${x.sent_at}`;
      }, { external: 'email' });
    }
    const overdue = (await this.result('ledger.documents.list', { kind: 'invoice', status: 'overdue' })).documents[0];
    if (need(overdue, 'ledger.reminder.send', 'ledger.reminder.send', 'an overdue invoice in the books')) {
      await W('ledger.reminder.send', 'ledger.reminder.send', { document_number: overdue.number, to, note: `Live validation ${T}: a test reminder, not a real chase` }, `Remind about ${overdue.number} (to ${to.join(', ')})`, async () => {
        const x = (await this.result('ledger.documents.list', { kind: 'invoice', status: 'all' })).documents.find((y: any) => y.number === overdue.number);
        if (!x?.reminded_at) throw new Error(`${overdue.number} has no reminded_at`);
        return `${overdue.number} reminded_at ${x.reminded_at}`;
      }, { external: 'email' });
    }
    await W('ledger.close_pack.email', 'ledger.close_pack.email', { period: { from: d.prevFrom, to: d.prevTo }, to, note: `Live validation ${T}` }, `Email the ${d.prevMonth} close pack to ${to.join(', ')}`, async (ap) => `proof ${JSON.stringify(ap?.proof?.read_back ?? {}).slice(0, 120)}`, { external: 'email' });

    // Package writes (e.g. nep-gst).
    for (const a of this.abilities.filter((x) => x.kind === 'write' && x.from !== 'own')) {
      planned.add(a.key);
      if (a.key === 'gst.gstr3b.prepare') {
        await W(a.key, a.key, { period: d.prevMonth }, `Prepare GSTR-3B for ${d.prevMonth}`, async () => {
          const r = (await this.result('gst.returns.list', { period: d.prevMonth })).returns;
          if (!r?.length) throw new Error(`no return for ${d.prevMonth}`);
          return `gst.returns.list has ${d.prevMonth} (${r[0].status ?? '?'})`;
        });
      } else if (a.effects?.external || (a.doors ?? []).length) {
        if (!this.o.gst) this.add('writes', a.key, 'SKIPPED', 'a GST portal effect (save / OTP / file) — run with --gst only against a sandbox portal');
        else this.add('writes', a.key, 'SKIPPED', 'needs a person to enter the portal OTP on the OTP door; not automatable through the API');
      } else this.add('writes', a.key, 'FAIL', 'not exercised: no plan in the validator for this package write');
    }
    for (const a of this.abilities.filter((x) => x.kind === 'write' && !planned.has(x.key))) this.add('writes', a.key, 'FAIL', 'not exercised: no plan in the validator for this write');
  }

  // ── 3. governance ──────────────────────────────────────────────────────────
  async governance(): Promise<void> {
    const app = this.o.app;
    const G: Section = 'governance';
    const sb0 = (await this.api('GET', `/api/switchboards/${app}`)).body;
    // (a) A read switched off leaves the registry and is refused; switched back it returns.
    const readKey = this.ability('ledger.budget.remaining') ? 'ledger.budget.remaining' : this.abilities.find((a) => a.kind === 'read' && a.setting === 'on')?.key;
    if (readKey) {
      const prev = sb0?.settings?.[readKey] ?? null;
      const args = readCases(this.d, this.chart)[readKey]?.[0] ?? {};
      const off = await this.api('PUT', `/api/switchboards/${app}`, { settings: { [readKey]: 'off' } });
      const reg = (await this.api('GET', '/api/registry')).body.apps?.find((x: any) => x.key === app);
      const listed = reg?.abilities?.some((x: any) => x.key === readKey);
      const direct = await this.read(readKey, args);
      const back = await this.api('PUT', `/api/switchboards/${app}`, { settings: { [readKey]: prev ?? 'on' } });
      const reg2 = (await this.api('GET', '/api/registry')).body.apps?.find((x: any) => x.key === app);
      const again = await this.read(readKey, args);
      const ok = off.status === 200 && !listed && direct.status >= 400 && direct.status < 500 && back.status === 200 && reg2?.abilities?.some((x: any) => x.key === readKey) && again.status === 200;
      this.add(G, `switch ${readKey} off and back`, ok ? 'PASS' : 'FAIL', `off: HTTP ${off.status} · in registry while off: ${listed} · direct read while off: HTTP ${direct.status} ${direct.body?.error?.code ?? ''} · back to ${prev ?? 'on'}: HTTP ${back.status} · read again: HTTP ${again.status}`);
    } else this.add(G, 'switch a read off', 'SKIPPED', 'no read is on');

    // (b) A company can only tighten.
    const askFirst = this.abilities.find((a) => a.kind === 'write' && a.floor === 'ask_first');
    if (askFirst) {
      const r = await this.api('PUT', `/api/switchboards/${app}`, { settings: { [askFirst.key]: 'on' } });
      this.add(G, `loosen ${askFirst.key} to on`, r.status === 422 ? 'PASS' : 'FAIL', `HTTP ${r.status} ${r.body?.error?.code ?? ''}`);
    }
    if (readKey) {
      const r = await this.api('PUT', `/api/switchboards/${app}`, { settings: { [readKey]: 'ask_first' } });
      this.add(G, `a read set to ask_first`, r.status === 422 ? 'PASS' : 'FAIL', `HTTP ${r.status} ${r.body?.error?.code ?? ''}`);
    }

    // (c) A standing yes: within its cap a small write runs without a card; beyond it, it asks.
    const post = this.ability('ledger.journal.post');
    const netZero = (minor: number, memo: string) => ({ date: this.d.today, memo, currency: 'INR', lines: [{ account_code: this.chart.expense, debit_minor: minor, credit_minor: 0 }, { account_code: this.chart.expense, debit_minor: 0, credit_minor: minor }] });
    const zeroNote = 'Both lines are on the same account on purpose: the entry has no effect on any balance.';
    if (post && post.setting === 'ask_first') {
      const g = await this.api('POST', '/api/grants', { app_key: app, ability_key: post.key, limits: { per_call_minor: 1000, currency: 'INR' }, expires_at: new Date(Date.now() + 864e5).toISOString() });
      if (g.status !== 200) this.add(G, 'standing yes', 'FAIL', `create: HTTP ${g.status} ${JSON.stringify(g.body)}`);
      else {
        try {
          if (this.overBudget()) this.add(G, 'standing yes within its cap', 'SKIPPED', 'budget reached');
          else {
            const memo = `Live validation grant test ${this.tag}`;
            const args = netZero(100, memo);
            const run = await this.runJob(writeInstruction(this.tag, 'grant-in', post.key, args, true, 'Post a net-zero ₹1.00 test entry', zeroNote));
            const uses = run.detail?.grant_uses ?? [];
            const es = (await this.result('ledger.journal.list', { from: this.d.today, to: this.d.today, search: memo })).entries;
            const ok = run.status === 'COMPLETED' && run.cardsSeen.length === 0 && uses.length === 1 && es.length === 1;
            this.add(G, 'standing yes within its cap (₹1.00 ≤ ₹10.00)', ok ? 'PASS' : 'FAIL', `cards ${run.cardsSeen.length} · grant uses ${uses.length} · entries ${es.length} · ${this.jobEvidence(run)}`, run.cost);
          }
          if (this.overBudget()) this.add(G, 'standing yes beyond its cap', 'SKIPPED', 'budget reached');
          else {
            const memo = `Live validation grant cap test ${this.tag}`;
            const run = await this.runJob(writeInstruction(this.tag, 'grant-over', post.key, netZero(2000, memo), true, 'Post a net-zero ₹20.00 test entry', zeroNote));
            const declined = run.cardsSeen.filter((a) => a.ability_key === post.key);
            const es = (await this.result('ledger.journal.list', { from: this.d.today, to: this.d.today, search: memo })).entries;
            const ok = declined.length === 1 && es.length === 0 && (run.detail?.grant_uses ?? []).length === 0;
            this.add(G, 'standing yes beyond its cap (₹20.00 > ₹10.00) asks', ok ? 'PASS' : 'FAIL', `cards ${declined.length} (declined) · entries ${es.length} · ${this.jobEvidence(run)}`, run.cost);
          }
        } finally {
          const del = await this.api('DELETE', `/api/grants/${g.body.id}`);
          this.add(G, 'standing yes withdrawn', del.status === 200 ? 'PASS' : 'FAIL', `DELETE /api/grants/${short(g.body.id)}: HTTP ${del.status}`);
        }
      }
    } else this.add(G, 'standing yes', 'SKIPPED', 'ledger.journal.post is not ask-first here');

    // (d) A company rule refuses with its id.
    if (post && post.setting !== 'off') {
      const ruleId = `lv-cap-${this.tag.toLowerCase()}`;
      const prevRules = sb0?.rules ?? [];
      const put = await this.api('PUT', `/api/switchboards/${app}`, { rules: [...prevRules, { id: ruleId, type: 'amount_cap', currency: 'INR', per_call_minor: 500, applies_to: [post.key] }] });
      if (put.status !== 200) this.add(G, 'amount_cap rule', 'FAIL', `set: HTTP ${put.status} ${JSON.stringify(put.body)}`);
      else {
        try {
          if (this.overBudget()) this.add(G, 'amount_cap rule refuses', 'SKIPPED', 'budget reached');
          else {
            const memo = `Live validation rule test ${this.tag}`;
            const run = await this.runJob(writeInstruction(this.tag, 'rule', post.key, netZero(1000, memo), post.setting === 'ask_first', 'Post a net-zero ₹10.00 test entry', zeroNote));
            const refused = (run.detail?.activity ?? []).filter((x: any) => x.kind === 'refused').map((x: any) => x.summary).join(' ');
            const tr = await this.api('GET', `/api/tasks/${run.task_id}/transcript`);
            const cites = JSON.stringify(tr.body ?? '').includes(`rule:${ruleId}`);
            const es = (await this.result('ledger.journal.list', { from: this.d.today, to: this.d.today, search: memo })).entries;
            const ok = run.cardsSeen.length === 0 && /cap/.test(refused) && cites && es.length === 0;
            this.add(G, `amount_cap rule ${ruleId} refuses ₹10.00 (cap ₹5.00)`, ok ? 'PASS' : 'FAIL', `refused step: "${refused.slice(0, 160)}" · transcript cites rule:${ruleId}: ${cites} · cards ${run.cardsSeen.length} · entries ${es.length} · task ${short(run.task_id)}`, run.cost);
          }
        } finally {
          const back = await this.api('PUT', `/api/switchboards/${app}`, { rules: prevRules });
          this.add(G, 'company rules restored', back.status === 200 ? 'PASS' : 'FAIL', `HTTP ${back.status} (${prevRules.length} rules as before)`);
        }
      }
    }

    // (e) Member vs admin.
    if (!this.s.memberOk) this.add(G, 'member permissions', 'SKIPPED', 'no member token (NEOS_MEMBER_TOKEN_FILE)');
    else {
      const m = this.o.memberToken;
      const checks: [string, Promise<{ status: number; body: any }>, number][] = [
        ['member changes the switchboard', this.api('PUT', `/api/switchboards/${app}`, { settings: {} }, m), 403],
        ['member creates a standing yes', this.api('POST', '/api/grants', { app_key: app, ability_key: 'ledger.journal.post', limits: { per_call_minor: 100, currency: 'INR' }, expires_at: new Date(Date.now() + 864e5).toISOString() }, m), 403],
        ['member reads the audit trail', this.api('GET', '/api/audit?limit=1', undefined, m), 403],
        ['member sets a schedule', this.api('PUT', `/api/apps/${app}/schedules`, { ask: 'x', rule: { every: 'day', at: '08:00' } }, m), 403],
        ['member reads the switchboard', this.api('GET', `/api/switchboards/${app}`, undefined, m), 200],
        ['member runs a read', this.read('ledger.periods.status', {}, m), 200],
      ];
      for (const [label, p, want] of checks) {
        const r = await p;
        this.add(G, label, r.status === want ? 'PASS' : 'FAIL', `HTTP ${r.status} (want ${want})`);
      }
    }
  }

  // ── 4. questions ───────────────────────────────────────────────────────────
  private questionAsk(id: string): string {
    const q = { text: 'How much was the expense, in rupees?', why: 'The request does not say the amount.', fields: [{ key: 'amount_rupees', label: 'Amount in rupees', type: 'number' }] };
    return [
      `[live-validate ${this.tag}/${id}] This is an automated acceptance check. I want to note a small expense, but I have not told you the amount.`,
      'Before anything else, ask me for it with job_ask: exactly one field, key "amount_rupees", label "Amount in rupees", type number. Then wait for my answer.',
      `QUESTION: ${JSON.stringify(q)}`,
      'When my answer arrives, do NOT record anything and use no ability that changes anything. Finish the job with job_finish; the summary must contain "amount_rupees=<the number I gave>".',
    ].join('\n');
  }

  async questions(): Promise<void> {
    const Q: Section = 'questions';
    for (const [id, via, value] of [
      ['q-desk', 'desk', 37],
      ['q-follow-up', 'conversation', 41],
    ] as const) {
      if (this.overBudget()) {
        this.add(Q, `question answered via ${via}`, 'SKIPPED', 'budget reached');
        continue;
      }
      let answered = '';
      let questionSeen: any = null;
      const run = await this.runJob(this.questionAsk(id), {
        onQuestion: async (q, detail) => {
          questionSeen = q;
          if (via === 'desk') {
            const r = await this.api('POST', `/api/questions/${q.id}/answer`, { answers: { amount_rupees: value } });
            answered = `POST /api/questions/${short(q.id)}/answer → ${r.status}`;
          } else {
            const convo = detail.task.conversation_id;
            const r = await this.api('POST', '/api/ask', { text: String(value), conversation_id: convo });
            answered = `follow-up /api/ask in conversation ${short(convo)} → ${r.status}${r.body?.answered ? ` answered question ${short(r.body.question_id)}` : ` ${JSON.stringify(r.body).slice(0, 200)}`}`;
          }
        },
      });
      const summary = String(run.detail?.task?.result?.summary ?? '');
      const q = questionSeen ? (await this.api('GET', `/api/tasks/${run.task_id}`)).body?.questions?.find((x: any) => x.id === questionSeen.id) : null;
      const ok = !!questionSeen && run.status === 'COMPLETED' && q?.status === 'ANSWERED' && summary.includes(String(value)) && q?.answered_via === via;
      this.add(Q, `question answered via ${via}`, ok ? 'PASS' : 'FAIL', `${questionSeen ? `asked "${String(questionSeen.text).slice(0, 80)}" fields ${JSON.stringify((questionSeen.fields ?? []).map((f: any) => f.key))}` : 'no question was asked'} · ${answered} · question ${q?.status ?? '?'} via ${q?.answered_via ?? '?'} · ${this.jobEvidence(run)}`, run.cost);
    }
  }

  // ── 5. documents ───────────────────────────────────────────────────────────
  async documents(): Promise<void> {
    const D: Section = 'documents';
    const b = this.ability('ledger.bill.record');
    if (!b || b.setting !== 'ask_first') {
      this.add(D, 'bill from an attached file', 'SKIPPED', 'ledger.bill.record is not ask-first here');
      return;
    }
    if (this.overBudget()) {
      this.add(D, 'bill from an attached file', 'SKIPPED', 'budget reached');
      return;
    }
    const vendor = (await this.result('ledger.parties.list', { kind: 'vendor' })).parties[0]?.name;
    if (!vendor) {
      this.add(D, 'bill from an attached file', 'SKIPPED', 'no vendor in the books');
      return;
    }
    const number = `LVB-${this.tag}`;
    const csv = [
      'Supplier bill',
      `Vendor,${vendor}`,
      `Bill number,${number}`,
      `Bill date,${this.d.today}`,
      `Due date,${this.d.todayPlus30}`,
      'Description,Amount (INR, before GST),GST rate',
      'Packing material,250.00,18%',
      'Total with GST,295.00,',
    ].join('\n');
    const bytes = Buffer.from(csv + '\n');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const args = { vendor, number, issue_date: this.d.today, due_date: this.d.todayPlus30, currency: 'INR', gst_rate_bps: 1800, lines: [{ description: 'Packing material', amount_minor: 25000, account_code: this.chart.expense }], source_document: sha };
    const text = [
      `[live-validate ${this.tag}/doc] This is an automated acceptance check. The attached CSV is a supplier bill.`,
      `Read it and propose recording it with ledger.bill.record: the vendor, bill number, dates, line and GST rate come from the file; post the line to account ${this.chart.expense}; cite the file as source_document ${sha}.`,
      `TOOL: ledger.bill.record`,
      `ARGS: ${JSON.stringify(args)}`,
      'CARD: required',
      'A person will answer the card. Use no other ability that changes anything, ask no questions, and when the card is answered finish the job with job_finish.',
    ].join('\n');
    let card: any = null;
    let declined = '';
    const run = await this.runJob(text, {
      attachments: [{ filename: `live-validate-bill-${this.tag}.csv`, content_type: 'text/csv', content_base64: bytes.toString('base64') }],
      onCard: async (a) => {
        card = a;
        const r = await this.answerCard(a, 'no');
        declined = `declined: HTTP ${r.status}`;
      },
    });
    const cp = card ? (cardProblem(card) ?? subsetMismatch({ vendor, number, gst_rate_bps: 1800, source_document: sha }, card.args)) : 'no card was raised';
    const amt = card ? (card.args?.lines ?? []).reduce((s: number, l: any) => s + Number(l.amount_minor ?? 0), 0) : 0;
    const bills = (await this.result('ledger.documents.list', { kind: 'bill', status: 'all' })).documents.filter((x: any) => x.number === number);
    const ok1 = !cp && amt === 25000 && card?.ability_key === 'ledger.bill.record' && run.status === 'COMPLETED' && bills.length === 0;
    this.add(D, 'a bill proposal whose card matches the attached file, declined', ok1 ? 'PASS' : 'FAIL', `${cp ?? `card "${String(card.card.what).slice(0, 80)}" · ${number} · ₹${amt / 100} · source_document ${sha.slice(0, 12)}…`} · ${declined} · bills recorded: ${bills.length} · ${this.jobEvidence(run)}`, run.cost);

    // The file is kept, and downloads byte for byte; only to a signed-in person.
    const g = await this.checkRead('ledger.document.get', { sha256: sha });
    const doc = g.result?.document;
    if (g.problem || !doc) {
      this.add(D, 'the file is kept (ledger.document.get)', 'FAIL', g.problem ?? `not kept: ${JSON.stringify(g.result).slice(0, 300)}`);
      return;
    }
    this.s.keptSha = sha;
    const keptOk = doc.sha256 === sha && Number(doc.bytes) === bytes.length && g.result.download?.path;
    this.add(D, 'the file is kept (ledger.document.get)', keptOk ? 'PASS' : 'FAIL', `${doc.filename} · ${doc.bytes} bytes · ${doc.content_type} · store ${doc.store ?? '?'} · link ${g.result.download?.path ? 'issued' : 'missing'}`);
    if (!g.result.download?.path) return;
    const base = this.o.baseUrl.replace(/\/$/, '');
    const dl = await fetch(base + g.result.download.path, { headers: { authorization: `Bearer ${this.o.adminToken}` } }).catch((e) => ({ status: 0, arrayBuffer: async () => new ArrayBuffer(0), e }) as any);
    const got = Buffer.from(await dl.arrayBuffer());
    const same = dl.status === 200 && createHash('sha256').update(got).digest('hex') === sha;
    this.add(D, 'download is identical (sha256)', same ? 'PASS' : 'FAIL', `HTTP ${dl.status} · ${got.length} bytes · sha256 ${createHash('sha256').update(got).digest('hex').slice(0, 16)}… (want ${sha.slice(0, 16)}…)`);
    const anon = await fetch(base + g.result.download.path).catch(() => ({ status: 0 }) as Response);
    this.add(D, 'unauthenticated download refused', anon.status === 401 ? 'PASS' : 'FAIL', `HTTP ${anon.status} (want 401)`);
  }

  // ── 6. schedules ───────────────────────────────────────────────────────────
  async schedules(): Promise<void> {
    const C: Section = 'schedules';
    const app = this.o.app;
    const list0 = await this.api('GET', `/api/apps/${app}/schedules`);
    if (list0.status !== 200) {
      this.add(C, 'list schedules', 'FAIL', `HTTP ${list0.status} ${JSON.stringify(list0.body).slice(0, 200)}`);
      return;
    }
    if (this.overBudget()) {
      this.add(C, 'a timer job runs', 'SKIPPED', 'budget reached');
      return;
    }
    const now = this.now();
    const lead = Math.max(1, this.o.scheduleLeadMin);
    const at = hhmmIn(new Date(now.getTime() + lead * 60_000), this.tz);
    if (at < hhmmIn(now, this.tz)) {
      this.add(C, 'a timer job runs', 'SKIPPED', `too close to midnight in ${this.tz} to schedule ${lead} minute(s) ahead`);
      return;
    }
    const marker = `[live-validate ${this.tag}/timer]`;
    const ask = `${marker} Scheduled acceptance check: read ledger.home.summary once and finish the job with one line giving the cash figure. Change nothing.`;
    const put = await this.api('PUT', `/api/apps/${app}/schedules`, { ask, rule: { every: 'day', at } });
    const sched = put.body?.schedule;
    if (put.status !== 200 || !sched?.id) {
      this.add(C, 'create a schedule', 'FAIL', `HTTP ${put.status} ${JSON.stringify(put.body).slice(0, 300)}`);
      return;
    }
    this.add(C, `create a schedule (daily at ${at} ${this.tz})`, 'PASS', `schedule ${short(sched.id)} · next run ${sched.next_run_at ?? '?'}`);
    try {
      const until = Date.now() + (lead + 1) * 60_000 + this.o.jobTimeoutMs;
      let job: string | null = null;
      let done: any = null;
      while (Date.now() < until && !done) {
        const act = (await this.api('GET', `/api/activity?app=${app}&limit=200`)).body?.activity ?? [];
        job ??= act.find((x: any) => x.kind === 'received' && String(x.summary).includes(marker))?.job_id ?? null;
        if (job) done = act.find((x: any) => x.job_id === job && (x.kind === 'report' || x.kind === 'failed'));
        if (!done) await sleep(Math.max(this.o.pollMs, 1000));
      }
      await this.refreshUsage();
      const after = (await this.api('GET', `/api/apps/${app}/schedules`)).body?.schedules?.find((x: any) => x.id === sched.id);
      const ok = done?.kind === 'report' && !!after?.last_run_at;
      this.add(C, 'a timer job runs and completes', ok ? 'PASS' : 'FAIL', job ? `job ${short(job)} ${done ? `${done.kind}: "${String(done.summary).slice(0, 160)}"` : 'did not finish in time'} · last_run_at ${after?.last_run_at ?? 'none'} · timer job cost is not attributable per job (counted in the app's usage today)` : `no timer job started by ${at}`);
    } finally {
      const off = await this.api('PUT', `/api/apps/${app}/schedules`, { id: sched.id, ask, rule: { every: 'day', at }, enabled: false });
      const l = (await this.api('GET', `/api/apps/${app}/schedules`)).body?.schedules?.find((x: any) => x.id === sched.id);
      this.add(C, 'disable the schedule', off.status === 200 && l?.enabled === false ? 'PASS' : 'FAIL', `HTTP ${off.status} · enabled ${String(l?.enabled)} (there is no delete; a disabled schedule never runs)`);
    }
  }

  // ── 7. blocks ──────────────────────────────────────────────────────────────
  async blocks(): Promise<void> {
    const B: Section = 'blocks';
    const r = await this.api('GET', `/api/apps/${this.o.app}/blocks`);
    if (r.status !== 200 || !r.body?.blocks) {
      this.add(B, 'blocks', 'FAIL', `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      return;
    }
    const blocks = r.body.blocks as Record<string, unknown>;
    const none: string[] = [];
    for (const [name, block] of Object.entries(blocks)) {
      const src = blockSources(block);
      if (!src.length) {
        none.push(name);
        continue;
      }
      const problems: string[] = [];
      const ok: string[] = [];
      for (const s of src) {
        const { args, unresolved } = resolveBlockArgs(s.args, this.d, this.chart);
        if (unresolved.length) {
          problems.push(`${s.ability}: unresolved placeholder(s) ${unresolved.join(', ')}`);
          continue;
        }
        const a = this.ability(s.ability);
        if (!a) {
          problems.push(`${s.ability} is not an ability of ${this.o.app}`);
          continue;
        }
        if (a.kind !== 'read') {
          problems.push(`${s.ability} is not a read`);
          continue;
        }
        if (a.setting === 'off') {
          ok.push(`${s.ability} (off here)`);
          continue;
        }
        const c = await this.checkRead(s.ability, args);
        if (c.problem) problems.push(`${s.ability} ${JSON.stringify(args)}: ${c.problem}`);
        else ok.push(`${s.ability}${JSON.stringify(args) === '{}' ? '' : ` ${JSON.stringify(args)}`}`);
      }
      this.add(B, name, problems.length ? 'FAIL' : 'PASS', problems.length ? problems.join('; ') : `${ok.length} read(s) ok: ${ok.join(', ')}`);
    }
    if (none.length) this.add(B, `${none.length} blocks without reads`, 'PASS', none.join(', '));
  }

  // ── run ────────────────────────────────────────────────────────────────────
  async run(): Promise<Report> {
    this.startedAt = new Date();
    try {
      await this.init();
    } catch (e) {
      this.add('setup', 'sign in and load the app', 'FAIL', (e as Error).message);
      return this.report();
    }
    // Documents first: a kept file lets reads exercise ledger.document.get on a real id.
    const order: Section[] = ['documents', 'reads', 'blocks', 'governance', 'writes', 'questions', 'schedules'];
    for (const s of order) {
      if (!this.o.only.includes(s)) continue;
      try {
        await (this as any)[s]();
      } catch (e) {
        this.add(s, `${s} section`, 'FAIL', `the check itself failed: ${(e as Error).message}`);
      }
    }
    if (this.o.only.includes('writes') || this.o.only.includes('governance')) {
      this.notes.push(`Changes this run made to the books are tagged ${this.tag}: ₹1-scale test documents, bank lines and entries (the test journal entry is reversed; settings and the closed month are put back). Accounts, parties and coding rules are never deleted by the app, so they remain.`);
    }
    return this.report();
  }

  report(): Report {
    return {
      app: this.o.app,
      base_url: this.o.baseUrl,
      tag: this.tag,
      started_at: this.startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      company: this.company,
      today: this.d?.today ?? '',
      live_version: this.liveVersion,
      local_version: this.localVersion,
      spent_usd: Math.round(this.spent() * 1e6) / 1e6,
      budget_usd: this.o.budgetUsd,
      notes: this.notes,
      rows: this.rows,
    };
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Options {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tokenFrom = (file?: string, direct?: string) => (direct ? direct.trim() : file ? readFileSync(file, 'utf8').trim() : undefined);
  const adminToken = tokenFrom(env.NEOS_TOKEN_FILE, env.NEOS_TOKEN);
  if (!adminToken) throw new Error('NEOS_TOKEN_FILE (an admin token) is required');
  const only = (flag('only') ?? SECTIONS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of only) if (!(SECTIONS as readonly string[]).includes(s)) throw new Error(`--only: unknown section ${s} (${SECTIONS.join(', ')})`);
  return {
    baseUrl: (env.NEOS_PLATFORM_URL ?? 'http://127.0.0.1:4500').replace(/\/$/, ''),
    adminToken,
    memberToken: tokenFrom(env.NEOS_MEMBER_TOKEN_FILE, env.NEOS_MEMBER_TOKEN),
    app: flag('app') ?? 'ledger',
    only: only as Section[],
    out: flag('out') ?? 'docs/LIVE-VALIDATION.md',
    budgetUsd: Number(flag('budget-usd') ?? 12),
    emailTo: flag('email-to') ?? env.NEOS_VALIDATE_EMAIL_TO,
    gst: argv.includes('--gst'),
    doors: (flag('doors') ?? env.NEOS_VALIDATE_DOORS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    jobTimeoutMs: Number(flag('job-timeout-s') ?? 360) * 1000,
    pollMs: Number(flag('poll-ms') ?? 2000),
    scheduleLeadMin: Number(flag('schedule-lead-min') ?? 2),
    repoRoot: REPO_ROOT,
  };
}

export function writeReport(r: Report, out: string): void {
  const md = path.resolve(out);
  mkdirSync(path.dirname(md), { recursive: true });
  writeFileSync(md, renderMarkdown(r));
  writeFileSync(md.replace(/\.md$/i, '') + '.json', JSON.stringify(r, null, 2));
}

async function main() {
  const o = parseArgs(process.argv.slice(2), process.env);
  o.log = (l) => console.log(l);
  const r = await new LiveValidator(o).run();
  writeReport(r, o.out!);
  const fails = r.rows.filter((x) => x.result === 'FAIL').length;
  console.log(`\n${r.rows.length} checks: ${r.rows.filter((x) => x.result === 'PASS').length} pass, ${fails} fail, ${r.rows.filter((x) => x.result === 'SKIPPED').length} skipped · spent $${r.spent_usd.toFixed(4)} · report ${o.out}`);
  process.exit(fails ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
