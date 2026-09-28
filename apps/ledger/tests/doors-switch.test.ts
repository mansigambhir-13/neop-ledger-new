// doors-switch.test · v3 §4 "abilities and connections sit in one list". Every door an app declares is a line
// `door:<key>` on its switchboard, on or off (the app's floor from its manifest door entry, default on; a company
// can only switch it off). Off means three things at once: the backend reads no key for it from the secret store, every ability that
// needs it is not shown to the assistant, and the gate refuses such an ability even when asked by name.
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootstrapFamily, migrate, templateFiles } from '@neop/pgkit';
import { TEMPLATE_INFRA_TABLES, TEMPLATE_MIGRATIONS } from '@neop/template';
import { offDoors } from '../../../packages/neop-template/src/gate/tools.ts';
import { bootPilot, finish, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => P?.close());

const board = async () => (await P.api('GET', '/api/apps/ledger/abilities')).body;
const setDoor = (v: unknown, door = 'email', token?: string) => P.api('PUT', '/api/switchboards/ledger', { settings: { [`door:${door}`]: v } }, token);

async function toolsNow(): Promise<string[]> {
  let tools: string[] = [];
  P.setBrain((v) => {
    tools = v.tools;
    return finish('ok');
  });
  const t = await P.ask('what can you do?');
  await P.waitFor(async () => (await P.task(t.task_id)).task.status === 'COMPLETED', 'done');
  return tools;
}

describe('door lines on the board', () => {
  it('every declared door is a line door:<key>, floor from the manifest (default on), shown like the others', async () => {
    const b = await board();
    expect(b.doors).toEqual([
      { key: 'email', line: 'door:email', floor: 'on', company: null, setting: 'on', declared_by: 'own', scopes: ['send'] },
      // v3 S7: nep-gst is installed into Ledger's build; the doors its handlers may open are lines too (B6).
      { key: 'gst_portal', line: 'door:gst_portal', floor: 'on', company: null, setting: 'on', declared_by: 'package', scopes: [] },
      { key: 'gst_portal_otp', line: 'door:gst_portal_otp', floor: 'on', company: null, setting: 'on', declared_by: 'package', scopes: [] },
    ]);
  });

  it('on/off only; unknown doors refused; members cannot change it', async () => {
    expect((await setDoor('ask_first')).body.error.code).toBe('bad_setting');
    expect((await setDoor('off', 'fax')).body.error.code).toBe('unknown_door');
    expect((await setDoor('off', 'email', P.member.token)).status).toBe(403);
  });
});

