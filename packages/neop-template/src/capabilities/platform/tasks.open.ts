import type { GatewayClaims } from '@neop/contracts';
import type { Core } from '../../core.ts';

export interface OpenJobInput {
  task_id: string;
  ask: string;
  requester: string;
  source?: 'task' | 'room' | 'a2a' | 'timer';
  parent_job_id?: string | null;
  /** traceparent of the L3 span that opened it; the job's later hops continue this trace. */
  trace?: string | null;
}

/**
 * Inbound → job. One transaction: the job in RECEIVED, the first step, and an
 * outbox job.acknowledged. Idempotent on task_id. Answers within milliseconds;
 * the work happens later when the runner claims the job.
 */
export async function openJob(core: Core, companyId: string, input: OpenJobInput): Promise<{ job_id: string; status: string; created: boolean; ack: string }> {
  const { job, created } = await core.company(companyId, (c) =>
    core.book.openJobAtomic(c, {
      company_id: companyId,
      source: input.source ?? 'task',
      requester: input.requester,
      task_id: input.task_id,
      ask: input.ask,
      parent_job_id: input.parent_job_id ?? null,
      trace_id: input.trace ?? null,
    }),
  );
  return { job_id: job.id, status: job.status, created, ack: `On it — ${core.manifest.name} job ${job.id.slice(0, 8)}.` };
}

export function validateOpen(body: any): string | null {
  if (!body || typeof body !== 'object') return 'body required';
  if (typeof body.task_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.task_id)) return 'task_id (uuid) required';
  if (typeof body.ask !== 'string' || !body.ask.trim() || body.ask.length > 8000) return 'ask (1..8000 chars) required';
  if (typeof body.requester !== 'string' || !/^(user|app):.+/.test(body.requester)) return 'requester (user:<id> | app:<key>) required';
  return null;
}

export function requesterMatches(claims: GatewayClaims, requester: string): boolean {
  // A platform-originated task names its user; an app may only speak for itself.
  if (claims.sub === 'platform') return true;
  return claims.sub === requester;
}
