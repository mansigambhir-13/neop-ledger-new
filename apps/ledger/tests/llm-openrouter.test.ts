// llm-openrouter.test · the LLM proxy in front of OpenRouter's Anthropic-compatible API:
// the key goes as a Bearer token, the model id gains the provider prefix upstream, and
// pricing, caps and the agent-facing model id are unchanged.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, fakeAnthropic, type FakeUpstream, type Pilot } from './harness.ts';

let P: Pilot;
let U: FakeUpstream;
beforeAll(async () => {
  U = await fakeAnthropic({ apiKey: 'sk-or-v1-test-key' });
  P = await bootPilot({ llmUpstream: { url: U.url, apiKey: U.apiKey, auth: 'bearer', modelPrefix: 'anthropic/' } });
});
afterAll(async () => {
  await P?.close();
  await U?.close();
});

describe('LLM proxy · OpenRouter mode', () => {
  it('sends a Bearer key and the prefixed model; meters by the agent-facing model', async () => {
    U.setBrain((v) => {
      if (v.results.length === 0) return { tool: 'ledger__report__pnl', args: { from: '2026-08-01', to: '2026-08-31' } };
      if (v.results.length === 1) return { tool: 'job__finish', args: { outcome: 'done', summary: 'August P&L via OpenRouter.' } };
      return { text: 'done' };
    });
    const r = await P.api('POST', '/api/ask', { text: 'P&L for August 2026', app: 'ledger' });
    await P.waitFor(async () => (await P.task(r.body.task_id)).task.status === 'COMPLETED', 'completed');
    expect(U.calls.length).toBeGreaterThanOrEqual(2);
    for (const c of U.calls) {
      expect(c.auth).toBe('bearer');
      expect(c.apiKey).toBe(U.apiKey);
      expect(c.model).toBe('anthropic/claude-sonnet-5');
    }
    const usage = await P.platform.db.query('select model, outcome, cost_micros from neos.llm_usage where job_id = $1', [r.body.job_id]);
    expect(usage.rows.every((u: any) => u.model === 'claude-sonnet-5' && u.outcome === 'settled' && Number(u.cost_micros) > 0)).toBe(true);
  });
});
