// Carry an earlier Ledger's books into OUR ledger schema for one company. An ops
// step, run with the admin (or migrator) link — never by the app.
//
//   tsx scripts/import-legacy.ts --company <uuid> [--source-company <uuid>] [--from <old db url>]
//        [--to <admin url>] [--layout auto|v1|v2] [--dry-run]
//
// The layouts (documented in the earlier Ledger's dba/import-legacy.sql):
//   v1  neops.neop_ledger_*   keyed by customer_id, money numeric rupees
//   v2  public.ledger__*      keyed by company_id,  money numeric rupees
// v2 wins when both exist (its own import already copied v1). --from defaults to
// the target database; --source-company defaults to --company.
//
// What becomes what:
//   accounts        → accounts (subtype from the old profile: control accounts, cash
//                     accounts, report mapping; never guessed from a name)
//   journal entries → journal_entries + journal_lines (reference legacy:je:<id>)
//   bank lines      → bank_transactions (external_id legacy:<id>); a line the old
//                     Ledger folded into its books (coded, not matched) also posts
//                     its entry (legacy:txn:<id>) and is matched to it, so the two
//                     trial balances agree
//   AP invoices     → documents kind bill; AR invoices → documents kind invoice
//   vendors/customers named on them → parties
//   coding rules    → coding_rules, one per "a|b" alternative
//   closedPeriods   → period_locks (written last, so history lands first)
// Money: round(x × 100) to integer paise, in the company's currency.
// Idempotent: every row is keyed on a legacy reference; a second run adds nothing.
// One transaction: all of it or none of it. The report lists counts, everything
// that could not be mapped and why, and the trial balance before and after.

import { pathToFileURL } from 'node:url';
import { adminUrlFromEnv, createPool, type PoolClient } from '@neop/pgkit';

export type Layout = 'v1' | 'v2';
type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface ImportOptions {
  /** The database holding the old layout. */
  fromUrl: string;
  /** The database holding OUR ledger schema (admin or migrator link). */
  toUrl: string;
  companyId: string;
  sourceCompanyId?: string;
  layout?: Layout | 'auto';
  schema?: string;
  dryRun?: boolean;
  log?: (m: string) => void;
}

export interface TbRow {
  code: string;
  debit_minor: number;
  credit_minor: number;
}

export interface ImportReport {
  layout: Layout;
  company_id: string;
  source_company_id: string;
  currency: string;
  dry_run: boolean;
  counts: Record<string, { imported: number; existing: number }>;
  unmapped: { kind: string; id: string; reason: string }[];
  review: { kind: string; id: string; note: string }[];
  trial_balance: {
    before: { total_debit_minor: number; total_credit_minor: number; rows: TbRow[] };
    after: { total_debit_minor: number; total_credit_minor: number; rows: TbRow[] };
    equal: boolean;
    differences: { code: string; before_net_minor: number; after_net_minor: number }[];
  };
}

// ── the old layout, read once ────────────────────────────────────────────────

interface Old {
  config: any;
  accounts: { code: string; name: string; type: string; account_group?: string | null }[];
  rules: { id: string; pattern: string; account_code: string; note: string | null }[];
  txns: { id: string; date: string; description: string | null; amount_minor: number; account_code: string | null; status: string; notes: string | null }[];
  bills: { invoice: string; vendor: string | null; amount_minor: number; status: string; issue_date: string | null; due_date: string | null }[];
  ar: { id: string; customer: string; issue_date: string; due_date: string; amount_minor: number; received_minor: number; status: string }[];
  entries: { id: string; date: string; memo: string | null; source: string }[];
  lines: { entry_id: string; line_no: number; account_code: string; debit_minor: number; credit_minor: number }[];
}

async function detect(c: PoolClient, want: ImportOptions['layout']): Promise<Layout> {
  const has = async (t: string) => !!(await c.query<{ r: string | null }>('select to_regclass($1) as r', [t])).rows[0]!.r;
  const v2 = await has('public.ledger__accounts');
  const v1 = await has('neops.neop_ledger_accounts');
  if (want === 'v1' || want === 'v2') {
    if ((want === 'v1' && !v1) || (want === 'v2' && !v2)) throw new Error(`no ${want} layout in the source database`);
    return want;
  }
  if (v2) return 'v2';
  if (v1) return 'v1';
  throw new Error('no earlier Ledger layout found (neither public.ledger__* nor neops.neop_ledger_*)');
}

