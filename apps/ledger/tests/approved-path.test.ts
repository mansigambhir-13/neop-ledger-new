// approved-path.test · v3 S2 "the runner carries out the yes" (WP v3 §5–§7, §15 last bullet).
// A person's yes lands on ONE row through <schema>.answer_proposal() (the desk calls it as neos_desk); the app's
// runner notices APPROVED (NOTIFY 'approved:<id>' is the hint, its poll is the truth), claims it (FOR UPDATE SKIP
// LOCKED + the execution advisory lock), carries it out exactly once (operations idempotency, read-back), and only
// then readies the wait and wakes a fresh assistant with the proof. No platform, token or model in between.
//   · NOTIFY heard; a missed NOTIFY is caught by the poll; a yes given while no runner is up runs when one starts
//   · two runners: executed once
//   · withdraw vs execute: exactly one wins (withdraw before the claim; too late once it is being carried out; raced)
//   · kill mid-execute (before the door, and after it) → restart → resumed read-back first, never twice
//   · fingerprint changed after the yes → refused; expired → refused (nothing sent, the job wakes to say so)
//   · the desk role cannot touch proposals directly (only answer_proposal)
//   · the assistant is woken only after DONE, with the proof
//   · approver policy (roles, four-eyes) enforced in the database, whoever calls
//   · (was stuck-approval.test) a slow effect — longer than many polls — is carried out once and the card settles;
//     no platform call sits between a yes and the effect; ability calls still carry ability_version
//   · the drain: what the retired approvals worker had in hand (RECORDED / RESOLVED) is handed over once, idempotently
//   · t011 applies forward on a populated book (its proof in migrate.json)
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFamily, createPool, createTestDatabase, migrate, roleUrl, templateFiles, withCompany } from '@neop/pgkit';
import { migratePlatform } from '@neop/platform';
import { ApprovedPath, startBackend, TEMPLATE_INFRA_TABLES, TEMPLATE_MIGRATIONS, type NeopBackend } from '@neop/template';
import { runDrain } from '../../../scripts/v3/drain-approvals.ts';
import { ledgerApp, LEDGER_ROOT, seedLedger } from '../src/index.ts';
import { bootPilot, call, finish, type BrainView, type Pilot } from './harness.ts';

const errOf = (p: Promise<unknown>) => p.then(() => ({ code: 'ok', message: '' }), (e: { code?: string; message?: string }) => ({ code: e.code ?? '?', message: e.message ?? String(e) }));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const CARD = { what: 'Email the August close pack', why: 'Month-end', changes: 'One email leaves the company', if_no_answer: 'Nothing is sent' };
const email = (to = ['cfo@acme.example']) => call('ledger.close_pack.email', { period: { from: '2026-08-01', to: '2026-08-31' }, to, card: CARD });

