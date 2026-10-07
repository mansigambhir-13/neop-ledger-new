// Standing yeses: company-month limits, recipient restrictions, and self-suspension on FAILED/UNKNOWN.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCompany } from '@neop/pgkit';
import { matchGrant, recordGrantUse } from '@neop/template';
import { bootPilot, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => P?.close());


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
