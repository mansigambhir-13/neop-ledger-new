// wake-order.test · B2 + B3: no assistant wakes before execute is terminal; a crash between the yes and the
// effect recovers without losing the yes. (v3 S2: the yes is on the app's row — APPROVED — and it is the app's
// runner, not a platform worker, that carries it out; a runner that dies before it does is replaced by one that
// finds the row on its first poll.)
import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootPilot, call, finish, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot({ platformWorkers: false });
});
afterAll(async () => P?.close());

it('a yes never wakes the job before the effect is done, and survives a crash between the yes and the effect', async () => {
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
    return (await P.desk()).find((c) => c.job_id === job_id && c.status === 'PENDING');
  }, 'card');

  // The runner dies right after the yes landed on the row, before it carried it out (held here, then replaced).
  P.backend.runner.approved.pause();
  expect((await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint })).status).toBe(200);

  const p = await P.backend.core.runnerPool.query('select status from ledger.proposals where id = $1', [card.proposal_id]);
  expect(p.rows[0].status).toBe('APPROVED');
  const w = await P.backend.core.runnerPool.query('select status from ledger.waits where ref_id = $1', [card.proposal_id]);
  expect(w.rows[0].status).toBe('pending');
  await P.backend.runner.tick();
  await new Promise((r) => setTimeout(r, 400));
  expect(wakes).toHaveLength(0);
  expect((await P.jobRow(job_id)).status).toBe('WAITING');
  expect(await readdir(P.mailDir)).toHaveLength(0);
  expect((await P.desk()).find((c) => c.id === card.id).status).toBe('RESOLVED'); // the yes is recorded, not yet carried out

  // Restart: the new runner's first poll finds the APPROVED row and carries it out, once, before anything wakes.
  await P.restartBackend();
  await P.waitFor(async () => (await P.desk()).find((c) => c.id === card.id).status === 'EXECUTED', 'executed');
  expect(await readdir(P.mailDir)).toHaveLength(1);
  await P.waitFor(async () => {
    return (await P.task(task_id)).task.status === 'COMPLETED';
  }, 'completed');
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toContain('is now DONE');
  expect(wakes[0]).toContain('Proof from the app');
});
