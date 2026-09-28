// v3-conformance.test · WP v3 §6 and §11 on the template's standard tables, end to end:
//   B3  the standard columns are filled by the code that does the work (t007): jobs.origin /
//       switchboard_version / switchboard_snapshot / heartbeat_at; proposals.manifest_version /
//       answered_at / executed_at / verified_at; operations.request_checksum / result_checksum / reason.
//   B4  states move only along their lifecycle (t008): an UPDATE that skips a step is refused by the database.
//   A3  answer_proposal() is the one SQL place an answer enters: SECURITY DEFINER, owned by the migrator,
//       executable by the app's roles and nobody else; the desk-shaped direct call wakes the job like resolve.
//   A8  a wait made ready by a plain SQL UPDATE wakes its job through LISTEN/NOTIFY, with the poll 60 s away.
//   A7/A9 the switchboard, installs and grants are the truth in the app's schema (t010, v3 S1): written by the desk.
//   B11 Ledger's declared views (007) agree with the trial balance and ageing reads on the demo books.
//   And t007 + t008 + t009 + 007 applied forward on a populated book (their proof in migrate.json).
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalize, sha256 } from '@neop/contracts';
import { bootstrapFamily, createPool, createTestDatabase, migrate, roleUrl, templateFiles, withCompany } from '@neop/pgkit';
import { TEMPLATE_INFRA_TABLES, TEMPLATE_MIGRATIONS } from '@neop/template';
import { LEDGER_ROOT, seedLedger } from '../src/index.ts';
import { bootPilot, call, finish, type Pilot } from './harness.ts';

const CARD = { what: 'Email the August close pack', why: 'Month-end', changes: 'One email leaves the company', if_no_answer: 'Nothing is sent' };
const email = () => call('ledger.close_pack.email', { period: { from: '2026-08-01', to: '2026-08-31' }, to: ['cfo@acme.example'], card: CARD });
const errCode = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));

