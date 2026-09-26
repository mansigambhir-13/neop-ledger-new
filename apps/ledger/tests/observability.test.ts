// observability.test · R13: one trace follows a person's ask through the
// gateway, L3, runner, assistant, LLM proxy, gate, approval and door; and the
// Prometheus endpoints expose the plan's dashboard numbers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeAnthropic, fakeCollector, type FakeUpstream } from '@neop/testkit';
import { bootPilot, type Pilot } from './harness.ts';

let P: Pilot;
let U: FakeUpstream;
let C: Awaited<ReturnType<typeof fakeCollector>>;
beforeAll(async () => {
  C = await fakeCollector();
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = C.url; // every tracer reads it at construction
  U = await fakeAnthropic();
  P = await bootPilot({ llmUpstream: { url: U.url, apiKey: U.apiKey } });
});
afterAll(async () => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  await P?.close();
  await U?.close();
  await C?.close();
});

const traceOf = (name: string, where: (s: any) => boolean = () => true) => C.spans.find((s) => s.name === name && where(s))?.traceId;

describe('tracing', () => {
  it('one trace id from the ask to the door, across platform, app, agent and LLM proxy', async () => {
    U.setBrain((v) => {
      if (v.job.includes('WOKEN')) return v.results.length === 0 ? { tool: 'job__finish', args: { outcome: 'done', summary: 'sent' } } : { text: 'ok' };
      if (v.results.length === 0) {
        return {
          tool: 'ledger__close_pack__email',
          args: { period: { from: '2026-08-01', to: '2026-08-31' }, to: ['cfo@acme.example'], card: { what: 'Send pack', why: 'close', changes: 'one email', if_no_answer: 'nothing' } },
        };
      }
      return { text: 'waiting' };
    });
    const r = await P.api('POST', '/api/ask', { text: 'Send the August close pack to the CFO', app: 'ledger' });
    const card = await P.waitFor(async () => (await P.desk()).find((c) => c.task_id === r.body.task_id && c.status === 'PENDING'), 'card');
    await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    await P.waitFor(async () => (await P.task(r.body.task_id)).task.status === 'COMPLETED', 'completed');
    const want = [
      'neos.ask',
      'gateway tasks.open',
      'l3 tasks.open',
      'runner.spawn',
      'agent.session',
      'llm.messages',
      'agent.tool ledger.close_pack.email',
      'gate ledger.close_pack.email',
      'gateway proposals.resolve',
      'gateway proposals.execute',
      'l3 proposals.execute',
      'door ledger.close_pack.email',
    ];
    const root = await P.waitFor(async () => {
      const id = traceOf('neos.ask');
      if (!id) return null;
      const inT = C.spans.filter((s) => s.traceId === id);
      const names = new Set(inT.map((s) => s.name));
      const ids = new Set(inT.map((s) => s.spanId));
      // Spans export in batches; wait until every parent has arrived too.
      return want.every((w) => names.has(w)) && inT.every((s) => s.name === 'neos.ask' || ids.has(s.parentSpanId!)) && id;
    }, 'every hop in one trace', 20_000);
    const inTrace = C.spans.filter((s) => s.traceId === root);
    expect(new Set(inTrace.map((s) => s.service))).toEqual(new Set(['neos-gateway', 'neop-ledger', 'neop-agent-ledger', 'neos-llm-proxy']));
    // Parent links hold: every span except the root has its parent in the same trace.
    const ids = new Set(inTrace.map((s) => s.spanId));
    for (const s of inTrace) if (s.name !== 'neos.ask') expect(ids.has(s.parentSpanId!), `${s.name} parent`).toBe(true);
    // The operation row carries the trace too.
    const op = await P.backend.core.runnerPool.query("select trace_id from ledger.operations where ability_key = 'ledger.close_pack.email' order by id desc limit 1");
    expect(op.rows[0].trace_id).toContain(root);
  });
});

describe('metrics', () => {
  it('platform and app expose the dashboard numbers', async () => {
    const plat = await (await fetch(`${P.platformUrl}/metrics`)).text();
    expect(plat).toMatch(/neop_gateway_calls_total\{app="ledger",endpoint="tasks.open",status="200"\} \d+/);
    expect(plat).toMatch(/neop_gateway_latency_seconds_bucket\{/);
    expect(plat).toMatch(/neop_tasks\{app="ledger",status="COMPLETED"\} \d+/);
    expect(plat).toMatch(/neop_llm_spend_usd_today\{/);
    const app = await (await fetch(`http://127.0.0.1:${P.backend.ports.l3}/l3/metrics`)).text();
    expect(app).toMatch(/neop_job_ack_seconds_bucket\{app="ledger",le="0.3"\} \d+/);
    expect(app).toMatch(/neop_jobs\{app="ledger",status="DONE"\} \d+/);
    expect(app).toMatch(/neop_execute_total\{ability="ledger.close_pack.email",app="ledger",outcome="DONE"\} 1/);
    expect(app).toMatch(/neop_gate_decisions_total\{/);
  });
});
