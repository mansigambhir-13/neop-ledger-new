import { DECISIONS, type Decision } from '@neop/contracts';
import type { Core } from '../../core.ts';
import { ExecError } from '../execute.ts';

export interface ResolveInput {
  proposal_id: string;
  decision: Decision;
  fingerprint_seen: string;
  decided_by: string;
  feedback?: string | null;
}

export function validateResolve(b: any): string | null {
  if (!b || typeof b !== 'object') return 'body required';
  if (typeof b.proposal_id !== 'string') return 'proposal_id required';
  if (!DECISIONS.includes(b.decision)) return `decision must be one of ${DECISIONS.join(', ')}`;
  if (typeof b.fingerprint_seen !== 'string') return 'fingerprint_seen required';
  if (typeof b.decided_by !== 'string' || !b.decided_by.startsWith('user:')) return 'decided_by must be a person (user:<id>)';
  if (b.decision === 'change' && (typeof b.feedback !== 'string' || !b.feedback.trim())) return 'a change needs feedback';
  return null;
}

/**
 * A yes / no / change / withdraw arrives here, against a fingerprint. The check and the write live in
 * exactly one SQL place, `<schema>.answer_proposal()` (t009, WP v3 §6): fingerprint, expiry, the legal
 * transition, the event trail, the step, the outbox event, and — for anything but a yes — the wait made
 * ready and the runner notified. The desk and the room call the same function.
 * A yes does NOT wake the job (B2): the wait turns ready only after execute.
 */
export async function resolveProposal(core: Core, companyId: string, input: ResolveInput): Promise<{ status: string; idempotent: boolean }> {
  let out: { status: string; idempotent: boolean; refused?: string };
  try {
    out = await core.company(companyId, async (c) => {
      const r = await c.query<{ r: { status: string; idempotent: boolean; refused?: string } }>(`select ${core.key}.answer_proposal($1, $2, $3, $4, $5) as r`, [
        input.proposal_id,
        input.fingerprint_seen,
        input.decision,
        input.decided_by,
        input.feedback ?? null,
      ]);
      return r.rows[0]!.r; // a fingerprint refusal commits its proposal_events row, then is refused below
    });
  } catch (e) {
    const msg = String((e as Error).message ?? '');
    const m = /^(not_found|not_open|expired|bad_request): (.*)$/s.exec(msg);
    if (m) {
      const status = m[1] === 'not_found' ? 404 : m[1] === 'bad_request' ? 400 : 409;
      throw new ExecError(status, m[1]!, m[2]!);
    }
    throw e;
  }
  if (out.refused === 'fingerprint_mismatch') {
    throw new ExecError(409, 'fingerprint_mismatch', 'the answer was given against a different version of this proposal');
  }
  return { status: out.status, idempotent: out.idempotent };
}
