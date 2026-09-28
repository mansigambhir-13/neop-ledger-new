// presence-redelivery.test · v3 S5: task-delivery.test's meaning for an app that runs with NEOP presence, where a
// person's ask reaches it ONLY through Matrix (NeuralChat's typed task). A person's ask is never lost to an app that is
// down or a homeserver that is: Matrix redelivers the posted event until the app's appservice takes it; a send the
// homeserver did not take is resent with the SAME txnId (never a second event); the app dedupes on event_id and task id,
// so the job is opened once; past the delivery window a task nobody acknowledged fails visibly, never silently.
// (task-delivery.test keeps the gateway road's version, for presence-off installs.)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, toolName, type Pilot } from './harness.ts';

const finish = { tool: toolName('job.finish'), args: { outcome: 'done', summary: 'ok' } };

describe('appservice road: the app is down while NeuralChat posts', () => {
  let P: Pilot;
  beforeAll(async () => {
    P = await bootPilot({ presence: 'appservice', neuralchat: true, neuralchatAckWaitMs: 300 });
  }, 180_000);
  afterAll(async () => P?.close());
  const task = async (id: string) => (await P.platform.db.query('select status, job_id, matrix_event_id, last_error from neos.tasks where id = $1', [id])).rows[0];

  it('the homeserver keeps redelivering until the app is back; the job is opened once and completes', async () => {
    P.setBrain(() => finish);
    await P.backend.stop();
    const r = await P.api('POST', '/api/ask', { text: 'trial balance please', app: 'ledger' });
    expect(r.status).toBe(200);
    const id = r.body.task_id;
    const t0 = await P.waitFor(async () => (await task(id)).matrix_event_id && task(id), 'posted');
    expect(t0.status).toBe('OPEN'); // posted, not yet heard
    await P.waitFor(async () => P.hs!.deliveries.filter((d) => d.event_id === t0.matrix_event_id && d.status !== 200).length >= 3, 'failed pushes while the app is down');
    await P.platform.neuralchat!.tick(); // within the window: nothing is failed, nothing is resent
    expect((await task(id)).status).toBe('OPEN');
    await P.restartBackend();
    await P.waitFor(async () => (await task(id)).status === 'COMPLETED', 'completed after redelivery', 30_000);
    const jobs = (await P.backend.core.runnerPool.query('select id from ledger.jobs where task_id = $1', [id])).rows;
    expect(jobs).toHaveLength(1);
    // Matrix redelivers the same event again: still one job, one inbound record.
    await P.hs!.redeliver(t0.matrix_event_id);
    await new Promise((res) => setTimeout(res, 300));
    expect((await P.backend.core.runnerPool.query('select count(*)::int n from ledger.jobs where task_id = $1', [id])).rows[0].n).toBe(1);
    expect((await P.backend.core.runnerPool.query('select count(*)::int n from ledger.inbound_events where event_id = $1', [t0.matrix_event_id])).rows[0].n).toBe(1);
    expect(P.hs!.typed.filter((e) => e.type === 'neos.neop.task' && e.content.task_id === id)).toHaveLength(1);
  });

  it('past the delivery window a task the app never acknowledged fails visibly', async () => {
    await P.backend.stop();
    const r = await P.api('POST', '/api/ask', { text: 'cash position please', app: 'ledger' });
    const id = r.body.task_id;
    await P.waitFor(async () => (await task(id)).matrix_event_id, 'posted');
    await P.platform.db.query("update neos.tasks set created_at = now() - interval '11 minutes' where id = $1", [id]);
    await P.platform.neuralchat!.tick();
    const t = await task(id);
    expect(t.status).toBe('FAILED');
    expect(t.last_error).toBe('the app never acknowledged the task in Matrix');
    await P.restartBackend();
  });
});

describe('client road: the homeserver is down while NeuralChat posts', () => {
  let P: Pilot;
  beforeAll(async () => {
    P = await bootPilot({ presence: 'client', neuralchat: true, neuralchatAckWaitMs: 300 });
  }, 180_000);
  afterAll(async () => P?.close());
  const task = async (id: string) => (await P.platform.db.query('select status, job_id, matrix_event_id, matrix_txn, open_attempts, last_error from neos.tasks where id = $1', [id])).rows[0];

  it('a send the homeserver refused is resent with the same txnId: one event, one job', async () => {
    P.setBrain(() => finish);
    // First ask: the 1:1 room exists before the outage.
    const warm = await P.api('POST', '/api/ask', { text: 'trial balance please', app: 'ledger' });
    await P.waitFor(async () => (await task(warm.body.task_id)).status === 'COMPLETED', 'warm-up completed', 30_000);
    P.mx!.down(true);
    const r = await P.api('POST', '/api/ask', { text: 'cash position please', app: 'ledger' });
    expect(r.status).toBe(200);
    const id = r.body.task_id;
    const t0 = await task(id);
    expect(t0).toMatchObject({ status: 'OPEN', matrix_event_id: null, matrix_txn: `nc-task-${id}` });
    expect(t0.last_error).toMatch(/homeserver answered 503/);
    P.mx!.down(false);
    await P.platform.db.query('update neos.tasks set next_attempt_at = now() where id = $1', [id]);
    await P.platform.neuralchat!.tick();
    const t1 = await task(id);
    expect(t1.matrix_event_id).toBeTruthy();
    // A second resend (a crash after the send, before the record) is the same event.
    await P.platform.db.query('update neos.tasks set matrix_event_id = null where id = $1', [id]);
    expect(await P.platform.neuralchat!.deliver(id)).toBe(t1.matrix_event_id);
    await P.waitFor(async () => (await task(id)).status === 'COMPLETED', 'completed after the resend', 30_000);
    expect(P.mx!.typed(undefined, 'neos.neop.task').filter((e) => e.content.task_id === id)).toHaveLength(1);
    P.mx!.redeliver(t1.matrix_event_id);
    await new Promise((res) => setTimeout(res, 400));
    expect((await P.backend.core.runnerPool.query('select count(*)::int n from ledger.jobs where task_id = $1', [id])).rows[0].n).toBe(1);
  });
});
