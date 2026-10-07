import {sqlIdent} from '@neop/pgkit';
// Standing yeses (WP v3 §5), matched by the gate in the app's own schema (<schema>.grants, t010).
// The desk writes them (create_grant / revoke_grant); the gate only reads them and records each use
// (<schema>.grant_uses). No platform call, no execution token: a grant-covered proposal is written
// APPROVED (approved_via 'grant') and carried out by the same approved path a person's yes takes.

import type { PoolClient } from '@neop/pgkit';
import type { Measure } from '../types.ts';

interface GrantLimits {
  per_call_minor?: number;
  per_month_minor?: number;
  currency?: string;
  recipients_allow?: string[];
}

/**
 * The first ACTIVE, unexpired grant for this ability whose limits the call fits, or null. A limit the
 * call cannot be measured against never covers it (H1): a person decides. "This month" is the company's
 * month (its install's time zone). Runs inside the company's transaction; each candidate grant is
 * serialised (advisory lock) so two calls cannot both fit under one monthly limit.
 */
export async function matchGrant(c: PoolClient, schema: string, abilityKey: string, m: Measure, timeZone: string): Promise<{ grant_id: string } | null> {
  const grants = await c.query<{ grant_id: string; limits: GrantLimits | null }>(
    `select grant_id, limits from ${sqlIdent(schema)}.grants
      where ability_key = $1 and status = 'ACTIVE' and expires_at > now() order by created_at, grant_id`,
    [abilityKey],
  );
  for (const g of grants.rows) {
    const L = g.limits ?? {};
    const hasAmountLimit = L.per_call_minor !== undefined || L.per_month_minor !== undefined;
    if (hasAmountLimit && typeof m.amount_minor !== 'number') continue;
    if (L.currency && m.currency !== L.currency) continue;
    if (L.per_call_minor !== undefined && m.amount_minor! > L.per_call_minor) continue;
    if (L.recipients_allow && (!m.recipients?.length || m.recipients.some((r) => !L.recipients_allow!.includes(r)))) continue;
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [`${schema}:grant:${g.grant_id}`]);
    // Still active once we hold it (a revoke or a suspension may have landed meanwhile).
    const live = await c.query(`select 1 from ${sqlIdent(schema)}.grants where grant_id = $1 and status = 'ACTIVE' and expires_at > now()`, [g.grant_id]);
    if (!live.rowCount) continue;
    if (L.per_month_minor !== undefined) {
      const used = await c.query<{ s: number }>(
        `select coalesce(sum(amount_minor), 0)::bigint as s from ${sqlIdent(schema)}.grant_uses
          where grant_id = $1 and at >= (date_trunc('month', now() at time zone $2) at time zone $2)`,
        [g.grant_id, timeZone],
      );
      if (Number(used.rows[0]!.s) + (m.amount_minor ?? 0) > L.per_month_minor) continue;
    }
    return { grant_id: g.grant_id };
  }
  return null;
}

/** One use of a standing yes, in the same transaction that writes the proposal it approved. */
export async function recordGrantUse(
  c: PoolClient,
  schema: string,
  u: { company_id: string; grant_id: string; proposal_id: string; job_id: string | null; ability_key: string; fingerprint: string; amount_minor?: number; currency?: string },
): Promise<void> {
  await c.query(
    `insert into ${sqlIdent(schema)}.grant_uses (company_id, grant_id, proposal_id, job_id, ability_key, fingerprint, amount_minor, currency)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [u.company_id, u.grant_id, u.proposal_id, u.job_id, u.ability_key, u.fingerprint, u.amount_minor ?? null, u.currency ?? null],
  );
}
