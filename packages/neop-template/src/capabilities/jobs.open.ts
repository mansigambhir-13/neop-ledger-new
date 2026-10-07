import {sqlIdent} from '@neop/pgkit';
import type { Core } from '../core.ts';
import { attachmentFact, keepUploads, recordFile, type DocumentUpload } from '../doors/documents/index.ts';

export interface OpenJobInput {
  task_id: string;
  ask: string;
  requester: string;
  source?: 'task' | 'room' | 'a2a' | 'timer';
  /** A follow-up in the same conversation: the earlier job whose summary and facts this one starts from. */
  parent_job_id?: string | null;
  /** The person the work is for (a2a: where the chain started; WP §9). */
  on_behalf_of?: string | null;
  /** traceparent of the span that opened it (the typed task's `trace`); the job's later hops continue this trace. */
  trace?: string | null;
  /** Files the person attached: read by the documents door, kept on the job as untrusted notes. */
  attachments?: DocumentUpload[];
  /** Where the ask came from (jobs.origin, t007): the room event id for a room message; the task id otherwise. */
  origin?: string | null;
}

/**
 * Inbound (a typed task, a plain message, a bus task, a timer) → job. One transaction: the job in RECEIVED, the first step, and an
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
    const parent = input.parent_job_id ? ((await c.query(`select 1 from ${sqlIdent(core.key)}.jobs where id = $1`, [input.parent_job_id])).rowCount ? input.parent_job_id : null) : null;
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
