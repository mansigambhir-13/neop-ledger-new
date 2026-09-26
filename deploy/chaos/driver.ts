// chaos-live driver (run by scripts/chaos-live.sh on the operator's machine, against a running
// compose project). Plan Phase 6: "zero lost jobs across 50 forced restarts".
//   1. sends JOBS asks (half read-only, half gated writes a person approves) through the platform API
//   2. SIGKILLs containers RESTARTS times (backend mostly; once the agent, once the platform) and
//      starts them again — a crash, not a graceful stop
//   3. answers every card with a yes (bound to its fingerprint) while it runs
//   4. waits for every task to end and checks, from the platform's own records and the provider:
//      every task COMPLETED, exactly one result per task, one approval per gated task, EXECUTED
//      once; one email actually sent per executed approval (the provider's own count).
// Prints one JSON report; exits 1 if any check fails.
import { spawnSync } from 'node:child_process';

const E = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing ${k}`);
  return v;
};
const BASE = E('CHAOS_PLATFORM_URL').replace(/\/$/, '');
const TOKEN = E('CHAOS_TOKEN');
const JOBS = Number(E('CHAOS_JOBS', '20'));
const RESTARTS = Number(E('CHAOS_RESTARTS', '50'));
const INTERVAL = Number(E('CHAOS_INTERVAL_MS', '3000'));
const TIMEOUT = Number(E('CHAOS_TIMEOUT_MS', String(15 * 60_000)));
const COMPOSE = E('CHAOS_COMPOSE_ARGS').split('\n').filter(Boolean); // -p <proj> -f <file> ..., one per line
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string, x: Record<string, unknown> = {}) => console.error(JSON.stringify({ t: new Date().toISOString().slice(11, 19), m, ...x }));

class Refused extends Error {}
/** Retries while the platform is down or answering 5xx (it may be the one restarting); a 4xx is final. */
async function api(method: string, path: string, body?: unknown, tries = 60): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(BASE + path, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) return j;
      if (r.status < 500) throw new Refused(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
      if (i >= tries) throw new Error(`${method} ${path}: ${r.status}`);
    } catch (e) {
      if (e instanceof Refused || i >= tries) throw e;
    }
    await sleep(1000);
  }
}
const compose = (...a: string[]) => {
  const r = spawnSync('docker', ['compose', ...COMPOSE, ...a], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker compose ${a.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

const providerStats = () => JSON.parse(compose('exec', '-T', 'fakes', 'node', '-e', "fetch('http://127.0.0.1:4900/_stats').then(r=>r.text()).then(console.log)"));
const before = providerStats();
const t0 = Date.now();
const taskIds: string[] = [];
const gatedIds = new Set<string>();
let asked = 0;
/** 1. asks, in waves just before each kill, so every crash lands on work in flight. */
async function wave(n: number) {
  const out = await Promise.all(
    Array.from({ length: n }, () => {
      const i = asked++;
      return api('POST', '/api/ask', { text: `chaos job ${i} ${i % 2 ? '[gated]' : '[read]'}`, app: 'ledger' }).then((a) => ({ i, id: a.task_id as string }));
    }),
  );
  for (const { i, id } of out) {
    taskIds.push(id);
    if (i % 2) gatedIds.add(id);
  }
}

// ── 3. a person answering cards, throughout ─────────────────────────────────────────────────
let approving = true;
const answered = new Set<string>();
const approver = (async () => {
  while (approving) {
    try {
      const { cards } = await api('GET', '/api/desk', undefined, 0);
      for (const c of cards) {
        if (c.status !== 'PENDING' || answered.has(c.id)) continue;
        await api('POST', `/api/desk/${c.id}/answer`, { decision: 'yes', fingerprint_seen: c.fingerprint }, 0);
        answered.add(c.id);
      }
    } catch {
      /* platform restarting */
    }
    await sleep(500);
  }
})();

// ── 2. forced restarts ──────────────────────────────────────────────────────────────────────
const kills: Record<string, number> = {};
for (let i = 0; i < RESTARTS; i++) {
  // This restart's share of the asks, then a kill somewhere inside the next INTERVAL.
  await wave(Math.floor((JOBS * (i + 1)) / RESTARTS) - asked);
  await sleep(200 + Math.floor(Math.random() * INTERVAL));
  const svc = i === Math.floor(RESTARTS / 3) ? 'ledger-agent' : i === Math.floor((2 * RESTARTS) / 3) ? 'platform' : 'ledger-backend';
  compose('kill', '-s', 'KILL', svc);
  kills[svc] = (kills[svc] ?? 0) + 1;
  await sleep(300);
  compose('start', svc);
  if ((i + 1) % 10 === 0) log('restarts', { done: i + 1, kills });
}
if (asked < JOBS) await wave(JOBS - asked);
log('restarts finished', { kills, asked });

// ── 4. wait, then check ─────────────────────────────────────────────────────────────────────
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const deadline = Date.now() + TIMEOUT;
let details: any[] = [];
while (true) {
  details = await Promise.all(taskIds.map((id) => api('GET', `/api/tasks/${id}`)));
  const open = details.filter((d) => !TERMINAL.includes(d.task.status)).length;
  if (!open || Date.now() > deadline) break;
  log('waiting', { open });
  await sleep(5000);
}
approving = false;
await approver;

const after = providerStats();
const stats = Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - (before[k] ?? 0)])) as Record<string, number>; // this run only
const byStatus: Record<string, number> = {};
for (const d of details) byStatus[d.task.status] = (byStatus[d.task.status] ?? 0) + 1;
const resultsPer = details.map((d) => d.messages.filter((m: any) => m.kind === 'result').length);
const gated = details.filter((d) => gatedIds.has(d.task.id));
const approvals = gated.flatMap((d) => d.approvals);
const executed = approvals.filter((a: any) => a.status === 'EXECUTED');
const report = {
  jobs: JOBS,
  restarts: RESTARTS,
  kills,
  elapsed_s: Math.round((Date.now() - t0) / 1000),
  tasks_by_status: byStatus,
  lost: details.filter((d) => !TERMINAL.includes(d.task.status)).length,
  tasks_without_one_result: resultsPer.filter((n) => n !== 1).length,
  duplicate_results: resultsPer.filter((n) => n > 1).length,
  gated_tasks: gated.length,
  gated_with_not_exactly_one_approval: gated.filter((d) => d.approvals.length !== 1).length,
  approvals_executed: executed.length,
  approvals_other: approvals.filter((a: any) => a.status !== 'EXECUTED').map((a: any) => `${a.status}:${a.last_error ?? ''}`),
  proofs_done: executed.filter((a: any) => a.proof?.outcome === 'DONE').length,
  provider: stats,
};
const checks = {
  all_completed: byStatus.COMPLETED === JOBS,
  exactly_one_result_each: report.tasks_without_one_result === 0,
  one_approval_per_gated_task: report.gated_with_not_exactly_one_approval === 0,
  every_approval_executed: executed.length === gated.length,
  one_email_per_execution: stats.emails_performed === executed.length && stats.distinct_email_keys === executed.length,
};
console.log(JSON.stringify({ ...report, checks, pass: Object.values(checks).every(Boolean) }, null, 2));
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
