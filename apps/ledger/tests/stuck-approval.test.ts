// A slow execute (longer than the gateway's patience) must never strand a card.
// Before: the idempotency ledger stored the retry's 409 in_progress, every later retry
// replayed it, and the card sat RESOLVED forever. Now retryable answers are never
// ledgered, and the app's proposal.executed event settles the card on its own.
// Also: gateway tokens carry ability_version (plan, Contracts).
import { readdir } from 'node:fs/promises';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, call, finish, type Pilot } from './harness.ts';

let P: Pilot;
const tokens: { path: string; claims: any }[] = [];
beforeAll(async () => {
  P = await bootPilot();
  const real = P.platform.gateway.fetchImpl;
  P.platform.gateway.fetchImpl = (async (url: any, init: any) => {
    const auth = init?.headers?.authorization as string | undefined;
    if (auth?.startsWith('Bearer ')) tokens.push({ path: new URL(String(url)).pathname, claims: decodeJwt(auth.slice(7)) });
    return real(url, init);
  }) as typeof fetch;
});
afterAll(async () => P?.close());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gatedEmail(text: string) {
  P.setBrain((v) => {
    if (v.job.includes('YOU ARE BEING WOKEN')) return finish('Sent as approved.');
    if (v.calls === 0)
      return call('ledger.close_pack.email', {
        period: { from: '2026-08-01', to: '2026-08-31' },
        to: ['cfo@acme.example'],
        card: { what: 'Email the August close pack', why: 'month end', changes: 'one email leaves', if_no_answer: 'nothing is sent' },
      });
    return { text: 'waiting' };
  });
  const { task_id, job_id } = await P.ask(text);
  const card = await P.waitFor(async () => (await P.desk()).find((c) => c.job_id === job_id && c.status === 'PENDING'), 'card');
  return { task_id, job_id, card };
}

describe('a slow execute never strands the card', () => {
  it('the outbox settles the card EXECUTED exactly once while the platform’s execute call is still timing out; no retryable answer is ledgered', async () => {
    const mailsBefore = (await readdir(P.mailDir)).length;
    P.platform.gateway.timeoutMs = 400;
    P.backend.core.hooks.beforeExecuteEffect = async () => {
      await sleep(3_000);
    }; // the effect outlives the gateway's patience
    const { task_id, card } = await gatedEmail('Send the August close pack (slow provider)');
    await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    // The first call times out (400 ms) and the retry lands while the effect still holds its lock: 409 in_progress.
    const settled = await P.waitFor(async () => (await P.platform.db.query("select status, proof, attempts from neos.approvals where id = $1 and status <> 'RESOLVED' and status <> 'RECORDED'", [card.id])).rows[0], 'card settled', 20_000);
    expect(settled.status).toBe('EXECUTED');
    expect(settled.proof.outcome).toBe('DONE');
    await P.waitFor(async () => (await P.task(task_id)).task.status === 'COMPLETED', 'task done', 20_000);
    expect((await readdir(P.mailDir)).length - mailsBefore).toBe(1); // exactly once
    const executed = await P.platform.db.query(`select count(*)::int as n from neos.audit where action = 'proposal.executed' and detail->>'proposal_id' = $1`, [card.proposal_id]);
    expect(executed.rows[0].n).toBe(1);
    // The 409 in_progress the retry got is not stored, so a later retry would reach the app again.
    const ledger = await P.platform.db.query(`select status from neos.gateway_ledger where caller = 'platform' and idem_key = $1`, [`execute:${card.id}`]);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].status === null || ledger.rows[0].status === 200).toBe(true);
    const inProgress = await P.platform.db.query(`select count(*)::int as n from neos.audit where action = 'l3.proposals.execute' and idem_key = $1 and outcome = '409'`, [`execute:${card.id}`]);
    expect(inProgress.rows[0].n).toBeGreaterThanOrEqual(1); // the retry really did meet "in progress"
    P.backend.core.hooks.beforeExecuteEffect = undefined;
    P.platform.gateway.timeoutMs = 30_000;
  }, 60_000);

  it('with the outbox paused, the approvals worker’s own retries get through after "in progress" and reach EXECUTED', async () => {
    const pullOutbox = P.platform.outboxTick.bind(P.platform);
    const { card, task_id } = await gatedEmail('Send the August close pack (slow provider, outbox paused)');
    P.platform.outboxTick = async () => 0; // only the approvals worker can settle the card now
    P.platform.gateway.timeoutMs = 400;
    P.backend.core.hooks.beforeExecuteEffect = async () => {
      await sleep(3_000);
    };
    try {
      await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
      const done = await P.waitFor(async () => (await P.platform.db.query("select status, proof, attempts from neos.approvals where id = $1 and status = 'EXECUTED'", [card.id])).rows[0], 'executed by the worker', 30_000);
      expect(done.proof.outcome).toBe('DONE');
      const ledger = await P.platform.db.query(`select status from neos.gateway_ledger where caller = 'platform' and idem_key = $1`, [`execute:${card.id}`]);
      expect(ledger.rows[0].status).toBe(200); // the stored answer is the terminal proof, never "in progress"
      const tries = await P.platform.db.query(`select outcome from neos.audit where action = 'l3.proposals.execute' and idem_key = $1 order by id`, [`execute:${card.id}`]);
      expect(tries.rows.map((r) => r.outcome)).toEqual(expect.arrayContaining(['unreachable', '409', '200']));
    } finally {
      P.backend.core.hooks.beforeExecuteEffect = undefined;
      P.platform.gateway.timeoutMs = 30_000;
      P.platform.outboxTick = pullOutbox;
    }
    await P.waitFor(async () => (await P.task(task_id)).task.status === 'COMPLETED', 'task done', 20_000);
  }, 60_000);
});

describe('gateway tokens carry ability_version (Contracts)', () => {
  it('an ability call carries the version the manifest serves; an execution token carries the proposal’s', async () => {
    tokens.length = 0;
    const r = await P.api('POST', '/api/apps/ledger/read/ledger.report.pnl', { from: '2026-08-01', to: '2026-08-31' });
    expect(r.status).toBe(200);
    const ab = tokens.find((t) => t.path.endsWith('/l3/abilities/ledger.report.pnl'))!;
    const served = P.backend.core.manifest.abilities.find((a) => a.key === 'ledger.report.pnl')!.version;
    expect(ab.claims.ability_version).toBe(served);

    const exec = tokens.filter((t) => t.path.endsWith('/l3/proposals.execute'));
    expect(exec.length).toBe(0);
    const { card } = await gatedEmail('Send the close pack (token check)');
    tokens.length = 0;
    await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    await P.waitFor(async () => tokens.find((t) => t.path.endsWith('/l3/proposals.execute')), 'execute call');
    const approval = (await P.platform.db.query('select ability_version from neos.approvals where id = $1', [card.id])).rows[0];
    const et = tokens.find((t) => t.path.endsWith('/l3/proposals.execute'))!;
    expect(et.claims).toMatchObject({ exec: true, proposal_id: card.proposal_id, ability_version: approval.ability_version });
    // Platform doors are not abilities: no version claim.
    expect(tokens.find((t) => t.path.endsWith('/l3/proposals.resolve'))?.claims.ability_version).toBeUndefined();
  });
});
