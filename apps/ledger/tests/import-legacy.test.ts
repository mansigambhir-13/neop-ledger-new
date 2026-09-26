// import-legacy.test · an earlier Ledger's books (the v1 neops.neop_ledger_* and v2
// public.ledger__* layouts, built here from the shapes in its dba/import-legacy.sql
// and db/neops-ledger-schema.sql) carried into OUR ledger schema for one company:
// accounts, parties, bills and invoices, journal entries, bank lines, coding rules
// and period locks; the trial balance equal before and after; a second run adds
// nothing; what cannot be mapped is reported, never guessed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPool, createTestDatabase, roleUrl, withCompany } from '@neop/pgkit';
import { migrateApp } from '@neop/template';
import { importLegacy, oldTrialBalance } from '../../../scripts/import-legacy.ts';
import { trialBalance } from '../src/abilities/reads.ts';
import { accountsList } from '../src/abilities/books.ts';
import { ledgerApp } from '../src/index.ts';

const OLD_CO = '0a1b2c3d-0000-4000-8000-000000000001';
const OTHER_CO = '0a1b2c3d-0000-4000-8000-000000000002';
const NEW_CO = 'c0ffee00-0000-4000-8000-000000000001';
const NEW_CO_2 = 'c0ffee00-0000-4000-8000-000000000002';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let admin: pg.Client;
let appPool: ReturnType<typeof createPool>;
beforeAll(async () => {
  db = await createTestDatabase();
  await migrateApp(db.adminUrl, await ledgerApp());
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  appPool = createPool(roleUrl(db.adminUrl, 'ledger_app'));
});
afterAll(async () => {
  await appPool?.end();
  await admin?.end();
  await db?.drop();
});

/** The earlier Ledger's tables (heads only; history tables and triggers are not read by the import). */
function oldSchema(layout: 'v1' | 'v2'): string {
  const [ns, pre, key] = layout === 'v1' ? ['neops', 'neop_ledger_', 'customer_id'] : ['public', 'ledger__', 'company_id'];
  const t = (n: string) => `${ns}.${pre}${n}`;
  return `
    create schema if not exists ${ns};
    create table ${t('accounts')} (${key} uuid not null, code text not null, name text not null,
      type text not null default 'expense' check (type in ('asset','liability','equity','income','expense')),
      ${layout === 'v2' ? "account_group text check (account_group is null or account_group in ('cost_of_sales','operating','other'))," : ''}
      version integer not null default 1, primary key (${key}, code));
    create table ${t('coding_rules')} (${key} uuid not null, id text not null, pattern text not null, account_code text not null,
      note text, source text not null default 'declared', hits integer not null default 0, created_at timestamptz not null default now(),
      version integer not null default 1, primary key (${key}, id));
    create table ${t('transactions')} (${key} uuid not null, id text not null, date date not null, description text,
      amount numeric(18,2) not null, account_code text, status text not null default 'new' check (status in ('new','cleared','coded','matched','flagged')),
      notes text, version integer not null default 1, primary key (${key}, id));
    create table ${t('invoices')} (${key} uuid not null, invoice text not null, vendor text, amount numeric(18,2) not null check (amount >= 0),
      status text not null default 'open' check (status in ('open','approved-unpaid','paid')), issue_date date, due_date date,
      version integer not null default 1, primary key (${key}, invoice));
    create table ${t('config')} (${key} uuid primary key, doc jsonb not null default '{}', updated_at timestamptz not null default now());
    create table ${t('journal_entries')} (${key} uuid not null, id text not null, date date not null, period text not null,
      memo text, source text not null default 'manual', locked boolean not null default false, created_at timestamptz not null default now(), primary key (${key}, id));
    create table ${t('journal_lines')} (${key} uuid not null, id text not null, entry_id text not null, line_no integer not null,
      account_code text not null, debit numeric(18,2) not null default 0, credit numeric(18,2) not null default 0, memo text, primary key (${key}, id),
      check (debit >= 0 and credit >= 0));
    create table ${t('ar_invoices')} (${key} uuid not null, id text not null, customer text not null, issue_date date not null, due_date date not null,
      amount numeric(18,2) not null, received numeric(18,2) not null default 0, status text not null default 'open',
      last_chased timestamptz, created_at timestamptz not null default now(), primary key (${key}, id));`;
}

