// Day-to-day bookkeeping abilities. Reads answer from the books with sources;
// writes (ask-first unless purely internal staging) validate against the books
// before anyone is asked, post exactly once keyed on the proposal, and prove
// themselves by reading back.

import type { ExecCtx, ReadAbility, ReadCtx, WriteAbility } from '@neop/template';
import { DoorError } from '@neop/template';
import type { PoolClient } from '@neop/pgkit';
import * as B from '../data/books.repo.ts';
import { accountTotals } from '../data/ledger.repo.ts';
import { ACCT, bankLineEntry, billEntry, invoiceEntry, reverse, settlementEntry, suggest } from '../domain/bookkeeping.ts';
import { daysBetween, natural } from '../domain/reports.ts';
import { DEFAULT_CURRENCY } from './reads.ts';

const S = 'ledger';
const today = () => new Date().toISOString().slice(0, 10);
const head = (entries: number, ids: string[], basis: string, currency = DEFAULT_CURRENCY) => ({
  generatedAt: new Date().toISOString(),
  currency,
  empty: entries === 0,
  sources: { entries, entry_ids: ids.slice(0, 50), basis },
});
const rupees = (m: number) => (m / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const definite = (msg: string) => new DoorError(msg, { definite: true });

async function lockedMsg(db: PoolClient, date: string): Promise<string | null> {
  return (await B.isLocked(db, date)) ? `${date.slice(0, 7)} is closed; post into an open month or reopen it first` : null;
}

// ── reads ─────────────────────────────────────────────────────────────────

export const accountsList: ReadAbility = {
  kind: 'read',
  async run(a: { as_of?: string; type?: string; include_inactive?: boolean }, ctx: ReadCtx) {
    const asOf = a.as_of ?? today();
    const rows = (await accountTotals(ctx.db, { from: null, to: asOf, currency: DEFAULT_CURRENCY })).filter((x) => !a.type || x.type === a.type);
    const active = new Map((await ctx.db.query<{ code: string; is_active: boolean }>(`select code, is_active from ${S}.accounts`)).rows.map((r) => [r.code, r.is_active]));
    const accounts = rows
      .filter((x) => a.include_inactive || active.get(x.code) !== false)
      .map((x) => ({ code: x.code, name: x.name, type: x.type, subtype: x.subtype, balance_minor: natural(x), active: active.get(x.code) !== false }));
    return { ...head(accounts.length, [], `chart of accounts with balances as of ${asOf}`), as_of: asOf, accounts };
  },
};

export const accountLedger: ReadAbility = {
  kind: 'read',
  async run(a: { account_code: string; from: string; to: string }, ctx: ReadCtx) {
    const acct = await B.accountByCode(ctx.db, a.account_code);
    if (!acct) return { ...head(0, [], `no account ${a.account_code}`), account_code: a.account_code, account_name: null, opening_minor: null, closing_minor: null, rows: [] };
    const sign = acct.type === 'asset' || acct.type === 'expense' ? 1 : -1;
    const open = (
      await ctx.db.query<{ b: number }>(
        `select coalesce(sum(l.debit_minor - l.credit_minor), 0)::bigint as b from ${S}.journal_lines l join ${S}.journal_entries e on e.id = l.entry_id
          where l.account_id = $1 and e.entry_date < $2`,
        [acct.id, a.from],
      )
    ).rows[0]!.b * sign;
    const lines = (
      await ctx.db.query<{ entry_id: string; date: string; memo: string; reference: string; debit_minor: number; credit_minor: number }>(
        `select e.id as entry_id, to_char(e.entry_date, 'YYYY-MM-DD') as date, e.memo, e.reference, l.debit_minor, l.credit_minor
           from ${S}.journal_lines l join ${S}.journal_entries e on e.id = l.entry_id
          where l.account_id = $1 and e.entry_date between $2 and $3 order by e.entry_date, e.created_at, l.id`,
        [acct.id, a.from, a.to],
      )
    ).rows;
    let bal = open;
    const rows = lines.map((l) => {
      bal += (l.debit_minor - l.credit_minor) * sign;
      return { ...l, balance_minor: bal };
    });
    return {
      ...head(rows.length, rows.map((r) => r.entry_id), `lines on ${a.account_code} ${a.from}..${a.to}`),
      account_code: acct.code,
      account_name: acct.name,
      opening_minor: open,
      closing_minor: bal,
      rows,
    };
  },
};

export const journalList: ReadAbility = {
  kind: 'read',
  async run(a: { from: string; to: string; search?: string; limit?: number }, ctx: ReadCtx) {
    const entries = (
      await ctx.db.query(
        `select e.id, to_char(e.entry_date, 'YYYY-MM-DD') as date, e.memo, e.reference, e.source, e.reverses,
                coalesce(json_agg(json_build_object('account_code', a.code, 'account_name', a.name, 'debit_minor', l.debit_minor, 'credit_minor', l.credit_minor) order by l.id), '[]') as lines
           from ${S}.journal_entries e join ${S}.journal_lines l on l.entry_id = e.id join ${S}.accounts a on a.id = l.account_id
          where e.entry_date between $1 and $2 and ($3::text is null or e.memo ilike '%' || $3 || '%' or e.reference ilike '%' || $3 || '%')
          group by e.id order by e.entry_date, e.created_at limit $4`,
        [a.from, a.to, a.search ?? null, Math.min(a.limit ?? 100, 200)],
      )
    ).rows;
    return { ...head(entries.length, entries.map((e) => e.id), `journal entries ${a.from}..${a.to}${a.search ? ` matching "${a.search}"` : ''}`), entries };
  },
};

export const documentsList: ReadAbility = {
  kind: 'read',
  async run(a: { kind: 'invoice' | 'bill'; status?: 'open' | 'overdue' | 'paid' | 'all'; party?: string; as_of?: string }, ctx: ReadCtx) {
    const asOf = a.as_of ?? today();
    const rows = (
      await ctx.db.query(
        `select d.id, d.number, p.name as party, to_char(d.issue_date, 'YYYY-MM-DD') as issue_date, to_char(d.due_date, 'YYYY-MM-DD') as due_date,
                d.currency, d.total_minor, d.paid_minor, (d.total_minor - d.paid_minor)::bigint as outstanding_minor, d.status, d.sent_at, d.reminded_at
           from ${S}.documents d join ${S}.parties p on p.id = d.party_id
          where d.kind = $1 and ($2::text is null or p.name ilike '%' || $2 || '%') order by d.due_date`,
        [a.kind, a.party ?? null],
      )
    ).rows
      .map((d) => ({ ...d, overdue_days: d.status === 'open' ? Math.max(0, daysBetween(d.due_date, asOf)) : 0, sent_at: d.sent_at?.toISOString?.() ?? null, reminded_at: d.reminded_at?.toISOString?.() ?? null }))
      .filter((d) => {
        const st = a.status ?? 'open';
        if (st === 'all') return true;
        if (st === 'overdue') return d.status === 'open' && d.overdue_days > 0;
        return d.status === st;
      });
    return { ...head(rows.length, rows.map((d) => d.id), `${a.kind}s (${a.status ?? 'open'}) as of ${asOf}`), kind: a.kind, as_of: asOf, documents: rows };
  },
};

export const partiesList: ReadAbility = {
  kind: 'read',
  async run(a: { kind?: 'customer' | 'vendor' }, ctx: ReadCtx) {
    const rows = (
      await ctx.db.query(
        `select p.id, p.kind, p.name, p.email, p.gstin,
                coalesce(sum(d.total_minor - d.paid_minor) filter (where d.status = 'open'), 0)::bigint as outstanding_minor,
                count(d.id) filter (where d.status = 'open')::int as open_documents
           from ${S}.parties p left join ${S}.documents d on d.party_id = p.id
          where ($1::text is null or p.kind = $1) group by p.id order by p.name`,
        [a.kind ?? null],
      )
    ).rows;
    return { ...head(rows.length, rows.map((r) => r.id), `${a.kind ?? 'all'} parties with open balances`), parties: rows };
  },
};

export const bankUnreconciled: ReadAbility = {
  kind: 'read',
  async run(a: { bank_account_code?: string }, ctx: ReadCtx) {
    const txns = (
      await ctx.db.query(
        `select t.id, to_char(t.txn_date, 'YYYY-MM-DD') as date, t.description, t.amount_minor, t.currency, a.code as bank_account_code
           from ${S}.bank_transactions t join ${S}.accounts a on a.id = t.bank_account_id
          where t.status = 'unmatched' and ($1::text is null or a.code = $1) order by t.txn_date`,
        [a.bank_account_code ?? null],
      )
    ).rows;
    const rs = await B.rules(ctx.db);
    const docs = await B.openDocumentsForMatch(ctx.db);
    const out = txns.map((t) => ({ ...t, suggestions: suggest(t, rs, docs) }));
    return { ...head(out.length, out.map((t) => t.id), 'imported bank lines not yet matched to the books'), transactions: out };
  },
};

export const codingRulesList: ReadAbility = {
  kind: 'read',
  async run(_a: unknown, ctx: ReadCtx) {
    const rows = (
      await ctx.db.query(
        `select r.id, r.reference, r.pattern, a.code as account_code, a.name as account_name, r.direction, r.priority, r.created_at,
                (select count(*)::int from ${S}.bank_transactions t
                  where t.status <> 'unmatched' and t.description ilike '%' || r.pattern || '%') as matched
           from ${S}.coding_rules r join ${S}.accounts a on a.id = r.account_id
          order by r.priority, r.created_at`,
      )
    ).rows;
    return {
      ...head(rows.length, rows.map((r) => r.id), 'coding rules, in the order they are tried'),
      rules: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
    };
  },
};

export const periodsStatus: ReadAbility = {
  kind: 'read',
  async run(_a: unknown, ctx: ReadCtx) {
    const locks = (await ctx.db.query(`select to_char(month, 'YYYY-MM') as month, locked_at, locked_by, reason from ${S}.period_locks order by month`)).rows;
    const open = (
      await ctx.db.query(`select to_char(date_trunc('month', txn_date), 'YYYY-MM') as month, count(*)::int as n from ${S}.bank_transactions where status = 'unmatched' group by 1 order by 1`)
    ).rows;
    return {
      ...head(locks.length, [], 'period locks and unreconciled bank lines by month'),
      closed: locks.map((l) => ({ month: l.month, locked_at: l.locked_at.toISOString(), locked_by: l.locked_by, reason: l.reason })),
      unreconciled_by_month: open,
    };
  },
};

// ── writes ────────────────────────────────────────────────────────────────

type Items = { description: string; amount_minor: number; account_code?: string }[];

export const invoiceCreate: WriteAbility = {
  kind: 'write',
  measure: (a: { lines: Items; gst_rate_bps: number; currency: string }) => ({ amount_minor: invoiceEntry(a.lines, a.gst_rate_bps).total, currency: a.currency }),
  async validate(a: { customer: string; issue_date: string; due_date: string; lines: Items }, ctx) {
    if (a.due_date < a.issue_date) return 'due date is before the issue date';
    if (!(await B.partyByName(ctx.db, 'customer', a.customer))) return `no customer called "${a.customer}"; create them with ledger.party.create first`;
    for (const l of a.lines) {
      const acct = l.account_code ? await B.accountByCode(ctx.db, l.account_code) : { type: 'income' };
      if (!acct || acct.type !== 'income') return `line "${l.description}": ${l.account_code} is not an income account`;
    }
    return lockedMsg(ctx.db, a.issue_date);
  },
  async execute(a: { customer: string; issue_date: string; due_date: string; currency: string; gst_rate_bps: number; lines: Items; description?: string }, ctx: ExecCtx) {
    return ctx.withDb(async (db) => {
      const existing = (await db.query(`select id, number from ${S}.documents where reference = $1`, [ctx.idempotencyKey])).rows[0];
      if (existing) return { external_ref: existing.number };
      const party = await B.partyByName(db, 'customer', a.customer);
      if (!party) throw definite(`no customer ${a.customer}`);
      const inv = invoiceEntry(a.lines, a.gst_rate_bps);
      const number = await B.nextInvoiceNumber(db, ctx.company_id);
      const entry = await B.postEntry(db, { company_id: ctx.company_id, date: a.issue_date, memo: `Invoice ${number} to ${party.name}`, reference: ctx.idempotencyKey, currency: a.currency, source: 'assistant', job_id: ctx.job_id, lines: inv.lines });
      await db.query(
        `insert into ${S}.documents (company_id, kind, party_id, number, issue_date, due_date, currency, net_minor, tax_minor, total_minor, entry_id, description, reference)
         values ($1, 'invoice', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [ctx.company_id, party.id, number, a.issue_date, a.due_date, a.currency, inv.net, inv.tax, inv.total, entry.id, a.description ?? a.lines.map((l) => l.description).join('; '), ctx.idempotencyKey],
      );
      return { external_ref: number };
    });
  },
  async readBack(_a, ctx: ExecCtx) {
    const d = await ctx.withDb(async (db) => (await db.query(`select number, total_minor, entry_id from ${S}.documents where reference = $1`, [ctx.idempotencyKey])).rows[0]);
    return { found: !!d?.entry_id, data: d ?? null };
  },
};

export const billRecord: WriteAbility = {
  kind: 'write',
  measure: (a: { lines: Required<Items[number]>[]; gst_rate_bps: number; currency: string }) => ({ amount_minor: billEntry(a.lines, a.gst_rate_bps).total, currency: a.currency }),
  async validate(a: { vendor: string; number: string; issue_date: string; due_date: string; lines: Items }, ctx) {
    if (a.due_date < a.issue_date) return 'due date is before the issue date';
    if (!(await B.partyByName(ctx.db, 'vendor', a.vendor))) return `no vendor called "${a.vendor}"; create them with ledger.party.create first`;
    if (await B.documentByNumber(ctx.db, 'bill', a.number)) return `bill ${a.number} is already recorded`;
    for (const l of a.lines) {
      const acct = await B.accountByCode(ctx.db, l.account_code!);
      if (!acct || !['expense', 'asset'].includes(acct.type)) return `line "${l.description}": ${l.account_code} is not an expense or asset account`;
    }
    return lockedMsg(ctx.db, a.issue_date);
  },
  async execute(a: { vendor: string; number: string; issue_date: string; due_date: string; currency: string; gst_rate_bps: number; lines: Required<Items[number]>[] }, ctx: ExecCtx) {
    return ctx.withDb(async (db) => {
      const existing = (await db.query(`select number from ${S}.documents where reference = $1`, [ctx.idempotencyKey])).rows[0];
      if (existing) return { external_ref: existing.number };
      const party = await B.partyByName(db, 'vendor', a.vendor);
      if (!party) throw definite(`no vendor ${a.vendor}`);
      const bill = billEntry(a.lines, a.gst_rate_bps);
      const entry = await B.postEntry(db, { company_id: ctx.company_id, date: a.issue_date, memo: `Bill ${a.number} from ${party.name}`, reference: ctx.idempotencyKey, currency: a.currency, source: 'assistant', job_id: ctx.job_id, lines: bill.lines });
      await db.query(
        `insert into ${S}.documents (company_id, kind, party_id, number, issue_date, due_date, currency, net_minor, tax_minor, total_minor, entry_id, description, reference)
         values ($1, 'bill', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [ctx.company_id, party.id, a.number, a.issue_date, a.due_date, a.currency, bill.net, bill.tax, bill.total, entry.id, a.lines.map((l) => l.description).join('; '), ctx.idempotencyKey],
      );
      return { external_ref: a.number };
    });
  },
  async readBack(_a, ctx: ExecCtx) {
    const d = await ctx.withDb(async (db) => (await db.query(`select number, total_minor from ${S}.documents where reference = $1`, [ctx.idempotencyKey])).rows[0]);
    return { found: !!d, data: d ?? null };
  },
};

type PayArgs = { kind: 'invoice' | 'bill'; document_number: string; date: string; amount_minor: number; bank_account_code?: string; bank_transaction_id?: string };

export const paymentRecord: WriteAbility = {
  kind: 'write',
  async measure(a: PayArgs, db?: PoolClient) {
    const d = db ? await B.documentByNumber(db, a.kind, a.document_number) : null;
    return { amount_minor: a.amount_minor, currency: d?.currency ?? DEFAULT_CURRENCY };
  },
  async validate(a: PayArgs, ctx) {
    const d = await B.documentByNumber(ctx.db, a.kind, a.document_number);
    if (!d) return `no ${a.kind} ${a.document_number}`;
    if (d.status !== 'open') return `${a.kind} ${a.document_number} is ${d.status}`;
    if (a.amount_minor > d.total_minor - d.paid_minor) return `₹${rupees(a.amount_minor)} is more than the ₹${rupees(d.total_minor - d.paid_minor)} outstanding on ${a.document_number}`;
    const bank = await B.accountByCode(ctx.db, a.bank_account_code ?? ACCT.bank);
    if (!bank || !['bank', 'cash'].includes(bank.subtype)) return `${a.bank_account_code} is not a bank or cash account`;
    if (a.bank_transaction_id) {
      const t = await B.bankTxn(ctx.db, a.bank_transaction_id);
      if (!t) return 'no such bank line';
      if (t.status !== 'unmatched') return 'that bank line is already matched';
      const signed = a.kind === 'invoice' ? a.amount_minor : -a.amount_minor;
      if (Number(t.amount_minor) !== signed) return `the bank line is ₹${rupees(Number(t.amount_minor))}, not ${signed > 0 ? '' : '-'}₹${rupees(a.amount_minor)}`;
      if (t.bank_code !== bank.code) return `the bank line is on ${t.bank_code}, not ${bank.code}`;
    }
    return lockedMsg(ctx.db, a.date);
  },
  async execute(a: PayArgs, ctx: ExecCtx) {
    return ctx.withDb(async (db) => {
      const done = (await db.query(`select id from ${S}.payments where reference = $1`, [ctx.idempotencyKey])).rows[0];
      if (done) return { external_ref: done.id };
      const d = await B.documentByNumber(db, a.kind, a.document_number);
      if (!d || d.status !== 'open' || a.amount_minor > d.total_minor - d.paid_minor) throw definite(`${a.document_number} cannot take this payment any more`);
      const bankCode = a.bank_account_code ?? ACCT.bank;
      const bank = (await B.accountByCode(db, bankCode))!;
      if (a.bank_transaction_id) {
        // H3: the line must still be unmatched now, not just when this was proposed.
        const line = await db.query(`select status from ${S}.bank_transactions where id = $1 for update`, [a.bank_transaction_id]);
        if (line.rows[0]?.status !== 'unmatched') throw definite('that bank line was matched by something else after this was approved; nothing was posted');
      }
      const entry = await B.postEntry(db, {
        company_id: ctx.company_id,
        date: a.date,
        memo: `${a.kind === 'invoice' ? 'Receipt from' : 'Payment to'} ${d.party} for ${d.number}`,
        reference: ctx.idempotencyKey,
        currency: d.currency,
        source: 'assistant',
        job_id: ctx.job_id,
        lines: settlementEntry(a.kind, a.amount_minor, bankCode),
      });
      const p = await db.query<{ id: string }>(
        `insert into ${S}.payments (company_id, document_id, kind, pay_date, amount_minor, currency, bank_account_id, reference, entry_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [ctx.company_id, d.id, a.kind === 'invoice' ? 'receipt' : 'payment', a.date, a.amount_minor, d.currency, bank.id, ctx.idempotencyKey, entry.id],
      );
      await db.query(
        `update ${S}.documents set paid_minor = paid_minor + $2, status = case when paid_minor + $2 >= total_minor then 'paid' else 'open' end where id = $1`,
        [d.id, a.amount_minor],
      );
      if (a.bank_transaction_id) {
        const u = await db.query(`update ${S}.bank_transactions set status = 'matched', matched_entry_id = $2, matched_document_id = $3 where id = $1 and status = 'unmatched'`, [
          a.bank_transaction_id,
          entry.id,
          d.id,
        ]);
        if (!u.rowCount) throw definite('that bank line was matched concurrently; nothing was posted');
      }
      return { external_ref: p.rows[0]!.id };
    });
  },
  async readBack(_a, ctx: ExecCtx) {
    const p = await ctx.withDb(async (db) => (await db.query(`select id, amount_minor, entry_id from ${S}.payments where reference = $1`, [ctx.idempotencyKey])).rows[0]);
    return { found: !!p, data: p ?? null };
  },
};

function invoiceText(d: any, from: string, note?: string): string {
  return [
    `Invoice ${d.number} from ${from}`,
    note ? `\n${note}\n` : '',
    `Billed to: ${d.party}`,
    `Issued: ${d.issue} · Due: ${d.due}`,
    `Net: ₹${rupees(d.net_minor)} · GST: ₹${rupees(d.tax_minor)} · Total: ₹${rupees(d.total_minor)}`,
    d.paid_minor ? `Paid so far: ₹${rupees(d.paid_minor)} · Outstanding: ₹${rupees(d.total_minor - d.paid_minor)}` : '',
    d.description ? `\n${d.description}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

type SendArgs = { document_number: string; to?: string[]; note?: string };
const recipients = (a: SendArgs, d: any) => (a.to?.length ? a.to : d?.party_email ? [d.party_email] : []);
/** At execution only what was approved: the fingerprinted recipients. */
const approvedRecipients = (a: SendArgs) => a.to ?? [];

/** H2: the effective recipients are decided before proposing, so the card, fingerprint and rules all see them. */
async function withRecipients(a: SendArgs, ctx: ReadCtx): Promise<SendArgs> {
  if (a.to?.length) return a;
  const d = await B.documentByNumber(ctx.db, 'invoice', a.document_number);
  return d?.party_email ? { ...a, to: [d.party_email] } : a;
}

export const invoiceSend: WriteAbility = {
  kind: 'write',
  normalize: withRecipients,
  measure: (a: SendArgs) => ({ recipients: a.to ?? [] }),
  async validate(a: SendArgs, ctx) {
    const d = await B.documentByNumber(ctx.db, 'invoice', a.document_number);
    if (!d) return `no invoice ${a.document_number}`;
    if (d.status === 'void') return `${a.document_number} is void`;
    if (!recipients(a, d).length) return `${d.party} has no email on file; say who to send it to`;
    return null;
  },
  async execute(a: SendArgs, ctx: ExecCtx) {
    const d = await ctx.withDb((db) => B.documentByNumber(db, 'invoice', a.document_number));
    if (!d) throw definite(`no invoice ${a.document_number}`);
    const sent = await ctx.doors.email.send({ to: approvedRecipients(a), subject: `Invoice ${d.number} · ₹${rupees(d.total_minor)} due ${d.due}`, text: invoiceText(d, ctx.company_name, a.note) }, ctx.idempotencyKey);
    await ctx.withDb((db) => db.query(`update ${S}.documents set sent_at = coalesce(sent_at, now()) where id = $1`, [d.id]));
    return { external_ref: sent.id };
  },
  async readBack(_a, ctx: ExecCtx) {
    const m = await ctx.doors.email.lookup(ctx.idempotencyKey);
    return { found: !!m, data: m && { id: m.id, to: m.to, subject: m.subject } };
  },
};

export const reminderSend: WriteAbility = {
  kind: 'write',
  normalize: withRecipients,
  measure: (a: SendArgs) => ({ recipients: a.to ?? [] }),
  async validate(a: SendArgs, ctx) {
    const d = await B.documentByNumber(ctx.db, 'invoice', a.document_number);
    if (!d) return `no invoice ${a.document_number}`;
    if (d.status !== 'open') return `${a.document_number} is ${d.status}; nothing to chase`;
    if (d.due >= today()) return `${a.document_number} is not overdue (due ${d.due})`;
    if (!recipients(a, d).length) return `${d.party} has no email on file; say who to send it to`;
    return null;
  },
  async execute(a: SendArgs, ctx: ExecCtx) {
    const d = await ctx.withDb((db) => B.documentByNumber(db, 'invoice', a.document_number));
    if (!d) throw definite(`no invoice ${a.document_number}`);
    const days = daysBetween(d.due, today());
    const sent = await ctx.doors.email.send(
      { to: approvedRecipients(a), subject: `Reminder: invoice ${d.number} is ${days} days overdue`, text: `A friendly reminder that invoice ${d.number} was due on ${d.due}.\n\n${invoiceText(d, ctx.company_name, a.note)}` },
      ctx.idempotencyKey,
    );
    await ctx.withDb((db) => db.query(`update ${S}.documents set reminded_at = now() where id = $1`, [d.id]));
    return { external_ref: sent.id };
  },
  async readBack(_a, ctx: ExecCtx) {
    const m = await ctx.doors.email.lookup(ctx.idempotencyKey);
    return { found: !!m, data: m && { id: m.id, to: m.to, subject: m.subject } };
  },
};

type ImportArgs = { bank_account_code: string; currency: string; lines: { external_id: string; date: string; description: string; amount_minor: number }[] };

/** Staging only: imported lines change nothing in the books until matched. Floor on. */
export const bankImport: WriteAbility = {
  kind: 'write',
  check: (a: ImportArgs) => (a.lines.some((l) => l.amount_minor === 0) ? 'a bank line cannot be zero' : null),
  async validate(a: ImportArgs, ctx) {
    const acct = await B.accountByCode(ctx.db, a.bank_account_code);
    return acct && ['bank', 'cash'].includes(acct.subtype) ? null : `${a.bank_account_code} is not a bank or cash account`;
  },
  async execute(a: ImportArgs, ctx: ExecCtx) {
    return ctx.withDb(async (db) => {
      const acct = (await B.accountByCode(db, a.bank_account_code))!;
      let added = 0;
      for (const l of a.lines) {
        const r = await db.query(
          `insert into ${S}.bank_transactions (company_id, bank_account_id, external_id, txn_date, description, amount_minor, currency, import_ref)
           values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (company_id, bank_account_id, external_id) do nothing`,
          [ctx.company_id, acct.id, l.external_id, l.date, l.description, l.amount_minor, a.currency, ctx.idempotencyKey],
        );
        added += r.rowCount ?? 0;
      }
      return { external_ref: `${added} of ${a.lines.length} lines new`, detail: { added } };
    });
  },
  async readBack(a: ImportArgs, ctx: ExecCtx) {
    const n = await ctx.withDb(async (db) => {
      const acct = await B.accountByCode(db, a.bank_account_code);
      return (await db.query<{ n: number }>(`select count(*)::int as n from ${S}.bank_transactions where bank_account_id = $1 and external_id = any($2)`, [acct?.id, a.lines.map((l) => l.external_id)])).rows[0]!.n;
    });
    return { found: n === a.lines.length, data: { present: n, of: a.lines.length } };
  },
};

type CatArgs = { bank_transaction_id: string; account_code: string; memo?: string };

export const bankCategorize: WriteAbility = {
  kind: 'write',
  async measure(a: CatArgs, db?: PoolClient) {
    const t = db ? await B.bankTxn(db, a.bank_transaction_id) : null;
    return t ? { amount_minor: Math.abs(Number(t.amount_minor)), currency: t.currency } : {};
  },
  async validate(a: CatArgs, ctx) {
    const t = await B.bankTxn(ctx.db, a.bank_transaction_id);
    if (!t) return 'no such bank line';
    if (t.status !== 'unmatched') return 'that bank line is already matched';
    const acct = await B.accountByCode(ctx.db, a.account_code);
    if (!acct) return `no account ${a.account_code}`;
    if (['bank', 'cash', 'receivable', 'payable'].includes(acct.subtype)) return `code customer and supplier money with ledger.payment.record, not to ${a.account_code}`;
    return lockedMsg(ctx.db, t.date);
  },
  async execute(a: CatArgs, ctx: ExecCtx) {
    return ctx.withDb(async (db) => {
      await db.query(`select 1 from ${S}.bank_transactions where id = $1 for update`, [a.bank_transaction_id]);
      const t = await B.bankTxn(db, a.bank_transaction_id);
      if (!t) throw definite('no such bank line');
      const mine = (await db.query(`select id from ${S}.journal_entries where reference = $1`, [ctx.idempotencyKey])).rows[0];
      if (t.status === 'matched') {
        if (mine && t.matched_entry_id === mine.id) return { external_ref: mine.id }; // our own earlier attempt
        throw definite('that bank line was matched by something else after this was approved; nothing was posted');
      }
      const entry = await B.postEntry(db, {
        company_id: ctx.company_id,
        date: t.date,
        memo: a.memo ?? t.description,
        reference: ctx.idempotencyKey,
        currency: t.currency,
        source: 'assistant',
        job_id: ctx.job_id,
        lines: bankLineEntry(Number(t.amount_minor), t.bank_code, a.account_code),
      });
      const u = await db.query(`update ${S}.bank_transactions set status = 'matched', matched_entry_id = $2 where id = $1 and status = 'unmatched'`, [t.id, entry.id]);
      if (!u.rowCount) throw definite('that bank line was matched concurrently; nothing was posted');
      return { external_ref: entry.id };
    });
  },
  async readBack(a: CatArgs, ctx: ExecCtx) {
    const t = await ctx.withDb((db) => B.bankTxn(db, a.bank_transaction_id));
    return { found: t?.status === 'matched', data: t && { status: t.status, entry: t.matched_entry_id } };
  },
};

type RuleArgs = { pattern: string; account_code: string; direction?: 'in' | 'out' | 'any'; priority?: number };

/** Suggestions only (never posts). Floor on. */
export const codingRuleAdd: WriteAbility = {
  kind: 'write',
  async validate(a: RuleArgs, ctx) {
    return (await B.accountByCode(ctx.db, a.account_code)) ? null : `no account ${a.account_code}`;
  },
  async execute(a: RuleArgs, ctx: ExecCtx) {
    return ctx.withDb(async (db) => {
      const acct = (await B.accountByCode(db, a.account_code))!;
      const r = await db.query<{ id: string }>(
        `insert into ${S}.coding_rules (company_id, pattern, account_id, direction, priority, reference) values ($1,$2,$3,$4,$5,$6)
         on conflict (company_id, reference) do update set pattern = excluded.pattern returning id`,
        [ctx.company_id, a.pattern, acct.id, a.direction ?? 'any', a.priority ?? 100, ctx.idempotencyKey],
      );
      return { external_ref: r.rows[0]!.id };
    });
  },
  async readBack(_a, ctx: ExecCtx) {
    const r = await ctx.withDb(async (db) => (await db.query(`select id, pattern from ${S}.coding_rules where reference = $1`, [ctx.idempotencyKey])).rows[0]);
    return { found: !!r, data: r ?? null };
  },
};

type RevArgs = { entry: string; date: string; memo?: string };

export const entryReverse: WriteAbility = {
  kind: 'write',
  async measure(a: RevArgs, db?: PoolClient) {
    const e = db ? await B.entryByIdOrRef(db, a.entry) : null;
    if (!e) return {};
    const lines = await B.entryLines(db!, e.id);
    return { amount_minor: lines.reduce((s, l) => s + l.debit_minor, 0), currency: e.currency };
  },
  async validate(a: RevArgs, ctx) {
    const e = await B.entryByIdOrRef(ctx.db, a.entry);
    if (!e) return `no journal entry ${a.entry}`;
    if (e.reversed_by) return `entry ${a.entry} is already reversed`;
    if (e.reverses) return `entry ${a.entry} is itself a reversal; post a new entry instead`;
    if (a.date < e.date) return `a reversal cannot be dated before the entry it reverses (${e.date})`;
    return lockedMsg(ctx.db, a.date);
  },
  async execute(a: RevArgs, ctx: ExecCtx) {
    return ctx.withDb(async (db) => {
      const e = await B.entryByIdOrRef(db, a.entry);
      if (!e) throw definite(`no journal entry ${a.entry}`);
      const r = await B.postEntry(db, {
        company_id: ctx.company_id,
        date: a.date,
        memo: a.memo ?? `Reversal of: ${e.memo}`,
        reference: ctx.idempotencyKey,
        currency: e.currency,
        source: 'assistant',
        job_id: ctx.job_id,
        lines: reverse(await B.entryLines(db, e.id)),
        reverses: e.id,
      });
      return { external_ref: r.id };
    });
  },
  async readBack(_a, ctx: ExecCtx) {
    const e = await ctx.withDb((db) => B.entryByIdOrRef(db, ctx.idempotencyKey));
    return { found: !!e?.reverses, data: e && { id: e.id, reverses: e.reverses } };
  },
};

type PeriodArgs = { month: string; reason?: string };

export const periodClose: WriteAbility = {
  kind: 'write',
  async validate(a: PeriodArgs, ctx) {
    if ((await ctx.db.query(`select 1 from ${S}.period_locks where month = $1::date`, [`${a.month}-01`])).rowCount) return `${a.month} is already closed`;
    const open = (
      await ctx.db.query<{ n: number }>(
        `select count(*)::int as n from ${S}.bank_transactions where status = 'unmatched' and txn_date >= $1::date and txn_date < ($1::date + interval '1 month')`,
        [`${a.month}-01`],
      )
    ).rows[0]!.n;
    return open ? `${open} bank line(s) in ${a.month} are not reconciled; match or categorise them before closing` : null;
  },
  async execute(a: PeriodArgs, ctx: ExecCtx) {
    return ctx.withDb(async (db) => {
      await db.query(`insert into ${S}.period_locks (company_id, month, locked_by, reason) values ($1, $2, $3, $4) on conflict do nothing`, [
        ctx.company_id,
        `${a.month}-01`,
        ctx.caller,
        a.reason ?? null,
      ]);
      return { external_ref: a.month };
    });
  },
  async readBack(a: PeriodArgs, ctx: ExecCtx) {
    const r = await ctx.withDb(async (db) => (await db.query(`select locked_by from ${S}.period_locks where month = $1::date`, [`${a.month}-01`])).rows[0]);
    return { found: !!r, data: r ?? null };
  },
};

export const periodReopen: WriteAbility = {
  kind: 'write',
  check: (a: PeriodArgs) => (a.reason?.trim() ? null : 'reopening a closed month needs a reason'),
  async validate(a: PeriodArgs, ctx) {
    return (await ctx.db.query(`select 1 from ${S}.period_locks where month = $1::date`, [`${a.month}-01`])).rowCount ? null : `${a.month} is not closed`;
  },
  async execute(a: PeriodArgs, ctx: ExecCtx) {
    await ctx.withDb((db) => db.query(`delete from ${S}.period_locks where month = $1::date`, [`${a.month}-01`]));
    return { external_ref: a.month };
  },
  async readBack(a: PeriodArgs, ctx: ExecCtx) {
    const r = await ctx.withDb(async (db) => (await db.query(`select 1 from ${S}.period_locks where month = $1::date`, [`${a.month}-01`])).rowCount);
    return { found: !r, data: { reopened: !r } };
  },
};

type AcctArgs = { code: string; name: string; type: 'asset' | 'liability' | 'equity' | 'income' | 'expense'; subtype: string };
const SUBTYPES: Record<AcctArgs['type'], string[]> = {
  asset: ['cash', 'bank', 'receivable', 'inventory', 'fixed_asset', 'tax_input', 'other_asset'],
  liability: ['payable', 'tax_output', 'loan', 'other_liability'],
  equity: ['equity', 'retained_earnings'],
  income: ['revenue', 'other_income'],
  expense: ['cogs', 'opex', 'other_expense'],
};

export const accountCreate: WriteAbility = {
  kind: 'write',
  check: (a: AcctArgs) => (SUBTYPES[a.type]?.includes(a.subtype) ? null : `a ${a.type} account's subtype is one of ${SUBTYPES[a.type]?.join(', ')}`),
  async validate(a: AcctArgs, ctx) {
    return (await B.accountByCode(ctx.db, a.code)) ? `account code ${a.code} is taken` : null;
  },
  async execute(a: AcctArgs, ctx: ExecCtx) {
    return ctx.withDb(async (db) => {
      const r = await db.query<{ id: string }>(
        `insert into ${S}.accounts (company_id, code, name, type, subtype) values ($1,$2,$3,$4,$5) on conflict (company_id, code) do nothing returning id`,
        [ctx.company_id, a.code, a.name, a.type, a.subtype],
      );
      return { external_ref: r.rows[0]?.id ?? a.code };
    });
  },
  async readBack(a: AcctArgs, ctx: ExecCtx) {
    const r = await ctx.withDb((db) => B.accountByCode(db, a.code));
    return { found: !!r && r.name === a.name, data: r };
  },
};

type PartyArgs = { kind: 'customer' | 'vendor'; name: string; email?: string; gstin?: string };

/** Master data inside the company. Floor on. */
export const partyCreate: WriteAbility = {
  kind: 'write',
  async validate(a: PartyArgs, ctx) {
    return (await B.partyByName(ctx.db, a.kind, a.name)) ? `a ${a.kind} called "${a.name}" already exists` : null;
  },
  async execute(a: PartyArgs, ctx: ExecCtx) {
    return ctx.withDb(async (db) => {
      const r = await db.query<{ id: string }>(
        `insert into ${S}.parties (company_id, kind, name, email, gstin, reference) values ($1,$2,$3,$4,$5,$6)
         on conflict (company_id, reference) where reference is not null do nothing returning id`,
        [ctx.company_id, a.kind, a.name, a.email ?? null, a.gstin ?? null, ctx.idempotencyKey],
      );
      return { external_ref: r.rows[0]?.id ?? null };
    });
  },
  async readBack(_a, ctx: ExecCtx) {
    const r = await ctx.withDb(async (db) => (await db.query(`select id, name from ${S}.parties where reference = $1`, [ctx.idempotencyKey])).rows[0]);
    return { found: !!r, data: r ?? null };
  },
};
