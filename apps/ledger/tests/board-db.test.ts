// board-db.test · v3 S1 — the switchboard, the installs and the grants are the TRUTH in the app's own schema
// (WP v3 §4 "one table, one truth", §5, §11; template t010):
//   · the tighten-only trigger refuses what the platform refuses: a setting looser than the floor, an ask-first
//     read, a door or skill line that is not on/off, a floor the desk tries to loosen, a policy on a read;
//   · a change to <schema>.switchboard NOTIFYs 'board:<company>' and the gate drops its cached board within 1 s;
//   · the app role only reads (42501 on every write); the desk role (neos_desk) writes switchboard and installs and
//     nothing else of the app's; the runner may re-stamp floors and suspend a grant;
//   · create_grant / revoke_grant check what the platform checked; a grant suspends itself in the app's schema;
//   · t010 applies forward on a populated book (its proof in migrate.json).
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFamily, createPool, createTestDatabase, migrate, roleUrl, templateFiles, withCompany } from '@neop/pgkit';
import { migratePlatform } from '@neop/platform';
import { loadBoard, matchGrant, NotInstalled, TEMPLATE_INFRA_TABLES, TEMPLATE_MIGRATIONS } from '@neop/template';
import { LEDGER_ROOT, seedLedger } from '../src/index.ts';
import { bootPilot, call, finish, type Pilot } from './harness.ts';
import { appMigrationsBefore } from '@neop/testkit';

const errOf = (p: Promise<unknown>) => p.then(() => ({ code: 'ok', message: '' }), (e: { code?: string; message?: string }) => ({ code: e.code ?? '?', message: e.message ?? String(e) }));
/** One transaction as a role (the desk, by SET ROLE from the admin link), scoped to a company. */
async function as<T>(admin: pg.Client, role: string, co: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await admin.query('begin');
  try {
    await admin.query(`set local role ${role}`);
    await admin.query("select set_config('neos.company_id', $1, true)", [co]);
    const out = await fn(admin);
    await admin.query('commit');
    return out;
  } catch (e) {
    await admin.query('rollback').catch(() => {});
    throw e;
  }
}