describe('the approved path on a running pilot', () => {
  let P: Pilot;
  let admin: pg.Client;
  const woken: string[] = [];
  const mails = async () => (await readdir(P.mailDir)).length;
  const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows; // the admin link: works while a backend is down
  const proposal = async (id: string) => (await q('select * from ledger.proposals where id = $1', [id]))[0];
  const events = async (id: string) => (await q('select event, actor from ledger.proposal_events where proposal_id = $1 order by id', [id])).map((r) => r.event as string);
  const waitRow = async (id: string) => (await q('select status, outcome from ledger.waits where ref_id = $1', [id]))[0];
  const answer = (card: { id: string; fingerprint: string }, decision: string, token?: string) => P.api('POST', `/api/desk/${card.id}/answer`, { decision, fingerprint_seen: card.fingerprint }, token);
  const path_ = () => P.backend.runner.approved;
  /** One ask whose assistant proposes one email and waits; woken, it records what it was told and finishes. */
  async function asked(text = 'Email the August pack to the CFO', token?: string, to?: string[]) {
    P.setBrain((v: BrainView) => {
      if (v.job.includes('WOKEN')) {
        woken.push(v.job);
        return finish('reported');
      }
      return v.calls === 0 ? email(to) : { text: 'waiting' };
    });
    const r = await P.ask(text, token);
    const card = await P.waitFor(async () => (await P.desk()).find((c) => c.job_id === r.job_id && c.status === 'PENDING'), 'card');
    return { ...r, card };
  }
  const settled = (task: string) => P.waitFor(async () => ['COMPLETED', 'FAILED'].includes((await P.task(task)).task.status) && (await P.task(task)), 'task settled', 20_000);

  beforeAll(async () => {
    P = await bootPilot();
    admin = new pg.Client({ connectionString: P.adminUrl });
    await admin.connect();
  });
  afterAll(async () => {
    await admin?.end();
    await P?.close();
  });

  it('a yes on the row is heard (NOTIFY approved:<id>) and carried out once; the yes itself wakes nothing', async () => {
    const heard: string[] = [];
    const l = new pg.Client({ connectionString: P.adminUrl });
    await l.connect();
    l.on('notification', (n) => heard.push(String(n.payload)));
    await l.query('listen neop_ledger');
    try {
      path_().pause();
      const { card, task_id, job_id } = await asked();
      const before = await mails();
      expect((await answer(card, 'yes')).status).toBe(200);
      // B2: answer_proposal() recorded the yes and readied nothing: the job still waits, nothing ran.
      expect((await proposal(card.proposal_id)).status).toBe('APPROVED');
      expect(await waitRow(card.proposal_id)).toMatchObject({ status: 'pending' });
      expect((await P.jobRow(job_id)).status).toBe('WAITING');
      await P.waitFor(async () => heard.includes(`approved:${card.proposal_id}`), 'the hint');
      await sleep(400);
      expect(await mails()).toBe(before);
      path_().resume();
      await settled(task_id);
      expect(await mails()).toBe(before + 1);
      expect(await events(card.proposal_id)).toEqual(['proposed', 'answered:yes', 'executing', 'executed:DONE', 'resumed', 'reported']);
      const ex = await q("select actor from ledger.proposal_events where proposal_id = $1 and event = 'executing'", [card.proposal_id]);
      expect(ex[0].actor).toBe('runner:runner-ledger');
      const ops = await q("select caller, reason from ledger.operations where detail->>'proposal_id' = $1", [card.proposal_id]);
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({ caller: 'runner:runner-ledger', reason: expect.stringContaining(`a yes from user:${P.admin.id}`) });
    } finally {
      path_().resume();
      await l.end();
    }
  });

  it('a missed NOTIFY is caught by the poll', async () => {
    await admin.query('alter table ledger.proposals disable trigger proposals_approved_notify');
    const heard: string[] = [];
    const l = new pg.Client({ connectionString: P.adminUrl });
    await l.connect();
    l.on('notification', (n) => heard.push(String(n.payload)));
    await l.query('listen neop_ledger');
    try {
      const { card, task_id } = await asked();
      const before = await mails();
      await answer(card, 'yes');
      await settled(task_id);
      expect(await mails()).toBe(before + 1);
      expect(heard.filter((h) => h.startsWith('approved:'))).toEqual([]); // no hint was ever sent: the poll found it
      expect(await events(card.proposal_id)).toContain('executed:DONE');
    } finally {
      await admin.query('alter table ledger.proposals enable trigger proposals_approved_notify');
      await l.end();
    }
  });

  it('a yes given while no runner is up is carried out when one starts (the poll is the truth)', async () => {
    const { card, task_id } = await asked();
    const before = await mails();
    await P.backend.stop();
    // The desk does not need the app's backend: the answer goes to the app's row in the database.
    expect((await answer(card, 'yes')).status).toBe(200);
    expect((await proposal(card.proposal_id)).status).toBe('APPROVED');
    await sleep(300);
    expect(await mails()).toBe(before);
    await P.restartBackend();
    await settled(task_id);
    expect(await mails()).toBe(before + 1);
    expect((await proposal(card.proposal_id)).status).toBe('DONE');
  });

  it('two runners carry a yes out once', async () => {
    const def = await ledgerApp();
    const b2: NeopBackend = await startBackend(def, { ...P.backend.core.cfg, runnerId: 'runner-b' });
    try {
      // Deterministic: both runners' passes race for the same APPROVED row; one claims it, the other finds nothing.
      path_().pause();
      b2.runner.approved.pause();
      const slow = async () => void (await sleep(250));
      P.backend.core.hooks.beforeExecuteEffect = slow;
      b2.core.hooks.beforeExecuteEffect = slow;
      const one = await asked();
      const before = await mails();
      await answer(one.card, 'yes');
      const [a, b] = await Promise.all([new ApprovedPath(P.backend.core).tick({ wait: true }), new ApprovedPath(b2.core).tick({ wait: true })]);
      expect(a + b).toBe(1);
      expect(await mails()).toBe(before + 1);
      // A later pass by either runner finds nothing more to do.
      expect(await new ApprovedPath(b2.core).tick({ wait: true })).toBe(0);
      expect(await new ApprovedPath(P.backend.core).tick({ wait: true })).toBe(0);
      expect(await mails()).toBe(before + 1);
      await settled(one.task_id);

      // Live: both runners listening and polling; the yes is carried out once.
      path_().resume();
      b2.runner.approved.resume();
      const two = await asked();
      const before2 = await mails();
      await answer(two.card, 'yes');
      await settled(two.task_id);
      await sleep(500);
      expect(await mails()).toBe(before2 + 1);
      for (const c of [one.card, two.card]) {
        const ev = await events(c.proposal_id);
        expect(ev.filter((e) => e === 'executing')).toHaveLength(1);
        expect(ev.filter((e) => e.startsWith('executed:'))).toEqual(['executed:DONE']);
        expect(await q("select count(*)::int as n from ledger.operations where detail->>'proposal_id' = $1", [c.proposal_id])).toEqual([{ n: 1 }]);
      }
    } finally {
      P.backend.core.hooks.beforeExecuteEffect = undefined;
      path_().resume();
      await b2.stop();
    }
  });

  it('withdraw vs execute: a withdrawal before the claim stops it; once it is being carried out it is too late', async () => {
    // (a) Withdrawn while APPROVED: nothing runs, the job wakes to say so.
    path_().pause();
    const a = await asked();
    const before = await mails();
    await answer(a.card, 'yes');
    const w = await answer(a.card, 'withdraw');
    expect(w.status).toBe(200);
    expect((await proposal(a.card.proposal_id)).status).toBe('WITHDRAWN');
    path_().resume();
    await settled(a.task_id);
    await sleep(400);
    expect(await mails()).toBe(before);
    expect(await events(a.card.proposal_id)).not.toContain('executing');
    expect(woken.at(-1)).toContain('is now WITHDRAWN');
    expect((await P.desk()).find((c) => c.id === a.card.id)).toMatchObject({ status: 'CLOSED', decision: 'withdraw' });

    // (b) Withdrawn while EXECUTING: too late, the yes stands and is carried out once.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    P.backend.core.hooks.beforeExecuteEffect = () => gate;
    try {
      const b = await asked();
      const before2 = await mails();
      await answer(b.card, 'yes');
      await P.waitFor(async () => (await proposal(b.card.proposal_id)).status === 'EXECUTING', 'executing');
      const late = await answer(b.card, 'withdraw');
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe('too_late');
      release();
      await settled(b.task_id);
      expect(await mails()).toBe(before2 + 1);
      expect((await proposal(b.card.proposal_id)).status).toBe('DONE');
    } finally {
      release();
      P.backend.core.hooks.beforeExecuteEffect = undefined;
    }

    // (c) Raced: a withdrawal and a runner's pass at the same instant — exactly one wins, and the book agrees.
    path_().pause();
    try {
      const c = await asked();
      const before3 = await mails();
      await answer(c.card, 'yes');
      const [wd, n] = await Promise.all([answer(c.card, 'withdraw'), new ApprovedPath(P.backend.core).tick({ wait: true })]);
      const st = (await proposal(c.card.proposal_id)).status;
      if (wd.status === 200) {
        expect(st).toBe('WITHDRAWN');
        expect(await mails()).toBe(before3);
        expect(await events(c.card.proposal_id)).not.toContain('executing');
      } else {
        expect(wd.body.error.code).toBe('too_late');
        expect(n).toBe(1);
        expect(st).toBe('DONE');
        expect(await mails()).toBe(before3 + 1);
      }
      path_().resume();
      await settled(c.task_id);
    } finally {
      path_().resume();
    }
  });

  it('killed mid-execute (before the door, or after it answered): the restarted runner resumes read-back first — never twice', async () => {
    // (a) Killed after the email left, before the outcome was written: the read-back finds it; nothing is sent again.
    const a = await asked();
    const before = await mails();
    P.backend.core.hooks.afterExecuteEffect = () => new Promise(() => {}); // the process "dies" here
    await answer(a.card, 'yes');
    await P.waitFor(async () => (await mails()) === before + 1, 'the email left');
    expect((await proposal(a.card.proposal_id)).status).toBe('EXECUTING');
    await P.restartBackend(); // the old connection closes: its execution lock goes with it
    await settled(a.task_id);
    expect(await mails()).toBe(before + 1);
    const pa = await proposal(a.card.proposal_id);
    expect(pa.status).toBe('DONE');
    expect(await events(a.card.proposal_id)).toEqual(expect.arrayContaining(['executing', 'execute_resumed', 'executed:DONE']));
    expect(await q("select count(*)::int as n from ledger.operations where detail->>'proposal_id' = $1", [a.card.proposal_id])).toEqual([{ n: 1 }]);

    // (b) Killed before the door was called: the resumed runner finds nothing, sends it once, with the same key.
    const b = await asked();
    const before2 = await mails();
    P.backend.core.hooks.beforeExecuteEffect = () => new Promise(() => {});
    await answer(b.card, 'yes');
    await P.waitFor(async () => (await proposal(b.card.proposal_id)).status === 'EXECUTING', 'executing');
    await sleep(200);
    expect(await mails()).toBe(before2);
    await P.restartBackend();
    await settled(b.task_id);
    expect(await mails()).toBe(before2 + 1);
    expect((await proposal(b.card.proposal_id)).status).toBe('DONE');
    expect(await events(b.card.proposal_id)).toEqual(expect.arrayContaining(['execute_resumed', 'executed:DONE']));
  });

  it('a proposal whose fingerprint no longer matches the yes on record is refused at effect time; so is an expired one', async () => {
    for (const tamper of ["update ledger.proposals set fingerprint = 'sha256:' || repeat('0', 64) where id = $1", "update ledger.proposals set expires_at = now() - interval '1 second' where id = $1"]) {
      path_().pause();
      try {
        const x = await asked();
        const before = await mails();
        await answer(x.card, 'yes');
        await admin.query(tamper, [x.card.proposal_id]); // what the row says changed after the person said yes
        path_().resume();
        const t = await settled(x.task_id);
        const p = await proposal(x.card.proposal_id);
        expect(p.status).toBe('FAILED');
        expect(p.proof.error).toMatch(tamper.includes('fingerprint') ? /^fingerprint_mismatch: / : /^expired: /);
        expect(await mails()).toBe(before);
        expect(woken.at(-1)).toContain('NOT carried out');
        expect(t.task.status).toBe('COMPLETED'); // the job woke and reported what happened
        expect((await P.desk()).find((c) => c.id === x.card.id)).toMatchObject({ status: 'FAILED', last_error: p.proof.error });
      } finally {
        path_().resume();
      }
    }
  });

  it('the desk role cannot read or write proposals directly: only answer_proposal()', async () => {
    const x = await asked();
    const asDesk = async (sql: string, params: unknown[] = []) => {
      await admin.query('begin');
      try {
        await admin.query('set local role neos_desk');
        await admin.query("select set_config('neos.company_id', $1, true)", [P.company.id]);
        return await admin.query(sql, params);
      } finally {
        await admin.query('rollback');
      }
    };
    expect((await errOf(asDesk("update ledger.proposals set status = 'APPROVED' where id = $1", [x.card.proposal_id]))).code).toBe('42501');
    expect((await errOf(asDesk('select * from ledger.proposals'))).code).toBe('42501');
    expect((await errOf(asDesk("insert into ledger.proposal_events (company_id, proposal_id, event, actor) values ($1, $2, 'answered:yes', 'user:x')", [P.company.id, x.card.proposal_id]))).code).toBe('42501');
    expect((await errOf(asDesk("update ledger.waits set status = 'ready' where ref_id = $1", [x.card.proposal_id]))).code).toBe('42501');
    expect((await errOf(asDesk('select ledger.answer_proposal($1, $2, $3, $4)', [x.card.proposal_id, 'sha256:' + '1'.repeat(64), 'no', `user:${P.admin.id}`]))).code).toBe('ok');
    expect((await proposal(x.card.proposal_id)).status).toBe('PROPOSED'); // the refused fingerprint changed nothing (rolled back anyway)
    await answer(x.card, 'no');
    await settled(x.task_id);
  });

  it('the assistant is woken only after DONE, with the proof', async () => {
    const seen: { job: string; wait: string; resumed: boolean }[] = [];
    P.backend.core.hooks.beforeExecuteEffect = async (pid) => {
      const j = (await q('select j.status from ledger.jobs j join ledger.proposals p on p.job_id = j.id where p.id = $1', [pid]))[0];
      seen.push({ job: j.status, wait: (await waitRow(pid)).status, resumed: (await events(pid)).includes('resumed') });
    };
    try {
      const x = await asked();
      await answer(x.card, 'yes');
      await settled(x.task_id);
      expect(seen).toEqual([{ job: 'WAITING', wait: 'pending', resumed: false }]);
      const ev = await events(x.card.proposal_id);
      expect(ev.indexOf('executed:DONE')).toBeLessThan(ev.indexOf('resumed'));
      const told = woken.at(-1)!;
      expect(told).toContain(`Proposal ${x.card.proposal_id} (ledger.close_pack.email) is now DONE.`);
      expect(told).toContain(`Answered by: user:${P.admin.id}`);
      expect(told).toContain('Proof from the app: <data source="proof"');
      const proof = JSON.parse(told.slice(told.indexOf('\n', told.indexOf('Proof from the app:')) + 1, told.indexOf('</data>', told.indexOf('Proof from the app:'))));
      expect(proof).toMatchObject({ outcome: 'DONE', error: null, external_ref: expect.any(String), read_back: { to: ['cfo@acme.example'] } });
    } finally {
      P.backend.core.hooks.beforeExecuteEffect = undefined;
    }
  });

  it('the approver policy — roles and four-eyes — is enforced in the database, whoever calls', async () => {
    const policy = (p: Record<string, unknown>) => P.api('PUT', '/api/switchboards/ledger', { approvals: { 'ledger.close_pack.email': p } });
    const byDb = (card: { proposal_id: string; fingerprint: string }, by: string, roles: string[] | null) =>
      errOf(P.platform.boards.answer('ledger', P.company.id, { proposal_id: card.proposal_id, fingerprint_seen: card.fingerprint, decision: 'yes', by, roles }));
    try {
      // Four-eyes: the person who asked cannot also approve — at the desk, or straight at the function.
      expect((await policy({ four_eyes: true })).status).toBe(200);
      const a = await asked('Email the pack (four eyes)', P.admin.token);
      const self = await answer(a.card, 'yes', P.admin.token);
      expect(self.status).toBe(403);
      expect(self.body.error.code).toBe('four_eyes');
      expect(await byDb(a.card, `user:${P.admin.id}`, ['admin'])).toMatchObject({ code: '42501', message: expect.stringMatching(/^four_eyes: /) });
      expect((await proposal(a.card.proposal_id)).status).toBe('PROPOSED');
      const before = await mails();
      expect((await answer(a.card, 'yes', P.member.token)).status).toBe(200);
      await settled(a.task_id);
      expect(await mails()).toBe(before + 1);
      expect((await proposal(a.card.proposal_id)).decided_by).toBe(`user:${P.member.id}`);

      // Roles: only an admin may say yes; roles not given means none known (fail closed); anyone may say no.
      expect((await policy({ roles: ['admin'] })).status).toBe(200);
      const b = await asked('Email the pack (admins only)', P.member.token);
      const m = await answer(b.card, 'yes', P.member.token);
      expect(m.status).toBe(403);
      expect(m.body.error.code).toBe('not_an_approver');
      expect(await byDb(b.card, `user:${P.admin.id}`, null)).toMatchObject({ code: '42501', message: expect.stringMatching(/^not_an_approver: /) });
      expect(await byDb(b.card, `user:${P.member.id}`, ['member'])).toMatchObject({ code: '42501' });
      expect((await answer(b.card, 'yes', P.admin.token)).status).toBe(200);
      await settled(b.task_id);
      const c = await asked('Email the pack (a no is anyone’s)', P.admin.token);
      expect((await answer(c.card, 'no', P.member.token)).status).toBe(200);
      await settled(c.task_id);
    } finally {
      await policy({});
    }
  });
  it('the drain hands the retired worker’s RECORDED and RESOLVED yeses to the app once; a re-run changes nothing', async () => {
    // The state neos.approvals held at deploy time (written here as the old worker did, by the admin link: the
    // platform's own role can no longer write the frozen table).
    const legacy = async (card: any, status: string) => {
      const p = await proposal(card.proposal_id);
      return admin.query(
        `insert into neos.approvals (company_id, app_key, proposal_id, job_id, task_id, ability_key, ability_version, args, card, fingerprint, expires_at, status, decision, decided_by, decided_at, fingerprint_seen)
         values ($1, 'ledger', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'yes', $12, now(), $9) returning id`,
        [P.company.id, card.proposal_id, card.job_id, card.task_id, p.ability_key, p.ability_version, JSON.stringify(p.args), JSON.stringify(p.card), p.fingerprint, p.expires_at, status, P.admin.id],
      );
    };
    path_().pause();
    try {
      const recorded = await asked('Email the pack (a yes the old worker recorded)');
      const resolved = await asked('Email the pack (a yes the app already held)', undefined, ['ca@acme.example']);
      await answer(resolved.card, 'yes'); // the app holds it (APPROVED); the old worker had not executed it yet
      await legacy(recorded.card, 'RECORDED');
      await legacy(resolved.card, 'RESOLVED');
      const before = await mails();
      const first = await runDrain({ url: P.adminUrl, app: 'ledger' });
      expect(first.map((r) => [r.proposal_id, r.result, r.status]).sort()).toEqual(
        [
          [recorded.card.proposal_id, 'answered', 'APPROVED'],
          [resolved.card.proposal_id, 'already', 'APPROVED'],
        ].sort(),
      );
      expect((await proposal(recorded.card.proposal_id)).decided_by).toBe(`user:${P.admin.id}`);
      expect(await mails()).toBe(before); // the drain answers; it never executes
      path_().resume();
      await settled(recorded.task_id);
      await settled(resolved.task_id);
      expect(await mails()).toBe(before + 2);
      const again = await runDrain({ url: P.adminUrl, app: 'ledger' });
      expect(again.map((r) => r.result)).toEqual(['already', 'already']);
      await sleep(400);
      expect(await mails()).toBe(before + 2);
      for (const c of [recorded.card, resolved.card]) expect((await events(c.proposal_id)).filter((e) => e.startsWith('executed:'))).toEqual(['executed:DONE']);
    } finally {
      path_().resume();
      await admin.query("delete from neos.approvals where app_key = 'ledger'");
    }
  });

  it('a slow effect (longer than many polls) is carried out once and the card settles EXECUTED; no platform call is made on a yes', async () => {
    const calls: { path: string; claims: any }[] = [];
    const real = P.platform.gateway.fetchImpl;
    P.platform.gateway.fetchImpl = (async (url: any, init: any) => {
      const auth = init?.headers?.authorization as string | undefined;
      if (auth?.startsWith('Bearer ')) calls.push({ path: new URL(String(url)).pathname, claims: decodeJwt(auth.slice(7)) });
      return real(url, init);
    }) as typeof fetch;
    P.backend.core.hooks.beforeExecuteEffect = async () => void (await sleep(2_000)); // ~13 polls at 150 ms
    try {
      const x = await asked('Send the August close pack (slow provider)');
      const before = await mails();
      calls.length = 0;
      await answer(x.card, 'yes');
      await P.waitFor(async () => (await P.desk()).find((c) => c.id === x.card.id)?.status === 'EXECUTED', 'card settled', 20_000);
      await settled(x.task_id);
      expect((await mails()) - before).toBe(1); // exactly once
      expect(await events(x.card.proposal_id)).toEqual(['proposed', 'answered:yes', 'executing', 'executed:DONE', 'resumed', 'reported']);
      // Between the yes and the effect nothing went through the gateway: no resolve, no execute, no token.
      expect(calls.filter((c) => /\/l3\/proposals\./.test(c.path))).toEqual([]);
      expect(calls.some((c) => c.claims.exec || c.claims.fingerprint)).toBe(false);
      // Ability calls still carry the version the manifest serves (Contracts).
      calls.length = 0;
      expect((await P.api('POST', '/api/apps/ledger/read/ledger.report.pnl', { from: '2026-08-01', to: '2026-08-31' })).status).toBe(200);
      const ab = calls.find((c) => c.path.endsWith('/l3/abilities/ledger.report.pnl'))!;
      expect(ab.claims.ability_version).toBe(P.backend.core.manifest.abilities.find((a) => a.key === 'ledger.report.pnl')!.version);
    } finally {
      P.backend.core.hooks.beforeExecuteEffect = undefined;
      P.platform.gateway.fetchImpl = real;
    }
  }, 60_000);
});

