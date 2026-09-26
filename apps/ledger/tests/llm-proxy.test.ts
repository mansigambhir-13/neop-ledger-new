// llm-proxy.test · R1: the agent holds no provider key; spend is metered and
// capped where the key lives (reserve-then-settle), not by the agent's report.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, type Pilot } from './harness.ts';
import { fakeAnthropic, type FakeUpstream } from './harness.ts';

let P: Pilot;
let U: FakeUpstream;
beforeAll(async () => {
  U = await fakeAnthropic();
  P = await bootPilot({ llmUpstream: { url: U.url, apiKey: U.apiKey } });
});
afterAll(async () => {
  await P?.close();
  await U?.close();
});

describe('LLM proxy', () => {
  it('a real Anthropic-protocol session runs a job end to end with no key in the agent', async () => {
    U.setBrain((v) => {
      if (v.results.length === 0) return { tool: 'ledger__report__pnl', args: { from: '2026-08-01', to: '2026-08-31' } };
      if (v.results.length === 1) return { tool: 'job__finish', args: { outcome: 'done', summary: 'August P&L read through the proxy.' } };
      return { text: 'done' };
    });
    const r = await P.api('POST', '/api/ask', { text: 'P&L for August 2026', app: 'ledger' });
    await P.waitFor(async () => (await P.task(r.body.task_id)).task.status === 'COMPLETED', 'completed');
    // Upstream only ever saw the provider key — presented by the proxy, never by the agent.
    expect(U.calls.length).toBeGreaterThanOrEqual(2);
    for (const c of U.calls) expect(c.apiKey).toBe(U.apiKey);
    const usage = await P.platform.db.query("select outcome, cost_micros, input_tokens, output_tokens from neos.llm_usage where job_id = $1 order by id", [r.body.job_id]);
    expect(usage.rows.length).toBe(U.calls.length);
    expect(usage.rows.every((u: any) => u.outcome === 'settled')).toBe(true);
    // 1,200 input tokens at $3/MTok + 80 output tokens at $15/MTok = 3,600 + 1,200 micro-dollars per call.
    expect(Number(usage.rows[0].cost_micros)).toBe(4_800);
    const s = await P.platform.db.query('select spent_micros, reserved_micros from neos.llm_sessions where job_id = $1', [r.body.job_id]);
    expect(Number(s.rows[0].reserved_micros)).toBe(0);
    expect(Number(s.rows[0].spent_micros)).toBe(4_800 * U.calls.length);
  });

  it('refuses a call that would pass the job budget, before any upstream call', async () => {
    await P.api('PUT', '/api/switchboards/ledger', { budget: { per_job_usd: 0.01 } });
    U.setBrain((v) => (v.results.length === 0 ? { tool: 'ledger__report__pnl', args: { from: '2026-08-01', to: '2026-08-31' } } : { text: 'x' }));
    const before = U.calls.length;
    const r = await P.api('POST', '/api/ask', { text: 'P&L for August 2026', app: 'ledger' });
    const t = await P.waitFor(async () => {
      const t = await P.task(r.body.task_id);
      return t.task.status === 'FAILED' && t;
    }, 'failed on budget');
    expect(t.task.result.summary).toMatch(/budget|402|stopped/i);
    expect(U.calls.length).toBe(before); // the worst-case reservation did not fit: nothing went upstream
    const refused = await P.platform.db.query("select count(*)::int as n from neos.llm_usage where job_id = $1 and outcome = 'refused_budget'", [r.body.job_id]);
    expect(refused.rows[0].n).toBeGreaterThan(0);
    await P.api('PUT', '/api/switchboards/ledger', { budget: { per_job_usd: 5 } });
  });

  it('refuses forged, foreign and missing tokens', async () => {
    const url = `${P.platformUrl}/llm/v1/messages`;
    const body = JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': U.apiKey }, body })).status).toBe(401);
    const gatewayToken = await P.platform.gateway.mint({ aud: 'ledger', sub: 'platform', company_id: P.company.id, ability: 'tasks.open', idem_key: 'k' });
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': gatewayToken }, body })).status).toBe(401);
  });

  it('the daily cap holds across jobs for the company and app, enforced by the proxy', async () => {
    // Room for the runner's own check (spend so far) but not for one worst-case call at the proxy.
    const spent = Number((await P.platform.db.query("select coalesce(sum(spent_micros), 0) as s from neos.llm_days where app_key = 'ledger'")).rows[0].s);
    await P.api('PUT', '/api/switchboards/ledger', { budget: { per_day_usd: (spent + 20_000) / 1_000_000 } });
    U.setBrain(() => ({ text: 'x' }));
    const before = U.calls.length;
    const r = await P.api('POST', '/api/ask', { text: 'P&L for August 2026', app: 'ledger' });
    await P.waitFor(async () => (await P.task(r.body.task_id)).task.status === 'FAILED', 'failed on day cap');
    expect(U.calls.length).toBe(before);
    const refused = await P.platform.db.query("select count(*)::int as n from neos.llm_usage where job_id = $1 and outcome = 'refused_budget'", [r.body.job_id]);
    expect(refused.rows[0].n).toBeGreaterThan(0);
    await P.api('PUT', '/api/switchboards/ledger', { budget: { per_day_usd: 50 } });
  });
});
