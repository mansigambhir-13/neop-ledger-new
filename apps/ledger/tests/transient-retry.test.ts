// transient-retry.test · found live: a one-minute provider outage ("upstream unreachable: fetch failed") failed
// every job in flight within seconds — five retries 1.5 s apart. A transient model/network failure now backs off
// (5, 15, 30, 60, 120 s in production; 100/200/300 ms here), so a short outage is ridden out and the job finishes.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootPilot, finish, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => P?.close());

it('a job whose model is unreachable for a while backs off between attempts and finishes when it is back', async () => {
  let failures = 3;
  const at: number[] = [];
  P.setBrain(() => {
    if (failures > 0) {
      failures--;
      at.push(Date.now());
      return { error: '502 upstream unreachable: fetch failed' };
    }
    return finish('The trial balance is in balance.');
  });
  const t = await P.ask('Is the trial balance in balance?');
  const done = await P.waitFor(async () => { const x = (await P.task(t.task_id)).task; return ['COMPLETED', 'FAILED'].includes(x.status) && x; }, 'the task settled', 30_000);
  expect(done.status).toBe('COMPLETED');
  // The waits grew (100, 200, 300 ms here): never back-to-back.
  expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(90);
  expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(180);
  const steps = (await P.backend.core.runnerPool.query("select summary from ledger.steps where job_id = $1 and kind = 'system' order by seq", [t.job_id])).rows.map((r: any) => r.summary);
  expect(steps.filter((s: string) => /could not be reached .* trying again in/.test(s))).toHaveLength(3);
});