describe('on a running pilot', () => {
  let P: Pilot;
  let admin: pg.Client;
  const q = async (sql: string, params: unknown[] = []) => (await P.backend.core.runnerPool.query(sql, params)).rows;
  const pendingCard = (jobId: string) => P.waitFor(async () => (await P.desk()).find((c) => c.job_id === jobId && c.status === 'PENDING'), 'pending card');
  const settled = (taskId: string) => P.waitFor(async () => ['COMPLETED', 'FAILED', 'CANCELLED'].includes((await P.task(taskId)).task.status), 'task settled');
  beforeAll(async () => {
    P = await bootPilot();
    admin = new pg.Client({ connectionString: P.adminUrl });
    await admin.connect();
  });
  afterAll(async () => {
    await admin?.end();
    await P?.close();
  });

  it('B3: a job, its proposal and the operation carry origin, the board it ran on, and when it was answered, carried out and verified', async () => {
    P.setBrain((v) => (v.job.includes('WOKEN') ? finish('sent') : v.calls === 0 ? email() : { text: 'waiting' }));
    const t = await P.ask('Email the August pack to the CFO');
    const card = await pendingCard(t.job_id);
    const [before] = await q('select manifest_version, answered_at, executed_at, verified_at from ledger.proposals where id = $1', [card.proposal_id]);
    expect(before).toEqual({ manifest_version: P.backend.core.manifest.version, answered_at: null, executed_at: null, verified_at: null });
    expect((await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint })).status).toBe(200);
    await settled(t.task_id);

    const [job] = await q('select origin, task_id, switchboard_version, switchboard_snapshot from ledger.jobs where id = $1', [t.job_id]);
    expect(job.origin).toBe(job.task_id); // asked on the platform: the task it came from
    const board = await P.backend.core.board.get(P.company.id);
    expect(job.switchboard_version).toBe(board.version);
    expect(job.switchboard_snapshot).toMatchObject({ version: board.version, settings: { 'ledger.close_pack.email': 'ask_first', 'ledger.report.pnl': 'on' } });

    const [p] = await q('select status, answered_at, executed_at, verified_at, created_at, args from ledger.proposals where id = $1', [card.proposal_id]);
    expect(p.status).toBe('DONE');
    for (const k of ['answered_at', 'executed_at', 'verified_at']) expect(p[k], k).toBeInstanceOf(Date);
    expect(p.answered_at.getTime()).toBeGreaterThanOrEqual(p.created_at.getTime());
    expect(p.executed_at.getTime()).toBeGreaterThanOrEqual(p.answered_at.getTime());
    expect(p.verified_at.getTime()).toBeGreaterThanOrEqual(p.executed_at.getTime());

    const [op] = await q("select request_checksum, result_checksum, reason from ledger.operations where detail->>'proposal_id' = $1", [card.proposal_id]);
    expect(op.request_checksum).toBe(sha256(canonicalize(p.args)));
    expect(op.result_checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(op.reason).toContain(`user:${P.admin.id}`);
    expect(op.reason).toContain(card.proposal_id);
  });

  it('B3: a direct write and a read served to another app are checksummed too; a timer job’s origin is "timer"', async () => {
    // A write that is "on" (its floor) runs without a card: its operation is checksummed.
    const args = { kind: 'vendor', name: 'V3 Checksum Supplies' };
    P.setBrain((v) => (v.calls === 0 ? call('ledger.party.create', args) : finish('added')));
    const t = await P.ask('Add the vendor V3 Checksum Supplies');
    await settled(t.task_id);
    const [op] = await q("select request_checksum, result_checksum, reason, outcome from ledger.operations where job_id = $1 and ability_key = 'ledger.party.create'", [t.job_id]);
    expect(op.outcome).toBe('DONE');
    expect(op.request_checksum).toBe(sha256(canonicalize(args)));
    expect(op.result_checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(op.reason).toMatch(/switched on/);

    // A schedule's slot arriving opens a job whose origin is the timer.
    await admin.query(
      `insert into ledger.schedules (company_id, ask, requester, rule, time_zone, next_run_at) values ($1, 'v3 timer ask', $2, '{"every":"day","at":"09:00"}', 'Asia/Kolkata', now() - interval '1 minute')`,
      [P.company.id, `user:${P.admin.id}`],
    );
    P.setBrain(() => finish('ran'));
    const tj = await P.waitFor(async () => (await q("select origin, source from ledger.jobs where ask = 'v3 timer ask'"))[0], 'the timer job');
    expect(tj).toEqual({ origin: 'timer', source: 'timer' });
  });

  it('B3: the gate’s heartbeat stamps heartbeat_at while a session runs', async () => {
    P.setBrain(() => ({ hang: true }));
    const t = await P.ask('Think about it for a while');
    const [job] = await P.waitFor(async () => {
      const r = await q('select heartbeat_at, claimed_until from ledger.jobs where id = $1 and heartbeat_at is not null', [t.job_id]);
      return r.length ? r : null;
    }, 'a heartbeat');
    expect(job.heartbeat_at).toBeInstanceOf(Date);
    await P.api('POST', `/api/tasks/${t.task_id}/cancel`, {});
    P.worker.kill(t.job_id);
  });

  it('B4: a status may only move along its lifecycle — a direct UPDATE that skips a step is refused', async () => {
    P.setBrain((v) => (v.job.includes('WOKEN') ? finish('not sent') : v.calls === 0 ? email() : { text: 'waiting' }));
    const t = await P.ask('Email the pack again');
    const card = await pendingCard(t.job_id);
    const refuse = (sql: string, params: unknown[]) => admin.query(sql, params).then(() => 'ok', (e: Error & { code?: string }) => `${e.code}: ${e.message}`);
    expect(await refuse("update ledger.proposals set status = 'DONE' where id = $1", [card.proposal_id])).toMatch(/^23514: illegal transition: proposals\.status PROPOSED → DONE/);
    expect(await refuse("update ledger.proposals set status = 'EXECUTING' where id = $1", [card.proposal_id])).toMatch(/^23514: illegal transition/);
    expect(await refuse("update ledger.jobs set status = 'DONE' where id = $1", [t.job_id])).toMatch(/^23514: illegal transition: jobs\.status WAITING → DONE/);
    const [w] = await q("select id from ledger.waits where ref_id = $1 and status = 'pending'", [card.proposal_id]);
    expect(await refuse("update ledger.waits set status = 'consumed' where id = $1 and false", [w.id])).toBe('ok'); // nothing moved, nothing refused
    // Still as it was; the legal step still works (a person's no, through the one function).
    expect((await q('select status from ledger.proposals where id = $1', [card.proposal_id]))[0].status).toBe('PROPOSED');
    expect((await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'no', fingerprint_seen: card.fingerprint })).status).toBe(200);
    await P.waitFor(async () => (await q('select status from ledger.proposals where id = $1', [card.proposal_id]))[0].status === 'REJECTED', 'rejected');
    expect(await refuse("update ledger.proposals set status = 'PROPOSED' where id = $1", [card.proposal_id])).toMatch(/illegal transition: proposals\.status REJECTED → PROPOSED/);
    await P.waitFor(async () => (await q("select status from ledger.waits where id = $1", [w.id]))[0].status === 'consumed', 'wait consumed');
    expect(await refuse("update ledger.waits set status = 'pending', ready_at = null where id = $1", [w.id])).toMatch(/illegal transition: waits\.status consumed → pending/);
  });

  it('A3: answer_proposal() is the one place an answer enters — definer-owned, not public, the desk’s direct call wakes the job', async () => {
    const [fn] = (
      await admin.query(
        `select r.rolname as owner, p.prosecdef as definer,
                has_function_privilege('ledger_app', p.oid, 'execute') as app, has_function_privilege('ledger_runner', p.oid, 'execute') as runner,
                has_function_privilege('neos_app', p.oid, 'execute') as neos_app, has_function_privilege('public', p.oid, 'execute') as public
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
          where n.nspname = 'ledger' and p.proname = 'answer_proposal'`,
      )
    ).rows;
    expect(fn).toEqual({ owner: 'ledger_migrator', definer: true, app: true, runner: true, neos_app: false, public: false });
    // The app role cannot flip a proposal row by hand — but it can go through the function.
    P.setBrain((v) => (v.job.includes('WOKEN') ? finish('told') : v.calls === 0 ? email() : { text: 'waiting' }));
    const t = await P.ask('Email the pack once more');
    const card = await pendingCard(t.job_id);
    const pool = P.backend.core.appPool;
    const answer = (fp: string, by = `user:${P.admin.id}`, decision = 'no') =>
      withCompany(pool, P.company.id, async (c) => (await c.query('select ledger.answer_proposal($1, $2, $3, $4, $5) as r', [card.proposal_id, fp, decision, by, 'not this month'])).rows[0].r);
    // Another company finds nothing (row-level security holds inside the definer function too).
    await expect(withCompany(pool, '99999999-2222-3333-4444-555555555555', (c) => c.query('select ledger.answer_proposal($1, $2, $3, $4, null)', [card.proposal_id, card.fingerprint, 'no', 'user:x']))).rejects.toThrow(/not_found/);
    expect(await answer('sha256:' + '0'.repeat(64))).toMatchObject({ status: 'PROPOSED', refused: 'fingerprint_mismatch' });
    expect((await q("select count(*)::int as n from ledger.proposal_events where proposal_id = $1 and event = 'answer_refused:fingerprint'", [card.proposal_id]))[0].n).toBe(1);
    expect(await answer(card.fingerprint)).toEqual({ status: 'REJECTED', idempotent: false, job_id: t.job_id });
    expect(await answer(card.fingerprint)).toEqual({ status: 'REJECTED', idempotent: true, job_id: t.job_id });
    await expect(answer(card.fingerprint, `user:${P.admin.id}`, 'yes')).rejects.toThrow(/not_open: proposal is REJECTED/);
    await settled(t.task_id);
    const steps = await q("select summary from ledger.steps where job_id = $1 and summary like 'Answer on proposal%'", [t.job_id]);
    expect(steps).toEqual([{ summary: `Answer on proposal ${card.proposal_id.slice(0, 8)}: no (user:${P.admin.id}) — "not this month"` }]);
    expect((await q("select count(*)::int as n from ledger.outbox where dedupe_key = $1", [`resolved:${card.proposal_id}:no`]))[0].n).toBe(1);
  });

  it('A7/A9: the switchboard, the install and the grants are the TRUTH in the app’s schema — the desk writes them, the gate reads them, the app role only reads', async () => {
    const lines = () => withCompany(P.backend.core.appPool, P.company.id, async (c) => (await c.query("select line, kind, floor, setting, version from ledger.switchboard where line in ('ledger.report.pnl', 'ledger.journal.post') order by line")).rows);
    const r = await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.report.pnl': 'off' } });
    expect(r.status).toBe(200);
    const v = r.body.version;
    // Written through, in the same call, as the desk: the company's switch with the app's floor, at the new version.
    // A line the company never set has no row: it is at its floor.
    expect(await lines()).toEqual([{ line: 'ledger.report.pnl', kind: 'read', floor: 'on', setting: 'off', version: v }]);
    // …and that row is what the gate decides with (read from the database, not from the platform).
    await P.waitFor(async () => (await P.backend.core.board.get(P.company.id)).version === v, 'the gate on the new board', 1_000);
    expect((await P.backend.core.board.get(P.company.id)).setting(P.backend.core.ability('ledger.report.pnl')!)).toBe('off');
    await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.report.pnl': 'on' } });
    expect((await lines()).find((l) => l.line === 'ledger.report.pnl')).toMatchObject({ setting: 'on', version: v + 1 });
    // Every version is kept.
    const hist = await withCompany(P.backend.core.appPool, P.company.id, async (c) => (await c.query("select version, op, after->>'setting' as setting from ledger.switchboard_history where line = 'ledger.report.pnl' order by id")).rows);
    expect(hist.slice(-2)).toEqual([{ version: v, op: expect.stringMatching(/insert|update/), setting: 'off' }, { version: v + 1, op: 'update', setting: 'on' }]);
    const installs = await withCompany(P.backend.core.appPool, P.company.id, async (c) => (await c.query('select status, matrix_user, company_name, time_zone from ledger.installs')).rows);
    expect(installs).toEqual([{ status: 'active', matrix_user: null, company_name: 'Acme Traders', time_zone: 'Asia/Kolkata' }]);
    // Read-only to the app: the desk writes them.
    for (const sql of ["update ledger.switchboard set setting = 'on'", "insert into ledger.installs (company_id, status) values (current_setting('neos.company_id')::uuid, 'active')", 'delete from ledger.grants']) {
      expect(await errCode(withCompany(P.backend.core.appPool, P.company.id, (c) => c.query(sql))), sql).toBe('42501');
    }
    // A standing yes written on the desk lives in ledger.grants; the gate matches it there and records its use.
    const g = await P.api('POST', '/api/grants', { app_key: 'ledger', ability_key: 'ledger.journal.post', limits: { per_call_minor: 1_000_000, currency: 'INR' }, expires_at: new Date(Date.now() + 86_400_000).toISOString() });
    expect(g.status).toBe(200);
    P.setBrain((v2) => (v2.calls === 0 ? call('ledger.journal.post', { date: '2026-08-31', memo: 'v3 under the grant', currency: 'INR', lines: [{ account_code: '6300', debit_minor: 500, credit_minor: 0 }, { account_code: '2000', debit_minor: 0, credit_minor: 500 }], card: { ...CARD, what: 'Post a small accrual' } }) : finish('posted')));
    const t = await P.ask('Accrue a tiny fee');
    await settled(t.task_id);
    const [pr] = await q('select id, grant_id, approved_via, status from ledger.proposals where job_id = $1', [t.job_id]);
    expect(pr).toMatchObject({ grant_id: g.body.id, approved_via: 'grant', status: 'DONE' });
    const grants = await withCompany(P.backend.core.appPool, P.company.id, async (c) => (await c.query('select grant_id, ability_key, status, created_by from ledger.grants')).rows);
    expect(grants).toEqual([{ grant_id: g.body.id, ability_key: 'ledger.journal.post', status: 'ACTIVE', created_by: `user:${P.admin.id}` }]);
    const uses = await withCompany(P.backend.core.appPool, P.company.id, async (c) => (await c.query('select grant_id, proposal_id, amount_minor, currency from ledger.grant_uses')).rows);
    expect(uses).toEqual([{ grant_id: g.body.id, proposal_id: pr.id, amount_minor: 500, currency: 'INR' }]);
    // Nothing of it was kept on the platform.
    expect((await P.platform.db.query("select count(*)::int as n from neos.grants where company_id = $1", [P.company.id])).rows[0].n).toBe(0);
  });

  it('B11: the declared views agree with the trial balance and ageing reads on the demo books', async () => {
    const read = async (key: string, args: unknown) => (await P.api('POST', `/api/apps/ledger/read/${key}`, args)).body.result;
    for (const asOf of ['2026-08-31', '2026-09-30']) {
      const tb = await read('ledger.report.trial_balance', { as_of: asOf });
      const view = await withCompany(P.backend.core.appPool, P.company.id, async (c) =>
        (
          await c.query(
            `select code, sum(debit_minor)::bigint as debit_minor, sum(credit_minor)::bigint as credit_minor
               from ledger.v_account_balances where entry_date <= $1 and currency = 'INR'
              group by code having sum(debit_minor) <> 0 or sum(credit_minor) <> 0 order by code`,
            [asOf],
          )
        ).rows,
      );
      expect(view.length).toBeGreaterThan(5);
      expect(view).toEqual(tb.rows.map((r: any) => ({ code: r.code, debit_minor: r.debit_minor, credit_minor: r.credit_minor })));
    }
    for (const kind of ['receivable', 'payable'] as const) {
      const ag = await read('ledger.report.aging', { kind, as_of: '2026-09-30' });
      const view = await withCompany(P.backend.core.appPool, P.company.id, async (c) =>
        (await c.query(`select number, outstanding_minor from ledger.v_ageing where ageing_kind = $1 and issue_date <= $2 and currency = 'INR' order by number`, [kind, ag.as_of])).rows,
      );
      expect(view).toEqual(ag.items.map((i: any) => ({ number: i.number, outstanding_minor: i.outstanding_minor })).sort((a: any, b: any) => a.number.localeCompare(b.number)));
      expect(view.reduce((s: number, r: any) => s + r.outstanding_minor, 0)).toBe(ag.total_outstanding_minor);
    }
    // The views read with the caller's rights: another company sees none of these rows.
    const other = await withCompany(P.backend.core.appPool, '99999999-2222-3333-4444-555555555555', async (c) => (await c.query('select (select count(*) from ledger.v_account_balances)::int as a, (select count(*) from ledger.v_ageing)::int as b')).rows[0]);
    expect(other).toEqual({ a: 0, b: 0 });
  });
});

