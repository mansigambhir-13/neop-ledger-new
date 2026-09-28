// Platform gaps the audit found: a2a results (a 404 is retried, a give-up is loud),
// a2a hand-offs in the desk activity feed (C6), switchboard changes that reach an
// app while it is away (NOTIFY, v3 S1), and standing yeses (company-month limits, recipients,
// self-suspension on FAILED/UNKNOWN).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCompany } from '@neop/pgkit';
import { matchGrant, recordGrantUse } from '@neop/template';
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

describe('switchboard changes reach the gate from the database (v3 S1)', () => {
  it('a switch-off reaches the gate even while its L3 is unreachable: the NOTIFY needs no push, and nothing is owed', async () => {
    const ledger = P.backends.ledger!;
    const cashFlow = ledger.core.ability('ledger.report.cash_flow')!;
    const url = (await P.platform.db.query("select l3_url from neos.apps where key = 'ledger'")).rows[0].l3_url;
    const before = (await ledger.core.board.get(P.company.id)).version; // the gate's cache is warm
    expect((await ledger.core.board.get(P.company.id)).setting(cashFlow)).toBe('on');
    await P.platform.db.query("update neos.apps set l3_url = 'http://127.0.0.1:9' where key = 'ledger'");
    try {
      const t0 = Date.now();
      const r = await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.report.cash_flow': 'off' } });
      expect(r.status).toBe(200);
      const version = r.body.version;
      expect(version).toBeGreaterThan(before);
      // No cache lag and no retries: the app's own switchboard told its gate.
      await P.waitFor(async () => (await ledger.core.board.get(P.company.id)).version === version, 'the gate dropped its cached board', 1_000);
      expect(Date.now() - t0).toBeLessThan(2_000);
      expect((await ledger.core.board.get(P.company.id)).setting(cashFlow)).toBe('off');
      expect((await P.platform.db.query("select 1 from neos.app_notifications where app_key = 'ledger' and company_id = $1", [P.company.id])).rowCount).toBe(0);
    } finally {
      await P.platform.db.query("update neos.apps set l3_url = $1 where key = 'ledger'", [url]);
    }
    await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.report.cash_flow': 'on' } });
  }, 30_000);
});