async function readOld(c: PoolClient, layout: Layout, company: string): Promise<Old> {
  const t = (name: string) => (layout === 'v2' ? `public.ledger__${name}` : `neops.neop_ledger_${name}`);
  const key = layout === 'v2' ? 'company_id' : 'customer_id';
  const has = async (name: string) => !!(await c.query<{ r: string | null }>('select to_regclass($1) as r', [t(name)])).rows[0]!.r;
  const cols = async (name: string) =>
    new Set((await c.query<{ c: string }>(`select attname as c from pg_attribute where attrelid = $1::regclass and attnum > 0 and not attisdropped`, [t(name)])).rows.map((r) => r.c));
  const q = async <T>(name: string, sql: string): Promise<T[]> => ((await has(name)) ? (await c.query(sql.replaceAll('$T', t(name)).replaceAll('$K', key), [company])).rows : []);
  const d = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;
  const accountCols = (await has('accounts')) ? await cols('accounts') : new Set<string>();
  return {
    config: (await q<{ doc: any }>('config', 'select doc from $T where $K = $1'))[0]?.doc ?? {},
    accounts: await q('accounts', `select code, name, type${accountCols.has('account_group') ? ', account_group' : ''} from $T where $K = $1 order by code`),
    rules: await q('coding_rules', 'select id, pattern, account_code, note from $T where $K = $1 order by created_at, id'),
    txns: await q('transactions', `select id, ${d('date')} as date, description, round(amount * 100)::bigint::float8 as amount_minor, account_code, status, notes from $T where $K = $1 order by date, id`),
    bills: await q('invoices', `select invoice, vendor, round(amount * 100)::bigint::float8 as amount_minor, status, ${d('issue_date')} as issue_date, ${d('due_date')} as due_date from $T where $K = $1 order by invoice`),
    ar: await q('ar_invoices', `select id, customer, ${d('issue_date')} as issue_date, ${d('due_date')} as due_date, round(amount * 100)::bigint::float8 as amount_minor, round(received * 100)::bigint::float8 as received_minor, status from $T where $K = $1 order by id`),
    entries: await q('journal_entries', `select id, ${d('date')} as date, memo, source from $T where $K = $1 order by date, created_at, id`),
    lines: await q('journal_lines', `select entry_id, line_no, account_code, round(debit * 100)::bigint::float8 as debit_minor, round(credit * 100)::bigint::float8 as credit_minor from $T where $K = $1 order by entry_id, line_no`),
  };
}

// ── the old Ledger's rules, ported (profile.mjs, accounting.mjs) ────────────

const STD_MAPPING = {
  pl: { revenue: ['4000-4999'], costOfSales: ['5000-5999'], operatingExpenses: ['6000-7999'], otherIncomeExpense: ['8000-8499'], tax: ['8500-8599'] },
  bs: { fixedAssets: ['0010-0999'], currentAssets: ['1000-1999'], currentLiabilities: ['2000-2499'], longTermLiabilities: ['2500-2999'], equity: ['3000-3999'] },
};
function listed(code: string, list: unknown): boolean {
  if (!Array.isArray(list)) return false;
  const n = Number(code);
  return list.some((r) => {
    const s = String(r).trim();
    if (!s.includes('-')) return s === code;
    const [lo, hi] = s.split('-').map((x) => Number(x.trim()));
    return Number.isFinite(n) && Number.isFinite(lo) && Number.isFinite(hi) && n >= lo! && n <= hi!;
  });
}

