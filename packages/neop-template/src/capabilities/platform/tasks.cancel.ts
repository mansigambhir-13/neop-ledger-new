import type { TaskResult } from '@neop/contracts';
import type { Core } from '../../core.ts';
import type { ProposalRow } from '../../data/book.ts';
import { ExecError } from '../execute.ts';

/**
 * A person stops a job. Nothing further runs for it: open proposals are
 * withdrawn (an EXECUTING one cannot be recalled and is reported as such),
 * waits are consumed, the claim is dropped, and the live session's next gate
 * call is refused because the job is no longer RUNNING.
 */
export async function cancelJob(core: Core, companyId: string, input: { task_id: string; by: string; reason?: string }) {
  return core.company(companyId, async (c) => {
    const j = await c.query<{ id: string; status: string }>(`select id, status from ${core.key}.jobs where task_id = $1 for update`, [input.task_id]);
    const job = j.rows[0];
    if (!job) throw new ExecError(404, 'not_found', 'no job for that task');
    if (['DONE', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(job.status)) return { job_id: job.id, status: job.status, idempotent: true };
    const open = await c.query<ProposalRow>(`select * from ${core.key}.proposals where job_id = $1 and status in ('PROPOSED', 'APPROVED', 'EXECUTING') for update`, [job.id]);
    const executing: string[] = [];
    for (const p of open.rows) {
      if (p.status === 'EXECUTING') {
        executing.push(p.id);
        continue;
      }
      await core.book.updateProposal(c, p.id, { status: 'WITHDRAWN' });
      await core.book.proposalEvent(c, { company_id: companyId, proposal_id: p.id, event: 'withdrawn:cancelled', actor: input.by });
      await core.book.emit(c, companyId, 'proposal.resolved', { proposal_id: p.id, job_id: job.id, decision: 'withdraw', status: 'WITHDRAWN' }, `resolved:${p.id}:cancel`);
    }
    await c.query(`update ${core.key}.waits set status = 'consumed', outcome = coalesce(outcome, 'CANCELLED'), ready_at = coalesce(ready_at, now()) where job_id = $1 and status <> 'consumed'`, [job.id]);
    const summary = `Stopped by ${input.by}${input.reason ? `: ${input.reason}` : ''}.${executing.length ? ` ${executing.length} approved action was already being carried out and could not be recalled.` : ''}`;
    const result: TaskResult = { outcome: 'cancelled', summary, changed: [], could_not: [], sources: [] };
    await core.book.addStep(c, { company_id: companyId, job_id: job.id, kind: 'system', summary });
    await core.book.setJobStatus(c, job.id, 'CANCELLED', { result, clearClaim: true });
    await core.book.emit(c, companyId, 'task.failed', { job_id: job.id, task_id: input.task_id, result }, `finish:${job.id}`);
    return { job_id: job.id, status: 'CANCELLED', idempotent: false };
  });
}
