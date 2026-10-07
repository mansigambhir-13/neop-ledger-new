// observability.test · V3: one trace follows a person's ask through NeuralChat and Matrix into the runner,
// assistant, LLM proxy, gate, approval and door; the Prometheus endpoints expose only current runtime metrics.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeAnthropic, fakeCollector, type FakeUpstream } from '@neop/testkit';
import { bootPilot, type Pilot } from './harness.ts';

let C: Awaited<ReturnType<typeof fakeCollector>>;
// NeuralChat speaks Matrix: the trace rides in the typed task event — neos.ask → neuralchat.task (the post) and presence.task (the app
// opening the job from the event) → the runner, the assistant, the LLM proxy, the gate, the yes, the door.
describe('tracing through Matrix (NEOP presence + NeuralChat’s typed task)', () => {
  let Q: Pilot;
  let V: FakeUpstream;
  beforeAll(async () => {
    C = await fakeCollector();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = C.url; // every tracer reads it at construction
    V = await fakeAnthropic();
    Q = await bootPilot({ llmUpstream: { url: V.url, apiKey: V.apiKey }, presence: 'appservice', neuralchat: true });
  }, 180_000);
  afterAll(async () => {
    await Q?.close();
    await V?.close();
    await C?.close();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  }, 120_000);

  it('one trace id from the ask to the door, with no gateway hop to open the job', async () => {
    V.setBrain((v) => {
      if (v.job.includes('WOKEN')) return v.results.length === 0 ? { tool: 'job__finish', args: { outcome: 'done', summary: 'sent' } } : { text: 'ok' };
      if (v.results.length === 0) {
        return {
          tool: 'ledger__close_pack__email',
          args: { period: { from: '2026-08-01', to: '2026-08-31' }, to: ['cfo@acme.example'], card: { what: 'Send pack', why: 'close', changes: 'one email', if_no_answer: 'nothing' } },
        };
      }
      return { text: 'waiting' };
    });
    const r = await Q.api('POST', '/api/ask', { text: 'Send the August close pack to the CFO', app: 'ledger' });
    const card = await Q.waitFor(async () => (await Q.desk()).find((c) => c.task_id === r.body.task_id && c.status === 'PENDING'), 'card', 30_000);
    await Q.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    await Q.waitFor(async () => (await Q.task(r.body.task_id)).task.status === 'COMPLETED', 'completed', 30_000);
    const traceId = String((await Q.platform.db.query('select trace_parent from neos.tasks where id = $1', [r.body.task_id])).rows[0].trace_parent).split('-')[1];
    const want = ['neos.ask', 'neuralchat.task', 'presence.task', 'runner.spawn', 'agent.session', 'llm.messages', 'agent.tool ledger.close_pack.email', 'gate ledger.close_pack.email', 'runner.approved', 'door ledger.close_pack.email'];
    await Q.waitFor(async () => {
      const inT = C.spans.filter((s) => s.traceId === traceId);
      const names = new Set(inT.map((s) => s.name));
      const ids = new Set(inT.map((s) => s.spanId));
      return want.every((w) => names.has(w)) && inT.every((s) => s.name === 'neos.ask' || ids.has(s.parentSpanId!));
    }, 'every hop in one trace', 30_000);
    const inTrace = C.spans.filter((s) => s.traceId === traceId);
    expect(inTrace.some((s) => s.name === 'gateway tasks.open' || s.name === 'l3 tasks.open')).toBe(false); // the job was opened from the event
    expect(new Set(inTrace.map((s) => s.service))).toEqual(new Set(['neos-platform', 'neop-ledger', 'neop-agent-ledger', 'neos-llm-proxy']));
    // NeuralChat read the app's thread in the same trace.
    expect(inTrace.some((s) => /^neuralchat\.read /.test(s.name))).toBe(true);
    // Parent links and the operation's stored trace preserve the audit chain.
    const ids = new Set(inTrace.map((s) => s.spanId));
    for (const s of inTrace) if (s.name !== 'neos.ask') expect(ids.has(s.parentSpanId!), `${s.name} parent`).toBe(true);
    const op = await Q.backend.core.runnerPool.query("select trace_id from ledger.operations where ability_key = 'ledger.close_pack.email' order by id desc limit 1");
    expect(op.rows[0].trace_id).toContain(traceId);
  });

  it('platform and app expose the V3 dashboard metrics', async () => {
    const plat = await (await fetch(`${Q.platformUrl}/metrics`)).text();
    expect(plat).toMatch(/neop_tasks\{app="ledger",status="COMPLETED"\} \d+/);
    expect(plat).toMatch(/neop_approvals\{app="ledger",status="EXECUTED"\} \d+/);
    expect(plat).toContain('neop_tasks_unacknowledged');
    expect(plat).toContain('neop_llm_spend_usd_today');
    expect(plat).not.toContain('neop_gateway_');
    const app = await (await fetch(`http://127.0.0.1:${Q.backend.ports.files}/metrics`)).text();
    expect(app).toMatch(/neop_jobs\{app="ledger",status="DONE"\} \d+/);
    expect(app).toMatch(/neop_execute_total\{ability="ledger.close_pack.email",app="ledger",outcome="DONE"\} 1/);
    expect(app).toMatch(/neop_gate_decisions_total\{/);
    expect(app).toMatch(/neop_outbox_unmirrored\{app="ledger"\} \d+/);
  });
});
