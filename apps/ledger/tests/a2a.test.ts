// a2a.test · another app can call only what an ACL row allows, and never a platform door.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe('borrowing is checked at registration (WP §10)', () => {
  const base = async () => (await import('../src/index.ts')).manifest;
  it('a borrower must name an ability that exists at a version in its range', async () => {
    const m = await base();
    const reg = (uses: any[]) => P.platform.registerApp({ key: 'probe', l3_url: 'http://127.0.0.1:9', manifest: { ...m, app: 'probe', name: 'Probe', abilities: [], uses, blocks: [] } as any, service_secret: 'p'.repeat(32) });
    await expect(reg([{ app: 'ledger', ability: 'ledger.budget.remaining', range: '^2.0.0' }])).rejects.toThrow(/serves 1\.0\.0/);
    await expect(reg([{ app: 'ledger', ability: 'ledger.journal.post', range: '*' }])).rejects.toThrow(/no read/);
    // An owner not registered yet is checked when it registers (deploy order is free).
    await expect(reg([{ app: 'nobody', ability: 'nobody.y', range: '^1.0.0' }])).resolves.toBeUndefined();
    const nobody = { ...m, app: 'nobody', name: 'Nobody', abilities: [], uses: [], blocks: [] } as any;
    await expect(P.platform.registerApp({ key: 'nobody', l3_url: 'http://127.0.0.1:9', manifest: nobody, service_secret: 'n'.repeat(32) })).rejects.toThrow(/probe uses nobody\.y@\^1\.0\.0; this manifest drops it/);
    await expect(reg([{ app: 'ledger', ability: 'ledger.budget.remaining', range: '^1.0.0' }])).resolves.toBeUndefined();
  });
  it('an owner cannot re-register in a way that breaks a pinned borrower', async () => {
    const m = await base();
    const bumped = { ...m, abilities: m.abilities.map((a) => (a.key === 'ledger.budget.remaining' ? { ...a, version: '2.0.0' } : a)) };
    await expect(P.platform.registerApp({ key: 'ledger', l3_url: 'http://127.0.0.1:9', manifest: bumped as any, service_secret: 'l'.repeat(32) })).rejects.toThrow(/probe uses ledger\.budget\.remaining@\^1\.0\.0/);
  });
});