describe('t011 on a populated book', () => {
  it('t011 applies forward on a populated book: rows untouched, answers keep working, an old yes is picked up', async () => {
    const db = await createTestDatabase();
    const CO = '11111111-2222-3333-4444-555555555555';
    const tdir = await mkdtemp(path.join(os.tmpdir(), 'neop-t011-'));
    try {
      await migratePlatform(db.adminUrl); // the desk's role exists, as in a real cluster
      await cp(TEMPLATE_MIGRATIONS, tdir, { recursive: true });
      const tled = JSON.parse(await readFile(path.join(tdir, 'migrate.json'), 'utf8'));
      for (const m of tled.migrations.filter((x: any) => x.file >= 't011')) await rm(path.join(tdir, m.file));
      tled.migrations = tled.migrations.filter((m: any) => m.file < 't011');
      await writeFile(path.join(tdir, 'migrate.json'), JSON.stringify(tled));
      await bootstrapFamily(db.adminUrl, 'ledger');
      const run = async (t: string) => migrate({ adminUrl: db.adminUrl, schema: 'ledger', sources: { dir: path.join(LEDGER_ROOT, 'migrations'), prepend: await templateFiles(t) }, lintExempt: TEMPLATE_INFRA_TABLES });
      await run(tdir);
      const pool = createPool(roleUrl(db.adminUrl, 'ledger_app'));
      const runner = createPool(roleUrl(db.adminUrl, 'ledger_runner'));
      await seedLedger(pool, CO);
      // A book as t010 left it: open cards, a yes the old worker had resolved but nobody carried out, finished ones.
      const ids = await withCompany(pool, CO, async (c) => {
        const job = (await c.query("insert into ledger.jobs (company_id, source, requester, task_id, ask, status) values ($1, 'task', 'user:aaaaaaaa-0000-0000-0000-000000000001', gen_random_uuid(), 'old job', 'WAITING') returning id", [CO])).rows[0].id;
        const mk = async (status: string, via: string | null) =>
          (
            await c.query(
              `insert into ledger.proposals (company_id, job_id, ability_key, ability_version, args, card, fingerprint, status, approved_via, decided_by, expires_at, idempotency_key)
               values ($1, $2, 'ledger.journal.post', '1.0.0', '{}', '{"what":"x"}', 'sha256:' || md5(random()::text), $3, $4::text, case when $4::text is null then null else 'user:bbbbbbbb-0000-0000-0000-000000000002' end, now() + interval '1 day', gen_random_uuid()::text) returning id, fingerprint`,
              [CO, job, status, via],
            )
          ).rows[0] as { id: string; fingerprint: string };
        const open = await mk('PROPOSED', null);
        const approved = await mk('APPROVED', 'person');
        await c.query("insert into ledger.proposal_events (company_id, proposal_id, event, actor, fingerprint_seen) values ($1, $2, 'answered:yes', 'user:bbbbbbbb-0000-0000-0000-000000000002', $3)", [CO, approved.id, approved.fingerprint]);
        await c.query("insert into ledger.waits (company_id, job_id, kind, ref_id, expires_at) values ($1, $2, 'proposal', $3, now() + interval '1 day'), ($1, $2, 'proposal', $4, now() + interval '1 day')", [CO, job, open.id, approved.id]);
        return { job, open, approved };
      });
      const snap = async () =>
        (
          await runner.query(`select (select md5(string_agg(p::text, ',' order by id)) from ledger.proposals p) p,
                                     (select md5(string_agg(e::text, ',' order by id)) from ledger.proposal_events e) e,
                                     (select md5(string_agg(w::text, ',' order by id)) from ledger.waits w) w`)
        ).rows[0];
      const before = await snap();

      const applied = await run(TEMPLATE_MIGRATIONS);
      expect(applied.map((m) => m.name)).toEqual(['t011_approved_path.sql', 't012_presence.sql', 't015_bus_room.sql']); // t012 (S4), t015 (S6) follow; their own proofs are in presence-dedupe.test.ts and bus-room.test.ts
      expect(await snap()).toEqual(before);

      const admin = new pg.Client({ connectionString: db.adminUrl });
      await admin.connect();
      try {
        // One function, the new signature; the old five-argument call still resolves to it; the desk may call it.
        const fns = (await admin.query("select pg_get_function_identity_arguments(p.oid) a from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ledger' and p.proname = 'answer_proposal'")).rows;
        expect(fns).toEqual([{ a: 'p_id uuid, p_fingerprint text, p_decision text, p_by text, p_feedback text, p_roles text[]' }]);
        expect((await admin.query("select has_function_privilege('neos_desk', 'ledger.answer_proposal(uuid, text, text, text, text, text[])', 'execute') ok")).rows[0].ok).toBe(true);
        // The old APPROVED row is what the runner's poll selects (it was never carried out); the open card answers.
        const polled = (await runner.query("select id from ledger.proposals where status = 'EXECUTING' or (status = 'APPROVED' and approved_via is distinct from 'grant')")).rows.map((r) => r.id);
        expect(polled).toEqual([ids.approved.id]);
        const heard: string[] = [];
        admin.on('notification', (n) => heard.push(String(n.payload)));
        await admin.query('listen neop_ledger');
        const out = await withCompany(pool, CO, async (c) => (await c.query("select ledger.answer_proposal($1, $2, 'yes', 'user:cccccccc-0000-0000-0000-000000000003', null) as r", [ids.open.id, ids.open.fingerprint])).rows[0].r);
        expect(out).toMatchObject({ status: 'APPROVED', idempotent: false });
        await sleep(100);
        expect(heard).toContain(`approved:${ids.open.id}`);
        expect((await runner.query('select status from ledger.waits where ref_id = $1', [ids.open.id])).rows[0].status).toBe('pending'); // B2 holds
      } finally {
        await admin.end();
      }
      await pool.end();
      await runner.end();
    } finally {
      await db.drop();
      await rm(tdir, { recursive: true, force: true });
    }
  });
});
