// Timers (WP §7): an admin sets an app's schedules through the platform, naming the admin as the requester of every
// run. v3 S9: the platform writes and reads them on the app's own rows, as the desk, through <app>.set_schedule()
// (template t010) and <app>.list_schedules() (t018) — no gateway, no route into the app. The runner opens one timer job
// per slot (apps/ledger/tests/runtime-timers.test.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCompany } from '@neop/pgkit';
import { bootPilot, DeskHarness, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => P?.close());

describe('schedules', () => {
  it('an admin sets and lists an app’s schedules on the app’s own rows (as the desk); the admin is the requester of every run', async () => {
    const rule = { every: 'month', at: '09:00', day: 1 };
    const put = await P.api('PUT', '/api/apps/ledger/schedules', { ask: 'Prepare the month-end close checklist', rule });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.schedule).toMatchObject({ ask: 'Prepare the month-end close checklist', requester: `user:${P.admin.id}`, rule, company_id: P.company.id, time_zone: 'Asia/Kolkata', enabled: true });
    const id = put.body.schedule.id;
    const off = await P.api('PUT', '/api/apps/ledger/schedules', { id, ask: 'Prepare the month-end close checklist', rule, enabled: false });
    expect(off.body.schedule).toMatchObject({ id, enabled: false, next_run_at: null });
    const list = await P.api('GET', '/api/apps/ledger/schedules');
    expect(list.body.schedules.map((s: any) => s.id)).toEqual([id]);
    // The row is the app's own: the runner reads exactly what the desk wrote.
    const row = (await P.backend.core.runnerPool.query('select ask, requester, rule, enabled from ledger.schedules where id = $1', [id])).rows[0];
    expect(row).toEqual({ ask: 'Prepare the month-end close checklist', requester: `user:${P.admin.id}`, rule, enabled: false });
    const audit = (await P.platform.db.query("select actor, outcome from neos.audit where action = 'schedule.set' and app_key = 'ledger' order by id")).rows;
    expect(audit).toHaveLength(2);
    expect(audit[0].actor).toBe(`user:${P.admin.id}`);
    expect(audit[0].outcome).toBe(id);
    // A rule the table would never run is refused before anything is written.
    const bad = await P.api('PUT', '/api/apps/ledger/schedules', { ask: 'x', rule: { every: 'week', at: '09:00' } });
    expect(bad.status).toBe(400);
    expect((await P.api('PUT', '/api/apps/ledger/schedules', { ask: 'x', rule: { every: 'day', at: '25:00' } })).status).toBe(400);
    expect((await P.api('GET', '/api/apps/ledger/schedules')).body.schedules).toHaveLength(1);
  });

  it('members cannot set or list schedules; the schedules are no screen read; the desk reaches them only through the functions', async () => {
    expect((await P.api('PUT', '/api/apps/ledger/schedules', { ask: 'x', rule: { every: 'day', at: '08:00' } }, P.member.token)).status).toBe(403);
    expect((await P.api('GET', '/api/apps/ledger/schedules', undefined, P.member.token)).status).toBe(403);
    // Not a declared read of the app: the screens' read route refuses it.
    expect((await P.api('POST', '/api/apps/ledger/read/schedules.list', {})).status).toBe(403);
    // The desk role: the functions, never the table.
    const desk = await DeskHarness.connect(P.adminUrl);
    try {
      expect(await desk.errorOf(P.company.id, 'select * from ledger.schedules')).toBe('42501');
      expect(await desk.errorOf(P.company.id, "insert into ledger.schedules (company_id, ask, requester, rule, time_zone) values ($1, 'x', 'user:x', '{\"every\":\"day\",\"at\":\"08:00\"}', 'UTC')", [P.company.id])).toBe('42501');
      const listed = await desk.query(P.company.id, 'select ledger.list_schedules() as r');
      expect(listed[0].r).toHaveLength(1);
    } finally {
      await desk.close();
    }
    // The app role only reads its schedules (it never deletes one: switched off, never deleted).
    await expect(withCompany(P.backend.core.appPool, P.company.id, (c) => c.query('delete from ledger.schedules'))).rejects.toThrow(/permission denied/);
  });
});
