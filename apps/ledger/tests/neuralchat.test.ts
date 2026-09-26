// NeuralChat's app choice (step 3, 5a): a model reasons over the installed apps'
// registry context through the platform's LLM proxy, under a platform budget, and
// must answer {app, reason} naming an installed app. Without a model, or when the
// model fails or names something not installed, the keyword picker decides — and
// the task and the audit say so.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { marketingApp, seedMarketing } from '@neop/marketing';
import { pickApp } from '@neop/platform';
import { bootPilot, fakeAnthropic, ledgerUnderTest, toolName, type FakeUpstream, type Pilot, type UpstreamView } from './harness.ts';

let P: Pilot;
let U: FakeUpstream;
let routed: UpstreamView[] = [];
let answer: (v: UpstreamView) => { tool: string; args: unknown } | { text: string };

beforeAll(async () => {
  U = await fakeAnthropic();
  U.setBrain((v) => {
    if (v.tools.includes('choose_app')) {
      routed.push(v);
      return answer(v);
    }
    return { tool: toolName('job.finish'), args: { outcome: 'done', summary: 'handled' } }; // the chosen app's assistant
  });
  P = await bootPilot({ apps: [await ledgerUnderTest(), { def: await marketingApp(), seed: seedMarketing }], llmUpstream: { url: U.url, apiKey: U.apiKey } });
  P.platform.routerModel = 'claude-sonnet-5';
});
afterAll(async () => {
  await P?.close();
  await U?.close();
});

// Its words are the Ledger's (bank, reconciliation, month, close, checklist, accounts);
// what it asks for is a social campaign — Marketing's subject.
const ASK = 'Run a social campaign promoting our month-end close checklist and bank reconciliation guide to accounts teams';

describe('NeuralChat routing', () => {
  it('a model picks the app that fits the meaning, even when the words overlap another app; the choice is recorded as the model’s', async () => {
    const ctx = await P.platform.registryContext(P.company.id);
    expect(pickApp(ASK, ctx)).toBe('ledger'); // the keyword stand-in would get this wrong
    routed = [];
    answer = () => ({ tool: 'choose_app', args: { app: 'marketing', reason: 'This asks for a promotional social campaign; the finance words are only its topic.' } });
    const r = await P.api('POST', '/api/ask', { text: ASK });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ handed_to: 'marketing', routed_by: 'model' });
    // The model was given the registry context and the ask, and forced to answer with choose_app.
    expect(routed).toHaveLength(1);
    const prompt = JSON.stringify(routed[0]!.messages);
    for (const s of ['Ledger', 'Marketing', 'ledger', 'marketing']) expect(prompt).toContain(s);
    expect(prompt).toContain(ctx.find((a) => a.key === 'marketing')!.abilities[0]!.title);
    expect(prompt).toContain('month-end close checklist');
    const task = (await P.platform.db.query('select app_key, routed_by, route_reason from neos.tasks where id = $1', [r.body.task_id])).rows[0];
    expect(task).toEqual({ app_key: 'marketing', routed_by: 'model', route_reason: 'This asks for a promotional social campaign; the finance words are only its topic.' });
    const audit = (await P.platform.db.query("select outcome, detail from neos.audit where action = 'neuralchat.routed' order by id desc limit 1")).rows[0];
    expect(audit).toMatchObject({ outcome: 'model', detail: { app: 'marketing' } });
    // Metered under the platform's own budget, not an app's.
    const usage = (await P.platform.db.query("select app_key, outcome from neos.llm_usage where app_key = 'neuralchat'")).rows;
    expect(usage).toEqual([{ app_key: 'neuralchat', outcome: 'settled' }]);
    await P.waitFor(async () => (await P.task(r.body.task_id)).task.status === 'COMPLETED', 'marketing handled it');
  });

  it('a model answer naming an app that is not installed is refused: the keyword picker decides, and the record says so', async () => {
    answer = () => ({ tool: 'choose_app', args: { app: 'payroll', reason: 'sounds like wages' } });
    const r = await P.api('POST', '/api/ask', { text: 'Show me the P&L for August' });
    expect(r.body).toMatchObject({ handed_to: 'ledger', routed_by: 'keyword' });
    expect(r.body.route_reason).toMatch(/keyword fallback: the routing model failed .*not installed/);
    const task = (await P.platform.db.query('select routed_by, route_reason from neos.tasks where id = $1', [r.body.task_id])).rows[0];
    expect(task.routed_by).toBe('keyword');
    expect(task.route_reason).toContain('payroll');
  });

  it('a model that answers in prose instead of the structured choice is not trusted either', async () => {
    answer = () => ({ text: 'I think marketing, probably.' });
    const r = await P.api('POST', '/api/ask', { text: 'Show me the P&L for August' });
    expect(r.body).toMatchObject({ handed_to: 'ledger', routed_by: 'keyword' });
    expect(r.body.route_reason).toMatch(/did not call choose_app/);
  });

  it('"none" from the model hands nothing over', async () => {
    answer = () => ({ tool: 'choose_app', args: { app: 'none', reason: 'nothing installed does travel bookings' } });
    const r = await P.api('POST', '/api/ask', { text: 'Book me a flight to Mumbai' });
    expect(r.body).toMatchObject({ handed_to: null, routed_by: 'model', route_reason: 'nothing installed does travel bookings' });
  });

  it('with no routing model configured, the keyword picker is used and recorded as the fallback', async () => {
    P.platform.routerModel = null;
    routed = [];
    try {
      const r = await P.api('POST', '/api/ask', { text: ASK });
      expect(r.body).toMatchObject({ handed_to: 'ledger', routed_by: 'keyword' });
      expect(r.body.route_reason).toBe('keyword fallback: no routing model is configured');
      expect(routed).toHaveLength(0);
      const audit = (await P.platform.db.query("select outcome from neos.audit where action = 'neuralchat.routed' order by id desc limit 1")).rows[0];
      expect(audit.outcome).toBe('keyword');
    } finally {
      P.platform.routerModel = 'claude-sonnet-5';
    }
  });

  it('naming the app explicitly skips routing and is recorded as explicit; the platform principal cannot be registered as an app', async () => {
    const r = await P.api('POST', '/api/ask', { text: 'Anything', app: 'ledger' });
    expect(r.body.routed_by).toBe('explicit');
    await expect(
      P.platform.registerApp({ key: 'neuralchat', l3_url: 'http://x', manifest: P.backend.core.manifest, service_secret: 'x'.repeat(40) }),
    ).rejects.toMatchObject({ code: 'reserved_key' });
    // Never listed or routed to as an app.
    expect((await P.api('GET', '/api/apps')).body.apps.map((a: any) => a.key)).not.toContain('neuralchat');
  });
});
