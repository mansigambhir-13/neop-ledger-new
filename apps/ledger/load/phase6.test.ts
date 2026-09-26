// Phase 6 exit (plan): load test with 200 concurrent jobs per app, p95 ack <
// 300 ms; zero lost jobs across 50 forced restarts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ackLoad, chaosRun, toolName } from '@neop/testkit';
import { bootPilot, type Pilot } from '../tests/harness.ts';

describe('load', () => {
  let P: Pilot;
  beforeAll(async () => {
    P = await bootPilot({ poolSize: 20, platformDbPool: 20 }); // production-sized platform pool
  });
  afterAll(async () => P?.close());

  const histogram = async (): Promise<[number, number][]> => {
    const text = await (await fetch(`http://127.0.0.1:${P.backend.ports.l3}/l3/metrics`)).text();
    return [...text.matchAll(/neop_job_ack_seconds_bucket\{app="ledger",le="([^"]+)"\} (\d+)/g)].map((m) => [m[1] === '+Inf' ? Infinity : Number(m[1]), Number(m[2])]);
  };

  it('200 concurrent new jobs: the app acknowledges with p95 under 300 ms (plan: HTTP response carries the job id)', async () => {
    await ackLoad(P, 20); // warm pools and JWKS
    const before = await histogram();
    const r = await ackLoad(P, 200);
    const after = await histogram();
    const counts = after.map(([le, n], i) => [le, n - before[i]![1]] as const);
    const total = counts.at(-1)![1];
    const p95 = counts.find(([, n]) => n >= 0.95 * total)![0];
    // End to end includes the gateway, and here the platform, app and agents share one Node process.
    console.log('app ack p95 bucket (s)', p95, 'end-to-end through the gateway (ms)', r);
    expect(total).toBe(200);
    expect(p95).toBeLessThanOrEqual(0.3);
    expect(r.p95).toBeLessThan(1_000);
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
