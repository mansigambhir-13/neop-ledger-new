// Day-to-day bookkeeping abilities. Reads answer from the books with sources;
// writes (ask-first unless purely internal staging) validate against the books
// before anyone is asked, post exactly once keyed on the proposal, and prove
// themselves by reading back.

import type { ExecCtx, ReadAbility, ReadCtx, WriteAbility } from '@neop/template';
import { DoorError } from '@neop/template';
import type { PoolClient } from '@neop/pgkit';
import * as B from '../data/books.repo.ts';
import { accountTotals, openDocuments } from '../data/ledger.repo.ts';
import { ACCT, bankLineEntry, billEntry, invoiceEntry, reverse, settlementEntry, suggest } from '../domain/bookkeeping.ts';
import { daysBetween, natural } from '../domain/reports.ts';
import { DEFAULT_CURRENCY } from './reads.ts';
import { sourceDocumentExists } from './documents.ts';
import { agedTo, chart, codesFromNames, companyToday, unknownAccount, unknownDocument, unknownParty } from '../domain/names.ts';

const S = 'ledger';
const head = (entries: number, ids: string[], basis: string, currency = DEFAULT_CURRENCY) => ({
  generatedAt: new Date().toISOString(),
  currency,
  empty: entries === 0,
  sources: { entries, entry_ids: ids.slice(0, 50), basis },
});
const rupees = (m: number) => (m / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const definite = (msg: string) => new DoorError(msg, { definite: true });

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

// ── reads ─────────────────────────────────────────────────────────────────

export const accountsList: ReadAbility = declared('read_accounts_list');

export const accountLedger: ReadAbility = declared('read_account_ledger');

export const journalList: ReadAbility = declared('read_journal_list');

export const documentsList: ReadAbility = declared('read_documents_list');

export const partiesList: ReadAbility = declared('read_parties_list');

export const bankUnreconciled: ReadAbility = declared('read_bank_unreconciled');

export const codingRulesList: ReadAbility = declared('read_coding_rules_list');

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
const monthEnd = (m: string) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
};

/** Home: the four figures a bookkeeper looks at first, each computed here (not in a screen). */
export const homeSummary: ReadAbility = declared('read_home_summary');

/** The month-end close checklist: what blocks closing a month, worked out from the books. */
export const closeChecklist: ReadAbility = declared('read_close_checklist');

export const periodsStatus: ReadAbility = declared('read_periods_status');

// ── writes ────────────────────────────────────────────────────────────────

type Items = { description: string; amount_minor: number; account_code?: string }[];

