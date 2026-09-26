// a2a.test · another app can call only what an ACL row allows, and never a platform door.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootPilot, type Pilot } from './harness.ts';
import { manifest } from '../src/index.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
  // A second app registered on the platform (its backend is not needed to be the caller).
  await P.platform.registerApp({ key: 'marketing', l3_url: 'http://127.0.0.1:9', manifest: { ...manifest, app: 'marketing', name: 'Marketing', abilities: [] }, service_secret: 'm'.repeat(32) });
});
afterAll(async () => P?.close());

it('refuses an app caller without an ACL row, allows it with one', async () => {
  const req = { caller: 'app:marketing', app: 'ledger', endpoint: 'ledger.report.pnl', company_id: P.company.id, body: { from: '2026-08-01', to: '2026-08-31' } };
  await expect(P.platform.gateway.call({ ...req, idem_key: 'a1' })).rejects.toMatchObject({ status: 403, code: 'denied' });
  await P.platform.db.query('insert into neos.acl (caller_app, target_app, ability_key, company_id, granted_by) values ($1,$2,$3,$4,$5)', [
    'marketing',
    'ledger',
    'ledger.report.pnl',
    P.company.id,
    P.admin.id,
  ]);
  const ok = await P.platform.gateway.call({ ...req, idem_key: 'a2' });
  expect(ok.status).toBe(200);
  expect(ok.body.result.period).toEqual({ from: '2026-08-01', to: '2026-08-31' });
  const audit = await P.platform.db.query("select count(*)::int as n from neos.audit where actor = 'app:marketing' and action = 'gateway.denied'");
  expect(audit.rows[0].n).toBe(1);
});

it('an app can never use a platform door or a write directly, even with an ACL row', async () => {
  await P.platform.db.query('insert into neos.acl (caller_app, target_app, ability_key, company_id, granted_by) values ($1,$2,$3,$4,$5), ($1,$2,$6,$4,$5)', [
    'marketing',
    'ledger',
    'proposals.resolve',
    P.company.id,
    P.admin.id,
    'ledger.journal.post',
  ]);
  await expect(
    P.platform.gateway.call({ caller: 'app:marketing', app: 'ledger', endpoint: 'proposals.resolve', company_id: P.company.id, body: {}, idem_key: 'r1' }),
  ).rejects.toMatchObject({ status: 403 });
  const w = await P.platform.gateway.call({ caller: 'app:marketing', app: 'ledger', endpoint: 'ledger.journal.post', company_id: P.company.id, body: {}, idem_key: 'w1' });
  expect(w.status).toBe(403);
});

it('the gateway replays a completed request for the same idempotency key and refuses a different body', async () => {
  const base = { caller: 'platform', app: 'ledger', endpoint: 'ledger.report.trial_balance', company_id: P.company.id };
  const a = await P.platform.gateway.call({ ...base, body: { as_of: '2026-09-30' }, idem_key: 'same' });
  const b = await P.platform.gateway.call({ ...base, body: { as_of: '2026-09-30' }, idem_key: 'same' });
  expect(b.replayed).toBe(true);
  expect(b.body).toEqual(a.body);
  await expect(P.platform.gateway.call({ ...base, body: { as_of: '2026-08-31' }, idem_key: 'same' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
});
