// Platform gaps the audit found: a2a results (a 404 is retried, a give-up is loud),
// a2a hand-offs in the desk activity feed (C6), switchboard pushes that survive an
// app being briefly away, and standing yeses (company-month limits, recipients,
// self-suspension on FAILED/UNKNOWN).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { marketingApp, seedMarketing } from '@neop/marketing';
import { bootPilot, ledgerUnderTest, toolName, type BrainView, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot({ apps: [await ledgerUnderTest(), { def: await marketingApp(), seed: seedMarketing }] });
});
afterAll(async () => P?.close());

const t = (key: string, args: unknown = {}) => ({ tool: toolName(key), args });
const finish = (summary: string, outcome = 'done') => t('job.finish', { outcome, summary });
const isMarketing = (v: BrainView) => v.tools.includes(toolName('marketing.campaigns.list'));

describe('a2a results and the activity feed', () => {
  it('a tasks.result 404 is retried with backoff until the host takes it; the hand-off shows in the desk activity feed', async () => {
    expect((await P.api('POST', '/api/acl', { caller_app: 'marketing', target_app: 'ledger', ability_key: 'tasks.open' })).status).toBe(200);
    // The host answers 404 twice (as it does while its wait is not yet recorded), then accepts.
    let refused = 0;
    const real = P.platform.gateway.fetchImpl;
    P.platform.gateway.fetchImpl = (async (url: any, init: any) => {
      if (String(url).endsWith('/l3/tasks.result') && refused < 2) {
        refused++;
        return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no job waits on that task' } }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      return real(url, init);
    }) as typeof fetch;
    try {
      P.setBrain((v) => {
        if (isMarketing(v)) {
          if (v.job.includes('answered the task')) return finish('Ledger answered.');
          return v.calls === 0 ? t('a2a.request', { app: 'ledger', ask: 'What is the trial balance at 30 September?' }) : { text: 'waiting' };
        }
        return finish('Trial balance read: it balances.');
      });
      const r = await P.ask('Ask Ledger for the trial balance', undefined, 'marketing');
      const done = await P.waitFor(async () => {
        const x = await P.task(r.task_id);
        return x.task.status === 'COMPLETED' && x;
      }, 'host woke with the result', 30_000);
      expect(done.task.result.summary).toBe('Ledger answered.');
      expect(refused).toBe(2);
      const child = (await P.platform.db.query("select * from neos.tasks where parent_task_id = $1 and requester = 'app:marketing'", [r.task_id])).rows[0];
      expect(child.status).toBe('COMPLETED');
      expect(child.result_attempts).toBe(2);
      expect(child.result_delivered_at).not.toBeNull();
      expect(child.result_failed_at).toBeNull();

      // C6: the hand-off is mirrored into the desk activity feed, under the host's job.
      const feed = (await P.api('GET', '/api/activity?kind=a2a')).body.activity;
      const row = feed.find((a: any) => a.job_id === r.job_id);
      expect(row).toMatchObject({ app_key: 'marketing', kind: 'a2a' });
      expect(row.summary).toContain('asked Ledger');
      expect(row.summary).toContain('trial balance');
      // …and in the task's own record.
      expect((await P.task(r.task_id)).activity.map((a: any) => a.kind)).toContain('a2a');
    } finally {
      P.platform.gateway.fetchImpl = real;
    }
  }, 60_000);

  it('a result nobody takes is given up after the bounded window: the task fails and the audit says why', async () => {
    const timings = (P.platform.opts.timings ??= {});
    const was = timings.a2aResultGiveUpMs;
    timings.a2aResultGiveUpMs = 2_500;
    try {
      const id = (
        await P.platform.db.query(
          `insert into neos.tasks (company_id, app_key, requester, ask, status, result, lineage) values ($1, 'ledger', 'app:marketing', 'orphan', 'COMPLETED', $2, '["marketing"]') returning id`,
          [P.company.id, JSON.stringify({ outcome: 'done', summary: 'nobody waits for this' })],
        )
      ).rows[0].id;
      const failed = await P.waitFor(async () => (await P.platform.db.query("select * from neos.tasks where id = $1 and status = 'FAILED'", [id])).rows[0], 'given up', 20_000);
      expect(failed.result_failed_at).not.toBeNull();
      expect(failed.result_attempts).toBeGreaterThanOrEqual(2); // retried, not dropped on the first 404
      expect(failed.last_error).toMatch(/could not be delivered to marketing/);
      const audit = (await P.platform.db.query("select outcome, detail from neos.audit where action = 'a2a.result_undeliverable' and detail->>'task_id' = $1", [id])).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].detail.error).toMatch(/404/);
    } finally {
      timings.a2aResultGiveUpMs = was;
    }
  }, 30_000);
});

