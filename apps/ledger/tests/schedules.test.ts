// Timers (WP §7): an admin sets an app's schedules through the platform; the platform
// carries them to the app's platform-only L3 doors (schedules.set / schedules.list)
// with a gateway token, naming the admin as the requester. The app here is a minimal
// L3 that verifies the gateway token exactly as the template does.
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeServer } from '@neop/pgkit';
import { bootPilot, type Pilot } from './harness.ts';

let P: Pilot;
let server: ReturnType<typeof serve>;
const schedules: any[] = [];
const seen: any[] = [];

beforeAll(async () => {
  P = await bootPilot();
  const app = new Hono();
  const verify = async (c: any, ability: string) => {
    const { payload } = await jwtVerify(String(c.req.header('authorization')).slice(7), createLocalJWKSet(P.platform.gateway.jwks() as any), { issuer: 'neos-gateway', audience: 'clock', algorithms: ['EdDSA'] });
    seen.push(payload);
    if (payload.ability !== ability || payload.sub !== 'platform') throw new Error('bad token');
    return payload;
  };
  app.post('/l3/schedules.set', async (c) => {
    const claims = await verify(c, 'schedules.set');
    const b = await c.req.json();
    const row = { id: b.id ?? randomUUID(), company_id: claims.company_id, ask: b.ask, requester: b.requester, rule: b.rule, enabled: b.enabled !== false };
    const i = schedules.findIndex((s) => s.id === row.id);
    if (i >= 0) schedules[i] = row;
    else schedules.push(row);
    return c.json({ schedule: row });
  });
  app.get('/l3/schedules', async (c) => {
    const claims = await verify(c, 'schedules.list');
    return c.json({ schedules: schedules.filter((s) => s.company_id === claims.company_id) });
  });
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port));
  });
  await P.platform.registerApp({ key: 'clock', l3_url: `http://127.0.0.1:${port}`, manifest: { ...P.backend.core.manifest, app: 'clock', name: 'Clock', abilities: [], uses: [], skills: [] } as any, service_secret: 'c'.repeat(40) });
  await P.platform.installApp(P.company.id, 'clock', P.admin.id);
});
afterAll(async () => {
  await closeServer(server as any);
  await P?.close();
});

describe('schedules', () => {
  it('an admin sets and lists an app’s schedules through the gateway; the admin is the requester of every run', async () => {
    const rule = { every: 'month', at: '09:00', day: 1 };
    const put = await P.api('PUT', '/api/apps/clock/schedules', { ask: 'Prepare the month-end close checklist', rule });
    expect(put.status).toBe(200);
    expect(put.body.schedule).toMatchObject({ ask: 'Prepare the month-end close checklist', requester: `user:${P.admin.id}`, rule, company_id: P.company.id });
    const id = put.body.schedule.id;
    const off = await P.api('PUT', '/api/apps/clock/schedules', { id, ask: 'Prepare the month-end close checklist', rule, enabled: false });
    expect(off.body.schedule).toMatchObject({ id, enabled: false });
    const list = await P.api('GET', '/api/apps/clock/schedules');
    expect(list.body.schedules).toHaveLength(1);
    expect(seen.map((s) => s.ability)).toEqual(['schedules.set', 'schedules.set', 'schedules.list']);
    const audit = (await P.platform.db.query("select actor, outcome from neos.audit where action = 'schedule.set' and app_key = 'clock'")).rows;
    expect(audit).toHaveLength(2);
    expect(audit[0].actor).toBe(`user:${P.admin.id}`);
  });

  it('members cannot set schedules, and no app can reach another app’s schedule doors', async () => {
    expect((await P.api('PUT', '/api/apps/clock/schedules', { ask: 'x', rule: { every: 'day', at: '08:00' } }, P.member.token)).status).toBe(403);
    expect((await P.api('GET', '/api/apps/clock/schedules', undefined, P.member.token)).status).toBe(403);
    expect((await P.api('POST', '/api/apps/clock/read/schedules.list', {})).status).toBe(403);
    await expect(P.platform.internalCall('ledger', { company_id: P.company.id, app: 'clock', endpoint: 'schedules.set', body: {}, idem_key: randomUUID() })).rejects.toMatchObject({ code: 'denied' });
    await expect(P.platform.gateway.call({ caller: 'app:ledger', app: 'clock', endpoint: 'schedules.list', company_id: P.company.id })).rejects.toMatchObject({ code: 'denied' });
  });
});