export const invoiceCreate: WriteAbility = {
  kind: 'write',
  // A category named in words is the one income account whose name matches it; anything else is refused below.
  async normalize(a: { lines: Items }, ctx: ReadCtx) {
    if (!Array.isArray(a?.lines)) return a;
    const codes = await codesFromNames(ctx.db, a.lines.map((l) => l?.account_code), (x) => x.type === 'income');
    return { ...a, lines: a.lines.map((l, i) => (codes[i] ? { ...l, account_code: codes[i] } : l)) };
  },
  measure: (a: { lines: Items; gst_rate_bps: number; currency: string }) => ({ amount_minor: invoiceEntry(a.lines, a.gst_rate_bps).total, currency: a.currency }),
  async validate(a: { customer: string; issue_date: string; due_date: string; lines: Items }, ctx) {
    if (a.due_date < a.issue_date) return 'due date is before the issue date';
    if (!(await B.partyByName(ctx.db, 'customer', a.customer))) return unknownParty(ctx.db, 'customer', a.customer);
    const accts = await chart(ctx.db);
    for (const l of a.lines) {
      if (l.account_code && !accts.some((x) => x.code === l.account_code)) return unknownAccount(accts.filter((x) => x.type === 'income'), l.account_code, 'income account');
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
  async normalize(a: { lines: Items }, ctx: ReadCtx) {
    if (!Array.isArray(a?.lines)) return a;
    const codes = await codesFromNames(ctx.db, a.lines.map((l) => l?.account_code), (x) => ['expense', 'asset'].includes(x.type));
    return { ...a, lines: a.lines.map((l, i) => (codes[i] ? { ...l, account_code: codes[i] } : l)) };
  },
  measure: (a: { lines: Required<Items[number]>[]; gst_rate_bps: number; currency: string }) => ({ amount_minor: billEntry(a.lines, a.gst_rate_bps).total, currency: a.currency }),
  async validate(a: { vendor: string; number: string; issue_date: string; due_date: string; lines: Items; source_document?: string }, ctx) {
    if (a.due_date < a.issue_date) return 'due date is before the issue date';
    if (a.source_document && !(await sourceDocumentExists(ctx.db, a.source_document))) return `no attached file ${a.source_document.slice(0, 12)}… is kept for this company; cite the document_id of a file the person attached`;
    if (!(await B.partyByName(ctx.db, 'vendor', a.vendor))) return unknownParty(ctx.db, 'vendor', a.vendor);
    if (await B.documentByNumber(ctx.db, 'bill', a.number)) return `bill ${a.number} is already recorded`;
    const accts = await chart(ctx.db);
    for (const l of a.lines) {
      if (!accts.some((x) => x.code === l.account_code)) return unknownAccount(accts.filter((x) => ['expense', 'asset'].includes(x.type)), l.account_code!, 'expense or asset account');
      const acct = await B.accountByCode(ctx.db, l.account_code!);
      if (!acct || !['expense', 'asset'].includes(acct.type)) return `line "${l.description}": ${l.account_code} is not an expense or asset account`;
    }
    return lockedMsg(ctx.db, a.issue_date);
  },
  async execute(a: { vendor: string; number: string; issue_date: string; due_date: string; currency: string; gst_rate_bps: number; lines: Required<Items[number]>[]; source_document?: string }, ctx: ExecCtx) {
    return ctx.withDb(async (db) => {
      const existing = (await db.query(`select number from ${S}.documents where reference = $1`, [ctx.idempotencyKey])).rows[0];
      if (existing) return { external_ref: existing.number };
      const party = await B.partyByName(db, 'vendor', a.vendor);
      if (!party) throw definite(`no vendor ${a.vendor}`);
      const bill = billEntry(a.lines, a.gst_rate_bps);
      const entry = await B.postEntry(db, { company_id: ctx.company_id, date: a.issue_date, memo: `Bill ${a.number} from ${party.name}`, reference: ctx.idempotencyKey, currency: a.currency, source: 'assistant', job_id: ctx.job_id, lines: bill.lines });
      await db.query(
        `insert into ${S}.documents (company_id, kind, party_id, number, issue_date, due_date, currency, net_minor, tax_minor, total_minor, entry_id, description, reference, source_document)
         values ($1, 'bill', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [ctx.company_id, party.id, a.number, a.issue_date, a.due_date, a.currency, bill.net, bill.tax, bill.total, entry.id, a.lines.map((l) => l.description).join('; '), ctx.idempotencyKey, a.source_document ?? null],
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
    if (!d) return unknownDocument(ctx.db, a.kind, a.document_number);
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
    if (!d) return unknownDocument(ctx.db, 'invoice', a.document_number);
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
    if (!d) return unknownDocument(ctx.db, 'invoice', a.document_number);
    if (d.status !== 'open') return `${a.document_number} is ${d.status}; nothing to chase`;
    // Overdue by the company's today: an invoice due today is not overdue yet.
    if (d.due >= companyToday(ctx)) return `${a.document_number} is not overdue (due ${d.due})`;
    if (!recipients(a, d).length) return `${d.party} has no email on file; say who to send it to`;
    return null;
  },
  async execute(a: SendArgs, ctx: ExecCtx) {
    const d = await ctx.withDb((db) => B.documentByNumber(db, 'invoice', a.document_number));
    if (!d) throw definite(`no invoice ${a.document_number}`);
    const days = daysBetween(d.due, companyToday(ctx));
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
  async normalize(a: CatArgs, ctx: ReadCtx) {
    if (!a?.account_code) return a;
    const [code] = await codesFromNames(ctx.db, [a.account_code], (x) => !['bank', 'cash', 'receivable', 'payable'].includes(x.subtype));
    return { ...a, account_code: code };
  },
  async measure(a: CatArgs, db?: PoolClient) {
    const t = db ? await B.bankTxn(db, a.bank_transaction_id) : null;
    return t ? { amount_minor: Math.abs(Number(t.amount_minor)), currency: t.currency } : {};
  },
  async validate(a: CatArgs, ctx) {
    const t = await B.bankTxn(ctx.db, a.bank_transaction_id);
    if (!t) return 'no such bank line';
    if (t.status !== 'unmatched') return 'that bank line is already matched';
    const acct = await B.accountByCode(ctx.db, a.account_code);
    if (!acct) return unknownAccount(await chart(ctx.db), a.account_code);
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
    return (await B.accountByCode(ctx.db, a.account_code)) ? null : unknownAccount(await chart(ctx.db), a.account_code);
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

// ledger.account.create lives in inherited.ts (1.1: Ledger may pick the code and subtype).

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
