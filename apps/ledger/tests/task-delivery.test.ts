// task-delivery.test · a person's ask is never lost to a burst of app restarts: the platform
// retries tasks.open for a window of time (not a count of attempts), fails it visibly past the
// window, and fails a definite refusal at once. Found by the live kill -9 chaos run.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootPilot, toolName, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot({ platformWorkers: false });
});
afterAll(async () => P?.close());

const finish = { tool: toolName('job.finish'), args: { outcome: 'done', summary: 'ok' } };
const task = async (id: string) => (await P.platform.db.query('select status, open_attempts, job_id from neos.tasks where id = $1', [id])).rows[0];

it('many failed attempts while the app is down: delivered once it is back, not failed', async () => {
  P.setBrain(() => finish);
  await P.backend.stop();
  const r = await P.api('POST', '/api/ask', { text: 'trial balance please', app: 'ledger' });
  expect(r.status).toBe(200);
  const id = r.body.task_id;
  expect((await task(id)).status).toBe('OPEN');
  // As if it had failed far more than the old 8-attempt limit during a burst of restarts.
  await P.platform.db.query("update neos.tasks set open_attempts = 40, next_attempt_at = now() where id = $1", [id]);
  await P.platform.tasksTick();
  expect((await task(id)).status).toBe('OPEN'); // still down, still within the window
  await P.restartBackend();
  await P.platform.db.query('update neos.tasks set next_attempt_at = now() where id = $1', [id]);
  await P.platform.tasksTick();
  const t = await task(id);
  expect(t.status).not.toBe('FAILED');
  expect(t.job_id).toBeTruthy();
});

it('past the delivery window the task fails visibly, never silently', async () => {
  await P.backend.stop();
  const r = await P.api('POST', '/api/ask', { text: 'cash position please', app: 'ledger' });
  const id = r.body.task_id;
  await P.platform.db.query("update neos.tasks set created_at = now() - interval '11 minutes', next_attempt_at = now() where id = $1", [id]);
  await P.platform.tasksTick();
  expect((await task(id)).status).toBe('FAILED');
  await P.restartBackend();
});