describe('a door switched off', () => {
  it('is off on the board, no key is read for it, its abilities are hidden and refused by name', async () => {
    const before = await toolsNow();
    expect(before).toContain('ledger__invoice__send');
    expect(before).toContain('ledger__close_pack__email');

    expect((await setDoor('off')).status).toBe(200);
    expect((await board()).doors[0]).toMatchObject({ line: 'door:email', company: 'off', setting: 'off' });

    // The backend's lend: refused on the switch, definitely, before the secret store is read.
    const core = P.backend.core;
    const spy = vi.spyOn(core.secrets, 'get');
    await P.waitFor(async () => (await core.lendDoor(P.company.id, 'email', ['email']).catch((e) => e))?.code === 'door_off', 'board refreshed');
    await expect(core.doors(P.company.id).email.send({ to: ['a@b.example'], subject: 's', text: 't' }, 'k-off')).rejects.toMatchObject({ code: 'door_off', definite: true });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    // The assistant is not shown any ability that needs it; the rest are untouched.
    const after = await toolsNow();
    for (const k of ['ledger__invoice__send', 'ledger__reminder__send', 'ledger__close_pack__email']) expect(after).not.toContain(k);
    expect(after).toContain('ledger__report__pnl');

    // A token that still lists it (minted before the switch) is refused by the gate, by name.
    P.setBrain((v) => (v.calls === 0 ? { hang: true } : finish('x')));
    const t = await P.ask('hold');
    const job = await P.waitFor(async () => {
      const j = await P.jobRow(t.job_id);
      return j.status === 'RUNNING' && j;
    }, 'running');
    const tok = await P.backend.core.jobTokens.mint({ sub: t.job_id, sid: job.claimed_by, company_id: P.company.id, abilities: ['ledger.invoice.send'] }, 60_000);
    const res = await fetch(`http://127.0.0.1:${P.backend.ports.gate}/gate/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'ledger.invoice.send', args: {} }),
    });
    const body = await res.json();
    expect(body).toMatchObject({ status: 'refused', code: 'door_off' });
    expect(body.reason).toMatch(/email door/);
    P.worker.kill(t.job_id);
  });

  it('switched back on: shown again and the key is read again', async () => {
    expect((await setDoor('on')).status).toBe(200);
    expect((await board()).doors[0]).toMatchObject({ company: 'on', setting: 'on' });
    expect(await toolsNow()).toContain('ledger__invoice__send');
    const r = await P.waitFor(async () => P.backend.core.lendDoor(P.company.id, 'email', ['email']).catch(() => null), 'key read');
    expect(r).toMatchObject({ provider: 'dev-mailbox' });
  });
});

describe('a door whose floor is off', () => {
  it('a company cannot switch it on; the backend refuses it; a floor is on or off', async () => {
    const m = (await P.platform.db.query("select manifest from neos.apps where key = 'ledger'")).rows[0].manifest;
    const base = { ...m, app: 'doorfloor', name: 'Door floor', abilities: [], uses: [], skills: [], packages: [], blocks: [], personal_data: undefined };
    await expect(P.platform.registerApp({ key: 'doorfloor', l3_url: 'http://x', manifest: { ...base, doors: [{ key: 'post', scopes: [], floor: 'ask_first' as any }] }, service_secret: 's' })).rejects.toMatchObject({ code: 'bad_door_floor' });
    // Every NEOP has its own schema (v3 §11), where its switchboard lives (t010): the template's tables for this one.
    const none = await mkdtemp(path.join(os.tmpdir(), 'neop-doorfloor-'));
    await bootstrapFamily(P.adminUrl, 'doorfloor');
    await migrate({ adminUrl: P.adminUrl, schema: 'doorfloor', sources: { dir: none, prepend: await templateFiles(TEMPLATE_MIGRATIONS) }, lintExempt: TEMPLATE_INFRA_TABLES });
    await P.platform.registerApp({ key: 'doorfloor', l3_url: 'http://x', manifest: { ...base, doors: [{ key: 'post', scopes: [], floor: 'off' }, { key: 'sms', scopes: [] }] }, service_secret: 's' });
    await P.platform.installApp(P.company.id, 'doorfloor');
    const r = await P.api('PUT', '/api/switchboards/doorfloor', { settings: { 'door:post': 'on' } });
    expect(r.body.error.code).toBe('cannot_loosen');
    expect((await P.api('PUT', '/api/switchboards/doorfloor', { settings: { 'door:post': 'off', 'door:sms': 'off' } })).status).toBe(200);
    const lines = await P.platform.doorLines('doorfloor', P.company.id);
    expect(lines.map((l) => [l.line, l.floor, l.setting])).toEqual([
      ['door:post', 'off', 'off'],
      ['door:sms', 'on', 'off'],
    ]);
    // What a backend's lend checks (the same rule as its gate): off by floor, or off by the company.
    const sb = await P.platform.switchboard(P.company.id, 'doorfloor');
    const board = { hostSetting: (k: string) => (sb.settings as any)?.[k] ?? 'on' };
    const fm = { doors: [{ key: 'post', scopes: [], floor: 'off' as const }, { key: 'sms', scopes: [] }] };
    expect(offDoors(fm as any, board as any, { doors: ['post', 'sms'] })).toEqual(['post', 'sms']);
    expect(offDoors(fm as any, { hostSetting: () => 'on' } as any, { doors: ['post', 'sms'] })).toEqual(['post']);
  });
});
