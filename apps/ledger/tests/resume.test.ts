// resume.test · kill the assistant mid-job; the runner re-claims after the claim
// lapses and a fresh assistant continues from the book.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootPilot, call, finish, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot({ timings: { claimMs: 800, heartbeatMs: 200 } });
});
afterAll(async () => P?.close());

it('a killed session loses its claim; the next session resumes from the book', async () => {
  let session = 0;
  let secondJob = '';
  P.setBrain((v) => {
    if (v.calls === 0 && !v.job.includes('Resumed after')) {
      session = 1;
      return call('ledger.report.trial_balance', { as_of: '2026-09-30' });
    }
    if (session === 1 && v.calls === 1) return { hang: true };
    session = 2;
    secondJob = v.job;
    return finish('Trial balance agrees; resumed after an interruption.');
  });
  const { task_id, job_id } = await P.ask('Is the trial balance at 30 Sep in agreement?');
  await P.waitFor(async () => (await P.backend.core.runnerPool.query("select 1 from ledger.steps where job_id = $1 and kind = 'ability'", [job_id])).rowCount, 'first read');
  await new Promise((r) => setTimeout(r, 100));
  expect(P.worker.kill(job_id)).toBe(true);

  const t = await P.waitFor(async () => {
    const t = await P.task(task_id);
    return t.task.status === 'COMPLETED' && t;
  }, 'completed after resume', 20_000);
  expect(session).toBe(2);
  expect(secondJob).toContain('Resumed after an interrupted session');
  expect(secondJob).toContain('Read Trial balance');
  expect((await P.jobRow(job_id)).attempts).toBe(1);
  expect(t.task.result.summary).toContain('resumed');
});
