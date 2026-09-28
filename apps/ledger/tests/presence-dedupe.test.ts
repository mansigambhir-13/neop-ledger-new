// presence-dedupe.test · v3 §8 "Matrix will redeliver" · S4: the NEOP's presence records every event once by
// event_id (ledger.inbound_events, template t012) and every word it says once by key (ledger.outbound_events; the key
// is the transaction id), so on either road:
//   · a redelivered message never opens a second job, and never gets a second reply;
//   · a re-read outbox (a rewound mirror cursor, a restarted backend) never says anything twice;
//   · a reply resent after a crash is the same transaction (the homeserver returns the same event);
//   · t012 applies forward on a populated book (its proof in migrate.json).
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFamily, createPool, createTestDatabase, migrate, roleUrl, templateFiles, withCompany } from '@neop/pgkit';
import { migratePlatform } from '@neop/platform';
import { TEMPLATE_INFRA_TABLES, TEMPLATE_MIGRATIONS, type PresenceClient } from '@neop/template';
import { LEDGER_ROOT, seedLedger } from '../src/index.ts';
import { bootPilot, call, fakeClientHomeserver, finish, MATRIX, type FakeClientHomeserver, type Pilot } from './harness.ts';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (body: string, extra: Record<string, unknown> = {}) => ({ msgtype: 'm.text', body, ...extra });
const pnl = (P: Pilot, answer = 'Net profit for August 2026 came from 8 entries.') =>
  P.setBrain((v) => (v.calls === 0 ? call('ledger.report.pnl', { from: '2026-08-01', to: '2026-08-31' }) : finish(answer, 'done', { sources: ['ledger.report.pnl'] })));

describe('the client road: redelivery never opens twice or replies twice', () => {
  const ME = '@ledger:hs.test';
  const AGENT = '@reasoning_agent:hs.test';
  const PRIYA = '@priya:hs.test';
  let P: Pilot;
  const running: PresenceClient[] = [];
  const db = () => P.backend.core.runnerPool;
  beforeAll(async () => {
    P = await bootPilot({ presence: 'client' });
    expect((await P.api('PUT', `/api/users/${P.admin.id}/chat`, { matrix_user_id: PRIYA })).status).toBe(200);
    for (const e of [
      { app: 'ledger', matrix_id: PRIYA, kind: 'person' },
      { app: 'ledger', matrix_id: AGENT, kind: 'bridge', acts_for: P.admin.id },
    ]) expect((await P.api('PUT', '/api/chat/allowlist', e)).status).toBe(200);
    expect((await P.api('PUT', '/api/chat/presence', { app: 'ledger', matrix_user: ME })).status).toBe(200);
  });
  afterEach(async () => {
    while (running.length) await P.presence!.removeClient(running.pop()!);
  });
  afterAll(async () => P?.close());

  async function client(hs: FakeClientHomeserver) {
    await db().query('update ledger.presence_accounts set next_batch = null where account = $1', [ME]);
    const c = await P.presence!.addClient({ account: ME, accessToken: hs.token }, { homeserverUrl: 'http://hs.test', fetchImpl: hs.fetchImpl, syncTimeoutMs: 100, replyEveryMs: 50 });
    running.push(c);
    return c;
  }
  async function dmWith(hs: FakeClientHomeserver, from: string) {
    const dm = hs.invite(from);
    await P.waitFor(async () => hs.rooms.get(dm)!.members.has(ME) && (await db().query('select 1 from ledger.presence_dms where account = $1 and peer = $2 and room_id = $3', [ME, from, dm])).rowCount, `${from}'s DM`);
    return dm;
  }
  const jobsFrom = async (eventId: string) => (await db().query('select count(*)::int as n from ledger.jobs where origin = $1', [eventId])).rows[0].n as number;

  it('a plain message delivered three times: one job, one reply', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT);
    pnl(P);
    const q = hs.say(dm, AGENT, text('What was our net profit in August 2026?'));
    hs.redeliver(q);
    await P.waitFor(async () => hs.notices(dm).length >= 1, 'the reply');
    hs.redeliver(q);
    await pause(600);
    expect(await jobsFrom(q.event_id)).toBe(1);
    expect(hs.notices(dm)).toHaveLength(1);
    expect((await db().query('select count(*)::int as n from ledger.inbound_events where event_id = $1', [q.event_id])).rows[0].n).toBe(1);
  });

  it('a typed task redelivered: one job, one done, one reply', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, PRIYA);
    pnl(P);
    const t = hs.sayTyped(dm, PRIYA, 'neos.neop.task', { task_id: 'T-dup', company: P.company.id, on_behalf_of: PRIYA, text: 'P&L for August 2026' });
    hs.redeliver(t);
    await P.waitFor(async () => hs.typed(dm, 'neos.neop.done').length >= 1 && hs.notices(dm).length >= 1, 'done and the reply');
    hs.redeliver(t);
    await pause(600);
    expect(await jobsFrom(t.event_id)).toBe(1);
    expect(hs.typed(dm, 'neos.neop.done')).toHaveLength(1);
    expect(hs.notices(dm)).toHaveLength(1);
  });

  it('a reply resent after a crash is the same transaction: still one message', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT);
    pnl(P, 'once only');
    const q = hs.say(dm, AGENT, text('P&L please'));
    const [r] = await P.waitFor(async () => hs.notices(dm).length >= 1 && hs.notices(dm), 'the reply');
    // As if the process died between sending and recording: the row says "sending" again.
    await db().query("update ledger.inbound_events set reply_status = 'sending' where event_id = $1", [q.event_id]);
    await P.waitFor(async () => (await db().query("select 1 from ledger.inbound_events where event_id = $1 and reply_status = 'sent'", [q.event_id])).rowCount, 'resent');
    await pause(200);
    expect(hs.notices(dm)).toHaveLength(1);
    expect((await db().query('select reply_event_id from ledger.inbound_events where event_id = $1', [q.event_id])).rows[0].reply_event_id).toBe(r!.event_id);
  });
});

