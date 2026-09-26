// governance.test · the platform surfaces the console governs Ledger through: standing yeses,
// company rules, the switchboard (incl. package lines), who may ask Ledger, the audit trail,
// switchboard history, assistant spend, and a job's full record.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEDGER_ROOT } from '../src/index.ts';
import { bootPilot, installAndMigrate, publishPackage, toolName, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => P?.close());

const admin = (m: string, p: string, b?: unknown) => P.api(m, p, b);
const member = (m: string, p: string, b?: unknown) => P.api(m, p, b, P.member.token);
const inAMonth = () => new Date(Date.now() + 30 * 864e5).toISOString();

describe('standing yeses', () => {
  let id = '';
  it('an admin creates one for an ask-first write, with a currency-bound cap', async () => {
    const r = await admin('POST', '/api/grants', { app_key: 'ledger', ability_key: 'ledger.payment.record', limits: { per_call_minor: 50_000_00, currency: 'INR' }, expires_at: inAMonth() });
    expect(r.status).toBe(200);
    id = r.body.id;
    const list = (await member('GET', '/api/grants')).body.grants;
    expect(list.find((g: any) => g.id === id)).toMatchObject({ ability_key: 'ledger.payment.record', status: 'ACTIVE', uses: 0, used_this_month_minor: 0 });
  });

  it('refuses reads, money without a cap, caps without a currency, and expiries past a year', async () => {
    const bad = [
      { ability_key: 'ledger.report.pnl', limits: {}, expires_at: inAMonth() },
      { ability_key: 'ledger.payment.record', limits: {}, expires_at: inAMonth() },
      { ability_key: 'ledger.payment.record', limits: { per_call_minor: 100 }, expires_at: inAMonth() },
      { ability_key: 'ledger.invoice.send', limits: {}, expires_at: new Date(Date.now() + 400 * 864e5).toISOString() },
    ];
    for (const b of bad) expect((await admin('POST', '/api/grants', { app_key: 'ledger', ...b })).status, JSON.stringify(b)).toBe(422);
  });

  it('only an admin can create or withdraw one; withdrawing is audited', async () => {
    expect((await member('POST', '/api/grants', { app_key: 'ledger', ability_key: 'ledger.invoice.send', limits: {}, expires_at: inAMonth() })).status).toBe(403);
    expect((await member('DELETE', `/api/grants/${id}`)).status).toBe(403);
    expect((await admin('DELETE', `/api/grants/${id}`)).status).toBe(200);
    expect((await admin('DELETE', `/api/grants/${id}`)).status).toBe(404);
    const audit = (await admin('GET', '/api/audit?action=grant.')).body.rows.map((r: any) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['grant.created', 'grant.revoked']));
  });
});

describe('company rules and the switchboard', () => {
  it('refuses a rule the gate could not read — the next job would otherwise fail', async () => {
    for (const rule of [
      { id: 'x', type: 'teleport' },
      { id: 'w', type: 'time_window', days: [8], from: '09:00', to: '18:00' },
      { id: 'c', type: 'amount_cap', currency: 'rupees', per_call_minor: 5 },
      { id: 'p', type: 'require_person', abilities: ['ledger.nope'] },
    ]) {
      const r = await admin('PUT', '/api/switchboards/ledger', { rules: [rule] });
      expect(r.status, JSON.stringify(rule)).toBe(422);
      expect(r.body.error.code).toBe('bad_rule');
    }
    const ok = await admin('PUT', '/api/switchboards/ledger', { rules: [{ id: 'office-hours', type: 'time_window', days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '23:59', applies_to: 'external' }] });
    expect(ok.status).toBe(200);
  });

  it('shows floor, company setting and what is in force; require_person forces ask-first', async () => {
    await admin('PUT', '/api/switchboards/ledger', { rules: [{ id: 'people-for-parties', type: 'require_person', abilities: ['ledger.party.create'] }] });
    const b = (await admin('GET', '/api/apps/ledger/abilities')).body;
    const party = b.abilities.find((a: any) => a.key === 'ledger.party.create');
    expect(party).toMatchObject({ floor: 'on', company: null, setting: 'ask_first', forced_by_rule: true, from: 'own' });
    expect(b.doors.map((d: any) => d.key)).toContain('email');
    await admin('PUT', '/api/switchboards/ledger', { rules: [] });
  });

  it('keeps every version, newest first, with who changed it', async () => {
    const v = (await admin('GET', '/api/switchboards/ledger/history')).body.versions;
    expect(v.length).toBeGreaterThanOrEqual(3);
    expect(v[0].version).toBeGreaterThan(v[1].version);
    expect(v[0].updated_by_name).toBe('Priya');
  });

  it("an installed package's abilities become lines the company can tighten", async () => {
    await publishPackage(P, path.resolve(LEDGER_ROOT, '../../registry/nep-gst'));
    const cat = (await member('GET', '/api/registry/catalog')).body.entries.find((e: any) => e.key === 'nep-gst');
    expect(cat).toMatchObject({ kind: 'package', signed: true, installs: [] });
    expect(cat.offers.map((o: any) => o.key)).toContain('gst.gstr3b.file');
    await installAndMigrate(P, 'ledger', 'nep-gst');
    const b = (await admin('GET', '/api/apps/ledger/abilities')).body;
    const file = b.abilities.find((a: any) => a.key === 'gst.gstr3b.file');
    expect(file).toMatchObject({ from: 'nep-gst', floor: 'ask_first', setting: 'ask_first' });
    expect(b.doors.map((d: any) => d.key)).toContain('gst_portal');
    expect((await admin('PUT', '/api/switchboards/ledger', { settings: { 'gst.gstr3b.prepare': 'ask_first' } })).status).toBe(200);
    expect((await admin('PUT', '/api/switchboards/ledger', { settings: { 'gst.gstr3b.file': 'on' } })).status).toBe(422); // below the package's floor
    const after = (await admin('GET', '/api/apps/ledger/abilities')).body.abilities.find((a: any) => a.key === 'gst.gstr3b.prepare');
    expect(after).toMatchObject({ company: 'ask_first', setting: 'ask_first' });
    const pinned = (await member('GET', '/api/registry/catalog')).body.entries.find((e: any) => e.key === 'nep-gst');
    expect(pinned.installs[0]).toMatchObject({ host_app: 'ledger', pinned_version: '2.0.0', status: 'active' });
  });
});