describe('standing yeses (grants) — matched in the app’s own schema', () => {
  const core = () => P.backends.ledger!.core;
  const grant = (limits: Record<string, unknown>, ability_key = 'ledger.close_pack.email') =>
    P.platform.createGrant({ company_id: P.company.id, app_key: 'ledger', ability_key, limits, expires_at: new Date(Date.now() + 86_400_000), created_by: P.admin.id });
  const revokeAll = async () => {
    for (const g of (await P.api('GET', '/api/grants')).body.grants) if (g.status !== 'REVOKED') expect((await P.api('DELETE', `/api/grants/${g.id}`)).status).toBe(200);
  };
  /** What the gate does for an ask-first call: match a grant and, when one covers it, record the use. */
  const ask = (ability_key: string, m: { amount_minor?: number; currency?: string; recipients?: string[] }) =>
    withCompany(core().appPool, P.company.id, async (c) => {
      const g = await matchGrant(c, 'ledger', ability_key, m, 'Asia/Kolkata');
      if (g) await recordGrantUse(c, 'ledger', { company_id: P.company.id, grant_id: g.grant_id, proposal_id: randomUUID(), job_id: null, ability_key, fingerprint: `sha256:${randomUUID()}`, amount_minor: m.amount_minor, currency: m.currency });
      return g;
    });
  const grantRow = async (gid: string) => (await core().runnerPool.query('select status, suspended_reason from ledger.grants where grant_id = $1', [gid])).rows[0];

  it('recipients_allow: only calls to the listed recipients are covered, and a call that names none is not', async () => {
    await revokeAll();
    await grant({ recipients_allow: ['cfo@acme.example'] });
    const email = (recipients?: string[]) => ask('ledger.close_pack.email', recipients ? { recipients } : {});
    expect(await email(['cfo@acme.example'])).not.toBeNull();
    expect(await email(['cfo@acme.example', 'x@evil.example'])).toBeNull();
    expect(await email([])).toBeNull();
    expect(await email()).toBeNull();
  });

  it('per_month counts the company’s month (Asia/Kolkata), not the UTC month', async () => {
    await revokeAll();
    const monthStart = `(date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`;
    const used = (gid: string, amount: number, at: string) =>
      withCompany(core().appPool, P.company.id, (c) =>
        c.query(`insert into ledger.grant_uses (company_id, grant_id, proposal_id, ability_key, amount_minor, currency, at) values ($1, $2, $3, 'ledger.payment.record', $4, 'INR', ${at})`, [P.company.id, gid, randomUUID(), amount]),
      );
    const pay = (amount: number) => ask('ledger.payment.record', { amount_minor: amount, currency: 'INR' });

    // Spent 10 minutes into this month in Kolkata — which is still last month in UTC.
    const g1 = await grant({ per_month_minor: 1000, currency: 'INR' }, 'ledger.payment.record');
    await used(g1, 900, `${monthStart} + interval '10 minutes'`);
    const inUtcLastMonth = (await P.platform.db.query(`select (${monthStart} + interval '10 minutes') < date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' as x`)).rows[0].x;
    expect(inUtcLastMonth).toBe(true); // the case a UTC month gets wrong
    expect(await pay(200)).toBeNull(); // 900 + 200 > 1000 this (company) month
    expect(await pay(100)).not.toBeNull(); // exactly 1000
    expect((await P.api('DELETE', `/api/grants/${g1}`)).status).toBe(200);

    // Spent 10 minutes before this month began in Kolkata: last month there, so it does not count.
    const g2 = await grant({ per_month_minor: 1000, currency: 'INR' }, 'ledger.payment.record');
    await used(g2, 900, `${monthStart} - interval '10 minutes'`);
    expect(await pay(600)).not.toBeNull();
    expect(await pay(500)).toBeNull(); // 600 + 500 > 1000
    // The grants list (read from the app's schema) reports the same month.
    const listed = (await P.api('GET', '/api/grants')).body.grants.find((x: any) => x.id === g2);
    expect(listed.used_this_month_minor).toBe(600);
  });

  it('a grant suspends itself in the app’s schema when an execution under it ends FAILED or UNKNOWN; DONE never does', async () => {
    await revokeAll();
    /** A proposal the grant approved, carried through the approved path's states to `outcome`. */
    const executedUnder = (gid: string, outcome: 'FAILED' | 'UNKNOWN' | 'DONE') =>
      withCompany(core().appPool, P.company.id, async (c) => {
        const job = (await c.query("insert into ledger.jobs (company_id, source, requester, task_id, ask, status) values ($1, 'task', 'user:x', gen_random_uuid(), 'grant probe', 'DONE') returning id", [P.company.id])).rows[0].id;
        const p = (
          await c.query(
            `insert into ledger.proposals (company_id, job_id, ability_key, ability_version, args, card, fingerprint, status, approved_via, grant_id, decided_by, expires_at, idempotency_key)
             values ($1, $2, 'ledger.close_pack.email', '1.0.0', '{}', '{}', 'sha256:' || md5(random()::text), 'APPROVED', 'grant', $3::uuid, 'grant:' || $3::text, now() + interval '1 day', gen_random_uuid()::text) returning id`,
            [P.company.id, job, gid],
          )
        ).rows[0].id;
        await c.query("update ledger.proposals set status = 'EXECUTING' where id = $1", [p]);
        await c.query('update ledger.proposals set status = $2 where id = $1', [p, outcome]);
        return p as string;
      });
    for (const outcome of ['FAILED', 'UNKNOWN'] as const) {
      const gid = await grant({ recipients_allow: ['cfo@acme.example'] });
      expect(await ask('ledger.close_pack.email', { recipients: ['cfo@acme.example'] })).toEqual({ grant_id: gid });
      const pid = await executedUnder(gid, outcome);
      // In the same transaction that wrote the outcome: no platform, no outbox round trip.
      const g = await grantRow(gid);
      expect(g.status).toBe('SUSPENDED');
      expect(g.suspended_reason).toContain(outcome);
      expect(await ask('ledger.close_pack.email', { recipients: ['cfo@acme.example'] })).toBeNull();
      const ev = (await core().runnerPool.query("select actor, detail from ledger.proposal_events where proposal_id = $1 and event = 'grant_suspended'", [pid])).rows;
      expect(ev).toEqual([{ actor: `grant:${gid}`, detail: { grant_id: gid, outcome } }]);
      // The desk lists it suspended, with why.
      const listed = (await P.api('GET', '/api/grants')).body.grants.find((x: any) => x.id === gid);
      expect(listed).toMatchObject({ status: 'SUSPENDED', suspended_reason: g.suspended_reason });
    }
    // DONE never suspends.
    const gid = await grant({ recipients_allow: ['cfo@acme.example'] });
    await executedUnder(gid, 'DONE');
    expect((await grantRow(gid)).status).toBe('ACTIVE');
    await revokeAll();
  });
});