describe('the appservice road: redelivery and a re-read outbox never say anything twice', () => {
  const ROOM = '!ledger-dedupe:acme.example';
  const PRIYA = '@priya:acme.example';
  let P: Pilot;
  const db = () => P.backend.core.runnerPool;
  beforeAll(async () => {
    P = await bootPilot({ presence: 'appservice' });
    expect((await P.api('PUT', '/api/chat/presence', { app: 'ledger', room_ids: [ROOM] })).status).toBe(200);
    expect((await P.api('PUT', `/api/users/${P.admin.id}/chat`, { matrix_user_id: PRIYA })).status).toBe(200);
  });
  afterAll(async () => P?.close());
  const inRoom = () => P.hs!.sent.filter((m) => m.room === ROOM);
  /** The same event, pushed again by the homeserver (a new transaction id, the same event id). */
  const repush = async (ev: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${P.backend.ports.appservice}/_matrix/app/v1/transactions/re-${Math.random()}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${MATRIX.hsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events: [ev] }),
    });
    expect(res.status).toBe(200);
  };

  it('a room message pushed three times opens one job; its notices are said once each', async () => {
    pnl(P);
    const ev = { type: 'm.room.message', event_id: '$dup-plain:acme.example', room_id: ROOM, sender: PRIYA, content: { msgtype: 'm.text', body: 'P&L for August 2026 please' } };
    await repush(ev);
    await repush(ev);
    await P.waitFor(async () => inRoom().find((m) => /^Ledger: Net profit/.test(m.body)), 'the result');
    await repush(ev);
    await pause(500);
    expect((await db().query('select count(*)::int as n from ledger.jobs where origin = $1', [ev.event_id])).rows[0].n).toBe(1);
    const bodies = inRoom().map((m) => m.body);
    expect(bodies.filter((b) => /^On it — Ledger job/.test(b))).toHaveLength(1);
    expect(bodies.filter((b) => /^Ledger: Net profit/.test(b))).toHaveLength(1);
    expect(new Set(inRoom().map((m) => m.txn)).size).toBe(inRoom().length);
  });

  it('a typed task pushed twice: one job, one done', async () => {
    pnl(P);
    const ev = { type: 'neos.neop.task', event_id: '$dup-typed:acme.example', room_id: ROOM, sender: PRIYA, content: { task_id: 'T-dup', company: 'acmetraders', on_behalf_of: PRIYA, text: 'P&L for August 2026' } };
    await repush(ev);
    await repush(ev);
    await P.waitFor(async () => P.hs!.typed.find((e) => e.type === 'neos.neop.done' && e.content.task_id === 'T-dup'), 'done');
    await pause(400);
    expect((await db().query('select count(*)::int as n from ledger.jobs where origin = $1', [ev.event_id])).rows[0].n).toBe(1);
    expect(P.hs!.typed.filter((e) => e.type === 'neos.neop.done' && e.content.task_id === 'T-dup')).toHaveLength(1);
  });

  it('the mirror re-reading its outbox (cursor rewound, backend restarted) says nothing twice', async () => {
    const sent = inRoom().length;
    const typed = P.hs!.typed.length;
    await db().query('update ledger.presence_mirror set cursor = 0 where company_id = $1', [P.company.id]);
    await P.waitFor(async () => Number((await db().query('select cursor from ledger.presence_mirror where company_id = $1', [P.company.id])).rows[0].cursor) > 0, 're-read');
    await P.restartBackend();
    await db().query('update ledger.presence_mirror set cursor = 0 where company_id = $1', [P.company.id]);
    await P.waitFor(async () => Number((await db().query('select cursor from ledger.presence_mirror where company_id = $1', [P.company.id])).rows[0].cursor) > 0, 're-read after restart');
    await pause(400);
    expect(inRoom()).toHaveLength(sent);
    expect(P.hs!.typed).toHaveLength(typed);
  });
});

