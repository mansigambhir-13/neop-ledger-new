import { DECISIONS, type Decision } from '@neop/contracts';
import type { Core } from '../../core.ts';
import { alreadyResolvedAs, statusForDecision } from '../../domain/proposals.ts';
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
 * A yes / no / change / withdraw arrives here, against a fingerprint. The app
 * writes the answer in its own hand after checking the fingerprint itself.
 * A yes does NOT wake the job (B2): the wait turns ready only after execute.
 */
export async function resolveProposal(core: Core, companyId: string, input: ResolveInput): Promise<{ status: string; idempotent: boolean }> {
  const out = await core.company(companyId, async (c): Promise<{ status: string; idempotent: boolean } | 'fingerprint_mismatch'> => {
    const p = await core.book.getProposal(c, input.proposal_id, true);
    if (!p) throw new ExecError(404, 'not_found', 'no such proposal');
    if (alreadyResolvedAs(p.status, input.decision) && p.fingerprint === input.fingerprint_seen) {
      return { status: p.status, idempotent: true };
    }
    const withdrawable = input.decision === 'withdraw' && p.status === 'APPROVED';
    if (p.status !== 'PROPOSED' && !withdrawable) throw new ExecError(409, 'not_open', `proposal is ${p.status}`);
    if (input.fingerprint_seen !== p.fingerprint) {
      await core.book.proposalEvent(c, { company_id: companyId, proposal_id: p.id, event: 'answer_refused:fingerprint', actor: input.decided_by, fingerprint_seen: input.fingerprint_seen });
      return 'fingerprint_mismatch'; // commit the refusal event, then refuse
    }
    const { rows } = await c.query<{ expired: boolean }>('select $1::timestamptz <= now() as expired', [p.expires_at]);
    if (rows[0]!.expired && input.decision !== 'withdraw') throw new ExecError(409, 'expired', 'the proposal expired before this answer arrived');

    const status = statusForDecision(input.decision);
    await core.book.updateProposal(c, p.id, { status, decided_by: input.decided_by, feedback: input.feedback ?? null, approved_via: input.decision === 'yes' ? 'person' : null });
    await core.book.proposalEvent(c, {
      company_id: companyId,
      proposal_id: p.id,
      event: `answered:${input.decision}`,
      actor: input.decided_by,
      fingerprint_seen: input.fingerprint_seen,
      detail: input.feedback ? { feedback: input.feedback } : undefined,
    });
    const said = { yes: 'yes', no: 'no', change: 'change this first', withdraw: 'withdrawn' }[input.decision];
    await core.book.addStep(c, {
      company_id: companyId,
      job_id: p.job_id,
      kind: 'system',
      summary: `Answer on proposal ${p.id.slice(0, 8)}: ${said} (${input.decided_by})${input.feedback ? ` — "${input.feedback}"` : ''}`,
    });
    await core.book.emit(c, companyId, 'proposal.resolved', { proposal_id: p.id, job_id: p.job_id, decision: input.decision, status }, `resolved:${p.id}:${input.decision}`);
    if (input.decision !== 'yes') {
      const woke = await core.book.readyWait(c, p.id, status, {
        proposal_id: p.id,
        status,
        decided_by: input.decided_by,
        feedback: input.feedback ?? null,
      });
      if (woke) await core.book.notify(c, `wait:${p.job_id}`);
    }
    return { status, idempotent: false };
  });
  if (out === 'fingerprint_mismatch') {
    throw new ExecError(409, 'fingerprint_mismatch', 'the answer was given against a different version of this proposal');
  }
  return out;
}