/** A small trading company's books as the earlier Ledger kept them (rupees, numeric). */
async function seedOld(c: pg.Client, layout: 'v1' | 'v2', co: string, opts: { unbalanced?: boolean } = {}) {
  const [ns, pre, key] = layout === 'v1' ? ['neops', 'neop_ledger_', 'customer_id'] : ['public', 'ledger__', 'company_id'];
  const t = (n: string) => `${ns}.${pre}${n}`;
  await c.query(`insert into ${t('config')} (${key}, doc) values ($1, $2)`, [
    co,
    { org: { name: 'Acme Traders', currency: 'INR', period: '2026-08' }, closedPeriods: ['2026-07'], profile: { controlAccounts: { bank: '1000', debtors: '1100', creditors: '2000', vat: '2200', revenue: '4000' }, retainedEarningsAccount: '3200', cashAccounts: ['1050'] } },
  ]);
  for (const [code, name, type] of [
    ['1000', 'Current account', 'asset'],
    ['1050', 'Petty cash', 'asset'],
    ['1100', 'Trade debtors', 'asset'],
    ['0500', 'Laptops', 'asset'],
    ['2000', 'Trade creditors', 'liability'],
    ['2200', 'GST control', 'liability'],
    ['2600', 'Director loan', 'liability'],
    ['3000', 'Share capital', 'equity'],
    ['3200', 'Retained earnings', 'equity'],
    ['4000', 'Sales', 'income'],
    ['5000', 'Stock purchases', 'expense'],
    ['6500', 'Cloud hosting', 'expense'],
    ['6999', 'Uncoded purchases', 'expense'],
    ['8100', 'Bank interest', 'income'],
  ]) await c.query(`insert into ${t('accounts')} (${key}, code, name, type) values ($1,$2,$3,$4)`, [co, code, name, type]);
  const je = async (id: string, date: string, memo: string | null, source: string, lines: [string, number, number][]) => {
    await c.query(`insert into ${t('journal_entries')} (${key}, id, date, period, memo, source) values ($1,$2,$3,$4,$5,$6)`, [co, id, date, date.slice(0, 7), memo, source]);
    for (const [n, [code, d, cr]] of lines.entries()) await c.query(`insert into ${t('journal_lines')} (${key}, id, entry_id, line_no, account_code, debit, credit) values ($1,$2,$3,$4,$5,$6,$7)`, [co, `${id}:${n}`, id, n, code, d, cr]);
  };
  await je('opening-balances', '2026-07-01', 'Opening balances', 'opening', [['1000', 250000, 0], ['1050', 1500.5, 0], ['0500', 90000, 0], ['2600', 0, 100000], ['3000', 0, 241500.5]]);
  await je('je-bill-1', '2026-07-05', 'Bill B-17 from Mehta Wholesale', 'ap-bill', [['6999', 40000, 0], ['2000', 0, 40000]]);
  await je('je-sale-1', '2026-07-12', 'Sales invoice ar-1 — Sharma Retail', 'ar', [['1100', 59000, 0], ['4000', 0, 50000], ['2200', 0, 9000]]);
  await je('je-rcpt-1', '2026-08-02', 'Receipt against ar-1', 'ar-receipt', [['1000', 30000, 0], ['1100', 0, 30000]]);
  await je('je-pay-1', '2026-08-03', 'Payment of bill B-17 to Mehta Wholesale', 'ap-payment', [['2000', 40000, 0], ['1000', 0, 40000]]);
  // Legacy oddities: a memo-less entry, a zero line, a line with both sides.
  await je('je-odd', '2026-08-10', null, 'manual', [['5000', 1180, 0], ['2200', 180, 0], ['6500', 0, 0], ['6500', 0, 0], ['1000', 0, 1360]]);
  await c.query(`update ${t('journal_lines')} set debit = 100, credit = 100 where ${key} = $1 and id = 'je-odd:2'`, [co]);
  if (opts.unbalanced) await je('je-broken', '2026-08-11', 'Half an entry', 'manual', [['6500', 99.99, 0], ['1000', 0, 99]]);
  // An orphan line (no entry): the old ledger never counted it, and neither do we.
  await c.query(`insert into ${t('journal_lines')} (${key}, id, entry_id, line_no, account_code, debit, credit) values ($1, 'orphan:0', 'orphan', 0, '6500', 5, 0)`, [co]);
  for (const [id, date, desc, amt, code, status, notes] of [
    ['t1', '2026-08-05', 'AWS INDIA 8123', -8260, '6500', 'coded', null], // folded into the books
    ['t2', '2026-08-06', 'INTEREST CREDIT', 312.45, '8100', 'coded', null], // folded
    ['t3', '2026-08-03', 'NEFT MEHTA B-17', -40000, null, 'matched', 'matched B-17'], // settled by its bill's journal
    ['t4', '2026-08-20', 'UPI 9921 UNKNOWN', -750, null, 'flagged', 'uncategorized'], // not in the books yet
    ['t5', '2026-08-21', null, -99.99, '9100', 'coded', null], // coded to an account nobody declared
    ['t6', '2026-08-22', 'SELF TRANSFER', 1000, '1000', 'coded', null], // coded to the bank itself: never folded
    ['t7', '2026-08-23', 'ZERO', 0, null, 'new', null],
  ] as const) await c.query(`insert into ${t('transactions')} (${key}, id, date, description, amount, account_code, status, notes) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [co, id, date, desc, amt, code, status, notes]);
  for (const [inv, vendor, amt, status, issue, due] of [
    ['B-17', 'Mehta Wholesale', 40000, 'paid', '2026-07-05', '2026-08-04'],
    ['B-18', 'Mehta Wholesale', 12500, 'approved-unpaid', '2026-08-15', '2026-09-14'],
    ['CS-9', null, 2360, 'open', null, null],
  ] as const) await c.query(`insert into ${t('invoices')} (${key}, invoice, vendor, amount, status, issue_date, due_date) values ($1,$2,$3,$4,$5,$6,$7)`, [co, inv, vendor, amt, status, issue, due]);
  for (const [id, cust, issue, due, amt, rec, status] of [
    ['ar-1', 'Sharma Retail', '2026-07-12', '2026-08-11', 59000, 30000, 'part-paid'],
    ['ar-2', 'Kapoor Traders', '2026-08-18', '2026-09-17', 11800, 0, 'open'],
  ] as const) await c.query(`insert into ${t('ar_invoices')} (${key}, id, customer, issue_date, due_date, amount, received, status) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [co, id, cust, issue, due, amt, rec, status]);
  for (const [id, pattern, code] of [
    ['r1', 'aws|gcp', '6500'],
    ['r2', 'interest', '8100'],
    ['r3', 'x', '6500'],
  ]) await c.query(`insert into ${t('coding_rules')} (${key}, id, pattern, account_code) values ($1,$2,$3,$4)`, [co, id, pattern, code]);
}