describe('switchboard pushes', () => {
  it('a switch-off reaches an app that was briefly unreachable as soon as it is back (no 30 s cache lag)', async () => {
    const ledger = P.backends.ledger!;
    const url = (await P.platform.db.query("select l3_url from neos.apps where key = 'ledger'")).rows[0].l3_url;
    const before = (await ledger.core.board.get(P.company.id)).version; // the gate's cache is warm
    await P.platform.db.query("update neos.apps set l3_url = 'http://127.0.0.1:9' where key = 'ledger'");
    let version = 0;
    try {
      const r = await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.report.cash_flow': 'off' } });
      expect(r.status).toBe(200);
      version = r.body.version;
      expect(version).toBeGreaterThan(before);
      const owed = await P.waitFor(async () => (await P.platform.db.query("select * from neos.app_notifications where app_key = 'ledger' and company_id = $1 and attempts >= 2", [P.company.id])).rows[0], 'push retried');
      expect(owed.version).toBe(version);
      expect(owed.last_error).toMatch(/unreachable|did not answer/);
      expect((await ledger.core.board.get(P.company.id)).version).toBe(before); // the app still has the old board
    } finally {
      await P.platform.db.query("update neos.apps set l3_url = $1 where key = 'ledger'", [url]);
    }
    const t0 = Date.now();
    await P.waitFor(async () => (await ledger.core.board.get(P.company.id)).version === version, 'the app dropped its cached board', 10_000);
    expect(Date.now() - t0).toBeLessThan(10_000);
    await P.waitFor(async () => !(await P.platform.db.query("select 1 from neos.app_notifications where app_key = 'ledger' and company_id = $1", [P.company.id])).rowCount, 'push acknowledged');
    await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.report.cash_flow': 'on' } });
  }, 30_000);
});