describe('skill lines on the switchboard (WP §10)', () => {
  const skill = async (k: string) => (await admin('GET', '/api/apps/ledger/abilities')).body.skills.find((x: any) => x.key === k);
  const systemFor = async (ask: string) => {
    let system = '';
    P.setBrain((v) => {
      system = v.system;
      return { tool: toolName('job.finish'), args: { outcome: 'done', summary: 'ok' } };
    });
    const t = await P.ask(ask);
    await P.waitFor(async () => (await P.task(t.task_id)).task.status === 'COMPLETED', 'done');
    return system;
  };

  it('lists the app’s skills with what each needs, all loading by default', async () => {
    const { skills } = (await admin('GET', '/api/apps/ledger/abilities')).body;
    expect(skills.map((s: any) => s.key).sort()).toEqual(['bank-reconciliation', 'cash-and-tax', 'company-setup', 'corrections', 'documents-to-books', 'financial-reports', 'invoicing-and-collections', 'month-end-close']);
    expect(await skill('month-end-close')).toMatchObject({ setting: 'on', loads: true, missing: [] });
    expect(await systemFor('Close September')).toContain('# Month-end close');
  });

  it('a skill line is on or off; off removes it from the assistant, the others stay', async () => {
    expect((await admin('PUT', '/api/switchboards/ledger', { settings: { 'skill:month-end-close': 'ask_first' } })).status).toBe(422);
    expect((await admin('PUT', '/api/switchboards/ledger', { settings: { 'skill:teleport': 'off' } })).status).toBe(422);
    expect((await admin('PUT', '/api/switchboards/ledger', { settings: { 'skill:month-end-close': 'off' } })).status).toBe(200);
    expect(await skill('month-end-close')).toMatchObject({ setting: 'off', loads: false });
    const system = await systemFor('Close September');
    expect(system).not.toContain('# Month-end close');
    expect(system).toContain('# Financial reports');
    await admin('PUT', '/api/switchboards/ledger', { settings: { 'skill:month-end-close': 'on' } });
  });

  it('switching a required tool off greys the skill out and says why', async () => {
    await admin('PUT', '/api/switchboards/ledger', { settings: { 'ledger.period.close': 'off' } });
    expect(await skill('month-end-close')).toMatchObject({ setting: 'on', loads: false, missing: ['ledger.period.close'] });
    expect(await systemFor('Close September')).not.toContain('# Month-end close');
    await admin('PUT', '/api/switchboards/ledger', { settings: { 'ledger.period.close': 'ask_first' } });
    expect(await skill('month-end-close')).toMatchObject({ loads: true });
  });
});