describe('A8: NOTIFY from the database wakes the runner (the poll 60 s away)', () => {
  let Q: Pilot;
  beforeAll(async () => {
    Q = await bootPilot({ timings: { pollMs: 60_000 } });
  });
  afterAll(async () => Q?.close());

  it('a wait made ready by a plain SQL UPDATE wakes its job via LISTEN', async () => {
    let woke = 0;
    Q.setBrain((v) => {
      if (v.job.includes('WOKEN')) {
        woke++;
        return finish('woke up');
      }
      return v.calls === 0 ? call('job.wait_until', { at: new Date(Date.now() + 7 * 86_400_000).toISOString(), reason: 'wait a week' }) : { text: 'waiting' };
    });
    const t = await Q.ask('Remind me next week');
    const q = async (sql: string, params: unknown[] = []) => (await Q.backend.core.runnerPool.query(sql, params)).rows;
    const [w] = await Q.waitFor(async () => {
      const r = await q("select w.id from ledger.waits w join ledger.jobs j on j.id = w.job_id where w.job_id = $1 and w.kind = 'timer' and w.status = 'pending' and j.status = 'WAITING' and j.claimed_by is null", [t.job_id]);
      return r.length ? r : null;
    }, 'the job parked on its timer');
    await new Promise((r) => setTimeout(r, 300)); // every earlier hint has been spent
    const at = Date.now();
    // Not through the app: a plain UPDATE, as a DBA or the desk's function would make it.
    const admin = new pg.Client({ connectionString: Q.adminUrl });
    await admin.connect();
    await admin.query("update ledger.waits set status = 'ready', ready_at = now(), outcome = 'TIMER', answer = coalesce(answer, '{}'::jsonb) || '{\"timer\":true}' where id = $1", [w.id]);
    await admin.end();
    await Q.waitFor(async () => (await Q.task(t.task_id)).task.status === 'COMPLETED', 'the job woke and finished', 10_000);
    expect(woke).toBe(1);
    expect(Date.now() - at).toBeLessThan(10_000); // long before the 60 s poll
  });
});

