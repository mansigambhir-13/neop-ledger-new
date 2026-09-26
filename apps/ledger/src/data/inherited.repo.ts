// RECORD BOOK · SQL for the inherited bookkeeping: settings, aging inputs,
// document facts. Saves and loads; never decides.

import type { PoolClient } from '@neop/pgkit';
import { DEFAULT_SETTINGS, type AgingDoc, type Expected, type Settings } from '../domain/inherited.ts';

const S = 'ledger';

export async function settings(c: PoolClient): Promise<{ settings: Settings; stored: boolean; updated_at: string | null; updated_by: string | null }> {
  const r = (await c.query(`select * from ${S}.settings limit 1`)).rows[0];
  if (!r) return { settings: { ...DEFAULT_SETTINGS }, stored: false, updated_at: null, updated_by: null };
  return {
    settings: {
      tax_regime: r.tax_regime,
      return_frequency: r.return_frequency,
      fiscal_year_start_month: r.fiscal_year_start_month,
      aging_buckets: r.aging_buckets,
      forecast_weeks: r.forecast_weeks,
      min_cash_buffer_minor: Number(r.min_cash_buffer_minor),
      chase_after_days: r.chase_after_days,
    },
    stored: true,
    updated_at: r.updated_at.toISOString(),
    updated_by: r.updated_by,
  };
}

export async function saveSettings(c: PoolClient, companyId: string, s: Settings, by: string): Promise<void> {
  await c.query(
    `insert into ${S}.settings (company_id, tax_regime, return_frequency, fiscal_year_start_month, aging_buckets, forecast_weeks, min_cash_buffer_minor, chase_after_days, updated_at, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now(), $9)
     on conflict (company_id) do update set tax_regime = excluded.tax_regime, return_frequency = excluded.return_frequency,
       fiscal_year_start_month = excluded.fiscal_year_start_month, aging_buckets = excluded.aging_buckets, forecast_weeks = excluded.forecast_weeks,
       min_cash_buffer_minor = excluded.min_cash_buffer_minor, chase_after_days = excluded.chase_after_days, updated_at = now(), updated_by = excluded.updated_by`,
    [companyId, s.tax_regime, s.return_frequency, s.fiscal_year_start_month, s.aging_buckets, s.forecast_weeks, s.min_cash_buffer_minor, s.chase_after_days, by],
  );
}

/** Open documents as of a date: issued by then, with what was still outstanding (payments after the date added back). */
export async function openAsOf(c: PoolClient, q: { kind: 'invoice' | 'bill'; as_of: string; currency: string }): Promise<(AgingDoc & { id: string })[]> {
  const { rows } = await c.query(
    `select d.id, d.number, p.name as party, to_char(d.issue_date, 'YYYY-MM-DD') as issue_date, to_char(d.due_date, 'YYYY-MM-DD') as due_date,
            d.total_minor::bigint as total_minor,
            (d.total_minor - coalesce((select sum(x.amount_minor) from ${S}.payments x where x.document_id = d.id and x.pay_date <= $2), 0))::bigint as outstanding_minor,
            to_char(d.reminded_at at time zone 'UTC', 'YYYY-MM-DD') as reminded_at
       from ${S}.documents d join ${S}.parties p on p.id = d.party_id
      where d.kind = $1 and d.status <> 'void' and d.issue_date <= $2 and d.currency = $3
      order by d.due_date, d.number`,
    [q.kind, q.as_of, q.currency],
  );
  // Documents imported already paid (no payment rows) carry their paid amount on the row itself.
  const paidNoRows = await c.query<{ id: string; paid: number }>(
    `select d.id, d.paid_minor::bigint as paid from ${S}.documents d
      where d.kind = $1 and d.paid_minor > 0 and not exists (select 1 from ${S}.payments x where x.document_id = d.id)`,
    [q.kind],
  );
  const paid = new Map(paidNoRows.rows.map((r) => [r.id, Number(r.paid)]));
  return rows
    .map((r) => ({ ...r, total_minor: Number(r.total_minor), outstanding_minor: Number(r.outstanding_minor) - (paid.get(r.id) ?? 0) }))
    .filter((r) => r.outstanding_minor > 0);
}

export async function issuedBetween(c: PoolClient, q: { kind: 'invoice' | 'bill'; from: string; to: string; currency: string }): Promise<number> {
  const r = await c.query<{ t: number }>(
    `select coalesce(sum(total_minor), 0)::bigint as t from ${S}.documents where kind = $1 and status <> 'void' and issue_date > $2 and issue_date <= $3 and currency = $4`,
    [q.kind, q.from, q.to, q.currency],
  );
  return Number(r.rows[0]!.t);
}

export async function expected(c: PoolClient, kind: 'invoice' | 'bill', currency: string): Promise<Expected[]> {
  const { rows } = await c.query(
    `select to_char(due_date, 'YYYY-MM-DD') as due_date, (total_minor - paid_minor)::bigint as outstanding_minor
       from ${S}.documents where kind = $1 and status = 'open' and currency = $2 and total_minor > paid_minor order by due_date`,
    [kind, currency],
  );
  return rows.map((r) => ({ due_date: r.due_date, outstanding_minor: Number(r.outstanding_minor) }));
}

/** A file attached to a job, as the documents door read it (the job's untrusted note). */
export async function attachedDocument(c: PoolClient, sha256: string) {
  const r = await c.query<{ value: any; job_id: string | null; observed_at: Date }>(
    `select value, job_id, observed_at from ${S}.facts where source = $1 order by observed_at desc limit 1`,
    [`upload:sha256:${sha256}`],
  );
  return r.rows[0] ?? null;
}
