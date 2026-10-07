// Abilities inherited from the earlier Ledger (docs/INHERITED-FROM-SHIV.md):
// richer aging, a cash forecast, the tax return per regime, report exports,
// the company's bookkeeping settings, opening balances, cash expenses, bank-line
// matching and setting aside, and reading an uploaded document. Reads are free
// and model-free; writes validate against the books before anyone is asked,
// post exactly once keyed on the proposal, and prove themselves by read-back.

import type { ExecCtx, ReadAbility, ReadCtx, WriteAbility } from '@neop/template';
import { DoorError, documents } from '@neop/template';
import type { PoolClient } from '@neop/pgkit';
import * as B from '../data/books.repo.ts';
import * as I from '../data/inherited.repo.ts';
import { accountTotals, entrySources } from '../data/ledger.repo.ts';
import { ACCT, billEntry } from '../domain/bookkeeping.ts';
import {
  agingAnalysis,
  cashForecast,
  DEFAULT_SUBTYPE,
  minorToDecimal,
  nextAccountCode,
  openingEntry,
  tableToCsv,
  tableToMarkdown,
  taxReturn,
  type Settings,
  type Table,
} from '../domain/inherited.ts';
import { natural, type AccountType } from '../domain/reports.ts';
import { aging, balanceSheet, cashFlow, DEFAULT_CURRENCY, pnl, trialBalance } from './reads.ts';
import { journalList } from './books.ts';
import { agedTo, chart, codesFromNames, unknownAccount } from '../domain/names.ts';

