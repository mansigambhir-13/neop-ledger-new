// Proposal lifecycle (plan §Data model). PROPOSED → APPROVED → EXECUTING →
// DONE | FAILED | UNKNOWN; UNKNOWN → DONE | FAILED by reconciliation. Every
// other answer ends the proposal. FAILED and UNKNOWN wake the job (S2).

import type { Decision } from '@neop/contracts';
import type { ProposalStatus } from '../data/book.ts';

const NEXT: Record<ProposalStatus, ProposalStatus[]> = {
  PROPOSED: ['APPROVED', 'REJECTED', 'SUPERSEDED', 'EXPIRED', 'WITHDRAWN'],
  APPROVED: ['EXECUTING', 'WITHDRAWN'],
  EXECUTING: ['DONE', 'FAILED', 'UNKNOWN'],
  UNKNOWN: ['DONE', 'FAILED'],
  REJECTED: [],
  SUPERSEDED: [],
  EXPIRED: [],
  WITHDRAWN: [],
  DONE: [],
  FAILED: [],
};

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return NEXT[from].includes(to);
}

/** Terminal for the purpose of waking the job (B2). APPROVED and EXECUTING never wake it. */
export const WAKES_JOB: readonly ProposalStatus[] = ['DONE', 'FAILED', 'UNKNOWN', 'REJECTED', 'SUPERSEDED', 'EXPIRED', 'WITHDRAWN'];
export const EXECUTION_TERMINAL: readonly ProposalStatus[] = ['DONE', 'FAILED', 'UNKNOWN'];

export function statusForDecision(d: Decision): ProposalStatus {
  switch (d) {
    case 'yes':
      return 'APPROVED';
    case 'no':
      return 'REJECTED';
    case 'change':
      return 'SUPERSEDED';
    case 'withdraw':
      return 'WITHDRAWN';
  }
}

/** Has this proposal already absorbed this decision? (resolve is idempotent) */
export function alreadyResolvedAs(status: ProposalStatus, d: Decision): boolean {
  if (d === 'yes') return ['APPROVED', 'EXECUTING', 'DONE', 'FAILED', 'UNKNOWN'].includes(status);
  return status === statusForDecision(d);
}
