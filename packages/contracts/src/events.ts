/** Outbox event types an app emits and the platform consumes by cursor. */
export const OUTBOX_EVENT_TYPES = [
  'job.acknowledged',
  'proposal.created',
  'proposal.resolved',
  'proposal.expired',
  'proposal.executed',
  'step.mirror',
  'card.raised',
  'operation.recorded',
  'task.completed',
  'task.failed',
  'a2a.requested',
] as const;
export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

export interface OutboxEvent<T = Record<string, unknown>> {
  id: number;
  company_id: string;
  event_type: OutboxEventType;
  payload: T;
  created_at: string;
}

export interface ProposalCard {
  what: string;
  why: string;
  changes: string;
  if_no_answer: string;
}

export interface ProposalCreatedPayload {
  proposal_id: string;
  job_id: string;
  task_id: string | null;
  ability_key: string;
  ability_version: string;
  args: unknown;
  card: ProposalCard;
  fingerprint: string;
  expires_at: string;
}

export type ExecOutcome = 'DONE' | 'FAILED' | 'UNKNOWN';

/** What a carried-out proposal returns and what the woken assistant verifies. */
export interface Proof {
  outcome: ExecOutcome;
  external_ref: string | null;
  read_back: unknown;
  error: string | null;
  at: string;
}

export interface TaskResult {
  outcome: 'done' | 'failed' | 'blocked' | 'needs_input' | 'cancelled';
  summary: string;
  changed: string[];
  could_not: string[];
  sources: string[];
}

export type Decision = 'yes' | 'no' | 'change' | 'withdraw';
export const DECISIONS: readonly Decision[] = ['yes', 'no', 'change', 'withdraw'];
