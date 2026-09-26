// switchboard.test · off = not shown AND refused; a company can only tighten;
// a change takes effect on the next call, not in 30 seconds.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootPilot, call, finish, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => P?.close());

it('a company cannot loosen the app floor', async () => {
  const r = await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.journal.post': 'on' } });
  expect(r.status).toBe(422);
  expect(r.body.error.code).toBe('cannot_loosen');
  const m = await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.report.pnl': 'off' } }, P.member.token);
  expect(m.status).toBe(403);
});

it('off means not shown to the assistant and refused even by name', async () => {
  // Warm the gate's cache, then switch off; the next call must already see it.
  let tools: string[] = [];
  P.setBrain((v) => {
    tools = v.tools;
    return finish('ok');
  });
  const t1 = await P.ask('warm up');
  await P.waitFor(async () => (await P.task(t1.task_id)).task.status === 'COMPLETED', 'warm');
  expect(tools).toContain('ledger__report__cash_flow');

  const r = await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.report.cash_flow': 'off' } });
  expect(r.status).toBe(200);

  let refusal = '';
  P.setBrain((v) => {
    if (v.calls === 0) {
      tools = v.tools;
      return call('ledger.report.cash_flow', { from: '2026-08-01', to: '2026-08-31' });
    }
    refusal = v.results[0]!.text;
    return finish('cash flow is switched off', 'blocked');
  });
  const t2 = await P.ask('Cash flow for August');
  await P.waitFor(async () => (await P.task(t2.task_id)).task.status === 'COMPLETED', 'done');
  expect(tools).not.toContain('ledger__report__cash_flow');
  expect(refusal).toMatch(/not found|Refused/i);

  // Even a token that still lists it (minted before the switch) is refused by the gate.
  let jobId = '';
  P.setBrain((v) => (v.calls === 0 ? { hang: true } : finish('x')));
  const t3 = await P.ask('hold');
  jobId = t3.job_id;
  const job = await P.waitFor(async () => {
    const j = await P.jobRow(jobId);
    return j.status === 'RUNNING' && j;
  }, 'running');
  const tok = await P.backend.core.jobTokens.mint({ sub: jobId, sid: job.claimed_by, company_id: P.company.id, abilities: ['ledger.report.cash_flow'] }, 60_000);
  const res = await fetch(`http://127.0.0.1:${P.backend.ports.gate}/gate/call`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'ledger.report.cash_flow', args: { from: '2026-08-01', to: '2026-08-31' } }),
  });
  expect(await res.json()).toMatchObject({ status: 'refused', code: 'switched_off' });
  P.worker.kill(jobId);

  // And the platform's read path refuses it too.
  const viaPlatform = await P.api('POST', '/api/apps/ledger/read/ledger.report.cash_flow', { from: '2026-08-01', to: '2026-08-31' });
  expect(viaPlatform.status).toBe(403);
});