describe('t007 + t008 + t009 + 007 on a populated book', () => {
  it('t007 + t008 + t009 + 007 apply forward on a populated book: history kept, new columns NULL, lifecycles enforced, mirrors and views work', async () => {
    const db = await createTestDatabase();
    const CO = '11111111-2222-3333-4444-555555555555';
    const tdir = await mkdtemp(path.join(os.tmpdir(), 'neop-t007-'));
    const adir = await mkdtemp(path.join(os.tmpdir(), 'neop-007-'));
    try {
      // The book as it stood before: every later file cut from both streams.
      await cp(TEMPLATE_MIGRATIONS, tdir, { recursive: true });
      const tled = JSON.parse(await readFile(path.join(tdir, 'migrate.json'), 'utf8'));
      for (const m of tled.migrations.filter((x: any) => x.file >= 't007')) await rm(path.join(tdir, m.file));
      tled.migrations = tled.migrations.filter((m: any) => m.file < 't007');
      await writeFile(path.join(tdir, 'migrate.json'), JSON.stringify(tled));
      await cp(path.join(LEDGER_ROOT, 'migrations'), adir, { recursive: true });
      const aled = JSON.parse(await readFile(path.join(adir, 'migrate.json'), 'utf8'));
      for (const m of aled.migrations.filter((x: any) => x.file >= '007')) await rm(path.join(adir, m.file));
      aled.migrations = aled.migrations.filter((m: any) => m.file < '007');
      await writeFile(path.join(adir, 'migrate.json'), JSON.stringify(aled));
      await bootstrapFamily(db.adminUrl, 'ledger');
      const run = async (t: string, a: string) => migrate({ adminUrl: db.adminUrl, schema: 'ledger', sources: { dir: a, prepend: await templateFiles(t) }, lintExempt: TEMPLATE_INFRA_TABLES });
      await run(tdir, adir);
      const pool = createPool(roleUrl(db.adminUrl, 'ledger_app'));
      await seedLedger(pool, CO);
      const ids = await withCompany(pool, CO, async (c) => {
        const job = async (status: string) => (await c.query<{ id: string }>("insert into ledger.jobs (company_id, source, requester, task_id, ask, status) values ($1, 'task', 'user:x', gen_random_uuid(), 'old job', $2) returning id", [CO, status])).rows[0]!.id;
        const waiting = await job('WAITING');
        const done = await job('DONE');
        const prop = async (jobId: string, status: string) =>
          (
            await c.query<{ id: string }>(
              `insert into ledger.proposals (company_id, job_id, ability_key, ability_version, args, card, fingerprint, status, expires_at, idempotency_key)
               values ($1, $2, 'ledger.journal.post', '1.0.0', '{}', '{}', 'sha256:' || md5(random()::text), $3, now() + interval '1 day', gen_random_uuid()::text) returning id`,
              [CO, jobId, status],
            )
          ).rows[0]!.id;
        const open = await prop(waiting, 'PROPOSED');
        const finished = await prop(done, 'DONE');
        await c.query("insert into ledger.waits (company_id, job_id, kind, ref_id, expires_at) values ($1, $2, 'proposal', $3, now() + interval '1 day')", [CO, waiting, open]);
        return { waiting, done, open, finished };
      });
      const runner = createPool(roleUrl(db.adminUrl, 'ledger_runner'));
      await runner.query("insert into ledger.operations (company_id, job_id, caller, ability_key, idempotency_key, outcome) values ($1, $2, 'assistant:x', 'ledger.journal.post', 'old-op', 'DONE')", [CO, ids.done]);
      const before = await withCompany(pool, CO, async (c) => (await c.query("select md5(string_agg(id::text || status, ',' order by id)) h, count(*)::int n from ledger.jobs")).rows[0]);

      const applied = await run(TEMPLATE_MIGRATIONS, path.join(LEDGER_ROOT, 'migrations'));
      expect(applied.map((m) => m.name)).toEqual(['t007_standard_columns.sql', 't008_transitions.sql', 't009_notify.sql', 't010_board_truth.sql', 't011_approved_path.sql', 't012_presence.sql', 't015_bus_room.sql', '007_views.sql']);

      await withCompany(pool, CO, async (c) => {
        expect((await c.query("select md5(string_agg(id::text || status, ',' order by id)) h, count(*)::int n from ledger.jobs")).rows[0]).toEqual(before);
        // Rows from before say nothing they never knew: the new columns are NULL.
        expect((await c.query('select origin, switchboard_version, switchboard_snapshot, heartbeat_at from ledger.jobs where id = $1', [ids.waiting])).rows[0]).toEqual({ origin: null, switchboard_version: null, switchboard_snapshot: null, heartbeat_at: null });
        expect((await c.query('select manifest_version, answered_at, executed_at, verified_at from ledger.proposals where id = $1', [ids.finished])).rows[0]).toEqual({ manifest_version: null, answered_at: null, executed_at: null, verified_at: null });
        expect((await c.query("select request_checksum, result_checksum, reason from ledger.operations where idempotency_key = 'old-op'")).rows[0]).toEqual({ request_checksum: null, result_checksum: null, reason: null });
        // A job may now wait on a dependency; a bogus kind is still refused.
        await c.query("insert into ledger.waits (company_id, job_id, kind, expires_at) values ($1, $2, 'dependency', now() + interval '1 day')", [CO, ids.waiting]);
        expect((await c.query('select count(*)::int as n from ledger.v_account_balances')).rows[0].n).toBeGreaterThan(10);
        expect((await c.query('select count(*)::int as n from ledger.switchboard')).rows[0].n).toBe(0);
      });
      await expect(withCompany(pool, CO, (c) => c.query("insert into ledger.waits (company_id, job_id, kind, expires_at) values ($1, $2, 'bogus', now())", [CO, ids.waiting]))).rejects.toThrow(/waits_kind_check/);
      // The lifecycles hold on rows written before t008 existed.
      await expect(runner.query("update ledger.proposals set status = 'PROPOSED' where id = $1", [ids.finished])).rejects.toThrow(/illegal transition: proposals\.status DONE → PROPOSED/);
      await expect(runner.query("update ledger.jobs set status = 'RUNNING' where id = $1", [ids.done])).rejects.toThrow(/illegal transition: jobs\.status DONE → RUNNING/);
      // And an old open proposal is answered through the one function, waking its old wait.
      const fp = (await runner.query('select fingerprint from ledger.proposals where id = $1', [ids.open])).rows[0].fingerprint;
      const out = await withCompany(pool, CO, async (c) => (await c.query("select ledger.answer_proposal($1, $2, 'no', 'user:x', null) as r", [ids.open, fp])).rows[0].r);
      expect(out).toMatchObject({ status: 'REJECTED', idempotent: false });
      expect((await runner.query('select status, outcome from ledger.waits where ref_id = $1', [ids.open])).rows[0]).toEqual({ status: 'ready', outcome: 'REJECTED' });
      await pool.end();
      await runner.end();
    } finally {
      await db.drop();
      await rm(tdir, { recursive: true, force: true });
      await rm(adir, { recursive: true, force: true });
    }
  });
});
