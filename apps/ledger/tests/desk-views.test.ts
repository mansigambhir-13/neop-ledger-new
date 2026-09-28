// desk-views.test · v3 §11 union views and §10 the registry schema, on a real two-app pilot (Ledger + Marketing).
//   A4  neos_desk (NOLOGIN) reads neos.v_pending_approvals and neos.v_activity — built by neos.refresh_desk_views()
//       over every registered app schema at registration — and nothing else. Reconciliation: the proposals the
//       union view shows as waiting are exactly the neos.approvals rows that are PENDING, before and after a yes.
//   A6  every app's app/runner role reads neos_registry (apps, abilities, doors, uses, skills, packages) and nothing
//       else in neos.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { marketingApp, seedMarketing, DIWALI_CAMPAIGN } from '@neop/marketing';
import { bootPilot, call, finish, ledgerUnderTest, type Pilot } from './harness.ts';

let P: Pilot;
let c: pg.Client;
beforeAll(async () => {
  P = await bootPilot({ apps: [await ledgerUnderTest(), { def: await marketingApp(), seed: seedMarketing }] });
  c = new pg.Client({ connectionString: P.adminUrl });
  await c.connect();
});
afterAll(async () => {
  await c?.end();
  await P?.close();
});

/** Run a query as a role (the admin connection switches to it for one transaction). */
async function as<T = any>(role: string, sql: string, params: unknown[] = []): Promise<T[]> {
  await c.query('begin');
  try {
    await c.query(`set local role ${role}`);
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.query('rollback');
  }
}
async function denied(role: string, sql: string): Promise<string> {
  try {
    await as(role, sql);
    return 'OPEN';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}
const key = (r: { app_key: string; proposal_id: string; fingerprint: string }) => `${r.app_key}:${r.proposal_id}:${r.fingerprint}`;
const pendingInView = async () => (await as('neos_desk', 'select app_key, proposal_id, fingerprint, company_id from neos.v_pending_approvals')).map(key).sort();
const pendingInDesk = async () => (await c.query("select app_key, proposal_id, fingerprint from neos.approvals where status = 'PENDING'")).rows.map(key).sort();

describe('A4 · the desk’s union views', () => {
  it('neos_desk is NOLOGIN and the views cover every registered app schema', async () => {
    expect((await c.query("select rolcanlogin, rolbypassrls, rolsuper from pg_roles where rolname = 'neos_desk'")).rows[0]).toEqual({ rolcanlogin: false, rolbypassrls: false, rolsuper: false });
    const def = (await c.query("select pg_get_viewdef('neos.v_pending_approvals'::regclass) d")).rows[0].d as string;
    expect(def).toContain("desk_pending('ledger'::text)");
    expect(def).toContain("desk_pending('marketing'::text)");
    // no catalog dependency on any app's tables (a restored or remote schema never blocks the views)
    const deps = (await c.query("select distinct n.nspname from pg_depend d join pg_rewrite r on r.oid = d.objid join pg_class v on v.oid = r.ev_class join pg_class t on t.oid = d.refobjid join pg_namespace n on n.oid = t.relnamespace where v.relname in ('v_pending_approvals', 'v_activity') and t.oid <> v.oid")).rows;
    expect(deps).toEqual([]);
  });

  it('reconciles with neos.approvals: the pending proposals of both apps, before and after a person’s yes', async () => {
    P.setBrain((v) => {
      if (v.job.includes('WOKEN')) return finish('Done.');
      if (v.calls > 0) return { text: 'waiting' };
      if (v.tools.includes('marketing__spend__commit')) {
        return call('marketing.spend.commit', { campaign_id: DIWALI_CAMPAIGN, vendor: 'Meta', amount_minor: 1_000_000, currency: 'INR', card: { what: 'Commit ₹10,000 to Meta', why: 'launch', changes: 'money committed', if_no_answer: 'nothing' } });
      }
      return call('ledger.expense.record', { date: '2026-09-21', currency: 'INR', description: 'Courier', amount_minor: 30_000, gst_rate_bps: 0, account_code: '6200', card: { what: 'Record ₹300 courier', why: 'asked', changes: 'one expense', if_no_answer: 'nothing' } });
    });
    await P.ask('Record a ₹300 courier expense', undefined, 'ledger');
    await P.ask('Commit ₹10,000 to Meta for Diwali', undefined, 'marketing');
    await P.waitFor(async () => (await pendingInDesk()).length >= 2, 'two pending cards on the desk');
    await P.waitFor(async () => JSON.stringify(await pendingInView()) === JSON.stringify(await pendingInDesk()) && true, 'the view agrees with the desk');
    const view = await as('neos_desk', 'select * from neos.v_pending_approvals');
    expect(new Set(view.map((r) => r.app_key))).toEqual(new Set(['ledger', 'marketing']));
    expect(view.every((r) => r.company_id === P.company.id && r.task_id && r.card?.what)).toBe(true);

    const first = (await P.desk()).find((x) => x.status === 'PENDING' && x.app_key === 'ledger')!;
    await P.api('POST', `/api/desk/${first.id}/answer`, { decision: 'yes', fingerprint_seen: first.fingerprint });
    await P.waitFor(async () => (await c.query('select status from neos.approvals where id = $1', [first.id])).rows[0].status === 'EXECUTED', 'executed');
    await P.waitFor(async () => JSON.stringify(await pendingInView()) === JSON.stringify(await pendingInDesk()) && true, 'the view agrees after the yes');
    expect((await pendingInView()).some((k) => k.includes(first.proposal_id))).toBe(false);
  });

  it('v_activity has both apps’ steps; neos_desk reads nothing else', async () => {
    const act = await as('neos_desk', "select app_key, count(*)::int n from neos.v_activity group by 1 order by 1");
    expect(act.map((r) => r.app_key)).toEqual(['ledger', 'marketing']);
    expect(act.every((r) => r.n > 0)).toBe(true);
    for (const t of ['neos.approvals', 'neos.tasks', 'neos.users', 'neos.vault_secrets', 'ledger.proposals', 'marketing.jobs']) expect(await denied('neos_desk', `select 1 from ${t} limit 1`), t).toBe('42501');
  });

  it('a newly registered app joins the views at registration', async () => {
    const m = (await c.query("select manifest from neos.apps where key = 'ledger'")).rows[0].manifest;
    await P.platform.registerApp({ key: 'zeta', l3_url: 'http://127.0.0.1:9', manifest: { ...m, app: 'zeta', name: 'Zeta', abilities: [], uses: [], skills: [], blocks: [], personal_data: undefined }, service_secret: 'z'.repeat(32) });
    const def = (await c.query("select pg_get_viewdef('neos.v_activity'::regclass) d")).rows[0].d as string;
    expect(def).toContain("desk_activity('zeta'::text)");
    // no schema for zeta here: it contributes no rows, and nothing breaks
    expect((await as('neos_desk', "select count(*)::int n from neos.v_activity where app_key = 'zeta'"))[0].n).toBe(0);
  });
});

describe('A6 · the registry schema', () => {
  it('each app’s app and runner roles read neos_registry, and nothing else in neos', async () => {
    for (const role of ['ledger_app', 'ledger_runner', 'marketing_app', 'marketing_runner']) {
      const apps = await as(role, 'select app from neos_registry.apps order by app');
      expect(apps.map((r) => r.app)).toEqual(expect.arrayContaining(['ledger', 'marketing']));
      const abilities = await as(role, "select kind, floor from neos_registry.abilities where app = 'ledger' and ability = 'ledger.expense.record'");
      expect(abilities).toEqual([{ kind: 'write', floor: 'ask_first' }]);
      expect(await as(role, "select door, floor from neos_registry.doors where app = 'ledger'")).toEqual([{ door: 'email', floor: 'on' }]);
      expect(await as(role, "select owner_app, ability from neos_registry.uses where app = 'marketing' and ability = 'ledger.expense.record'")).toEqual([{ owner_app: 'ledger', ability: 'ledger.expense.record' }]);
      await as(role, 'select * from neos_registry.skills');
      await as(role, 'select * from neos_registry.packages');
      for (const t of ['neos.apps', 'neos.registry_entries', 'neos.approvals', 'neos.tasks', 'neos.vault_secrets', 'neos.v_pending_approvals']) expect(await denied(role, `select 1 from ${t} limit 1`), `${role} ${t}`).toBe('42501');
      expect((await c.query("select has_schema_privilege($1, 'neos', 'usage') as u", [role])).rows[0].u).toBe(false);
    }
  });

  it('no secret or company data is in the registry views', async () => {
    const cols = (await c.query("select table_name, column_name from information_schema.columns where table_schema = 'neos_registry'")).rows.map((r) => r.column_name);
    for (const bad of ['service_secret_hash', 'company_id', 'l3_url', 'secret', 'body', 'author_key']) expect(cols).not.toContain(bad);
  });
});