function controls(cfg: any) {
  const p = cfg?.profile ?? {};
  const c = { debtors: '1100', creditors: '2000', bank: '1000', revenue: '4000', vat: '2200', ...(p.controlAccounts ?? {}) };
  return {
    ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, String(v)])),
    cash: (Array.isArray(p.cashAccounts) ? p.cashAccounts : []).map(String) as string[],
    retained: p.retainedEarningsAccount ? String(p.retainedEarningsAccount) : null,
    mapping: p.reportMapping ?? STD_MAPPING,
  } as { debtors: string; creditors: string; bank: string; revenue: string; vat: string; cash: string[]; retained: string | null; mapping: any };
}

/** The type the old Ledger gave a code it had no chart row for (profile.mjs declaredType). */
function declaredType(code: string, cfg: any): AccountType | null {
  const k = controls(cfg);
  if (code === k.bank || code === k.debtors || k.cash.includes(code)) return 'asset';
  if (code === k.creditors || code === k.vat) return 'liability';
  if (code === k.revenue) return 'income';
  if (k.retained && code === k.retained) return 'equity';
  const m = cfg?.profile?.reportMapping ?? {};
  for (const key of ['revenue', 'costOfSales', 'operatingExpenses', 'otherIncomeExpense', 'tax']) if (listed(code, m.pl?.[key])) return key === 'revenue' ? 'income' : 'expense';
  for (const key of ['fixedAssets', 'currentAssets', 'currentLiabilities', 'longTermLiabilities', 'equity'])
    if (listed(code, m.bs?.[key])) return key === 'fixedAssets' || key === 'currentAssets' ? 'asset' : key === 'equity' ? 'equity' : 'liability';
  return null;
}

/** Our subtype for an old account: from what the company declared, then its type. */
export function subtypeFor(code: string, type: AccountType, cfg: any, group?: string | null): string {
  const k = controls(cfg);
  const m = k.mapping;
  switch (type) {
    case 'asset':
      if (code === k.bank) return 'bank';
      if (k.cash.includes(code)) return 'cash';
      if (code === k.debtors) return 'receivable';
      if (code === k.vat) return 'tax_input';
      if (listed(code, m.bs?.fixedAssets)) return 'fixed_asset';
      return 'other_asset';
    case 'liability':
      if (code === k.creditors) return 'payable';
      if (code === k.vat) return 'tax_output';
      if (listed(code, m.bs?.longTermLiabilities)) return 'loan';
      return 'other_liability';
    case 'equity':
      return k.retained && code === k.retained ? 'retained_earnings' : 'equity';
    case 'income':
      return listed(code, m.pl?.otherIncomeExpense) ? 'other_income' : 'revenue';
    case 'expense':
      if (group === 'cost_of_sales' || listed(code, m.pl?.costOfSales)) return 'cogs';
      if (group === 'other' || listed(code, m.pl?.otherIncomeExpense) || listed(code, m.pl?.tax)) return 'other_expense';
      return 'opex';
  }
}

/** The old trial balance: journal lines of real entries plus every coded, unmatched bank line folded in (accounting.mjs accountLedger). */
export function oldTrialBalance(old: Old): TbRow[] {
  const bank = controls(old.config).bank;
  const tb = new Map<string, TbRow>();
  const bump = (code: string, d: number, c: number) => {
    const r = tb.get(code) ?? { code, debit_minor: 0, credit_minor: 0 };
    r.debit_minor += d;
    r.credit_minor += c;
    tb.set(code, r);
  };
  const ids = new Set(old.entries.map((e) => e.id));
  for (const l of old.lines) if (ids.has(l.entry_id)) bump(l.account_code, l.debit_minor, l.credit_minor);
  for (const t of old.txns) {
    if (!t.account_code || t.status === 'matched' || t.account_code === bank || !t.amount_minor) continue;
    if (t.amount_minor > 0) {
      bump(t.account_code, 0, t.amount_minor);
      bump(bank, t.amount_minor, 0);
    } else {
      bump(t.account_code, -t.amount_minor, 0);
      bump(bank, 0, -t.amount_minor);
    }
  }
  return netted(tb);
}