describe('package uninstall', () => {
  it('disables the package, keeps its tables, and takes its lines off the board at once', async () => {
    expect((await member('DELETE', '/api/registry/installs', { host_app: 'ledger', entry_key: 'nep-gst' })).status).toBe(403);
    const r = await admin('DELETE', '/api/registry/installs', { host_app: 'ledger', entry_key: 'nep-gst' });
    expect(r.body).toMatchObject({ status: 'disabled' });
    const b = (await admin('GET', '/api/apps/ledger/abilities')).body;
    expect(b.abilities.some((a: any) => a.from === 'nep-gst')).toBe(false);
    expect(b.doors.map((d: any) => d.key)).not.toContain('gst_portal');
    // Its tables are kept.
    const t = await P.backend.core.runnerPool.query("select count(*)::int as n from pg_tables where schemaname = 'ledger' and tablename like 'nep_gst_%'");
    expect(t.rows[0].n).toBeGreaterThan(0);
    // The app stops offering it straight away (no 30 s cache).
    expect((await P.backend.core.packages.forCompany(P.company.id)).abilities.some((a) => a.meta.key.startsWith('gst.'))).toBe(false);
    expect((await admin('GET', '/api/audit?action=registry.uninstalled')).body.rows).toHaveLength(1);
    expect((await admin('DELETE', '/api/registry/installs', { host_app: 'ledger', entry_key: 'nep-gst' })).status).toBe(404);
  });

  it('re-installing brings it back without re-running its migrations', async () => {
    const r = await admin('POST', '/api/registry/installs', { host_app: 'ledger', entry_key: 'nep-gst' });
    expect(r.body.status).toBe('active');
    expect((await admin('GET', '/api/apps/ledger/abilities')).body.abilities.some((a: any) => a.key === 'gst.gstr3b.file')).toBe(true);
  });
});

describe('who may ask Ledger, and the audit trail', () => {
  it('lists permission rows and installed apps (admins only)', async () => {
    const r = await admin('GET', '/api/acl?app=ledger');
    expect(r.status).toBe(200);
    expect(r.body.installed_apps.map((a: any) => a.key)).toContain('ledger');
    expect((await member('GET', '/api/acl')).status).toBe(403);
  });

  it('the audit trail pages, filters, and names the people', async () => {
    const all = (await admin('GET', '/api/audit?limit=2')).body;
    expect(all.rows).toHaveLength(2);
    expect(all.next_before).toBeTruthy();
    const next = (await admin('GET', `/api/audit?limit=2&before=${all.next_before}`)).body;
    expect(next.rows[0].id).toBeLessThan(all.rows[1].id);
    const sb = (await admin('GET', '/api/audit?action=switchboard.changed')).body.rows;
    expect(sb.length).toBeGreaterThan(0);
    expect(sb[0].actor_name).toBe('Priya');
    expect((await member('GET', '/api/audit')).status).toBe(403);
  });
});

describe("a job's full record", () => {
  it('task detail carries its approvals (with who and the fingerprint seen), and the list its counts', async () => {
    P.setBrain((v) => {
      if (v.job.includes('WOKEN')) return { tool: toolName('job.finish'), args: { outcome: 'done', summary: 'Account 6560 added.' } };
      if (v.calls === 0)
        return {
          tool: toolName('ledger.account.create'),
          args: { code: '6560', name: 'Printing', type: 'expense', subtype: 'opex', card: { what: 'Add 6560 Printing', why: 'asked', changes: 'new account', if_no_answer: 'nothing' } },
        };
      return v.results.some((r) => r.text.includes('Proposal ')) ? { text: 'waiting' } : { tool: toolName('job.finish'), args: { outcome: 'done', summary: 'ok' } };
    });
    const t = await P.ask('Add a Printing expense account 6560');
    const card = await P.waitFor(async () => (await P.desk()).find((c) => c.task_id === t.task_id && c.status === 'PENDING'), 'card');
    const listed = (await admin('GET', '/api/tasks')).body.tasks.find((x: any) => x.id === t.task_id);
    expect(listed.pending_approvals).toBe(1);
    await admin('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    await P.waitFor(async () => (await P.task(t.task_id)).task.status === 'COMPLETED', 'completed');
    const d = (await admin('GET', `/api/tasks/${t.task_id}`)).body;
    expect(d.approvals).toHaveLength(1);
    expect(d.approvals[0]).toMatchObject({ decision: 'yes', decided_by_name: 'Priya', fingerprint_seen: card.fingerprint, status: 'EXECUTED' });
    expect(d.approvals[0].proof.outcome).toBe('DONE');
    expect(d.cost).toMatchObject({ usd: expect.any(Number), calls: expect.any(Number) });
    expect(d.activity.length).toBeGreaterThan(0);
  });

  it('assistant spend is reported against the caps', async () => {
    const u = (await member('GET', '/api/usage/ledger')).body;
    expect(u).toMatchObject({ per_job_cap_usd: 5, per_day_cap_usd: 50 });
    expect(typeof u.today_usd).toBe('number');
  });
});