const tbOf = async (co: string) =>
  withCompany(appPool, co, async (c) =>
    (await trialBalance.run({ as_of: '2026-12-31', currency: 'INR' }, { company_id: co, caller: 'test', job_id: null, now: new Date(), db: c })) as any,
  );

describe('import from the v1 layout (neops.neop_ledger_*)', () => {
  it('carries the books over with the trial balance equal before and after', async () => {
    await admin.query(oldSchema('v1'));
    await seedOld(admin, 'v1', OLD_CO);
    await seedOld(admin, 'v1', OTHER_CO); // another customer of the old install: must not come over
    const r = await importLegacy({ fromUrl: db.adminUrl, toUrl: db.adminUrl, companyId: NEW_CO, sourceCompanyId: OLD_CO });
    expect(r.layout).toBe('v1');
    expect(r.currency).toBe('INR');

    // Trial balance: the old one (journal + folded bank feed) equals ours, account by account.
    expect(r.trial_balance.equal).toBe(true);
    expect(r.trial_balance.differences).toEqual([]);
    expect(r.trial_balance.before.total_debit_minor).toBe(r.trial_balance.before.total_credit_minor);
    const before = new Map(r.trial_balance.before.rows.map((x) => [x.code, x.debit_minor - x.credit_minor]));
    expect(before.get('1000')).toBe(25_000_000 + 3_000_000 - 4_000_000 - 136_000 - 826_000 + 31_245 - 9_999);
    expect(before.get('6500')).toBe(826_000); // the AWS bank line the old ledger folded in
    const ours = await tbOf(NEW_CO);
    expect(ours.balanced).toBe(true);
    for (const row of ours.rows) expect(row.balance_minor, row.code).toBe(before.get(row.code) ?? 0);
    for (const [code, net] of before) expect(ours.rows.find((x: any) => x.code === code)?.balance_minor, code).toBe(net);

    expect(r.counts).toMatchObject({
      accounts: { imported: 15, existing: 0 },
      journal_entries: { imported: 6, existing: 0 },
      bank_entries: { imported: 3, existing: 0 },
      bank_transactions: { imported: 6, existing: 0 },
      bills: { imported: 3, existing: 0 },
      invoices: { imported: 2, existing: 0 },
      coding_rules: { imported: 3, existing: 0 },
      period_locks: { imported: 1, existing: 0 },
    });
    expect(r.unmapped).toEqual([
      { kind: 'bank_transaction', id: 't7', reason: 'zero amount' },
      { kind: 'coding_rule', id: 'r3:0', reason: 'pattern "x" must be 2–100 characters here' },
    ]);
    expect(r.review).toEqual(
      expect.arrayContaining([
        { kind: 'account', id: '9100', note: expect.stringMatching(/created as an asset/) },
        { kind: 'bill', id: 'B-18', note: expect.stringMatching(/approved for payment in the old Ledger; imported open/) },
        { kind: 'bill', id: 'CS-9', note: expect.stringMatching(/no issue or due date/) },
        { kind: 'bill', id: 'CS-9', note: expect.stringMatching(/Unknown supplier/) },
      ]),
    );

    // What landed, through Ledger's own reads and tables.
    const pool = appPool;
    await withCompany(pool, NEW_CO, async (c) => {
      const ctx = { company_id: NEW_CO, caller: 'test', job_id: null, now: new Date(), db: c };
      const accts = ((await accountsList.run({ as_of: '2026-12-31' }, ctx)) as any).accounts;
      const sub = Object.fromEntries(accts.map((a: any) => [a.code, a.subtype]));
      expect(sub).toMatchObject({ '1000': 'bank', '1050': 'cash', '1100': 'receivable', '0500': 'fixed_asset', '2000': 'payable', '2200': 'tax_output', '2600': 'loan', '3200': 'retained_earnings', '5000': 'cogs', '6500': 'opex', '8100': 'other_income', '9100': 'other_asset' });
      const docs = (await c.query(`select d.kind, d.number, p.name as party, to_char(d.issue_date, 'YYYY-MM-DD') as issue, d.total_minor::int as total, d.paid_minor::int as paid, d.status, d.entry_id is not null as linked from ledger.documents d join ledger.parties p on p.id = d.party_id order by d.kind, d.number`)).rows;
      expect(docs).toEqual([
        { kind: 'bill', number: 'B-17', party: 'Mehta Wholesale', issue: '2026-07-05', total: 4_000_000, paid: 4_000_000, status: 'paid', linked: true },
        { kind: 'bill', number: 'B-18', party: 'Mehta Wholesale', issue: '2026-08-15', total: 1_250_000, paid: 0, status: 'open', linked: false },
        { kind: 'bill', number: 'CS-9', party: 'Unknown supplier', issue: new Date().toISOString().slice(0, 10), total: 236_000, paid: 0, status: 'open', linked: false },
        { kind: 'invoice', number: 'ar-1', party: 'Sharma Retail', issue: '2026-07-12', total: 5_900_000, paid: 3_000_000, status: 'open', linked: true },
        { kind: 'invoice', number: 'ar-2', party: 'Kapoor Traders', issue: '2026-08-18', total: 1_180_000, paid: 0, status: 'open', linked: false },
      ]);
      const bank = (await c.query(`select external_id, status, amount_minor::int as amt, matched_entry_id is not null as entry, matched_document_id is not null as doc from ledger.bank_transactions order by external_id`)).rows;
      expect(bank).toEqual([
        { external_id: 'legacy:t1', status: 'matched', amt: -826_000, entry: true, doc: false },
        { external_id: 'legacy:t2', status: 'matched', amt: 31_245, entry: true, doc: false },
        { external_id: 'legacy:t3', status: 'matched', amt: -4_000_000, entry: false, doc: true },
        { external_id: 'legacy:t4', status: 'unmatched', amt: -75_000, entry: false, doc: false },
        { external_id: 'legacy:t5', status: 'matched', amt: -9_999, entry: true, doc: false },
        { external_id: 'legacy:t6', status: 'ignored', amt: 100_000, entry: false, doc: false },
      ]);
      expect((await c.query(`select pattern from ledger.coding_rules order by reference`)).rows.map((x) => x.pattern)).toEqual(['aws', 'gcp', 'interest']);
      expect((await c.query(`select to_char(month, 'YYYY-MM') as m, locked_by from ledger.period_locks`)).rows).toEqual([{ m: '2026-07', locked_by: 'legacy-import' }]);
      const odd = (await c.query(`select e.memo, count(l.*)::int as n from ledger.journal_entries e join ledger.journal_lines l on l.entry_id = e.id where e.reference = 'legacy:je:je-odd' group by e.memo`)).rows[0];
      expect(odd).toEqual({ memo: 'Imported entry je-odd', n: 5 }); // zero line dropped, two-sided line split
      // A locked month refuses new posts, as it did in the old ledger.
      await expect(c.query(`insert into ledger.journal_entries (company_id, entry_date, memo, reference, currency, source) values ($1, '2026-07-20', 'late', 'late-1', 'INR', 'manual')`, [NEW_CO])).rejects.toThrow(/locked/);
    });
    await withCompany(pool, NEW_CO_2, async (c) => {
      expect((await c.query('select count(*)::int as n from ledger.accounts')).rows[0].n).toBe(0);
    });
  });

  it('is idempotent: a second run adds nothing and the books stay equal', async () => {
    const r = await importLegacy({ fromUrl: db.adminUrl, toUrl: db.adminUrl, companyId: NEW_CO, sourceCompanyId: OLD_CO });
    for (const [k, v] of Object.entries(r.counts)) expect(v.imported, k).toBe(0);
    expect(r.counts.journal_entries).toEqual({ imported: 0, existing: 6 });
    expect(r.trial_balance.equal).toBe(true);
    const n = await admin.query(`select count(*)::int as n from ledger.journal_entries where company_id = $1`, [NEW_CO]);
    expect(n.rows[0].n).toBe(9);
  });
});

