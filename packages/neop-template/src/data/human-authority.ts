import { sqlIdent, type PoolClient } from '@neop/pgkit';
import { fingerprint } from '@neop/contracts';
import type { ExecCtx } from '../types.ts';
import { DoorError } from '../doors/errors.ts';

/** Opt-in only. Call after receipt replay lookup, within the app write's transaction. */
export async function checkHumanAuthority(db: PoolClient, schema: string, ability: string, args: unknown, ctx: ExecCtx): Promise<Record<string, unknown>> {
  if (!ctx.job_id) throw new DoorError('authority_required: an approved job is required', { definite: true });
  try {
    const result = await db.query(`select ${sqlIdent(schema)}.check_human_authority($1,$2,$3,$4::jsonb) as authority`, [ctx.job_id, ctx.idempotencyKey, ability, JSON.stringify(args)]);
    const authority = result.rows[0]!.authority;
    const expected = fingerprint({ key: ability, version: authority.ability_version, args, company_id: ctx.company_id, job_id: ctx.job_id });
    if (authority.fingerprint !== expected) throw new DoorError('authority_evidence: approved content hash does not match', { definite: true });
    return authority;
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === '42501' && e.message?.startsWith('authority_')) throw new DoorError(e.message, { definite: true });
    throw error;
  }
}
