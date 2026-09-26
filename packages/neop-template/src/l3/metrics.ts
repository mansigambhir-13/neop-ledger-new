import { Metrics } from '@neop/contracts';
import type { Core } from '../core.ts';

/** Backend metrics: in-process counters/histograms plus book state at scrape time (runner role, all companies). */
export async function renderBackendMetrics(core: Core): Promise<string> {
  const q = async (sql: string) => (await core.runnerPool.query(sql)).rows;
  const s = core.key;
  const g = [
    Metrics.lines('neop_jobs', 'Jobs by status', 'gauge', (await q(`select status, count(*)::int as n from ${s}.jobs group by 1`)).map((r) => ({ labels: { app: s, status: r.status }, value: r.n }))),
    Metrics.lines('neop_waits_open', 'Open waits by kind', 'gauge', (await q(`select kind, count(*)::int as n from ${s}.waits where status <> 'consumed' group by 1`)).map((r) => ({ labels: { app: s, kind: r.kind }, value: r.n }))),
    Metrics.lines('neop_execute_outcomes', 'Carried-out proposals by outcome', 'gauge', (await q(`select status, count(*)::int as n from ${s}.proposals where status in ('DONE','FAILED','UNKNOWN','EXECUTING') group by 1`)).map((r) => ({ labels: { app: s, outcome: r.status }, value: r.n }))),
    Metrics.lines('neop_outbox_unacked', 'Outbox events not yet acknowledged by the platform', 'gauge', (await q(`select count(*)::int as n from ${s}.outbox where id > (select cursor from ${s}.outbox_acked where id = 1)`)).map((r) => ({ labels: { app: s }, value: r.n }))),
  ];
  return (await core.metrics.render()) + g.join('\n') + '\n';
}
