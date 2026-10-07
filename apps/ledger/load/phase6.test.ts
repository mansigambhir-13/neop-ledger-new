// V3 release bar: 200 concurrent jobs are all acknowledged through Matrix with bounded latency, and zero jobs are
// lost across 50 forced restarts. Matrix preserves a room's delivery order, so the end-to-end burst bound is separate
// from the app's own typed-event ingress bound.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ackLoad, chaosRun, toolName } from '@neop/testkit';
import { bootPilot, type Pilot } from '../tests/harness.ts';

describe('load', () => {
  let P: Pilot;
  beforeAll(async () => {
    // Production-sized pools on both sides: the template's default app/runner pools (5) queue 200 concurrent opens.
    P = await bootPilot({ poolSize: 20, platformDbPool: 20, backendConfig: () => ({ appPoolSize: 20, runnerPoolSize: 20 }) });
  });
  afterAll(async () => P?.close());

  it('200 concurrent typed Matrix tasks: the app acknowledges every one with p95 under 1 s', async () => {
    await ackLoad(P, 20); // warm pools and JWKS
    const r = await ackLoad(P, 200);
    console.log('typed Matrix task → app job acknowledgement (ms)', r);
    expect(r.n).toBe(200);
    expect(r.p95).toBeLessThanOrEqual(1_000);
  });

  it('200 concurrent asks: /api/ask → task row → Matrix typed task, every one acknowledged (bounded; see notes #24)', async () => {
    P.setBrain(() => ({ tool: toolName('job.finish'), args: { outcome: 'done', summary: 'ok' } }));
    const asks = await Promise.all(Array.from({ length: 200 }, (_, i) => P.api('POST', '/api/ask', { text: `ack ${i}`, app: 'ledger' })));
    for (const a of asks) if (a.status !== 200 || !a.body.task_id) throw new Error(`ask ${a.status} ${JSON.stringify(a.body)}`);
    const ids = asks.map((a) => a.body.task_id);
    // The ack message and the task's job id are persisted in one transaction. Query all 200 together: polling each
    // task would create a thundering herd and measure the test harness rather than Matrix acknowledgement.
    const rows = await P.waitFor(async () => {
      const r = await P.platform.db.query(
        `select t.id, extract(epoch from (min(m.at) - t.created_at)) * 1000 as ms
           from neos.tasks t join neos.conversation_messages m on m.task_id = t.id and m.kind = 'ack'
          where t.id = any($1) and t.job_id is not null group by t.id, t.created_at`,
        [ids],
      );
      return r.rows.length === 200 && r.rows;
    }, 'all 200 persisted Matrix acknowledgements', 30_000);
    const lat = rows.map((r: any) => Number(r.ms));
    lat.sort((a, b) => a - b);
    const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))]!;
    console.log('ask → ack end to end (ms)', { p50: pct(50), p95: pct(95), p99: pct(99), max: lat.at(-1) });
    expect(lat).toHaveLength(200);
    expect(pct(95)).toBeLessThan(10_000);
  });

  it('200 concurrent asks all run to completion', async () => {
    P.setBrain((v) => (v.calls === 0 ? { tool: toolName('ledger.report.pnl'), args: { from: '2026-08-01', to: '2026-08-31' } } : { tool: toolName('job.finish'), args: { outcome: 'done', summary: 'ok' } }));
    const t0 = Date.now();
    const asks = await Promise.all(Array.from({ length: 200 }, (_, i) => P.api('POST', '/api/ask', { text: `load ${i}`, app: 'ledger' })));
    const ids = asks.map((a) => a.body.task_id);
    await P.waitFor(async () => {
      const r = await P.platform.db.query("select count(*)::int as n from neos.tasks where id = any($1) and status = 'COMPLETED'", [ids]);
      return r.rows[0].n === 200;
    }, '200 completed', 600_000);
    console.log(`200 jobs completed in ${Date.now() - t0} ms`);
  });
});

describe('chaos', () => {
  let P: Pilot;
  beforeAll(async () => {
    P = await bootPilot({ poolSize: 10, timings: { claimMs: 1_500, heartbeatMs: 300, maxAttempts: 200 } });
  });
  afterAll(async () => P?.close());

  it('zero lost jobs and zero duplicate executions across 50 forced restarts', async () => {
    const r = await chaosRun(P, { jobs: 60, restarts: 50, intervalMs: 300, timeoutMs: 600_000 });
    console.log('chaos', { completed: r.completed, done: r.done, mails: r.mails, jobs: r.jobs });
    expect(r.completed).toBe(60);
    expect(r.doubleExecuted).toEqual([]);
    expect(r.duplicateResults).toEqual([]);
    expect(r.mails).toBe(r.done);
  });
});