describe('on a running pilot', () => {
  let P: Pilot;
  let admin: pg.Client;
  const desk = <T = any>(sql: string, params: unknown[] = [], co?: string) => as(admin, 'neos_desk', co ?? P.company.id, async (c) => (await c.query(sql, params)).rows as T[]);
  const app = (sql: string, params: unknown[] = []) => withCompany(P.backend.core.appPool, P.company.id, (c) => c.query(sql, params));
  beforeAll(async () => {
    P = await bootPilot();
    admin = new pg.Client({ connectionString: P.adminUrl });
    await admin.connect();
  });
  afterAll(async () => {
    await admin?.end();
    await P?.close();
  });

  it('the tighten-only trigger refuses exactly what the platform refuses', async () => {
    const ins = (line: string, kind: string | null, floor: string | null, setting: string, extra = '') =>
      errOf(desk(`insert into ledger.switchboard (company_id, line, kind, floor, setting${extra ? ', approvers' : ''}) values ($1, $2, $3, $4, $5${extra ? ", '{\"roles\":[\"admin\"]}'" : ''})`, [P.company.id, line, kind, floor, setting]));
    // A company setting can never loosen the manifest floor.
    expect(await ins('ledger.journal.post', 'write', 'ask_first', 'on')).toMatchObject({ code: '23514', message: expect.stringMatching(/^cannot_loosen: ledger\.journal\.post: the app's floor is ask_first/) });
    // A read can't be ask-first.
    expect(await ins('ledger.report.pnl', 'read', 'on', 'ask_first')).toMatchObject({ code: '23514', message: expect.stringMatching(/^read_cannot_ask_first/) });
    // A door is on or off, and its floor holds; a skill is on or off.
    expect(await ins('door:email', null, 'on', 'ask_first')).toMatchObject({ code: '23514', message: expect.stringMatching(/^bad_setting: door:email: a door line is on or off/) });
    expect(await ins('door:post', null, 'off', 'on')).toMatchObject({ code: '23514', message: expect.stringMatching(/^cannot_loosen: door:post/) });
    expect(await ins('skill:financial-reports', null, null, 'ask_first')).toMatchObject({ code: '23514', message: expect.stringMatching(/^bad_setting: skill:/) });
    // An approver policy belongs to a write.
    expect(await ins('ledger.report.pnl', 'read', 'on', 'on', 'policy')).toMatchObject({ code: '23514', message: expect.stringMatching(/^bad_policy/) });
    // The DBA's restore switch (neos.restore) is honoured for the admin link only, never for the desk's pool.
    const viaPlatform = await errOf(
      P.platform.boards.asDesk('ledger', P.company.id, async (c) => {
        await c.query("select set_config('neos.restore', 'on', true)");
        await c.query("insert into ledger.switchboard (company_id, line, kind, floor, setting) values ($1, 'ledger.journal.post', 'write', 'ask_first', 'on')", [P.company.id]);
      }),
    );
    expect(viaPlatform).toMatchObject({ code: '23514', message: expect.stringMatching(/^cannot_loosen/) });
    // What is allowed is allowed: tighter than the floor, or equal to it.
    expect(await ins('ledger.journal.post', 'write', 'ask_first', 'off')).toMatchObject({ code: 'ok' });
    // The desk may not loosen the floor it is held to, nor recast the line …
    expect(await errOf(desk("update ledger.switchboard set floor = 'on', setting = 'on' where line = 'ledger.journal.post'"))).toMatchObject({ code: '23514', message: expect.stringMatching(/^cannot_loosen: ledger\.journal\.post: the app's floor is ask_first; only the app can change it/) });
    expect(await errOf(desk("update ledger.switchboard set kind = 'read' where line = 'ledger.journal.post'"))).toMatchObject({ code: '23514', message: expect.stringMatching(/^bad_line/) });
    // … the app's own runner may (a new manifest can move a floor), and a floor that tightened pulls the switch up.
    const runner = P.backend.core.runnerPool;
    await withCompany(runner, P.company.id, (c) => c.query("update ledger.switchboard set floor = 'on' where line = 'ledger.journal.post'"));
    expect(await P.backend.core.board.syncFloors(runner)).toBe(1); // back to the manifest's ask_first
    expect((await desk("select floor, setting from ledger.switchboard where line = 'ledger.journal.post'"))[0]).toEqual({ floor: 'ask_first', setting: 'off' });
    // Through the platform's API the same refusals come back as 422s (validated there first).
    expect((await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.journal.post': 'on' } })).body.error.code).toBe('cannot_loosen');
    expect((await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.report.pnl': 'ask_first' } })).body.error.code).toBe('read_cannot_ask_first');
    await desk("delete from ledger.switchboard where line = 'ledger.journal.post'");
  });

  it('a change to the switchboard NOTIFYs the gate, which drops its cached board within 1 s', async () => {
    const core = P.backend.core;
    const pnl = core.ability('ledger.report.pnl')!;
    const warm = await core.board.get(P.company.id);
    expect(warm.setting(pnl)).toBe('on');
    // Straight into the table as the desk — no platform call, no push: the database tells the gate.
    const t0 = Date.now();
    await desk("insert into ledger.switchboard (company_id, line, kind, floor, setting) values ($1, 'ledger.report.pnl', 'read', 'on', 'off')", [P.company.id]);
    await P.waitFor(async () => (await core.board.get(P.company.id)).setting(pnl) === 'off', 'the gate saw it', 1_000);
    expect(Date.now() - t0).toBeLessThan(1_000);
    const now = await core.board.get(P.company.id);
    expect(now.version).toBeGreaterThan(warm.version);
    // The install is part of the board: uninstalling it stops the gate acting for the company at once.
    await desk("update ledger.installs set status = 'removed' where company_id = $1", [P.company.id]);
    await P.waitFor(async () => (await errOf(core.board.get(P.company.id))).code === 'not_installed', 'the gate refused', 1_000);
    await expect(core.board.get(P.company.id)).rejects.toBeInstanceOf(NotInstalled);
    await desk("update ledger.installs set status = 'active' where company_id = $1", [P.company.id]);
    await desk("update ledger.switchboard set setting = 'on' where line = 'ledger.report.pnl'");
    await P.waitFor(async () => (await core.board.get(P.company.id)).setting(pnl) === 'on', 'back on', 1_000);
  });

  it('the app role may only read the board, the install and the grants; the desk writes the board and nothing of the app’s own', async () => {
    for (const sql of [
      "insert into ledger.switchboard (company_id, line, setting, version) values (current_setting('neos.company_id')::uuid, 'ledger.report.pnl', 'off', 1)",
      "update ledger.switchboard set setting = 'off'",
      'delete from ledger.switchboard',
      "update ledger.installs set status = 'removed'",
      "insert into ledger.grants (company_id, grant_id, ability_key, status) values (current_setting('neos.company_id')::uuid, gen_random_uuid(), 'x', 'ACTIVE')",
      "update ledger.grants set status = 'ACTIVE'",
      "insert into ledger.switchboard_history (company_id, version, line, op) values (current_setting('neos.company_id')::uuid, 1, 'x', 'insert')",
      "select ledger.create_grant('ledger.journal.post', '{}', now() + interval '1 day', 'user:x')",
      "select ledger.suspend_grant(gen_random_uuid(), 'x')",
    ]) expect((await errOf(app(sql))).code, sql).toBe('42501');
    expect((await app('select count(*)::int as n from ledger.switchboard')).rows[0].n).toBeGreaterThan(0);
    // The runner neither copies nor writes lines any more.
    expect((await errOf(P.backend.core.runnerPool.query("insert into ledger.switchboard (company_id, line, setting, version) values ($1, 'ledger.report.pnl', 'off', 1)", [P.company.id]))).code).toBe('42501');
    expect((await errOf(P.backend.core.runnerPool.query("insert into ledger.grants (company_id, grant_id, ability_key, status) values ($1, gen_random_uuid(), 'x', 'ACTIVE')", [P.company.id]))).code).toBe('42501');
    // The desk: the board and the install, yes; the app's own tables, no.
    expect(await desk('select count(*)::int as n from ledger.installs')).toEqual([{ n: 1 }]);
    for (const sql of ['select 1 from ledger.jobs', 'select 1 from ledger.proposals', 'select 1 from ledger.journal_entries', "update ledger.grants set status = 'REVOKED'", 'delete from ledger.grant_uses']) {
      expect((await errOf(desk(sql))).code, sql).toBe('42501');
    }
    // The platform's own pool role holds the desk's rights only after SET ROLE (membership WITH INHERIT FALSE).
    expect((await errOf(P.platform.db.query('select 1 from ledger.switchboard'))).code).toBe('42501');
  });

  it('create_grant / revoke_grant: the desk writes standing yeses only through them, checked like the platform checks', async () => {
    const create = (ability: string, limits: unknown, expires: string, by = `user:${P.admin.id}`) =>
      errOf(desk<{ id: string }>('select ledger.create_grant($1, $2::jsonb, $3::timestamptz, $4) as id', [ability, JSON.stringify(limits), expires, by]));
    const inAWeek = new Date(Date.now() + 7 * 864e5).toISOString();
    expect(await create('ledger.payment.record', { per_call_minor: -5, currency: 'INR' }, inAWeek)).toMatchObject({ code: '22023', message: expect.stringMatching(/^bad_limits: per_call_minor/) });
    expect(await create('ledger.payment.record', { per_call_minor: 1000 }, inAWeek)).toMatchObject({ code: '22023', message: expect.stringMatching(/^bad_limits: an amount limit needs a currency/) });
    expect(await create('ledger.close_pack.email', { recipients_allow: ['not-an-email'] }, inAWeek)).toMatchObject({ message: expect.stringMatching(/^bad_limits: recipients_allow/) });
    expect(await create('ledger.payment.record', { per_call_minor: 1000, currency: 'INR' }, new Date(Date.now() + 400 * 864e5).toISOString())).toMatchObject({ message: expect.stringMatching(/^bad_expiry/) });
    expect(await create('ledger.payment.record', { per_call_minor: 1000, currency: 'INR' }, inAWeek, 'app:ledger')).toMatchObject({ message: expect.stringMatching(/^bad_request: a standing yes is written by a person/) });
    await desk("insert into ledger.switchboard (company_id, line, kind, floor, setting) values ($1, 'ledger.report.pnl', 'read', 'on', 'on') on conflict (company_id, line) do nothing", [P.company.id]);
    expect(await create('ledger.report.pnl', {}, inAWeek)).toMatchObject({ message: expect.stringMatching(/^not_grantable/) });
    const ok = await desk<{ id: string }>('select ledger.create_grant($1, $2::jsonb, $3::timestamptz, $4) as id', ['ledger.payment.record', JSON.stringify({ per_call_minor: 50_000, currency: 'INR' }), inAWeek, `user:${P.admin.id}`]);
    const id = ok[0]!.id;
    expect(await desk('select ability_key, status, created_by, limits from ledger.grants where grant_id = $1', [id])).toEqual([{ ability_key: 'ledger.payment.record', status: 'ACTIVE', created_by: `user:${P.admin.id}`, limits: { per_call_minor: 50_000, currency: 'INR' } }]);
    // The gate matches it — in the app's schema, under the app role.
    const match = (amount: number) => withCompany(P.backend.core.appPool, P.company.id, (c) => matchGrant(c, 'ledger', 'ledger.payment.record', { amount_minor: amount, currency: 'INR' }, 'Asia/Kolkata'));
    expect(await match(40_000)).toEqual({ grant_id: id });
    expect(await match(60_000)).toBeNull();
    // Another company's session cannot see or revoke it.
    const other = randomUUID();
    expect(await errOf(desk('select ledger.revoke_grant($1, $2)', [id, `user:${P.admin.id}`], other))).toMatchObject({ code: 'P0002' });
    expect((await desk<{ r: any }>('select ledger.revoke_grant($1, $2) as r', [id, `user:${P.admin.id}`]))[0]!.r).toMatchObject({ status: 'REVOKED', changed: true });
    expect((await desk<{ r: any }>('select ledger.revoke_grant($1, $2) as r', [id, `user:${P.admin.id}`]))[0]!.r).toMatchObject({ status: 'REVOKED', changed: false });
    expect(await match(40_000)).toBeNull();
    expect(await errOf(desk('select ledger.revoke_grant($1, $2)', [randomUUID(), `user:${P.admin.id}`]))).toMatchObject({ code: 'P0002' });
    // The runner's self-suspend: ACTIVE → SUSPENDED only.
    const g2 = (await desk<{ id: string }>('select ledger.create_grant($1, $2::jsonb, $3::timestamptz, $4) as id', ['ledger.payment.record', JSON.stringify({ per_call_minor: 50_000, currency: 'INR' }), inAWeek, `user:${P.admin.id}`]))[0]!.id;
    const suspend = () => withCompany(P.backend.core.runnerPool, P.company.id, async (c) => (await c.query('select ledger.suspend_grant($1, $2) as ok', [g2, 'test'])).rows[0].ok);
    expect(await suspend()).toBe(true);
    expect(await suspend()).toBe(false);
    expect(await desk('select status, suspended_reason from ledger.grants where grant_id = $1', [g2])).toEqual([{ status: 'SUSPENDED', suspended_reason: 'test' }]);
    // set_schedule: the desk's way to set a timer, in the install's time zone.
    const s = (await desk<{ s: any }>(`select ledger.set_schedule(null, 'Send the weekly summary', $1, '{"every":"week","at":"09:00","weekday":1}'::jsonb, true) as s`, [`user:${P.admin.id}`]))[0]!.s;
    expect(s).toMatchObject({ time_zone: 'Asia/Kolkata', enabled: true, company_id: P.company.id });
    expect(s.next_run_at).toBeTruthy();
    await desk('select ledger.set_schedule($1, $2, $3, $4::jsonb, false)', [s.id, s.ask, s.requester, JSON.stringify(s.rule)]);
  });

  it('a grant suspends itself in the app’s schema when a write it approved ends FAILED (the gate, the approved path, no platform)', async () => {
    const g = await P.api('POST', '/api/grants', { app_key: 'ledger', ability_key: 'ledger.journal.post', limits: { per_call_minor: 1_000_000, currency: 'INR' }, expires_at: new Date(Date.now() + 864e5).toISOString() });
    expect(g.status).toBe(200);
    const core = P.backend.core;
    // Switched off in the window after the gate matched the grant: the approved path re-reads and FAILs it.
    core.hooks.afterGrantMatched = async () => {
      await desk("insert into ledger.switchboard (company_id, line, kind, floor, setting) values ($1, 'ledger.journal.post', 'write', 'ask_first', 'off') on conflict (company_id, line) do update set setting = 'off'", [P.company.id]);
    };
    try {
      P.setBrain((v) =>
        v.calls === 0
          ? call('ledger.journal.post', { date: '2026-08-31', memo: 'self-suspend probe', currency: 'INR', lines: [{ account_code: '6300', debit_minor: 700, credit_minor: 0 }, { account_code: '2000', debit_minor: 0, credit_minor: 700 }], card: { what: 'Post', why: 'test', changes: 'One entry', if_no_answer: 'Nothing' } })
          : finish('not run', 'blocked'),
      );
      const t = await P.ask('Accrue under the standing yes');
      await P.waitFor(async () => ['COMPLETED', 'FAILED'].includes((await P.task(t.task_id)).task.status), 'task settled');
      const [p] = (await core.runnerPool.query('select id, status, approved_via, grant_id from ledger.proposals where job_id = $1', [t.job_id])).rows;
      expect(p).toMatchObject({ status: 'FAILED', approved_via: 'grant', grant_id: g.body.id });
      expect(await desk('select status, suspended_reason from ledger.grants where grant_id = $1', [g.body.id])).toEqual([{ status: 'SUSPENDED', suspended_reason: `execution FAILED for proposal ${p.id}` }]);
      expect((await core.runnerPool.query("select count(*)::int as n from ledger.proposal_events where proposal_id = $1 and event = 'grant_suspended'", [p.id])).rows[0].n).toBe(1);
      expect((await P.api('GET', '/api/grants')).body.grants.find((x: any) => x.id === g.body.id)).toMatchObject({ status: 'SUSPENDED', uses: 1 });
    } finally {
      delete core.hooks.afterGrantMatched;
      await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.journal.post': 'ask_first' } });
      await P.api('DELETE', `/api/grants/${g.body.id}`);
    }
  });

});

describe('t010 on a populated book', () => {
  it('t010 applies forward on a populated book: history kept, new columns NULL, t009 mirrors stay safe, the triggers hold on old rows', async () => {
    const db = await createTestDatabase();
    const CO = '11111111-2222-3333-4444-555555555555';
    const tdir = await mkdtemp(path.join(os.tmpdir(), 'neop-t010-'));
    let beforeDir = '';
    try {
      await migratePlatform(db.adminUrl); // the desk's role exists, as in a real cluster
      // The book as it stood before: the template stream up to t009, and the app's own.
      await cp(TEMPLATE_MIGRATIONS, tdir, { recursive: true });
      const tled = JSON.parse(await readFile(path.join(tdir, 'migrate.json'), 'utf8'));
      for (const m of tled.migrations.filter((x: any) => x.file >= 't010')) await rm(path.join(tdir, m.file));
      tled.migrations = tled.migrations.filter((m: any) => m.file < 't010');
      await writeFile(path.join(tdir, 'migrate.json'), JSON.stringify(tled));
      await bootstrapFamily(db.adminUrl, 'ledger');
      const run = async (t: string, appDir = path.join(LEDGER_ROOT, 'migrations')) => migrate({ adminUrl: db.adminUrl, schema: 'ledger', sources: { dir: appDir, prepend: await templateFiles(t) }, lintExempt: TEMPLATE_INFRA_TABLES });
      await run(tdir, (beforeDir = await appMigrationsBefore(path.join(LEDGER_ROOT, 'migrations'), '010')));
      const pool = createPool(roleUrl(db.adminUrl, 'ledger_app'));
      const runner = createPool(roleUrl(db.adminUrl, 'ledger_runner'));
      await seedLedger(pool, CO);
      // What t009's mirror wrote (as the runner): effective settings at the platform's version, an install, a grant seen.
      const grant = randomUUID();
      await runner.query(
        `insert into ledger.switchboard (company_id, line, kind, floor, setting, caps, rules, version) values
           ($1, 'ledger.report.pnl', 'read', 'on', 'off', '{}', '[]', 4), ($1, 'ledger.journal.post', 'write', 'ask_first', 'ask_first', '{}', '[]', 4)`,
        [CO],
      );
      await runner.query("insert into ledger.installs (company_id, status) values ($1, 'active')", [CO]);
      await runner.query("insert into ledger.grants (company_id, grant_id, ability_key, status) values ($1, $2, 'ledger.journal.post', 'ACTIVE')", [CO, grant]);
      const pid = await withCompany(pool, CO, async (c) => {
        const job = (await c.query("insert into ledger.jobs (company_id, source, requester, task_id, ask, status) values ($1, 'task', 'user:x', gen_random_uuid(), 'old job', 'DONE') returning id", [CO])).rows[0].id;
        return (
          await c.query(
            `insert into ledger.proposals (company_id, job_id, ability_key, ability_version, args, card, fingerprint, status, approved_via, grant_id, expires_at, idempotency_key)
             values ($1, $2, 'ledger.journal.post', '1.0.0', '{}', '{}', 'sha256:' || md5(random()::text), 'APPROVED', 'grant', $3, now() + interval '1 day', gen_random_uuid()::text) returning id`,
            [CO, job, grant],
          )
        ).rows[0].id as string;
      });
      await runner.query("update ledger.proposals set status = 'EXECUTING' where id = $1", [pid]);
      const before = await runner.query('select line, setting, version from ledger.switchboard order by line');

      const applied = await run(TEMPLATE_MIGRATIONS);
      expect(applied.map((m) => m.name)).toEqual(['t010_board_truth.sql', 't011_approved_path.sql', 't012_presence.sql', 't013_answer_wait.sql', 't015_bus_room.sql', 't017_acted_for.sql', 't018_desk_without_gateway.sql', 't019_no_gateway_tables.sql', 't020_human_authority.sql', 't021_draft_origin.sql', 't022_answer_deadline.sql', 't023_input_deadline.sql', 't024_answer_intents.sql', '010_declared_reads.sql']);

      // Kept as it was; what the rows never knew is NULL.
      expect((await runner.query('select line, setting, version from ledger.switchboard order by line')).rows).toEqual(before.rows);
      expect((await runner.query('select approvers, updated_by from ledger.switchboard')).rows.every((r) => r.approvers === null && r.updated_by === null)).toBe(true);
      expect((await runner.query('select status, company_name, time_zone, room_ids, agent_senders from ledger.installs')).rows).toEqual([{ status: 'active', company_name: null, time_zone: null, room_ids: [], agent_senders: [] }]);
      expect((await runner.query('select created_by, suspended_reason from ledger.grants')).rows).toEqual([{ created_by: null, suspended_reason: null }]);
      expect((await runner.query('select count(*)::int as n from ledger.switchboard_history')).rows[0].n).toBe(0);
      // The gate will not act on an install that has no time zone yet: the backfill fills it (fail closed, never guessed).
      await expect(loadBoard(runner, 'ledger', CO)).rejects.toBeInstanceOf(NotInstalled);
      const admin = new pg.Client({ connectionString: db.adminUrl });
      await admin.connect();
      try {
        await as(admin, 'neos_desk', CO, (c) => c.query("update ledger.installs set company_name = 'Old Co', time_zone = 'Asia/Kolkata' where company_id = $1", [CO]));
        // The old mirror rows read as the company's switches — never looser than what was in force.
        expect(await loadBoard(runner, 'ledger', CO)).toMatchObject({ version: 4, settings: { 'ledger.report.pnl': 'off', 'ledger.journal.post': 'ask_first' }, company: { name: 'Old Co' } });
        // The triggers hold on rows written before them: a change bumps the version and is kept …
        await as(admin, 'neos_desk', CO, (c) => c.query("update ledger.switchboard set setting = 'on' where line = 'ledger.report.pnl'"));
        expect((await loadBoard(runner, 'ledger', CO)).version).toBe(5);
        expect((await runner.query("select version, op from ledger.switchboard_history where line = 'ledger.report.pnl'")).rows).toEqual([{ version: 5, op: 'update' }]);
        // … a loosening is refused …
        expect((await errOf(as(admin, 'neos_desk', CO, (c) => c.query("update ledger.switchboard set setting = 'on' where line = 'ledger.journal.post'"))))).toMatchObject({ code: '23514' });
        // … and an old grant-approved proposal that fails suspends its old grant.
        await runner.query("update ledger.proposals set status = 'FAILED' where id = $1", [pid]);
        expect((await runner.query('select status, suspended_reason from ledger.grants where grant_id = $1', [grant])).rows[0]).toEqual({ status: 'SUSPENDED', suspended_reason: `execution FAILED for proposal ${pid}` });
        // The runner copies nothing any more; the app role still only reads.
        expect((await errOf(runner.query("insert into ledger.installs (company_id, status) values (gen_random_uuid(), 'active')"))).code).toBe('42501');
        expect((await errOf(withCompany(pool, CO, (c) => c.query("update ledger.switchboard set setting = 'off'"))))).toMatchObject({ code: '42501' });
      } finally {
        await admin.end();
      }
      await pool.end();
      await runner.end();
    } finally {
      await db.drop();
      await rm(tdir, { recursive: true, force: true });
      if (beforeDir) await rm(beforeDir, { recursive: true, force: true });
    }
  });
});
