// chaos.test (quick) · jobs and approvals survive forced backend restarts:
// every task terminal exactly once, nothing executed twice. Full size
// (50 restarts, 200 concurrent) runs in `pnpm test:load`.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chaosRun } from '@neop/testkit';
import { bootPilot, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot({ poolSize: 10, timings: { claimMs: 1_500, heartbeatMs: 300, maxAttempts: 40 } });
});
afterAll(async () => P?.close());

it('20 jobs, 6 forced restarts: zero lost, zero duplicate executions', async () => {
  const r = await chaosRun(P, { jobs: 20, restarts: 6, intervalMs: 400 });
  if (r.completed !== 20) {
    const bad = await P.platform.db.query("select t.status, t.result->>'summary' as summary from neos.tasks t where t.status <> 'COMPLETED'");
    console.log('NOT COMPLETED', bad.rows);
  }
  expect(r.completed).toBe(20);
  expect(r.doubleExecuted).toEqual([]);
  expect(r.duplicateResults).toEqual([]);
  expect(r.mails).toBe(r.done);
  expect(r.done).toBe(10);
}, 180_000);