describe('template migration t012', () => {
  it('t012 applies forward on a populated book: nothing lost, the new tables empty and company-scoped, the desk writes people, the app only reads them', async () => {
    const db = await createTestDatabase();
    const CO = '11111111-2222-3333-4444-555555555555';
    const tdir = await mkdtemp(path.join(os.tmpdir(), 'neop-t012-'));
    try {
      await migratePlatform(db.adminUrl); // the desk's role exists, as in a real cluster
      await cp(TEMPLATE_MIGRATIONS, tdir, { recursive: true });
      const tled = JSON.parse(await readFile(path.join(tdir, 'migrate.json'), 'utf8'));
      for (const m of tled.migrations.filter((x: any) => x.file >= 't012')) await rm(path.join(tdir, m.file));
      tled.migrations = tled.migrations.filter((m: any) => m.file < 't012');
      await writeFile(path.join(tdir, 'migrate.json'), JSON.stringify(tled));
      await bootstrapFamily(db.adminUrl, 'ledger');
      const run = async (t: string) => migrate({ adminUrl: db.adminUrl, schema: 'ledger', sources: { dir: path.join(LEDGER_ROOT, 'migrations'), prepend: await templateFiles(t) }, lintExempt: TEMPLATE_INFRA_TABLES });
      await run(tdir);
      const pool = createPool(roleUrl(db.adminUrl, 'ledger_app'));
      const runner = createPool(roleUrl(db.adminUrl, 'ledger_runner'));
      const admin = new pg.Client({ connectionString: db.adminUrl });
      await admin.connect();
      try {
        await seedLedger(pool, CO);
        await admin.query(
          "insert into ledger.installs (company_id, status, company_name, time_zone, matrix_user, agent_senders) values ($1, 'active', 'Old Co', 'Asia/Kolkata', '@ledger:hs', '{@agent:hs}')",
          [CO],
        );
        await withCompany(pool, CO, (c) => c.query("insert into ledger.jobs (company_id, source, requester, task_id, ask, status) values ($1, 'room', 'user:x', gen_random_uuid(), 'old job', 'DONE')", [CO]));
        const count = async () => (await admin.query('select (select count(*) from ledger.jobs) + (select count(*) from ledger.installs) + (select count(*) from ledger.accounts) as n')).rows[0].n;
        const before = await count();

        const applied = await run(TEMPLATE_MIGRATIONS);
        expect(applied.map((m) => m.name)).toContain('t012_presence.sql');
        expect(await count()).toBe(before);
        expect((await runner.query('select matrix_user, agent_senders, agent_acts_for, company_slug from ledger.installs')).rows).toEqual([{ matrix_user: '@ledger:hs', agent_senders: ['@agent:hs'], agent_acts_for: {}, company_slug: null }]);
        for (const t of ['people', 'inbound_events', 'outbound_events', 'presence_accounts', 'presence_dms', 'presence_mirror']) {
          expect((await runner.query(`select count(*)::int as n from ledger.${t}`)).rows[0].n).toBe(0);
        }
        // The desk (the platform's write-through) writes people, scoped to its company; the app only reads them.
        await admin.query('begin');
        await admin.query('set local role neos_desk');
        await admin.query("select set_config('neos.company_id', $1, true)", [CO]);
        await admin.query("insert into ledger.people (company_id, matrix_id, user_id, name, role, chat_person) values ($1, '@priya:hs', '22222222-2222-3333-4444-555555555555', 'Priya', 'admin', true)", [CO]);
        await expect(admin.query("insert into ledger.people (company_id, matrix_id, user_id) values ('99999999-2222-3333-4444-555555555555', '@x:hs', '22222222-2222-3333-4444-555555555555')")).rejects.toThrow(/row-level security/);
        await admin.query('rollback');
        await admin.query('begin');
        await admin.query('set local role neos_desk');
        await admin.query("select set_config('neos.company_id', $1, true)", [CO]);
        await admin.query("insert into ledger.people (company_id, matrix_id, user_id, name, role, chat_person) values ($1, '@priya:hs', '22222222-2222-3333-4444-555555555555', 'Priya', 'admin', true)", [CO]);
        await admin.query('commit');
        expect((await withCompany(pool, CO, (c) => c.query('select matrix_id, chat_person from ledger.people'))).rows).toEqual([{ matrix_id: '@priya:hs', chat_person: true }]);
        expect((await withCompany(pool, '99999999-2222-3333-4444-555555555555', (c) => c.query('select 1 from ledger.people'))).rowCount).toBe(0);
        await expect(withCompany(pool, CO, (c) => c.query("update ledger.people set chat_person = false"))).rejects.toThrow(/permission denied/);
        await expect(withCompany(pool, CO, (c) => c.query('select * from ledger.inbound_events'))).rejects.toThrow(/permission denied/);
        // The runner keeps the road's records: once per event id.
        const ins = (id: string) =>
          runner.query(`insert into ledger.inbound_events (event_id, company_id, account, room_id, road, sender, type) values ($1, $2, '@ledger:hs', '!dm:hs', 'client', '@agent:hs', 'm.room.message') on conflict do nothing`, [id, CO]);
        expect((await ins('$e1')).rowCount).toBe(1);
        expect((await ins('$e1')).rowCount).toBe(0);
      } finally {
        await admin.end();
        await pool.end();
        await runner.end();
      }
    } finally {
      await db.drop();
      await rm(tdir, { recursive: true, force: true });
    }
  });
});