const S = 'ledger';
const today = () => new Date().toISOString().slice(0, 10);
const head = (entries: number, ids: string[], basis: string, currency = DEFAULT_CURRENCY) => ({
  generatedAt: new Date().toISOString(),
  currency,
  empty: entries === 0,
  sources: { entries, entry_ids: ids.slice(0, 50), basis },
});
const definite = (msg: string) => new DoorError(msg, { definite: true });
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
const rupees = (m: number) => `₹${(m / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * v3 S9 · a read the NEOS screens use is ONE SQL function the app declared in its migration file (read_<x>, registered
 * in ledger.declared_reads): the desk runs it through ledger.block_read(), and this handler runs the same function —
 * so a screen and the assistant always see one answer.
 */
function declared(fn: string): ReadAbility {
  return {
    kind: 'read',
    async run(a: unknown, ctx: ReadCtx) {
      return (await ctx.db.query<{ r: unknown }>(`select ledger.${fn}($1::jsonb) as r`, [JSON.stringify(a ?? {})])).rows[0]!.r;
    },
  };
}

async function lockedMsg(db: PoolClient, date: string): Promise<string | null> {
  return (await B.isLocked(db, date)) ? `${date.slice(0, 7)} is closed; post into an open month or reopen it first` : null;
}

async function controlBalance(db: PoolClient, subtype: 'receivable' | 'payable', asOf: string, currency: string) {
  const totals = (await accountTotals(db, { from: null, to: asOf, currency })).filter((a) => a.subtype === subtype);
  return { account_code: totals.map((a) => a.code).join(',') || null, balance_minor: totals.reduce((t, a) => t + natural(a), 0) };
}

// ── reads ─────────────────────────────────────────────────────────────────

export const settingsGet: ReadAbility = {
  kind: 'read',
  async run(_a: unknown, ctx: ReadCtx) {
    const s = await I.settings(ctx.db);
    return {
      ...head(s.stored ? 1 : 0, [], s.stored ? `company settings, last changed ${s.updated_at} by ${s.updated_by}` : 'defaults: nothing has been set for this company yet'),
      settings: s.settings,
      stored: s.stored,
      updated_at: s.updated_at,
      updated_by: s.updated_by,
    };
  },
};

export const agingAnalysisRead: ReadAbility = {
  kind: 'read',
  async run(a: { kind: 'receivable' | 'payable'; as_of: string; currency?: string }, ctx: ReadCtx) {
    const cur = a.currency ?? DEFAULT_CURRENCY;
    const kind = a.kind === 'receivable' ? 'invoice' : 'bill';
    const s = (await I.settings(ctx.db)).settings;
    // A running period is aged to the company's today, never past it: a bill due today is due, not overdue.
    const asOf = agedTo(a.as_of, ctx);
    const open = await I.openAsOf(ctx.db, { kind, as_of: asOf, currency: cur });
    const issued90 = await I.issuedBetween(ctx.db, { kind, from: addDays(asOf, -90), to: asOf, currency: cur });
    const control = await controlBalance(ctx.db, a.kind, asOf, cur);
    const r = agingAnalysis(a.kind, open, issued90, asOf, s, control);
    return {
      ...head(
        open.length,
        open.map((d) => d.id),
        `${a.kind === 'receivable' ? 'customer invoices' : 'supplier bills'} open on ${asOf}; the ${a.kind} control account; documents issued in the 90 days to ${asOf}${asOf !== a.as_of ? ` (aged to today, ${asOf}: ${a.as_of} has not come yet)` : ''}`,
        cur,
      ),
      kind: a.kind,
      as_of: asOf,
      ...r,
    };
  },
};

export const cashForecastRead: ReadAbility = declared('read_cash_forecast');

export const taxReturnRead: ReadAbility = declared('read_tax_return');

type ExportArgs = {
  report: 'trial_balance' | 'pnl' | 'balance_sheet' | 'cash_flow' | 'aging_receivable' | 'aging_payable' | 'tax_return' | 'journal' | 'cash_forecast';
  format?: 'csv' | 'md';
  from?: string;
  to?: string;
  as_of?: string;
};

/** A report as a file: regenerated from the posted books on every call, so a download is never stale. */
export const reportExport: ReadAbility = {
  kind: 'read',
  async run(a: ExportArgs, ctx: ReadCtx) {
    const format = a.format ?? 'csv';
    const to = a.to ?? a.as_of ?? today();
    const from = a.from ?? `${to.slice(0, 7)}-01`;
    const asOf = a.as_of ?? to;
    let title = '';
    let summary: [string, string][] = [];
    let table: Table;
    let result: any;
    const cols = (...c: [string, string, boolean?][]) => c.map(([key, label, m]) => ({ key, label, ...(m ? { money: true } : {}) }));
    switch (a.report) {
      case 'trial_balance':
        result = await trialBalance.run({ as_of: asOf }, ctx);
        title = `Trial balance as of ${asOf}`;
        summary = [['Total debits', minorToDecimal(result.total_debit_minor)], ['Total credits', minorToDecimal(result.total_credit_minor)], ['Balanced', result.balanced ? 'yes' : 'NO']];
        table = { columns: cols(['code', 'Code'], ['name', 'Account'], ['type', 'Type'], ['debit_minor', 'Debit', true], ['credit_minor', 'Credit', true]), rows: result.rows };
        break;
      case 'pnl':
        result = await pnl.run({ from, to }, ctx);
        title = `Profit and loss ${from} to ${to}`;
        summary = [['Revenue', minorToDecimal(result.totals.revenue_minor)], ['Gross profit', minorToDecimal(result.totals.gross_profit_minor)], ['Net profit', minorToDecimal(result.totals.net_profit_minor)]];
        table = {
          columns: cols(['section', 'Section'], ['code', 'Code'], ['name', 'Account'], ['amount_minor', 'Amount', true]),
          rows: [...result.income.map((l: any) => ({ section: 'Income', ...l })), ...result.expenses.map((l: any) => ({ section: 'Expenses', ...l }))],
        };
        break;
      case 'balance_sheet':
        result = await balanceSheet.run({ as_of: asOf }, ctx);
        title = `Balance sheet as of ${asOf}`;
        summary = [['Assets', minorToDecimal(result.totals.assets_minor)], ['Liabilities', minorToDecimal(result.totals.liabilities_minor)], ['Equity', minorToDecimal(result.totals.equity_minor)], ['Earnings to date', minorToDecimal(result.totals.earnings_to_date_minor)], ['Balanced', result.balanced ? 'yes' : 'NO']];
        table = {
          columns: cols(['section', 'Section'], ['code', 'Code'], ['name', 'Account'], ['amount_minor', 'Amount', true]),
          rows: [
            ...result.assets.map((l: any) => ({ section: 'Assets', ...l })),
            ...result.liabilities.map((l: any) => ({ section: 'Liabilities', ...l })),
            ...result.equity.map((l: any) => ({ section: 'Equity', ...l })),
            { section: 'Equity', code: '', name: 'Earnings to date', amount_minor: result.totals.earnings_to_date_minor },
          ],
        };
        break;
      case 'cash_flow':
        result = await cashFlow.run({ from, to }, ctx);
        title = `Cash flow ${from} to ${to}`;
        table = {
          columns: cols(['line', 'Line'], ['amount_minor', 'Amount', true]),
          rows: [
            { line: 'Opening cash', amount_minor: result.opening_cash_minor },
            { line: 'Operating', amount_minor: result.operating_minor },
            { line: 'Investing', amount_minor: result.investing_minor },
            { line: 'Financing', amount_minor: result.financing_minor },
            { line: 'Closing cash', amount_minor: result.closing_cash_minor },
          ],
        };
        break;
      case 'aging_receivable':
      case 'aging_payable':
        result = await aging.run({ kind: a.report === 'aging_receivable' ? 'receivable' : 'payable', as_of: asOf }, ctx);
        title = `${a.report === 'aging_receivable' ? 'Receivables' : 'Payables'} aging as of ${result.as_of}`;
        summary = [['Outstanding', minorToDecimal(result.total_outstanding_minor)]];
        table = { columns: cols(['number', 'Number'], ['party', 'Party'], ['due_date', 'Due'], ['days_past_due', 'Days late'], ['bucket', 'Bucket'], ['outstanding_minor', 'Outstanding', true]), rows: result.items };
        break;
      case 'tax_return':
        result = await taxReturnRead.run({ from, to }, ctx);
        title = `${result.tax_name} return ${from} to ${to} (${result.regime})`;
        summary = [['Net payable', minorToDecimal(result.net_payable_minor)], ['Due', result.due_date ?? 'not set for this regime']];
        table = { columns: cols(['box', 'Box'], ['label', 'Description'], ['amount_minor', 'Amount', true]), rows: result.boxes };
        break;
      case 'cash_forecast':
        result = await cashForecastRead.run({ as_of: asOf }, ctx);
        title = `Cash forecast from ${asOf}`;
        summary = [['Opening cash', minorToDecimal(result.opening_cash_minor)], ['Lowest balance', minorToDecimal(result.lowest_balance_minor)], ['Warning', result.warning ?? 'none']];
        table = { columns: cols(['week', 'Week'], ['week_ending', 'Week ending'], ['inflow_minor', 'In', true], ['outflow_minor', 'Out', true], ['balance_minor', 'Balance', true]), rows: result.weeks };
        break;
      case 'journal': {
        result = await journalList.run({ from, to, limit: 200 }, ctx);
        title = `Journal ${from} to ${to}`;
        const rows: Record<string, unknown>[] = [];
        for (const e of result.entries) for (const l of e.lines) rows.push({ date: e.date, reference: e.reference, memo: e.memo, account_code: l.account_code, account_name: l.account_name, debit_minor: l.debit_minor, credit_minor: l.credit_minor });
        table = { columns: cols(['date', 'Date'], ['reference', 'Reference'], ['memo', 'Memo'], ['account_code', 'Code'], ['account_name', 'Account'], ['debit_minor', 'Debit', true], ['credit_minor', 'Credit', true]), rows };
        break;
      }
    }
    const content = format === 'md' ? tableToMarkdown(title, summary, table!) : tableToCsv(table!);
    return {
      generatedAt: result.generatedAt,
      currency: result.currency,
      empty: result.empty,
      sources: result.sources,
      report: a.report,
      title,
      filename: `${a.report}_${a.report.startsWith('aging') || ['trial_balance', 'balance_sheet', 'cash_forecast'].includes(a.report) ? asOf : `${from}_${to}`}.${format}`,
      content_type: format === 'md' ? 'text/markdown' : 'text/csv',
      rows: table!.rows.length,
      content,
    };
  },
};

type ExtractArgs = { filename?: string; content_type?: string; content_base64?: string; sha256?: string; offset?: number; limit?: number };

/** Reading a file is deterministic and holds no model; the text reaches the assistant as untrusted data. */
export const documentExtract: ReadAbility = {
  kind: 'read',
  async run(a: ExtractArgs, ctx: ReadCtx) {
    const offset = a.offset ?? 0;
    const limit = a.limit ?? 20_000;
    const base = { generatedAt: new Date().toISOString(), currency: DEFAULT_CURRENCY, sources: { entries: 0, entry_ids: [] as string[], basis: '' } };
    const fail = (filename: string, code: string, message: string) => ({
      ...base,
      empty: true,
      sources: { ...base.sources, basis: `the file ${filename}, read by the documents door (no model)` },
      document: null,
      text: '',
      offset: 0,
      next_offset: null,
      tables: [],
      error: { code, message },
    });
    let doc: { filename: string; content_type: string; method: string; sha256: string; bytes: number; pages: number | null; chars: number };
    let text: string;
    let tables: { name: string; rows: string[][]; truncated: boolean }[] = [];
    let basis: string;
    if (a.content_base64 !== undefined) {
      const filename = a.filename ?? 'document';
      try {
        const d = documents.readDocument({ bytes: documents.uploadBytes({ filename, content_type: a.content_type, content_base64: a.content_base64 }), filename, contentType: a.content_type });
        doc = { filename: d.filename, content_type: d.content_type, method: d.method, sha256: d.sha256, bytes: d.bytes, pages: d.pages ?? null, chars: d.chars };
        text = d.text;
        tables = (d.tables ?? []).map((t) => ({ name: t.name, rows: t.rows.slice(0, 500), truncated: t.truncated || t.rows.length > 500 }));
        basis = `the file ${filename} (sha256 ${d.sha256.slice(0, 12)}…), read by the documents door (no model)`;
      } catch (e) {
        if (e instanceof documents.DocumentError) return fail(filename, e.code, e.message);
        throw e;
      }
    } else if (a.sha256) {
      const f = await I.attachedDocument(ctx.db, a.sha256);
      if (!f) return fail(a.sha256, 'not_found', `no file with sha256 ${a.sha256} is attached to a job of this company`);
      const v = f.value;
      if (v.error) return fail(v.filename, v.error, v.message);
      doc = { filename: v.filename, content_type: v.content_type, method: v.method, sha256: v.sha256, bytes: v.bytes, pages: v.pages ?? null, chars: v.chars };
      text = String(v.text ?? '');
      basis = `the file ${v.filename} attached to job ${f.job_id ?? '(none)'} on ${f.observed_at.toISOString()}, read by the documents door (no model)`;
    } else {
      return fail(a.filename ?? 'document', 'bad_request', 'give content_base64 (the file) or sha256 (a file attached to a job)');
    }
    const slice = text.slice(offset, offset + limit);
    const next = offset + limit < text.length ? offset + limit : null;
    return {
      ...base,
      empty: !slice.trim(),
      sources: { entries: 0, entry_ids: [], basis },
      document: doc,
      text: slice,
      offset,
      next_offset: next,
      tables: offset === 0 ? tables : [],
      error: null,
    };
  },
};

// ── writes ────────────────────────────────────────────────────────────────

type SettingsArgs = Partial<Settings>;

export const settingsUpdate: WriteAbility = {
  kind: 'write',
  check: (a: SettingsArgs) => (Object.keys(a).length ? null : 'say which setting to change'),
  async execute(a: SettingsArgs, ctx: ExecCtx) {
    return ctx.withDb(async (db) => {
      const cur = (await I.settings(db)).settings;
      const next: Settings = { ...cur, ...a, ...(a.aging_buckets ? { aging_buckets: [...new Set(a.aging_buckets)].sort((x, y) => x - y) } : {}) };
      await I.saveSettings(db, ctx.company_id, next, ctx.caller);
      return { external_ref: 'settings', detail: next };
    });
  },
  async readBack(a: SettingsArgs, ctx: ExecCtx) {
    const s = await ctx.withDb((db) => I.settings(db));
    const want = { ...a, ...(a.aging_buckets ? { aging_buckets: [...new Set(a.aging_buckets)].sort((x, y) => x - y) } : {}) } as Record<string, unknown>;
    const ok = s.stored && Object.entries(want).every(([k, v]) => JSON.stringify((s.settings as any)[k]) === JSON.stringify(v));
    return { found: ok, data: s.settings };
  },
};

type OpeningArgs = { date: string; currency: string; balances: { account_code: string; amount_minor: number }[]; equity_account_code?: string };
const OPENING_REF = 'opening-balances';

async function openingPlan(db: PoolClient, a: OpeningArgs) {
  const codes = [...new Set(a.balances.map((b) => b.account_code))];
  const accts = (await db.query<{ code: string; type: AccountType; subtype: string }>(`select code, type, subtype from ${S}.accounts where code = any($1)`, [codes])).rows;
  const missing = codes.filter((c) => !accts.some((x) => x.code === c));
  const equity = a.equity_account_code
    ? await B.accountByCode(db, a.equity_account_code)
    : (await db.query(`select * from ${S}.accounts where type = 'equity' order by (subtype = 'retained_earnings') desc, code limit 1`)).rows[0];
  const plan = openingEntry(
    a.balances.map((b) => ({ account_code: b.account_code, type: accts.find((x) => x.code === b.account_code)?.type ?? 'asset', amount_minor: b.amount_minor })),
    equity?.code ?? '',
  );
  return { missing, equity, plan };
}

export const openingBalancesSet: WriteAbility = {
  kind: 'write',
  measure: (a: OpeningArgs) => ({
    amount_minor: a.balances.reduce((t, b) => t + Math.abs(b.amount_minor), 0),
    currency: a.currency,
  }),
  check: (a: OpeningArgs) =>
    new Set(a.balances.map((b) => b.account_code)).size !== a.balances.length ? 'each account appears once in the opening balances' : a.balances.every((b) => b.amount_minor === 0) ? 'enter at least one non-zero balance' : null,
  async validate(a: OpeningArgs, ctx) {
    if (await B.entryByIdOrRef(ctx.db, OPENING_REF)) return 'opening balances are already set; correct them with a journal entry (ledger.journal.post) instead';
    const { missing, equity, plan } = await openingPlan(ctx.db, a);
    if (missing.length) return `unknown account codes: ${missing.join(', ')}`;
    if (!equity || equity.type !== 'equity') return a.equity_account_code ? `${a.equity_account_code} is not an equity account` : 'the chart has no equity account for the balancing figure; create one first';
    if (a.balances.some((b) => b.account_code === equity.code) && plan.opening_equity_minor !== 0) return `${equity.code} takes the balancing figure; leave it out of the balances or name another equity account`;
    const earlier = (await ctx.db.query<{ n: number; first: string | null }>(`select count(*)::int as n, to_char(min(entry_date), 'YYYY-MM-DD') as first from ${S}.journal_entries where entry_date < $1`, [a.date])).rows[0]!;
    if (earlier.n) return `${earlier.n} entries are dated before ${a.date} (the first on ${earlier.first}); opening balances are dated on or before the first entry`;
    return lockedMsg(ctx.db, a.date);
  },
  async execute(a: OpeningArgs, ctx: ExecCtx) {
    return ctx.withDb(async (db) => {
      const done = await B.entryByIdOrRef(db, OPENING_REF);
      if (done) {
        if (done.job_id === ctx.job_id) return { external_ref: done.id };
        throw definite('opening balances were set by someone else after this was approved; nothing was posted');
      }
      const { missing, equity, plan } = await openingPlan(db, a);
      if (missing.length || !equity) throw definite('the accounts changed after this was approved; nothing was posted');
      const r = await B.postEntry(db, { company_id: ctx.company_id, date: a.date, memo: 'Opening balances', reference: OPENING_REF, currency: a.currency, source: 'assistant', job_id: ctx.job_id, lines: plan.lines });
      return { external_ref: r.id, detail: { opening_equity_minor: plan.opening_equity_minor, lines: plan.lines.length } };
    });
  },
  async readBack(_a: OpeningArgs, ctx: ExecCtx) {
    const e = await ctx.withDb((db) => B.entryByIdOrRef(db, OPENING_REF));
    return { found: !!e, data: e && { id: e.id, date: e.date } };
  },
};

type ExpenseArgs = {
  date: string;
  currency: string;
  description: string;
  vendor?: string;
  amount_minor: number;
  gst_rate_bps: number;
  account_code: string;
  bank_account_code?: string;
  bank_transaction_id?: string;
};

const expenseLines = (a: ExpenseArgs) => {
  const b = billEntry([{ description: a.description, amount_minor: a.amount_minor, account_code: a.account_code }], a.gst_rate_bps);
  const bank = a.bank_account_code ?? ACCT.bank;
  // A bill paid on the spot: the payable nets out, so post straight to the bank.
  return { total: b.total, tax: b.tax, lines: b.lines.map((l) => (l.account_code === ACCT.payable ? { ...l, account_code: bank } : l)) };
};

const EXPENSE_FITS = (x: { type: string; subtype: string }) => ['expense', 'asset'].includes(x.type) && !['bank', 'cash', 'receivable', 'tax_input'].includes(x.subtype);

export const expenseRecord: WriteAbility = {
  kind: 'write',
  measure: (a: ExpenseArgs) => ({ amount_minor: expenseLines(a).total, currency: a.currency }),
  // "Office supplies" is the one expense category whose name matches it; none or several is refused below.
  async normalize(a: ExpenseArgs, ctx: ReadCtx) {
    if (!a || typeof a !== 'object') return a;
    const [acct, bank] = await codesFromNames(ctx.db, [a.account_code, a.bank_account_code]);
    const [exp] = a.account_code ? await codesFromNames(ctx.db, [a.account_code], EXPENSE_FITS) : [acct];
    return { ...a, ...(exp ? { account_code: exp } : {}), ...(bank ? { bank_account_code: bank } : {}) };
  },
  async validate(a: ExpenseArgs, ctx) {
    const accts = await chart(ctx.db);
    if (!accts.some((x) => x.code === a.account_code)) return unknownAccount(accts.filter(EXPENSE_FITS), a.account_code, 'expense category');
    const acct = await B.accountByCode(ctx.db, a.account_code);
    if (!acct || !['expense', 'asset'].includes(acct.type) || ['bank', 'cash', 'receivable', 'tax_input'].includes(acct.subtype)) return `${a.account_code} is not an expense or asset account`;
    const bank = await B.accountByCode(ctx.db, a.bank_account_code ?? ACCT.bank);
    if (!bank || !['bank', 'cash'].includes(bank.subtype)) return `${a.bank_account_code ?? ACCT.bank} is not a bank or cash account`;
    if (a.bank_transaction_id) {
      const t = await B.bankTxn(ctx.db, a.bank_transaction_id);
      if (!t) return 'no such bank line';
      if (t.status !== 'unmatched') return 'that bank line is already matched';
      if (t.bank_code !== bank.code) return `the bank line is on ${t.bank_code}, not ${bank.code}`;
      const total = expenseLines(a).total;
      if (Number(t.amount_minor) !== -total) return `the bank line is ${rupees(Number(t.amount_minor))}, but this expense comes to -${rupees(total)} (net plus GST)`;
    }
    return lockedMsg(ctx.db, a.date);
  },
  async execute(a: ExpenseArgs, ctx: ExecCtx) {
    return ctx.withDb(async (db) => {
      const mine = await B.entryByIdOrRef(db, ctx.idempotencyKey);
      if (mine) return { external_ref: mine.id };
      if (a.bank_transaction_id) {
        const line = await db.query(`select status from ${S}.bank_transactions where id = $1 for update`, [a.bank_transaction_id]);
        if (line.rows[0]?.status !== 'unmatched') throw definite('that bank line was matched by something else after this was approved; nothing was posted');
      }
      const e = expenseLines(a);
      const r = await B.postEntry(db, {
        company_id: ctx.company_id,
        date: a.date,
        memo: `${a.description}${a.vendor ? ` (${a.vendor})` : ''}`.slice(0, 300),
        reference: ctx.idempotencyKey,
        currency: a.currency,
        source: 'assistant',
        job_id: ctx.job_id,
        lines: e.lines,
      });
      if (a.bank_transaction_id) {
        const u = await db.query(`update ${S}.bank_transactions set status = 'matched', matched_entry_id = $2 where id = $1 and status = 'unmatched'`, [a.bank_transaction_id, r.id]);
        if (!u.rowCount) throw definite('that bank line was matched concurrently; nothing was posted');
      }
      return { external_ref: r.id, detail: { total_minor: e.total, tax_minor: e.tax } };
    });
  },
  async readBack(_a: ExpenseArgs, ctx: ExecCtx) {
    const e = await ctx.withDb((db) => B.entryByIdOrRef(db, ctx.idempotencyKey));
    return { found: !!e, data: e && { id: e.id, date: e.date, memo: e.memo } };
  },
};

type MatchArgs = { bank_transaction_id: string; entry: string };

async function matchProblem(db: PoolClient, a: MatchArgs): Promise<string | null> {
  const t = await B.bankTxn(db, a.bank_transaction_id);
  if (!t) return 'no such bank line';
  if (t.status !== 'unmatched') return `that bank line is already ${t.status}`;
  const e = await B.entryByIdOrRef(db, a.entry);
  if (!e) return `no journal entry ${a.entry}`;
  if (e.currency !== t.currency) return `the entry is in ${e.currency}, the bank line in ${t.currency}`;
  const net = (
    await db.query<{ n: number }>(
      `select coalesce(sum(l.debit_minor - l.credit_minor), 0)::bigint as n from ${S}.journal_lines l where l.entry_id = $1 and l.account_id = $2`,
      [e.id, t.bank_account_id],
    )
  ).rows[0]!.n;
  if (Number(net) !== Number(t.amount_minor)) return `the entry moves ${rupees(Number(net))} on ${t.bank_code}; the bank line is ${rupees(Number(t.amount_minor))}`;
  const other = (await db.query(`select id from ${S}.bank_transactions where matched_entry_id = $1 and id <> $2`, [e.id, t.id])).rows[0];
  if (other) return 'that entry is already matched to another bank line';
  return null;
}

/** A bank line that is already in the books (a payment recorded before the statement arrived): match it, post nothing. */
export const bankMatch: WriteAbility = {
  kind: 'write',
  async measure(a: MatchArgs, db?: PoolClient) {
    const t = db ? await B.bankTxn(db, a.bank_transaction_id) : null;
    return t ? { amount_minor: Math.abs(Number(t.amount_minor)), currency: t.currency } : {};
  },
  async validate(a: MatchArgs, ctx) {
    return matchProblem(ctx.db, a);
  },
  async execute(a: MatchArgs, ctx: ExecCtx) {
    return ctx.withDb(async (db) => {
      await db.query(`select 1 from ${S}.bank_transactions where id = $1 for update`, [a.bank_transaction_id]);
      const e = await B.entryByIdOrRef(db, a.entry);
      const t = await B.bankTxn(db, a.bank_transaction_id);
      if (t?.status === 'matched' && e && t.matched_entry_id === e.id) return { external_ref: e.id };
      const p = await matchProblem(db, a);
      if (p) throw definite(`${p}; nothing was changed`);
      await db.query(`update ${S}.bank_transactions set status = 'matched', matched_entry_id = $2 where id = $1 and status = 'unmatched'`, [a.bank_transaction_id, e!.id]);
      return { external_ref: e!.id };
    });
  },
  async readBack(a: MatchArgs, ctx: ExecCtx) {
    const t = await ctx.withDb((db) => B.bankTxn(db, a.bank_transaction_id));
    return { found: t?.status === 'matched' && !!t.matched_entry_id, data: t && { status: t.status, entry: t.matched_entry_id } };
  },
};

type IgnoreArgs = { bank_transaction_id: string; reason: 'duplicate' | 'not_business' | 'already_in_books_elsewhere' | 'other'; note?: string };

/** Set a bank line aside (it never reaches the books). Ask first: it hides money from the reconciliation. */
export const bankIgnore: WriteAbility = {
  kind: 'write',
  async measure(a: IgnoreArgs, db?: PoolClient) {
    const t = db ? await B.bankTxn(db, a.bank_transaction_id) : null;
    return t ? { amount_minor: Math.abs(Number(t.amount_minor)), currency: t.currency } : {};
  },
  check: (a: IgnoreArgs) => (a.reason === 'other' && !a.note?.trim() ? 'say why the line is set aside' : null),
  async validate(a: IgnoreArgs, ctx) {
    const t = await B.bankTxn(ctx.db, a.bank_transaction_id);
    if (!t) return 'no such bank line';
    if (t.status !== 'unmatched') return `that bank line is already ${t.status}`;
    return lockedMsg(ctx.db, t.date);
  },
  async execute(a: IgnoreArgs, ctx: ExecCtx) {
    return ctx.withDb(async (db) => {
      const note = `${a.reason}${a.note ? `: ${a.note}` : ''}`.slice(0, 500);
      const u = await db.query(`update ${S}.bank_transactions set status = 'ignored', note = $2 where id = $1 and status in ('unmatched', 'ignored') returning status`, [a.bank_transaction_id, note]);
      if (!u.rowCount) throw definite('that bank line was matched after this was approved; nothing was changed');
      return { external_ref: a.bank_transaction_id };
    });
  },
  async readBack(a: IgnoreArgs, ctx: ExecCtx) {
    const t = await ctx.withDb((db) => B.bankTxn(db, a.bank_transaction_id));
    return { found: t?.status === 'ignored', data: t && { status: t.status, note: t.note } };
  },
};

// ── chart authoring: ledger.account.create 1.1 (code and subtype may be left to Ledger) ──

type AcctArgs = { code?: string; name: string; type: AccountType; subtype?: string };
export const SUBTYPES: Record<AccountType, string[]> = {
  asset: ['cash', 'bank', 'receivable', 'inventory', 'fixed_asset', 'tax_input', 'other_asset'],
  liability: ['payable', 'tax_output', 'loan', 'other_liability'],
  equity: ['equity', 'retained_earnings'],
  income: ['revenue', 'other_income'],
  expense: ['cogs', 'opex', 'other_expense'],
};

export const accountCreate: WriteAbility = {
  kind: 'write',
  /** The code Ledger picks is decided before anyone is asked, so the card shows it and the fingerprint binds it. */
  async normalize(a: AcctArgs, ctx: ReadCtx) {
    const subtype = a.subtype ?? DEFAULT_SUBTYPE[a.type];
    if (a.code) return { ...a, subtype };
    const used = (await ctx.db.query<{ code: string }>(`select code from ${S}.accounts`)).rows.map((r) => r.code);
    const code = nextAccountCode(used, a.type, subtype);
    return code ? { ...a, code, subtype } : { ...a, subtype };
  },
  check: (a: AcctArgs) => (a.subtype === undefined || SUBTYPES[a.type]?.includes(a.subtype) ? null : `a ${a.type} account's subtype is one of ${SUBTYPES[a.type]?.join(', ')}`),
  async validate(a: AcctArgs, ctx) {
    if (!a.code) return `no free ${a.type} code is left; give one`;
    return (await B.accountByCode(ctx.db, a.code)) ? `account code ${a.code} is taken` : null;
  },
  async execute(a: AcctArgs, ctx: ExecCtx) {
    if (!a.code || !a.subtype) throw definite('the account code and subtype are decided before approval');
    return ctx.withDb(async (db) => {
      const r = await db.query<{ id: string }>(
        `insert into ${S}.accounts (company_id, code, name, type, subtype) values ($1,$2,$3,$4,$5) on conflict (company_id, code) do nothing returning id`,
        [ctx.company_id, a.code, a.name, a.type, a.subtype],
      );
      return { external_ref: r.rows[0]?.id ?? a.code! };
    });
  },
  async readBack(a: AcctArgs, ctx: ExecCtx) {
    const r = a.code ? await ctx.withDb((db) => B.accountByCode(db, a.code!)) : null;
    return { found: !!r && r.name === a.name, data: r };
  },
};
