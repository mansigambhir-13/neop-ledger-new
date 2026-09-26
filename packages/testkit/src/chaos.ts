// Chaos and load scenarios shared by the quick suite and `pnpm test:load`.
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { toolName } from '@neop/template';
import type { Pilot } from './pilot.ts';

const t = (key: string, args: unknown = {}) => ({ tool: toolName(key), args });

/**
 * Jobs (half of them gated writes that a person approves) run while the app
 * backend is forcibly restarted again and again. Returns what an operator
 * would check: every task terminal exactly once, nothing executed twice.
 */
export async function chaosRun(P: Pilot, o: { jobs: number; restarts: number; intervalMs: number; timeoutMs?: number }) {
  P.setBrain((v) => {
    const gated = v.job.includes('[gated]');
    if (v.job.includes('WOKEN')) return v.results.length === 0 ? t('job.finish', { outcome: 'done', summary: 'verified after approval' }) : { text: 'ok' };
    const ok = v.results.filter((r) => !r.isError);
    if (gated) {
      return ok.length === 0 && !v.results.some((r) => r.text.includes('Proposal '))
        ? t('ledger.close_pack.email', {
            period: { from: '2026-08-01', to: '2026-08-31' },
            to: ['cfo@acme.example'],
            card: { what: 'Send pack', why: 'chaos', changes: 'one email', if_no_answer: 'nothing' },
          })
        : { text: 'waiting' };
    }
    return ok.length === 0 ? t('ledger.report.trial_balance', { as_of: '2026-09-30' }) : t('job.finish', { outcome: 'done', summary: 'trial balance read' });
  });
  let approving = true;
  const approver = (async () => {
    while (approving) {
      for (const c of (await P.desk().catch(() => [])) ?? []) {
        if (c.status === 'PENDING') await P.api('POST', `/api/desk/${c.id}/answer`, { decision: 'yes', fingerprint_seen: c.fingerprint }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  const asks = await Promise.all(
    Array.from({ length: o.jobs }, (_, i) => P.api('POST', '/api/ask', { text: `chaos job ${i} ${i % 2 ? '[gated]' : '[read]'}`, app: P.backend.core.key })),
  );
  const taskIds = asks.map((a) => a.body.task_id as string);
  for (let i = 0; i < o.restarts; i++) {
    await new Promise((r) => setTimeout(r, o.intervalMs));
    await P.restartBackend();
  }
  const terminal = await P.waitFor(
    async () => {
      const r = await P.platform.db.query('select id, status from neos.tasks where id = any($1)', [taskIds]);
      return r.rows.every((x) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(x.status)) && r.rows;
    },
    'every task terminal',
    o.timeoutMs ?? 120_000,
  );
  approving = false;
  await approver;
  const k = P.backend.core.key;
  const q = async (sql: string) => (await P.backend.core.runnerPool.query(sql)).rows;
  return {
    tasks: terminal,
    completed: terminal.filter((x) => x.status === 'COMPLETED').length,
    jobs: await q(`select status, count(*)::int as n from ${k}.jobs group by 1`),
    doubleExecuted: await q(`select proposal_id, count(*)::int as n from ${k}.proposal_events where event like 'executed:%' group by 1 having count(*) > 1`),
    done: (await q(`select count(*)::int as n from ${k}.proposals where status = 'DONE'`))[0].n as number,
    mails: (await readdir(P.mailDir)).filter((f) => f.endsWith('.json')).length,
    duplicateResults: (await P.platform.db.query("select task_id, count(*)::int as n from neos.conversation_messages where kind = 'result' and task_id = any($1) group by 1 having count(*) > 1", [taskIds])).rows,
  };
}

/** N concurrent tasks.open calls through the gateway; returns latency percentiles in ms. */
export async function ackLoad(P: Pilot, n: number) {
  const lat: number[] = [];
  await Promise.all(
    Array.from({ length: n }, async () => {
      const t0 = performance.now();
      const r = await P.platform.gateway.call({
        caller: 'platform',
        app: P.backend.core.key,
        endpoint: 'tasks.open',
        company_id: P.company.id,
        body: { task_id: randomUUID(), ask: 'load: ack only', requester: `user:${P.admin.id}` },
        idem_key: `load:${randomUUID()}`,
      });
      if (r.status !== 200) throw new Error(`tasks.open ${r.status}`);
      lat.push(performance.now() - t0);
    }),
  );
  lat.sort((a, b) => a - b);
  const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))]!;
  return { n, p50: pct(50), p95: pct(95), p99: pct(99), max: lat[lat.length - 1]! };
}
