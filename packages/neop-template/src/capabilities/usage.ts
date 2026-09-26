import type { PoolClient } from '@neop/pgkit';
import type { Core } from '../core.ts';
import type { RuleUsage } from '../domain/rules.ts';
import type { EffectiveBoard } from '../gate/switchboard.ts';
import { measure } from './execute.ts';

/**
 * Money already committed today and this month, in the company's time zone:
 * executed operations plus approved or executing proposals still in flight.
 */
export async function ruleUsage(core: Core, c: PoolClient, board: EffectiveBoard, currency: string | undefined, excludeProposal?: string): Promise<RuleUsage> {
  if (!currency) return { day_minor: 0, month_minor: 0 };
  const tz = board.company.time_zone;
  const { rows } = await c.query<{ day: number; month: number }>(
    `select
       coalesce(sum((detail->>'amount_minor')::bigint) filter (where at >= date_trunc('day', now() at time zone $1) at time zone $1), 0)::bigint as day,
       coalesce(sum((detail->>'amount_minor')::bigint), 0)::bigint as month
     from ${core.key}.operations
     where outcome in ('DONE', 'UNKNOWN') and detail->>'currency' = $2
       and detail ? 'amount_minor' and detail->>'amount_minor' is not null
       and at >= date_trunc('month', now() at time zone $1) at time zone $1`,
    [tz, currency],
  );
  let day = rows[0]?.day ?? 0;
  let month = rows[0]?.month ?? 0;
  const inflight = await c.query<{ id: string; ability_key: string; args: unknown; day: boolean }>(
    `select id, ability_key, args, updated_at >= date_trunc('day', now() at time zone $1) at time zone $1 as day
       from ${core.key}.proposals where status in ('APPROVED', 'EXECUTING') and id <> coalesce($2::uuid, '00000000-0000-0000-0000-000000000000')`,
    [tz, excludeProposal ?? null],
  );
  for (const p of inflight.rows) {
    const r = await core.resolve(board.company.id, p.ability_key);
    const a = r?.meta;
    const h = r?.handler;
    if (!a || !h || h.kind !== 'write') continue;
    const m = await measure(a, h, p.args, c);
    if (m.amount_minor && m.currency === currency) {
      month += m.amount_minor;
      if (p.day) day += m.amount_minor;
    }
  }
  return { day_minor: day, month_minor: month };
}
