import {sqlIdent} from '@neop/pgkit';
import { Metrics } from '@neop/contracts';
import type { Core } from '../core.ts';

/** Backend metrics: in-process counters/histograms plus book state at scrape time (runner role, all companies). */
export async function renderBackendMetrics(core: Core): Promise<string> {
  const q = async (sql: string) => (await core.runnerPool.query(sql)).rows;
  const s = core.key;
  const g = [
    Metrics.lines('neop_jobs', 'Jobs by status', 'gauge', (await q(`select status, count(*)::int as n from ${sqlIdent(s)}.jobs group by 1`)).map((r) => ({ labels: { app: s, status: r.status }, value: r.n }))),
    Metrics.lines('neop_waits_open', 'Open waits by kind', 'gauge', (await q(`select kind, count(*)::int as n from ${sqlIdent(s)}.waits where status <> 'consumed' group by 1`)).map((r) => ({ labels: { app: s, kind: r.kind }, value: r.n }))),
    Metrics.lines('neop_execute_outcomes', 'Carried-out proposals by outcome', 'gauge', (await q(`select status, count(*)::int as n from ${sqlIdent(s)}.proposals where status in ('DONE','FAILED','UNKNOWN','EXECUTING') group by 1`)).map((r) => ({ labels: { app: s, outcome: r.status }, value: r.n }))),
    // v3 S9: the outbox is read by this app's own presence mirror only; what it has not said yet, per company cursor.
    Metrics.lines(
      'neop_outbox_unmirrored',
      'Outbox events the presence mirror has not said in Matrix yet',
      'gauge',
      (await q(`select count(*)::int as n from ${sqlIdent(s)}.outbox o join ${sqlIdent(s)}.presence_mirror m on m.company_id = o.company_id where o.id > m.cursor`)).map((r) => ({ labels: { app: s }, value: r.n })),
    ),
  ];
  return (await core.metrics.render()) + g.join('\n') + '\n';
}