describe('import from the v2 layout (public.ledger__*)', () => {
  it('prefers v2, imports another company, and reports an unbalanced entry instead of guessing (trial balance differs, named)', async () => {
    await admin.query(oldSchema('v2'));
    await seedOld(admin, 'v2', OLD_CO, { unbalanced: true });
    await admin.query(`update public.ledger__accounts set account_group = 'cost_of_sales' where company_id = $1 and code = '6500'`, [OLD_CO]);
    const dry = await importLegacy({ fromUrl: db.adminUrl, toUrl: db.adminUrl, companyId: NEW_CO_2, sourceCompanyId: OLD_CO, dryRun: true });
    expect(dry.layout).toBe('v2');
    expect(dry.dry_run).toBe(true);
    expect((await admin.query(`select count(*)::int as n from ledger.journal_entries where company_id = $1`, [NEW_CO_2])).rows[0].n).toBe(0);
    const r = await importLegacy({ fromUrl: db.adminUrl, toUrl: db.adminUrl, companyId: NEW_CO_2, sourceCompanyId: OLD_CO });
    expect(r.unmapped).toContainEqual({ kind: 'journal_entry', id: 'je-broken', reason: 'does not balance (debits 9999, credits 9900 paise)' });
    expect(r.trial_balance.equal).toBe(false);
    expect(r.trial_balance.differences).toEqual([
      { code: '1000', before_net_minor: expect.any(Number), after_net_minor: expect.any(Number) },
      { code: '6500', before_net_minor: 826_000 + 9_999, after_net_minor: 826_000 },
    ]);
    const ours = await tbOf(NEW_CO_2);
    expect(ours.balanced).toBe(true);
    const sub = await admin.query(`select subtype from ledger.accounts where company_id = $1 and code = '6500'`, [NEW_CO_2]);
    expect(sub.rows[0].subtype).toBe('cogs');
  });

  it('the old trial balance counts journals plus the folded bank feed, never orphan lines', () => {
    const tb = oldTrialBalance({
      config: {},
      accounts: [],
      rules: [],
      bills: [],
      ar: [],
      entries: [{ id: 'e1', date: '2026-01-01', memo: null, source: 'manual' }],
      lines: [
        { entry_id: 'e1', line_no: 0, account_code: '1000', debit_minor: 100, credit_minor: 0 },
        { entry_id: 'e1', line_no: 1, account_code: '3000', debit_minor: 0, credit_minor: 100 },
        { entry_id: 'ghost', line_no: 0, account_code: '6000', debit_minor: 7, credit_minor: 0 },
      ],
      txns: [
        { id: 't', date: '2026-01-02', description: 'x', amount_minor: -40, account_code: '6000', status: 'coded', notes: null },
        { id: 'm', date: '2026-01-02', description: 'x', amount_minor: -40, account_code: '6000', status: 'matched', notes: null },
      ],
    });
    expect(tb).toEqual([
      { code: '1000', debit_minor: 60, credit_minor: 0 },
      { code: '3000', debit_minor: 0, credit_minor: 100 },
      { code: '6000', debit_minor: 40, credit_minor: 0 },
    ]);
  });
});
