import type { GatewayClaims } from '@neop/contracts';
import type { Core } from '../../core.ts';
import { attachmentFact, keepUploads, recordFile, validateAttachments, type DocumentUpload } from '../../doors/documents/index.ts';

export interface OpenJobInput {
  task_id: string;
  ask: string;
  requester: string;
  source?: 'task' | 'room' | 'a2a' | 'timer';
  /** A follow-up in the same conversation: the earlier job whose summary and facts this one starts from. */
  parent_job_id?: string | null;
  /** The person the work is for (a2a: where the chain started; WP §9). */
  on_behalf_of?: string | null;
  /** traceparent of the L3 span that opened it; the job's later hops continue this trace. */
  trace?: string | null;
  /** Files the person attached: read by the documents door, kept on the job as untrusted notes. */
  attachments?: DocumentUpload[];
  /** Where the ask came from (jobs.origin, t007): the room event id for a room message; the task id otherwise. */
  origin?: string | null;
}

/**
 * Inbound → job. One transaction: the job in RECEIVED, the first step, and an
 * outbox job.acknowledged. Idempotent on task_id. Answers within milliseconds;
 * the work happens later when the runner claims the job.
 */
export async function openJob(core: Core, companyId: string, input: OpenJobInput): Promise<{ job_id: string; status: string; created: boolean; ack: string }> {
  // The originals are kept first (WP §11: object storage under the schema name; the row keeps the id),
  // then read (deterministic, no model); both are written with the job, so the runner never sees it without them.
  const uploads = input.attachments ?? [];
  const kept = await keepUploads(core, companyId, uploads);
  const notes = uploads.map((u, i) => attachmentFact(u, kept[i]));
  const { job, created } = await core.company(companyId, async (c) => {
    // A parent that is not a job of this company in this book is not followed (RLS hides other companies).
    const parent = input.parent_job_id ? ((await c.query(`select 1 from ${core.key}.jobs where id = $1`, [input.parent_job_id])).rowCount ? input.parent_job_id : null) : null;
    const r = await core.book.openJobAtomic(c, {
      company_id: companyId,
      source: input.source ?? 'task',
      requester: input.requester,
      task_id: input.task_id,
      ask: input.ask,
      parent_job_id: parent,
      trace_id: input.trace ?? null,
      on_behalf_of: input.on_behalf_of ?? (input.requester.startsWith('user:') ? input.requester : null),
      origin: input.origin ?? input.task_id,
    });
    if (r.created) for (const n of notes) await core.book.addFact(c, { company_id: companyId, job_id: r.job.id, ...n });
    if (r.created) for (const f of kept) if (f) await recordFile(c, core.key, companyId, r.job.id, f);
    return r;
  });
  return { job_id: job.id, status: job.status, created, ack: `On it — ${core.manifest.name} job ${job.id.slice(0, 8)}.` };
}

export function validateOpen(body: any): string | null {
  if (!body || typeof body !== 'object') return 'body required';
  if (typeof body.task_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.task_id)) return 'task_id (uuid) required';
  if (typeof body.ask !== 'string' || !body.ask.trim() || body.ask.length > 8000) return 'ask (1..8000 chars) required';
  if (typeof body.requester !== 'string' || !/^(user|app):.+/.test(body.requester)) return 'requester (user:<id> | app:<key>) required';
  if (body.parent_job_id !== undefined && body.parent_job_id !== null && (typeof body.parent_job_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.parent_job_id))) return 'parent_job_id must be a uuid';
  if (body.on_behalf_of !== undefined && body.on_behalf_of !== null) {
    if (typeof body.on_behalf_of !== 'string' || !/^user:.{1,200}$/.test(body.on_behalf_of)) return 'on_behalf_of must be a person (user:<id>)';
    // A person asking for themselves cannot be on behalf of someone else.
    if (body.requester.startsWith('user:') && body.on_behalf_of !== body.requester) return 'on_behalf_of must be the requester when a person asks';
  }
  return validateAttachments(body.attachments);
}

export function requesterMatches(claims: GatewayClaims, requester: string): boolean {
  // A platform-originated task names its user; an app may only speak for itself.
  if (claims.sub === 'platform') return true;
  return claims.sub === requester;
}
