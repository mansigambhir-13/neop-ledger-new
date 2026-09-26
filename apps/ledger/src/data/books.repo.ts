// RECORD BOOK · SQL for day-to-day bookkeeping. Saves and loads; never decides.

import type { PoolClient } from '@neop/pgkit';
import type { EntryLine, OpenDocument, Rule } from '../domain/bookkeeping.ts';

const S = 'ledger';

export async function accountByCode(c: PoolClient, code: string) {
  return (await c.query<{ id: string; code: string; name: string; type: string; subtype: string; is_active: boolean }>(`select * from ${S}.accounts where code = $1`, [code])).rows[0] ?? null;
}

export async function isLocked(c: PoolClient, date: string): Promise<boolean> {
  const r = await c.query(`select 1 from ${S}.period_locks where month = date_trunc('month', $1::date)::date`, [date]);
  return (r.rowCount ?? 0) > 0;
}

/** Post one balanced entry with its lines; idempotent on reference. */
export async function postEntry(
  c: PoolClient,
  e: { company_id: string; date: string; memo: string; reference: string; currency: string; source: string; job_id: string | null; lines: EntryLine[]; reverses?: string | null },
): Promise<{ id: string; created: boolean }> {
  const codes = [...new Set(e.lines.map((l) => l.account_code))];
  const accts = new Map((await c.query<{ id: string; code: string }>(`select id, code from ${S}.accounts where code = any($1)`, [codes])).rows.map((r) => [r.code, r.id]));
  const missing = codes.filter((x) => !accts.has(x));
  if (missing.length) throw new Error(`unknown account codes: ${missing.join(', ')}`);
  const ins = await c.query<{ id: string }>(
    `insert into ${S}.journal_entries (company_id, entry_date, memo, reference, currency, source, job_id, reverses)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (company_id, reference) do nothing returning id`,
    [e.company_id, e.date, e.memo, e.reference, e.currency, e.source, e.job_id, e.reverses ?? null],
  );
  if (!ins.rows[0]) return { id: (await c.query<{ id: string }>(`select id from ${S}.journal_entries where reference = $1`, [e.reference])).rows[0]!.id, created: false };
  for (const l of e.lines) {
    await c.query(`insert into ${S}.journal_lines (company_id, entry_id, account_id, debit_minor, credit_minor) values ($1,$2,$3,$4,$5)`, [
      e.company_id,
      ins.rows[0].id,
      accts.get(l.account_code),
      l.debit_minor,
      l.credit_minor,
    ]);
  }
  return { id: ins.rows[0].id, created: true };
}

export async function entryLines(c: PoolClient, entryId: string): Promise<EntryLine[]> {
  return (
    await c.query<EntryLine>(
      `select a.code as account_code, l.debit_minor, l.credit_minor from ${S}.journal_lines l join ${S}.accounts a on a.id = l.account_id where l.entry_id = $1 order by l.id`,
      [entryId],
    )
  ).rows;
}

export async function entryByIdOrRef(c: PoolClient, idOrRef: string) {
  const uuid = /^[0-9a-f-]{36}$/i.test(idOrRef);
  return (
    await c.query(
      `select e.*, to_char(e.entry_date, 'YYYY-MM-DD') as date, (select id from ${S}.journal_entries r where r.reverses = e.id) as reversed_by
         from ${S}.journal_entries e where ${uuid ? 'e.id = $1::uuid' : 'e.reference = $1'}`,
      [idOrRef],
    )
  ).rows[0] ?? null;
}

export async function partyByName(c: PoolClient, kind: 'customer' | 'vendor', name: string) {
  return (await c.query<{ id: string; name: string; email: string | null }>(`select id, name, email from ${S}.parties where kind = $1 and lower(name) = lower($2)`, [kind, name])).rows[0] ?? null;
}

export async function documentByNumber(c: PoolClient, kind: 'invoice' | 'bill', number: string) {
  return (
    await c.query(
      `select d.*, to_char(d.issue_date, 'YYYY-MM-DD') as issue, to_char(d.due_date, 'YYYY-MM-DD') as due, p.name as party, p.email as party_email
         from ${S}.documents d join ${S}.parties p on p.id = d.party_id where d.kind = $1 and d.number = $2`,
      [kind, number],
    )
  ).rows[0] ?? null;
}

export async function nextInvoiceNumber(c: PoolClient, companyId: string): Promise<string> {
  // Never behind the highest existing INV-nnnn, so imported history is respected. Row-locked: no duplicates.
  const max = (await c.query<{ n: number }>(`select coalesce(max(substring(number from '^INV-([0-9]+)$')::int), 0) as n from ${S}.documents where kind = 'invoice'`)).rows[0]!.n;
  await c.query(`insert into ${S}.doc_counters (company_id, kind, next_no) values ($1, 'invoice', $2 + 1) on conflict do nothing`, [companyId, max]);
  const r = await c.query<{ no: number }>(
    `update ${S}.doc_counters set next_no = greatest(next_no, $1 + 1) + 1 where kind = 'invoice' returning next_no - 1 as no`,
    [max],
  );
  return `INV-${String(r.rows[0]!.no).padStart(4, '0')}`;
}

export async function openDocumentsForMatch(c: PoolClient): Promise<OpenDocument[]> {
  return (
    await c.query<OpenDocument>(
      `select d.number, d.kind, p.name as party, (d.total_minor - d.paid_minor)::bigint as outstanding_minor
         from ${S}.documents d join ${S}.parties p on p.id = d.party_id where d.status = 'open'`,
    )
  ).rows;
}

export async function rules(c: PoolClient): Promise<Rule[]> {
  return (
    await c.query<Rule>(`select r.pattern, a.code as account_code, r.direction, r.priority from ${S}.coding_rules r join ${S}.accounts a on a.id = r.account_id`)
  ).rows;
}

export async function bankTxn(c: PoolClient, id: string) {
  return (
    await c.query(
      `select t.*, to_char(t.txn_date, 'YYYY-MM-DD') as date, a.code as bank_code from ${S}.bank_transactions t join ${S}.accounts a on a.id = t.bank_account_id where t.id = $1`,
      [id],
    )
  ).rows[0] ?? null;
}
