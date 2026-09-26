// wake-order.test · B2 + B3: no assistant wakes before execute is terminal; a
// platform crash between resolve and execute recovers without losing the yes.
import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootPilot, call, finish, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot({ platformWorkers: false });
});
afterAll(async () => P?.close());

it('a yes never wakes the job before the effect is done, and survives a crash between resolve and execute', async () => {
  const wakes: string[] = [];
  P.setBrain((v) => {
    if (v.job.includes('WOKEN')) {
      wakes.push(v.job);
      return finish('verified');
    }
    return v.calls === 0
      ? call('ledger.close_pack.email', {
          period: { from: '2026-08-01', to: '2026-08-31' },
          to: ['cfo@acme.example'],
          card: { what: 'Send pack', why: 'close', changes: 'one email', if_no_answer: 'nothing' },
        })
      : { text: 'waiting' };
  });
  const { task_id, job_id } = await P.ask('Send the August pack to the CFO');
  const card = await P.waitFor(async () => {
    await P.platform.outboxTick();
    return (await P.desk()).find((c) => c.job_id === job_id && c.status === 'PENDING');
  }, 'card');

  // The platform crashes right after the app accepted the yes.
  P.platform.hooks.afterResolve = async () => {
    throw new Error('simulated platform crash');
  };
  await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
  await P.waitFor(async () => (await P.platform.db.query("select status from neos.approvals where id = $1", [card.id])).rows[0].status === 'RESOLVED', 'resolved');

  const p = await P.backend.core.runnerPool.query('select status from ledger.proposals where id = $1', [card.proposal_id]);
  expect(p.rows[0].status).toBe('APPROVED');
  const w = await P.backend.core.runnerPool.query('select status from ledger.waits where ref_id = $1', [card.proposal_id]);
  expect(w.rows[0].status).toBe('pending');
  await P.backend.runner.tick();
  await new Promise((r) => setTimeout(r, 400));
  expect(wakes).toHaveLength(0);
  expect((await P.jobRow(job_id)).status).toBe('WAITING');
  expect(await readdir(P.mailDir)).toHaveLength(0);

  // Restart: the worker picks the RESOLVED row back up and carries it out.
  P.platform.hooks.afterResolve = undefined;
  await P.platform.db.query('update neos.approvals set next_attempt_at = now() where id = $1', [card.id]);
  await P.platform.approvalsTick();
  expect((await P.platform.db.query('select status from neos.approvals where id = $1', [card.id])).rows[0].status).toBe('EXECUTED');
  expect(await readdir(P.mailDir)).toHaveLength(1);
  await P.waitFor(async () => {
    await P.platform.outboxTick();
    return (await P.task(task_id)).task.status === 'COMPLETED';
  }, 'completed');
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toContain('is now DONE');
  expect(wakes[0]).toContain('Proof from the app');
});
