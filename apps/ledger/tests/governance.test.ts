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
    expect(pinned.installs[0]).toMatchObject({ host_app: 'ledger', pinned_version: '1.0.0', status: 'active' });
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
