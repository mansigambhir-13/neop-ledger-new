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
    // The last call settles when its stream is drained, which may be just after the job reports: wait for the meter, not a clock.
    const usage = await P.waitFor(async () => {
      const u = await P.platform.db.query("select outcome, cost_micros, input_tokens, output_tokens from neos.llm_usage where job_id = $1 order by id", [r.body.job_id]);
      return u.rows.length === U.calls.length && u;
    }, 'every call settled');
    expect(usage.rows.every((u: any) => u.outcome === 'settled')).toBe(true);
    // 1,200 input tokens at $3/MTok + 80 output tokens at $15/MTok = 3,600 + 1,200 micro-dollars per call.
    expect(Number(usage.rows[0].cost_micros)).toBe(4_800);
    const s = await P.waitFor(async () => {
      const s = await P.platform.db.query('select spent_micros, reserved_micros from neos.llm_sessions where job_id = $1', [r.body.job_id]);
      return Number(s.rows[0]?.reserved_micros) === 0 && s;
    }, 'reservation released');
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
    // Final, not transient (S9): one refused call, no retries, and the person is told which cap.
    expect(t.task.result.summary).toMatch(/NEOS budget reached — the model budget for this job \(\$0\.01\) is used up/);
    expect(U.calls.length).toBe(before); // the worst-case reservation did not fit: nothing went upstream
    expect((await P.jobRow(r.body.job_id)).attempts).toBe(0);
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
    const t = await P.waitFor(async () => {
      const t = await P.task(r.body.task_id);
      return t.task.status === 'FAILED' && t;
    }, 'failed on day cap');
    expect(t.task.result.summary).toMatch(/NEOS budget reached — today's model budget/);
    expect(U.calls.length).toBe(before);
    const refused = await P.platform.db.query("select count(*)::int as n from neos.llm_usage where job_id = $1 and outcome = 'refused_budget'", [r.body.job_id]);
    expect(refused.rows[0].n).toBeGreaterThan(0);
    await P.api('PUT', '/api/switchboards/ledger', { budget: { per_day_usd: 50 } });
  });

  it('the job budget holds across sessions: a crashed session does not hand the next one a fresh budget (S9)', async () => {
    // Make every call cost more than its reservation, so each charges exactly its worst case E.
    U.usage.output = 20_000;
    try {
      // Measure E with a one-call probe job.
      U.setBrain(() => ({ tool: 'job__finish', args: { outcome: 'done', summary: 'probe' } }));
      const probe = await P.api('POST', '/api/ask', { text: 'P&L for August 2026', app: 'ledger' });
      await P.waitFor(async () => (await P.task(probe.body.task_id)).task.status === 'COMPLETED', 'probe done');
      const e = await P.waitFor(async () => {
        const u = await P.platform.db.query("select cost_micros from neos.llm_usage where job_id = $1 and outcome = 'settled'", [probe.body.job_id]);
        return u.rows[0] && Number(u.rows[0].cost_micros);
      }, 'probe metered');
      // Room for two calls, not three — per job, whatever the number of sessions.
      await P.api('PUT', '/api/switchboards/ledger', { budget: { per_job_usd: (2.5 * e) / 1_000_000 } });
      let jobId = '';
      let killed = false;
      let calls = 0;
      U.setBrain((v) => {
        calls++;
        if (v.results.length >= 1 && jobId && !killed) {
          killed = true;
          P.worker.kill(jobId); // the session dies mid-call: no session.end, the claim runs out
        }
        return { tool: 'ledger__report__pnl', args: { from: '2026-08-01', to: '2026-08-31' } };
      });
      const r = await P.api('POST', '/api/ask', { text: 'P&L for August 2026', app: 'ledger' });
      jobId = r.body.job_id;
      const t = await P.waitFor(async () => {
        const t = await P.task(r.body.task_id);
        return t.task.status === 'FAILED' && t;
      }, 'failed on the job budget in the second session', 20_000);
      expect(killed).toBe(true);
      expect(t.task.result.summary).toMatch(/the model budget for this job \(\$[0-9.]+\) is used up/);
      const job = await P.jobRow(jobId);
      expect(job.attempts).toBe(1); // the second session ran, and was refused
      expect(calls).toBe(2); // two calls fit the job's budget; the second session got none
      const rows = await P.waitFor(async () => {
        const u = await P.platform.db.query('select sid, outcome from neos.llm_usage where job_id = $1 order by id', [jobId]);
        return u.rows.filter((x: any) => x.outcome === 'settled').length === 2 && u.rows;
      }, 'both upstream calls settled, the killed one too');
      expect(new Set(rows.map((x: any) => x.sid)).size).toBe(2); // two sessions, one budget
      expect(rows.at(-1).outcome).toBe('refused_budget');
      // The meter, not the agent, is what the book shows as the job's spend.
      expect(Number(job.spend_micros)).toBeGreaterThan(0);
      const s = await P.platform.db.query('select coalesce(sum(reserved_micros), 0)::int as r from neos.llm_sessions where job_id = $1', [jobId]);
      expect(s.rows[0].r).toBe(0); // the killed call's reservation was settled, not leaked
    } finally {
      U.usage.output = 80;
      await P.api('PUT', '/api/switchboards/ledger', { budget: { per_job_usd: 5 } });
    }
  });

  it('spend comes from the proxy meter: a woken job whose metered spend has used its budget is not started again', async () => {
    U.setBrain((v) =>
      v.results.length === 0
        ? {
            tool: 'ledger__journal__post',
            args: {
              date: '2026-08-31',
              memo: 'metered budget probe',
              currency: 'INR',
              lines: [
                { account_code: '6300', debit_minor: 1000, credit_minor: 0 },
                { account_code: '2000', debit_minor: 0, credit_minor: 1000 },
              ],
              card: { what: 'Post a probe', why: 'test', changes: 'One entry', if_no_answer: 'Nothing' },
            },
          }
        : { text: 'waiting' },
    );
    const r = await P.api('POST', '/api/ask', { text: 'Post the probe', app: 'ledger' });
    const card = await P.waitFor(async () => (await P.desk()).find((c: any) => c.job_id === r.body.job_id && c.status === 'PENDING'), 'card');
    const metered = await P.waitFor(async () => {
      const u = await P.platform.db.query("select coalesce(sum(cost_micros), 0)::int as c, count(*)::int as n from neos.llm_usage where job_id = $1 and outcome = 'settled'", [r.body.job_id]);
      return u.rows[0].n >= 1 && u.rows[0].c;
    }, 'metered');
    // The budget is lowered below what the job has already spent, then the person answers.
    await P.api('PUT', '/api/switchboards/ledger', { budget: { per_job_usd: metered / 2 / 1_000_000 } });
    try {
      const before = U.calls.length;
      await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'no', fingerprint_seen: card.fingerprint });
      const t = await P.waitFor(async () => {
        const t = await P.task(r.body.task_id);
        return t.task.status === 'FAILED' && t;
      }, 'failed before starting');
      expect(t.task.result.summary).toMatch(/^Stopped: NEOS budget reached — the model budget for this job \(\$[0-9.]+\) is used up/);
      expect(U.calls.length).toBe(before); // no session was started: nothing reached the model
      const refused = await P.platform.db.query("select count(*)::int as n from neos.llm_usage where job_id = $1 and outcome = 'refused_budget'", [r.body.job_id]);
      expect(refused.rows[0].n).toBe(0); // the runner decided from the meter, before the proxy had to refuse
      expect(Number((await P.jobRow(r.body.job_id)).spend_micros)).toBe(metered); // the book mirrors the meter
    } finally {
      await P.api('PUT', '/api/switchboards/ledger', { budget: { per_job_usd: 5 } });
    }
  });
});