function netted(tb: Map<string, TbRow>): TbRow[] {
  return [...tb.values()]
    .map((r) => {
      const n = r.debit_minor - r.credit_minor;
      return { code: r.code, debit_minor: n > 0 ? n : 0, credit_minor: n < 0 ? -n : 0 };
    })
    .filter((r) => r.debit_minor || r.credit_minor)
    .sort((a, b) => a.code.localeCompare(b.code));
}

// ── the import ──────────────────────────────────────────────────────────────

const CODE_OK = /^[0-9A-Za-z.-]{1,20}$/;
const today = () => new Date().toISOString().slice(0, 10);

export async function importLegacy(o: ImportOptions): Promise<ImportReport> {
  const S = o.schema ?? 'ledger';
  if (!/^[a-z_][a-z0-9_]*$/.test(S)) throw new Error('bad schema name');
  const company = o.companyId;
  const sourceCompany = o.sourceCompanyId ?? company;
  const log = o.log ?? (() => {});
  const srcPool = createPool(o.fromUrl, 1);
  const dstPool = createPool(o.toUrl, 1);
  const src = await srcPool.connect();
  const dst = await dstPool.connect();
  const counts: ImportReport['counts'] = {};
  const count = (k: string, imported: boolean) => {
    counts[k] ??= { imported: 0, existing: 0 };
    counts[k]![imported ? 'imported' : 'existing']++;
  };
  const unmapped: ImportReport['unmapped'] = [];
  const review: ImportReport['review'] = [];
  try {
    const layout = await detect(src, o.layout);
    log(`source layout ${layout}, company ${sourceCompany}`);
    const old = await readOld(src, layout, sourceCompany);
    const currency = String(old.config?.org?.currency ?? 'INR').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`the old company's currency "${currency}" is not an ISO code`);
    const k = controls(old.config);
    const before = oldTrialBalance(old);

    await dst.query('begin');
    await dst.query(`select set_config('neos.company_id', $1, true)`, [company]);
    // Every statement below also names the company: the admin link bypasses RLS.
    const one = async <T = any>(sql: string, args: unknown[]) => (await dst.query(sql, args)).rows[0] as T | undefined;

    // ── accounts ──
    const accountIds = new Map<string, string>();
    const accountTypes = new Map<string, string>();
    for (const r of (await dst.query(`select id, code, type, subtype from ${S}.accounts where company_id = $1`, [company])).rows) {
      accountIds.set(r.code, r.id);
      accountTypes.set(r.code, r.subtype);
    }
    const wanted = new Map<string, { name: string; type: AccountType; group?: string | null; inferred?: boolean }>();
    for (const a of old.accounts) wanted.set(a.code, { name: a.name, type: a.type as AccountType, group: a.account_group });
    const referenced = new Set([...old.lines.map((l) => l.account_code), ...old.txns.filter((t) => t.account_code).map((t) => t.account_code!), ...old.rules.map((r) => r.account_code), k.bank]);
    for (const code of referenced) {
      if (wanted.has(code)) continue;
      const t = declaredType(code, old.config);
      wanted.set(code, { name: code === k.bank ? 'Bank / Cash' : `Imported account ${code}`, type: t ?? 'asset', inferred: true });
      review.push({ kind: 'account', id: code, note: t ? `not in the old chart; created as ${t} from the old profile` : 'not in the old chart and nothing declared its type; created as an asset (other_asset) — review it' });
    }
    for (const [code, a] of wanted) {
      if (!CODE_OK.test(code)) {
        unmapped.push({ kind: 'account', id: code, reason: 'code does not fit this chart (1–20 letters, digits, dot or dash)' });
        continue;
      }
      if (!['asset', 'liability', 'equity', 'income', 'expense'].includes(a.type)) {
        unmapped.push({ kind: 'account', id: code, reason: `unknown type ${a.type}` });
        continue;
      }
      const subtype = subtypeFor(code, a.type, old.config, a.group);
      if (accountIds.has(code)) {
        count('accounts', false);
        continue;
      }
      const r = await one<{ id: string }>(
        `insert into ${S}.accounts (company_id, code, name, type, subtype) values ($1,$2,$3,$4,$5) on conflict (company_id, code) do nothing returning id`,
        [company, code, a.name.slice(0, 200) || code, a.type, subtype],
      );
      accountIds.set(code, r!.id);
      accountTypes.set(code, subtype);
      count('accounts', true);
    }

    // ── parties ──
    const partyId = async (kind: 'customer' | 'vendor', name: string): Promise<string> => {
      const hit = await one<{ id: string }>(`select id from ${S}.parties where company_id = $1 and kind = $2 and lower(name) = lower($3)`, [company, kind, name]);
      if (hit) {
        count('parties', false);
        return hit.id;
      }
      const r = await one<{ id: string }>(`insert into ${S}.parties (company_id, kind, name, reference) values ($1,$2,$3,$4) returning id`, [company, kind, name, `legacy:${kind}:${name.toLowerCase()}`]);
      count('parties', true);
      return r!.id;
    };
    const partyCache = new Map<string, string>();
    const party = async (kind: 'customer' | 'vendor', name: string) => {
      const key = `${kind}:${name.toLowerCase()}`;
      if (!partyCache.has(key)) partyCache.set(key, await partyId(kind, name));
      return partyCache.get(key)!;
    };

    // ── journal entries ──
    const locked = new Set((await dst.query(`select to_char(month, 'YYYY-MM') as m from ${S}.period_locks where company_id = $1`, [company])).rows.map((r) => r.m as string));
    const imported = async (ref: string) => (await one<{ id: string }>(`select id from ${S}.journal_entries where company_id = $1 and reference = $2`, [company, ref]))?.id ?? null;
    const postEntry = async (ref: string, date: string, memo: string, lines: TbRow[]): Promise<{ id: string; created: boolean }> => {
      // Already here (a re-run): reuse it, before the period-lock trigger can object to a second insert.
      const had = await imported(ref);
      if (had) return { id: had, created: false };
      const ins = await one<{ id: string }>(
        `insert into ${S}.journal_entries (company_id, entry_date, memo, reference, currency, source) values ($1,$2,$3,$4,$5,'import')
         on conflict (company_id, reference) do nothing returning id`,
        [company, date, memo, ref, currency],
      );
      if (!ins) return { id: (await one<{ id: string }>(`select id from ${S}.journal_entries where company_id = $1 and reference = $2`, [company, ref]))!.id, created: false };
      for (const l of lines) {
        await dst.query(`insert into ${S}.journal_lines (company_id, entry_id, account_id, debit_minor, credit_minor) values ($1,$2,$3,$4,$5)`, [company, ins.id, accountIds.get(l.code), l.debit_minor, l.credit_minor]);
      }
      return { id: ins.id, created: true };
    };
    const linesOf = new Map<string, Old['lines']>();
    for (const l of old.lines) linesOf.set(l.entry_id, [...(linesOf.get(l.entry_id) ?? []), l]);
    const entryIdByOld = new Map<string, { id: string; memo: string }>();
    for (const e of old.entries) {
      const raw = linesOf.get(e.id) ?? [];
      const lines: TbRow[] = [];
      for (const l of raw) {
        // One side per line here: an old line holding both becomes two lines, a zero line is dropped.
        if (l.debit_minor) lines.push({ code: l.account_code, debit_minor: l.debit_minor, credit_minor: 0 });
        if (l.credit_minor) lines.push({ code: l.account_code, debit_minor: 0, credit_minor: l.credit_minor });
      }
      const clean = lines;
      const had = await imported(`legacy:je:${e.id}`);
      if (had) {
        entryIdByOld.set(e.id, { id: had, memo: (e.memo ?? '').trim() || `Imported entry ${e.id}` });
        count('journal_entries', false);
        continue;
      }
      const dr = clean.reduce((t, l) => t + l.debit_minor, 0);
      const cr = clean.reduce((t, l) => t + l.credit_minor, 0);
      const bad = clean.find((l) => !accountIds.has(l.code));
      const reason = !clean.length
        ? 'no non-zero lines'
        : dr !== cr
          ? `does not balance (debits ${dr}, credits ${cr} paise)`
          : clean.length < 2
            ? 'fewer than two lines'
            : bad
              ? `account ${bad.code} could not be mapped`
              : locked.has(e.date.slice(0, 7))
                ? `${e.date.slice(0, 7)} is already locked in this ledger`
                : null;
      if (reason) {
        unmapped.push({ kind: 'journal_entry', id: e.id, reason });
        continue;
      }
      const memo = (e.memo ?? '').trim() || `Imported entry ${e.id}`;
      const r = await postEntry(`legacy:je:${e.id}`, e.date, memo.slice(0, 500), clean);
      entryIdByOld.set(e.id, { id: r.id, memo });
      count('journal_entries', r.created);
    }

    // ── bank lines ──
    const bankAcct = accountIds.get(k.bank);
    const bankOk = bankAcct && ['bank', 'cash'].includes(accountTypes.get(k.bank) ?? '');
    const docIdByNumber = new Map<string, string>();
    const bankLines: { t: Old['txns'][number]; entry: string | null; status: 'matched' | 'unmatched' | 'ignored'; note: string | null; doc: string | null }[] = [];
    for (const t of old.txns) {
      if (!bankOk) {
        unmapped.push({ kind: 'bank_transaction', id: t.id, reason: `the bank account ${k.bank} is not a bank or cash account in this ledger` });
        continue;
      }
      if (!t.amount_minor) {
        unmapped.push({ kind: 'bank_transaction', id: t.id, reason: 'zero amount' });
        continue;
      }
      if (t.account_code && t.status !== 'matched' && t.account_code !== k.bank) {
        // The old Ledger counted this line in its books; post it here the same way.
        if (!accountIds.has(t.account_code)) {
          unmapped.push({ kind: 'bank_transaction', id: t.id, reason: `coded to ${t.account_code}, which could not be mapped` });
          continue;
        }
        if (locked.has(t.date.slice(0, 7)) && !(await imported(`legacy:txn:${t.id}`))) {
          unmapped.push({ kind: 'bank_transaction', id: t.id, reason: `${t.date.slice(0, 7)} is already locked in this ledger` });
          continue;
        }
        const a = Math.abs(t.amount_minor);
        const lines = t.amount_minor > 0 ? [{ code: k.bank, debit_minor: a, credit_minor: 0 }, { code: t.account_code, debit_minor: 0, credit_minor: a }] : [{ code: t.account_code, debit_minor: a, credit_minor: 0 }, { code: k.bank, debit_minor: 0, credit_minor: a }];
        const r = await postEntry(`legacy:txn:${t.id}`, t.date, (t.description ?? '').trim() || `Imported bank line ${t.id}`, lines);
        count('bank_entries', r.created);
        bankLines.push({ t, entry: r.id, status: 'matched', note: null, doc: null });
      } else if (t.status === 'matched') {
        bankLines.push({ t, entry: null, status: 'matched', note: t.notes, doc: String(t.notes ?? '').startsWith('matched ') ? String(t.notes).slice(8).trim().split(' ')[0]! : null });
      } else if (t.account_code === k.bank) {
        bankLines.push({ t, entry: null, status: 'ignored', note: 'legacy: coded to the bank account itself', doc: null });
      } else bankLines.push({ t, entry: null, status: 'unmatched', note: t.notes || null, doc: null });
    }

    // ── documents ──
    const linkEntry = (prefix: string): string | null => {
      const hits = [...entryIdByOld.values()].filter((e) => e.memo.startsWith(prefix));
      return hits.length === 1 ? hits[0]!.id : null;
    };
    const insertDoc = async (kind: 'invoice' | 'bill', number: string, partyName: string, issue: string, due: string, total: number, paid: number, status: 'open' | 'paid', entry: string | null) => {
      const existing = await one<{ id: string }>(`select id from ${S}.documents where company_id = $1 and kind = $2 and number = $3`, [company, kind, number]);
      if (existing) {
        docIdByNumber.set(number, existing.id);
        count(kind === 'bill' ? 'bills' : 'invoices', false);
        return;
      }
      const pid = await party(kind === 'bill' ? 'vendor' : 'customer', partyName);
      const r = await one<{ id: string }>(
        `insert into ${S}.documents (company_id, kind, party_id, number, issue_date, due_date, currency, net_minor, tax_minor, total_minor, paid_minor, status, entry_id, reference)
         values ($1,$2,$3,$4,$5,$6,$7,$8,0,$8,$9,$10,$11,$12) returning id`,
        [company, kind, pid, number, issue, due, currency, total, paid, status, entry, `legacy:${kind}:${number}`],
      );
      docIdByNumber.set(number, r!.id);
      count(kind === 'bill' ? 'bills' : 'invoices', true);
    };
    for (const b of old.bills) {
      if (b.amount_minor < 0) {
        unmapped.push({ kind: 'bill', id: b.invoice, reason: 'negative amount' });
        continue;
      }
      let issue = b.issue_date ?? b.due_date;
      if (!issue) {
        issue = today();
        review.push({ kind: 'bill', id: b.invoice, note: `no issue or due date in the old books; dated ${issue} (the import)` });
      }
      let due = b.due_date ?? issue;
      if (due < issue) {
        review.push({ kind: 'bill', id: b.invoice, note: `due ${due} was before issue ${issue}; due set to the issue date` });
        due = issue;
      }
      if (b.status === 'approved-unpaid') review.push({ kind: 'bill', id: b.invoice, note: 'approved for payment in the old Ledger; imported open — approvals are asked again here' });
      const vendor = (b.vendor ?? '').trim() || 'Unknown supplier';
      if (!b.vendor) review.push({ kind: 'bill', id: b.invoice, note: 'no supplier on the old bill; filed under "Unknown supplier"' });
      review.push(...(b.amount_minor === 0 ? [{ kind: 'bill', id: b.invoice, note: 'zero amount' }] : []));
      const paid = b.status === 'paid';
      await insertDoc('bill', b.invoice, vendor, issue, due, b.amount_minor, paid ? b.amount_minor : 0, paid ? 'paid' : 'open', linkEntry(`Bill ${b.invoice}`));
    }
    for (const a of old.ar) {
      if (a.amount_minor < 0) {
        unmapped.push({ kind: 'invoice', id: a.id, reason: 'negative amount' });
        continue;
      }
      let received = a.received_minor;
      if (received > a.amount_minor) {
        review.push({ kind: 'invoice', id: a.id, note: `received ${received} is more than the ${a.amount_minor} invoiced; capped` });
        received = a.amount_minor;
      }
      const due = a.due_date < a.issue_date ? a.issue_date : a.due_date;
      if (due !== a.due_date) review.push({ kind: 'invoice', id: a.id, note: `due ${a.due_date} was before issue ${a.issue_date}; due set to the issue date` });
      await insertDoc('invoice', a.id, a.customer.trim() || 'Unknown customer', a.issue_date, due, a.amount_minor, received, received >= a.amount_minor ? 'paid' : 'open', linkEntry(`Sales invoice ${a.id}`));
    }

    // Bank lines last among the books: a matched one may point at a bill.
    for (const b of bankLines) {
      const r = await one(
        `insert into ${S}.bank_transactions (company_id, bank_account_id, external_id, txn_date, description, amount_minor, currency, status, matched_entry_id, matched_document_id, import_ref, note)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'legacy-import',$11)
         on conflict (company_id, bank_account_id, external_id) do nothing returning id`,
        [company, bankAcct, `legacy:${b.t.id}`, b.t.date, (b.t.description ?? '').trim() || '(no description)', b.t.amount_minor, currency, b.status, b.entry, b.doc ? docIdByNumber.get(b.doc) ?? null : null, b.note?.slice(0, 500) ?? null],
      );
      count('bank_transactions', !!r);
    }

    // ── coding rules ──
    for (const r of old.rules) {
      if (!accountIds.has(r.account_code)) {
        unmapped.push({ kind: 'coding_rule', id: r.id, reason: `account ${r.account_code} could not be mapped` });
        continue;
      }
      const alts = String(r.pattern).split('|').map((p) => p.trim()).filter(Boolean);
      alts.forEach((p, i) => {
        if (p.length < 2 || p.length > 100) unmapped.push({ kind: 'coding_rule', id: `${r.id}:${i}`, reason: `pattern "${p}" must be 2–100 characters here` });
      });
      for (const [i, p] of alts.entries()) {
        if (p.length < 2 || p.length > 100) continue;
        const x = await one(
          `insert into ${S}.coding_rules (company_id, pattern, account_id, direction, priority, reference) values ($1,$2,$3,'any',100,$4) on conflict (company_id, reference) do nothing returning id`,
          [company, p, accountIds.get(r.account_code), `legacy:rule:${r.id}:${i}`],
        );
        count('coding_rules', !!x);
      }
    }

    // ── period locks, last ──
    for (const m of Array.isArray(old.config?.closedPeriods) ? old.config.closedPeriods : []) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(m))) {
        unmapped.push({ kind: 'period_lock', id: String(m), reason: 'not a YYYY-MM month' });
        continue;
      }
      const x = await one(
        `insert into ${S}.period_locks (company_id, month, locked_by, reason) values ($1, $2, 'legacy-import', 'closed in the earlier Ledger') on conflict do nothing returning month`,
        [company, `${m}-01`],
      );
      count('period_locks', !!x);
    }

    // ── the trial balance of what was imported, from our tables ──
    const afterRows = (
      await dst.query<{ code: string; d: string; c: string }>(
        `select a.code, sum(l.debit_minor)::text as d, sum(l.credit_minor)::text as c
           from ${S}.journal_lines l join ${S}.journal_entries e on e.id = l.entry_id join ${S}.accounts a on a.id = l.account_id
          where e.company_id = $1 and e.reference like 'legacy:%' group by a.code`,
        [company],
      )
    ).rows;
    const after = netted(new Map(afterRows.map((r) => [r.code, { code: r.code, debit_minor: Number(r.d), credit_minor: Number(r.c) }])));
    const net = (rows: TbRow[]) => new Map(rows.map((r) => [r.code, r.debit_minor - r.credit_minor]));
    const nb = net(before);
    const na = net(after);
    const differences = [...new Set([...nb.keys(), ...na.keys()])]
      .filter((c) => (nb.get(c) ?? 0) !== (na.get(c) ?? 0))
      .sort()
      .map((c) => ({ code: c, before_net_minor: nb.get(c) ?? 0, after_net_minor: na.get(c) ?? 0 }));
    const total = (rows: TbRow[]) => ({ total_debit_minor: rows.reduce((t, r) => t + r.debit_minor, 0), total_credit_minor: rows.reduce((t, r) => t + r.credit_minor, 0), rows });

    await dst.query(o.dryRun ? 'rollback' : 'commit');
    log(o.dryRun ? 'dry run: rolled back' : 'committed');
    return {
      layout,
      company_id: company,
      source_company_id: sourceCompany,
      currency,
      dry_run: !!o.dryRun,
      counts,
      unmapped,
      review,
      trial_balance: { before: total(before), after: total(after), equal: differences.length === 0, differences },
    };
  } catch (e) {
    await dst.query('rollback').catch(() => {});
    throw e;
  } finally {
    src.release();
    dst.release();
    await srcPool.end();
    await dstPool.end();
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const companyId = opt('company');
  if (!companyId || !/^[0-9a-f-]{36}$/i.test(companyId)) {
    console.error('usage: tsx scripts/import-legacy.ts --company <uuid> [--source-company <uuid>] [--from <url>] [--to <url>] [--layout auto|v1|v2] [--dry-run]');
    process.exit(64);
  }
  const toUrl = opt('to') ?? adminUrlFromEnv();
  const report = await importLegacy({
    fromUrl: opt('from') ?? toUrl,
    toUrl,
    companyId,
    sourceCompanyId: opt('source-company'),
    layout: (opt('layout') as Layout | 'auto' | undefined) ?? 'auto',
    dryRun: args.includes('--dry-run'),
    log: (m) => console.error(m),
  });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.trial_balance.equal ? 0 : 2);
}
