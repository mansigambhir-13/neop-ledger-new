// RECORD BOOK · the only place Ledger's SQL is written. Saves and loads; never decides.

import type { PoolClient } from '@neop/pgkit';
import type { AccountTotal, CashLine, OpenDoc, Sources } from '../domain/reports.ts';

const S = 'ledger';

export async function accountTotals(c: PoolClient, q: { from: string | null; to: string; currency: string }): Promise<AccountTotal[]> {
  const { rows } = await c.query<AccountTotal>(
    `select a.code, a.name, a.type, a.subtype,
            coalesce(s.debit, 0)::bigint as debit_minor, coalesce(s.credit, 0)::bigint as credit_minor
       from ${S}.accounts a
       left join (
         select l.account_id, sum(l.debit_minor) as debit, sum(l.credit_minor) as credit
           from ${S}.journal_lines l join ${S}.journal_entries e on e.id = l.entry_id
          where e.entry_date <= $1 and ($2::date is null or e.entry_date >= $2) and e.currency = $3
          group by l.account_id) s on s.account_id = a.id
      order by a.code`,
    [q.to, q.from, q.currency],
  );
  return rows;
}

export async function entrySources(c: PoolClient, q: { from: string | null; to: string; currency: string }, basis: string): Promise<Sources> {
  const { rows } = await c.query<{ n: number; ids: string[] | null }>(
    `select count(*)::int as n, (array_agg(id order by entry_date, created_at))[1:50]::text[] as ids
       from ${S}.journal_entries where entry_date <= $1 and ($2::date is null or entry_date >= $2) and currency = $3`,
    [q.to, q.from, q.currency],
  );
  return { entries: rows[0]!.n, entry_ids: rows[0]!.ids ?? [], basis };
}

export async function cashLines(c: PoolClient, q: { from: string; to: string; currency: string }): Promise<CashLine[]> {
  const { rows } = await c.query<CashLine>(
    `select l.entry_id, a.subtype, a.type, l.debit_minor, l.credit_minor
       from ${S}.journal_lines l
       join ${S}.journal_entries e on e.id = l.entry_id
       join ${S}.accounts a on a.id = l.account_id
      where e.entry_date between $1 and $2 and e.currency = $3
        and exists (select 1 from ${S}.journal_lines l2 join ${S}.accounts a2 on a2.id = l2.account_id
                     where l2.entry_id = l.entry_id and a2.subtype in ('cash', 'bank'))`,
    [q.from, q.to, q.currency],
  );
  return rows;
}

export async function cashBalanceBefore(c: PoolClient, q: { before: string; currency: string }): Promise<number> {
  const { rows } = await c.query<{ b: number }>(
    `select coalesce(sum(l.debit_minor - l.credit_minor), 0)::bigint as b
       from ${S}.journal_lines l join ${S}.journal_entries e on e.id = l.entry_id join ${S}.accounts a on a.id = l.account_id
      where a.subtype in ('cash', 'bank') and e.entry_date < $1 and e.currency = $2`,
    [q.before, q.currency],
  );
  return rows[0]!.b;
}

export async function openDocuments(c: PoolClient, q: { kind: 'invoice' | 'bill'; as_of: string; currency: string }): Promise<(OpenDoc & { id: string })[]> {
  const { rows } = await c.query(
    `select d.id, d.number, p.name as party, to_char(d.due_date, 'YYYY-MM-DD') as due_date, (d.total_minor - d.paid_minor)::bigint as outstanding_minor
       from ${S}.documents d join ${S}.parties p on p.id = d.party_id
      where d.kind = $1 and d.status = 'open' and d.issue_date <= $2 and d.currency = $3 and d.total_minor > d.paid_minor
      order by d.due_date`,
    [q.kind, q.as_of, q.currency],
  );
  return rows;
}

export async function accountIdsByCode(c: PoolClient, codes: string[]): Promise<Map<string, string>> {
  const { rows } = await c.query<{ id: string; code: string }>(`select id, code from ${S}.accounts where code = any($1)`, [codes]);
  return new Map(rows.map((r) => [r.code, r.id]));
}

export async function insertEntry(
  c: PoolClient,
  e: { company_id: string; date: string; memo: string; reference: string; currency: string; source: string; job_id: string | null; lines: { account_id: string; debit_minor: number; credit_minor: number }[] },
): Promise<{ id: string; created: boolean }> {
  const ins = await c.query<{ id: string }>(
    `insert into ${S}.journal_entries (company_id, entry_date, memo, reference, currency, source, job_id)
     values ($1,$2,$3,$4,$5,$6,$7) on conflict (company_id, reference) do nothing returning id`,
    [e.company_id, e.date, e.memo, e.reference, e.currency, e.source, e.job_id],
  );
  if (!ins.rows[0]) {
    const existing = await c.query<{ id: string }>(`select id from ${S}.journal_entries where reference = $1`, [e.reference]);
    return { id: existing.rows[0]!.id, created: false };
  }
  const id = ins.rows[0].id;
  for (const l of e.lines) {
    await c.query(`insert into ${S}.journal_lines (company_id, entry_id, account_id, debit_minor, credit_minor) values ($1,$2,$3,$4,$5)`, [
      e.company_id,
      id,
      l.account_id,
      l.debit_minor,
      l.credit_minor,
    ]);
  }
  return { id, created: true };
}

export async function budgetRemaining(c: PoolClient, q: { account_code: string; month: string; currency: string }) {
  const start = `${q.month}-01`;
  const acct = (await c.query<{ id: string; type: string }>(`select id, type from ${S}.accounts where code = $1`, [q.account_code])).rows[0];
  if (!acct) return null;
  const b = await c.query<{ amount_minor: number }>(`select amount_minor from ${S}.budgets where account_id = $1 and month = $2 and currency = $3`, [acct.id, start, q.currency]);
  const a = await c.query<{ actual: number; n: number; ids: string[] | null }>(
    `select coalesce(sum(l.debit_minor - l.credit_minor), 0)::bigint as actual, count(distinct e.id)::int as n,
            (array_agg(distinct e.id::text))[1:50] as ids
       from ${S}.journal_lines l join ${S}.journal_entries e on e.id = l.entry_id
      where l.account_id = $1 and e.currency = $2 and e.entry_date >= $3::date and e.entry_date < ($3::date + interval '1 month')`,
    [acct.id, q.currency, start],
  );
  return { budget: b.rows[0]?.amount_minor ?? null, actual: a.rows[0]!.actual, entries: a.rows[0]!.n, ids: a.rows[0]!.ids ?? [] };
}

export async function entryByReference(c: PoolClient, reference: string) {
  const { rows } = await c.query(
    `select e.id, to_char(e.entry_date, 'YYYY-MM-DD') as date, e.memo, e.currency,
            (select sum(debit_minor)::bigint from ${S}.journal_lines where entry_id = e.id) as total_minor
       from ${S}.journal_entries e where e.reference = $1`,
    [reference],
  );
  return rows[0] ?? null;
}