describe('standing yeses (grants)', () => {
  const req = (over: Record<string, unknown> = {}) => ({
    company_id: P.company.id,
    job_id: randomUUID(),
    proposal_id: randomUUID(),
    ability_key: 'ledger.close_pack.email',
    ability_version: '1.0.0',
    fingerprint: `sha256:${randomUUID()}`,
    ...over,
  });
  const grant = (limits: Record<string, unknown>, ability_key = 'ledger.close_pack.email') =>
    P.platform.createGrant({ company_id: P.company.id, app_key: 'ledger', ability_key, limits, expires_at: new Date(Date.now() + 86_400_000), created_by: P.admin.id });
  const revokeAll = () => P.platform.db.query("update neos.grants set status = 'REVOKED' where company_id = $1", [P.company.id]);

  it('recipients_allow: only calls to the listed recipients are covered, and a call that names none is not', async () => {
    await revokeAll();
    await grant({ recipients_allow: ['cfo@acme.example'] });
    expect(await P.platform.grantExecutionToken('ledger', req({ recipients: ['cfo@acme.example'] }))).not.toBeNull();
    expect(await P.platform.grantExecutionToken('ledger', req({ recipients: ['cfo@acme.example', 'x@evil.example'] }))).toBeNull();
    expect(await P.platform.grantExecutionToken('ledger', req({ recipients: [] }))).toBeNull();
    expect(await P.platform.grantExecutionToken('ledger', req({}))).toBeNull();
  });

  it('per_month counts the company’s month (Asia/Kolkata), not the UTC month', async () => {
    await revokeAll();
    const monthStart = `(date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`;
    const used = (gid: string, amount: number, at: string) =>
      P.platform.db.query(`insert into neos.audit (company_id, actor, app_key, action, outcome, detail, at) values ($1, $2, 'ledger', 'grant.used', 'token_minted', $3, ${at})`, [
        P.company.id,
        `grant:${gid}`,
        JSON.stringify({ grant_id: gid, proposal_id: randomUUID(), amount_minor: amount }),
      ]);
    const ask = (amount: number) => P.platform.grantExecutionToken('ledger', req({ ability_key: 'ledger.payment.record', amount_minor: amount, currency: 'INR' }));

    // Spent 10 minutes into this month in Kolkata — which is still last month in UTC.
    const g1 = await grant({ per_month_minor: 1000, currency: 'INR' }, 'ledger.payment.record');
    await used(g1, 900, `${monthStart} + interval '10 minutes'`);
    const inUtcLastMonth = (await P.platform.db.query(`select (${monthStart} + interval '10 minutes') < date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' as x`)).rows[0].x;
    expect(inUtcLastMonth).toBe(true); // the case a UTC month gets wrong
    expect(await ask(200)).toBeNull(); // 900 + 200 > 1000 this (company) month
    expect(await ask(100)).not.toBeNull(); // exactly 1000
    await P.platform.db.query("update neos.grants set status = 'REVOKED' where id = $1", [g1]);

    // Spent 10 minutes before this month began in Kolkata: last month there, so it does not count.
    const g2 = await grant({ per_month_minor: 1000, currency: 'INR' }, 'ledger.payment.record');
    await used(g2, 900, `${monthStart} - interval '10 minutes'`);
    expect(await ask(600)).not.toBeNull();
    expect(await ask(500)).toBeNull(); // 600 + 500 > 1000
    // The grants list reports the same month.
    const listed = (await P.api('GET', '/api/grants')).body.grants.find((x: any) => x.id === g2);
    expect(listed.used_this_month_minor).toBe(600);
  });

  it('a grant suspends itself when an execution under it ends FAILED or UNKNOWN (from the app’s outbox)', async () => {
    await revokeAll();
    for (const outcome of ['FAILED', 'UNKNOWN'] as const) {
      const gid = await grant({ recipients_allow: ['cfo@acme.example'] });
      const r = req({ recipients: ['cfo@acme.example'] });
      const tok = await P.platform.grantExecutionToken('ledger', r);
      expect(tok?.grant_id).toBe(gid);
      const core = P.backends.ledger!.core;
      await core.company(P.company.id, (c) => core.book.emit(c, P.company.id, 'proposal.executed', { proposal_id: r.proposal_id, job_id: r.job_id, outcome, proof: { outcome } }, `executed:${r.proposal_id}`));
      const g = await P.waitFor(async () => (await P.platform.db.query("select status, suspended_reason from neos.grants where id = $1 and status = 'SUSPENDED'", [gid])).rows[0], `suspended on ${outcome}`);
      expect(g.suspended_reason).toContain(outcome);
      expect(await P.platform.grantExecutionToken('ledger', req({ recipients: ['cfo@acme.example'] }))).toBeNull();
      const a = (await P.platform.db.query("select outcome from neos.audit where action = 'grant.suspended' and detail->>'grant_id' = $1", [gid])).rows;
      expect(a).toEqual([{ outcome }]);
    }
    // DONE never suspends.
    const gid = await grant({ recipients_allow: ['cfo@acme.example'] });
    const r = req({ recipients: ['cfo@acme.example'] });
    await P.platform.grantExecutionToken('ledger', r);
    const core = P.backends.ledger!.core;
    await core.company(P.company.id, (c) => core.book.emit(c, P.company.id, 'proposal.executed', { proposal_id: r.proposal_id, job_id: r.job_id, outcome: 'DONE', proof: { outcome: 'DONE' } }, `executed:${r.proposal_id}`));
    await P.waitFor(async () => (await P.platform.db.query("select 1 from neos.audit where action = 'proposal.executed' and detail->>'proposal_id' = $1", [r.proposal_id])).rowCount, 'consumed');
    expect((await P.platform.db.query('select status from neos.grants where id = $1', [gid])).rows[0].status).toBe('ACTIVE');
  });
});
