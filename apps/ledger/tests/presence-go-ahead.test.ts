// presence-go-ahead.test · v3 S4 · "only a person can say yes; the reasoning agent never approves" on the client
// road run by the NEOP itself (NEOP_PRESENCE=client) — the same checks as matrix-go-ahead.test. NeuralChat
// (neos-agent-neuralchat #143) sends plain m.text and may send a free-text go-ahead ("Go ahead with the ₹500
// expense.") — never a yes. The one reply re-shows the card and says "I can't take a yes through NeuralChat. Please
// approve #<id> on your desk."; nothing executes and no job opens. A person's yes on the desk then executes it once.
// A bridge's clear DECLINE still binds (PLAIN_DECLINE, never when it only postpones) — also for a person the bridge
// relays for who has no Matrix id of their own (t017, found in the v3 dry run).
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFamily, createPool, createTestDatabase, migrate, roleUrl, templateFiles, withCompany } from '@neop/pgkit';
import { migratePlatform } from '@neop/platform';
import { TEMPLATE_INFRA_TABLES, TEMPLATE_MIGRATIONS } from '@neop/template';
import { LEDGER_ROOT, seedLedger } from '../src/index.ts';
import { cardTextOf, goAheadOf, numbersIn, numbersNotOn, PRESENCE_REPLY_DEADLINE_MS, type PresenceClient } from '@neop/template';
import { bootPilot, call, fakeClientHomeserver, finish, type FakeClientHomeserver, type Pilot } from './harness.ts';
import { appMigrationsBefore } from '@neop/testkit';

const ME = '@ledger:hs.test';
const AGENT = '@reasoning_agent:hs.test'; // relays for Priya (admin)
const AGENT2 = '@reasoning_agent_two:hs.test'; // relays for Priya too, its own DM
const PRIYA = '@priya:hs.test';
const text = (body: string, extra: Record<string, unknown> = {}) => ({ msgtype: 'm.text', body, ...extra });
const replyTo = (ev: { event_id: string }) => ({ 'm.relates_to': { 'm.in_reply_to': { event_id: ev.event_id } } });
const inReplyTo = (e: { content: any }) => e.content?.['m.relates_to']?.['m.in_reply_to']?.event_id;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

let P: Pilot;
const running: PresenceClient[] = [];
const db = () => P.backend.core.runnerPool;
const diagnosticLog: { at: string; message: string; fields: Record<string, unknown> }[] = [];

beforeAll(async () => {
  P = await bootPilot({ presence: 'client', neuralchat: false, backendConfig: () => ({
    log(message, extra = {}) {
      // Only synthetic identifiers/status, never tokens, connection strings or model payloads.
      const fields = Object.fromEntries(Object.entries(extra).filter(([key]) =>
        ['event', 'room', 'job', 'job_id', 'session', 'session_id', 'outcome', 'fixed', 'status', 'reason'].includes(key)));
      diagnosticLog.push({ at: new Date().toISOString(), message, fields });
      if (diagnosticLog.length > 200) diagnosticLog.shift();
    },
  }) });
  expect((await P.api('PUT', `/api/users/${P.admin.id}/chat`, { matrix_user_id: PRIYA })).status).toBe(200);
  for (const e of [
    { app: 'ledger', matrix_id: PRIYA, kind: 'person' },
    { app: 'ledger', matrix_id: AGENT, kind: 'bridge', acts_for: P.admin.id },
    { app: 'ledger', matrix_id: AGENT2, kind: 'bridge', acts_for: P.admin.id },
  ]) {
    const r = await P.api('PUT', '/api/chat/allowlist', e);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  expect((await P.api('PUT', '/api/chat/presence', { app: 'ledger', matrix_user: ME })).status).toBe(200);
});
afterEach(async () => {
  while (running.length) await P.presence!.removeClient(running.pop()!);
});
afterAll(async () => P?.close());

async function client(hs: FakeClientHomeserver) {
  await db().query('update ledger.presence_accounts set next_batch = null where account = $1', [ME]);
  await db().query("update ledger.inbound_events set reply_status = 'sent' where account = $1 and reply_status in ('waiting', 'sending')", [ME]);
  running.push(await P.presence!.addClient({ account: ME, accessToken: hs.token }, { homeserverUrl: 'http://hs.test', fetchImpl: hs.fetchImpl, syncTimeoutMs: 100, replyEveryMs: 50 }));
}
async function dmWith(hs: FakeClientHomeserver, from: string) {
  const dm = hs.invite(from);
  await P.waitFor(async () => hs.rooms.get(dm)!.members.has(ME) && (await db().query('select 1 from ledger.presence_dms where account = $1 and peer = $2 and room_id = $3', [ME, from, dm])).rowCount, `${from}'s DM`);
  return dm;
}
const notices = (hs: FakeClientHomeserver, room: string, n: number, what: string) => P.waitFor(async () => hs.notices(room).length >= n && hs.notices(room), what);
const jobs = async () => (await db().query('select count(*)::int as n from ledger.jobs')).rows[0].n as number;
const proposal = async (id: string) => (await db().query('select status, decided_by, feedback, answered_at from ledger.proposals where id = $1', [id])).rows[0];
const executions = async (key: string) => (await db().query("select count(*)::int as n from ledger.operations where ability_key = $1 and outcome = 'DONE'", [key])).rows[0].n as number;
const withdraw = (id: string) => db().query("update ledger.proposals set status = 'WITHDRAWN' where id = $1 and status = 'PROPOSED'", [id]);

/** Failure-only evidence for the intermittent bridge refusal; no wait, retry or success-path query. */
async function refusalDiagnostic(hs: FakeClientHomeserver, room: string, event: string, job: string, card: string) {
  const rows = async (sql: string, args: unknown[] = []) => {
    try { return (await db().query(sql, args)).rows; }
    catch (e) { return [{ diagnostic_error: (e as Error).name }]; }
  };
  return JSON.stringify({
    observed_at: new Date().toISOString(), room, event, job, card,
    notices: hs.notices(room), log: diagnosticLog,
    inbound: await rows('select event_id,at,outcome,job_id,proposal_id,reply_status,reply_due_at,reply_text,reply_event_id,detail from ledger.inbound_events where room_id=$1 order by at', [room]),
    outbound: await rows('select key,event_id,job_id,proposal_id,wait_id,fingerprint_shown,at from ledger.outbound_events where room_id=$1 order by id', [room]),
    jobs: await rows('select id,status,claimed_by,claimed_until,heartbeat_at,attempts,tool_calls,result from ledger.jobs where id=$1 or id in (select job_id from ledger.inbound_events where room_id=$2)', [job, room]),
    proposal: await rows('select id,job_id,status,fingerprint,created_at,expires_at from ledger.proposals where id=$1', [card]),
    steps: await rows('select job_id,seq,kind,summary,output_ref,created_at from ledger.steps where job_id=$1 or job_id in (select job_id from ledger.inbound_events where room_id=$2) order by job_id,seq', [job, room]),
    sessions: await rows('select job_id,session_id,reason,message_count,created_at from ledger.transcripts where job_id=$1 or job_id in (select job_id from ledger.inbound_events where room_id=$2)', [job, room]),
    activity: await rows('select pid,usename,state,wait_event_type,wait_event,xact_start,query_start from pg_stat_activity where datname=current_database()'),
    locks: await rows('select l.pid,l.locktype,l.mode,l.granted,l.relation::regclass::text from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.datname=current_database()'),
  });
}

const DONE = 'Recorded the ₹500.00 office-supplies expense in the books.';
/** The job proposes an expense (a card) and, once woken by the answer, finishes with DONE. */
const expenseBrain = (description: string, amountMinor = 50_000) =>
  P.setBrain((v) =>
    v.job.includes('WOKEN')
      ? finish(DONE)
      : v.calls === 0
        ? call('ledger.expense.record', {
            date: '2026-09-21',
            currency: 'INR',
            description,
            amount_minor: amountMinor,
            gst_rate_bps: 0,
            account_code: '6200',
            card: { what: `Record a ₹${(amountMinor / 100).toFixed(2)} expense: ${description}`, why: 'asked in chat', changes: 'one expense entry in the books', if_no_answer: 'nothing is recorded' },
          })
        : { text: 'waiting' },
  );

/** NeuralChat's first message: a plain ask to prepare, not apply. Returns the proposal reply and its card. */
async function propose(hs: FakeClientHomeserver, dm: string, bridge: string, description: string, n = 1) {
  expenseBrain(description);
  const ask = hs.say(dm, bridge, text(`Please prepare, but do not apply, an expense of ₹500 for ${description}.`));
  const all = await notices(hs, dm, n, 'the proposal reply');
  const prop = all[n - 1]!;
  expect(inReplyTo(prop)).toBe(ask.event_id);
  const card = await P.waitFor(async () => (await db().query("select * from ledger.proposals where status = 'PROPOSED' and card->>'what' like $1 order by created_at desc limit 1", [`%${description}`])).rows[0], 'the card');
  return { ask, proposal: prop, card, id8: String(card.id).slice(0, 8) };
}

describe('the go-ahead lexicon and the number check (the template’s own copy)', () => {
  it('a clear go-ahead is an affirmative with no hold word; both is ambiguous; neither is none', () => {
    for (const t of ['Go ahead with the ₹500 expense.', 'Go ahead with the ₹500 change.', 'Yes, go ahead.', 'Proceed.', 'Approved — apply it', 'ok', 'Sure, do it', 'Confirmed.', 'yeah carry on']) {
      expect(goAheadOf(t), t).toBe('go_ahead');
    }
    for (const t of ["Don't go ahead with the ₹500 expense yet.", 'don’t go ahead', 'Go ahead? Wait, not yet.', 'No, do not proceed', 'Yes, but hold it until later', 'Go ahead but change the amount to ₹600', 'change: yes with ₹600', 'ok, cancel it', 'Yes — never mind, drop it', 'Go ahead with some changes', "I can't say yes"]) {
      expect(goAheadOf(t), t).toBe('ambiguous');
    }
    for (const t of ['What was our net profit in August 2026?', 'Record a ₹500 expense for office supplies.', 'Transfer ₹10,000 to Kapoor Traders right now.']) {
      expect(goAheadOf(t), t).toBe('none');
    }
  });

  it('numbers normalise ₹, commas, Indian grouping and decimals', () => {
    expect(numbersIn('₹500')).toEqual([500]);
    expect(numbersIn('₹50,000.00 and 5,00,000 and Rs. 1,200')).toEqual([50000, 500000, 1200]);
    expect(numbersNotOn('Go ahead with the ₹5,000 expense.', 'Record a ₹500.00 expense')).toEqual([5000]);
    expect(numbersNotOn('Go ahead with the ₹500 expense.', cardTextOf({ what: 'Record an expense' }, { amount_minor: 50_000 }))).toEqual([]);
  });

  it('the reply deadline defaults to 55 s, under NeuralChat’s 60 s wait', () => {
    expect(PRESENCE_REPLY_DEADLINE_MS).toBe(55_000);
  });
});

describe('a bridge’s go-ahead is never a yes (NeuralChat-shaped: plain messages, never replies)', () => {
  it('plain ask → proposal → plain "Go ahead with the ₹500 change." → refused, card re-shown, nothing executed; the desk yes then executes it once', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT);
    const { proposal: prop, card, id8 } = await propose(hs, dm, AGENT, 'office supplies');
    const body = String(prop.content.body);
    expect(body).toMatch(/^Ledger proposes: Record a ₹500\.00 expense: office supplies/);
    expect(body).toMatch(/awaits a person's approval — a bridge cannot approve it/);
    expect(body).not.toContain('Shall I go ahead?');
    const opsBefore = await executions('ledger.expense.record');

    const before = await jobs();
    const go = hs.say(dm, AGENT, text('Go ahead with the ₹500 change.'));
    const replies = await notices(hs, dm, 2, 'the refusal');
    expect(inReplyTo(replies[1]!)).toBe(go.event_id);
    const refusal = String(replies[1]!.content.body);
    expect(refusal).toMatch(/^Nothing was done: a bridge cannot approve\./);
    expect(refusal).toContain(`I can't take a yes through NeuralChat. Please approve #${id8} on your desk.`);
    expect(refusal).toMatch(/The change still waiting:\nLedger proposes: Record a ₹500\.00 expense: office supplies/);
    expect(refusal).toContain('Amounts: amount ₹500.00');
    await pause(400);
    expect(await proposal(card.id)).toMatchObject({ status: 'PROPOSED', decided_by: null, answered_at: null });
    expect(await jobs()).toBe(before); // no job opened by the go-ahead
    expect(await executions('ledger.expense.record')).toBe(opsBefore);
    expect((await db().query("select count(*)::int as n from ledger.proposal_events where proposal_id = $1 and event like 'answered:%'", [card.id])).rows[0].n).toBe(0);
    // the re-shown card is recorded with its fingerprint (so a "no" to it binds), never as a yes
    expect((await db().query('select outcome, proposal_id from ledger.inbound_events where event_id = $1', [go.event_id])).rows[0]).toEqual({ outcome: 'bridge_consent_refused', proposal_id: card.id });
    expect((await db().query('select fingerprint_shown from ledger.outbound_events where key = $1', [`reply:${go.event_id}`])).rows[0].fingerprint_shown).toBe(card.fingerprint);

    // A person's yes on the desk: executed exactly once.
    const desk = await P.waitFor(async () => (await P.desk()).find((c: any) => c.proposal_id === card.id && c.status === 'PENDING'), 'the desk card');
    const yes = await P.api('POST', `/api/desk/${desk.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    expect(yes.status, JSON.stringify(yes.body)).toBe(200);
    await P.waitFor(async () => (await proposal(card.id)).status === 'DONE', 'executed');
    expect(await executions('ledger.expense.record')).toBe(opsBefore + 1);
    // …and a later go-ahead from the bridge changes nothing.
    hs.say(dm, AGENT, text('Yes, go ahead.'));
    await pause(500);
    expect(await executions('ledger.expense.record')).toBe(opsBefore + 1);
  });

  it('a go-ahead as a REPLY to the card notice is refused the same way', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT2);
    const { proposal: prop, card, id8 } = await propose(hs, dm, AGENT2, 'printer paper');
    const before = await jobs();
    const go = hs.say(dm, AGENT2, text('Approved — apply it.', replyTo(prop)));
    const r = await notices(hs, dm, 2, 'the refusal');
    const expected = `Please approve #${id8} on your desk.`;
    const diagnostic = String(r[1]!.content.body).includes(expected) ? undefined : await refusalDiagnostic(hs, dm, go.event_id, card.job_id, card.id);
    expect(r[1]!.content.body, diagnostic).toContain(expected);
    await pause(300);
    expect((await proposal(card.id)).status).toBe('PROPOSED');
    expect(await jobs()).toBe(before);
    await withdraw(card.id);
  });

  it('a negation ("don’t go ahead") is an ordinary request: nothing is approved', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT);
    const { card } = await propose(hs, dm, AGENT, 'stationery', 1);
    const before = await jobs();
    P.setBrain(() => finish('Understood — nothing was applied.'));
    hs.say(dm, AGENT, text("Don't go ahead with the ₹500 expense yet."));
    const r = await notices(hs, dm, 2, 'the reply');
    expect(r[1]!.content.body).toBe('Understood — nothing was applied.');
    await pause(300);
    expect((await proposal(card.id)).status).toBe('PROPOSED'); // POSTPONE: never a decline either
    expect(await jobs()).toBe(before + 1);
    await withdraw(card.id);
  });
});

describe('a bridge’s clear decline still binds (caution may be added, never removed)', () => {
  it('NeuralChat’s plain decline — no reply, no card id — binds to the card the DM is at (PLAIN_DECLINE)', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT);
    const { card, id8 } = await propose(hs, dm, AGENT, 'desk lamps');
    P.setBrain((v) => (v.job.includes('WOKEN') ? finish('Nothing was recorded.') : { text: 'waiting' }));
    hs.say(dm, AGENT, text('The user declined. Please drop that proposal.'));
    const r = await notices(hs, dm, 2, 'the decline');
    expect(r[1]!.content.body).toBe(`Recorded: card ${id8} declined for Priya, via ${AGENT}. Nothing will be done.`);
    expect(await proposal(card.id)).toMatchObject({ status: 'REJECTED', decided_by: `user:${P.admin.id}` });
    expect((await db().query("select fingerprint_seen from ledger.proposal_events where proposal_id = $1 and event = 'answered:no'", [card.id])).rows[0].fingerprint_seen).toBe(card.fingerprint);
    // What scripts/neuralchat-sim.ts checks on the desk: the card is CLOSED with decision no (the platform follows the book).
    await P.waitFor(async () => (await P.desk()).find((c: any) => c.proposal_id === card.id && c.status === 'CLOSED' && c.decision === 'no'), 'the desk card closed as no');
  });

  it('a decline as a reply to the card', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT2);
    const { proposal: prop, card, id8 } = await propose(hs, dm, AGENT2, 'magazine subscription');
    P.setBrain((v) => (v.job.includes('WOKEN') ? finish('Nothing was recorded.') : { text: 'waiting' }));
    hs.say(dm, AGENT2, text('No, drop it — the user declined.', replyTo(prop)));
    const r = await notices(hs, dm, 2, 'the decline');
    expect(r[1]!.content.body).toBe(`Recorded: card ${id8} declined for Priya, via ${AGENT2}. Nothing will be done.`);
    expect(await proposal(card.id)).toMatchObject({ status: 'REJECTED', decided_by: `user:${P.admin.id}`, feedback: `declined via ${AGENT2} on behalf of Priya` });
  });
});

describe('a person the bridge relays for need not have a Matrix id (found in the v3 dry run, t017)', () => {
  it('a plain decline relayed for a person with no Matrix link is recorded for them', async () => {
    const AGENT3 = '@reasoning_agent_three:hs.test';
    const r = await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: AGENT3, kind: 'bridge', acts_for: P.member.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // The member has no Matrix id: not in people, only in acted_for.
    expect((await db().query('select count(*)::int as n from ledger.people where user_id = $1', [P.member.id])).rows[0].n).toBe(0);
    expect((await db().query('select count(*)::int as n from ledger.acted_for where user_id = $1', [P.member.id])).rows[0].n).toBe(1);
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT3);
    const { card, id8 } = await propose(hs, dm, AGENT3, 'printer toner');
    P.setBrain((v) => (v.job.includes('WOKEN') ? finish('Nothing was recorded.') : { text: 'waiting' }));
    hs.say(dm, AGENT3, text('The user declined. Please drop that proposal.'));
    const replies = await notices(hs, dm, 2, 'the decline');
    const name = (await db().query('select name from ledger.acted_for where user_id = $1', [P.member.id])).rows[0].name;
    expect(replies[1]!.content.body).toBe(`Recorded: card ${id8} declined for ${name}, via ${AGENT3}. Nothing will be done.`);
    expect(await proposal(card.id)).toMatchObject({ status: 'REJECTED', decided_by: `user:${P.member.id}` });
  });

  it('t017 applies forward on a populated book: nothing lost, acted_for empty, company-scoped, read-only to the app', async () => {
    const tdb = await createTestDatabase();
    const CO = '11111111-2222-3333-4444-555555555555';
    const tdir = await mkdtemp(path.join(os.tmpdir(), 'neop-t017-'));
    let beforeDir = '';
    try {
      await migratePlatform(tdb.adminUrl);
      await cp(TEMPLATE_MIGRATIONS, tdir, { recursive: true });
      const tled = JSON.parse(await readFile(path.join(tdir, 'migrate.json'), 'utf8'));
      for (const m of tled.migrations.filter((x: any) => x.file >= 't017')) await rm(path.join(tdir, m.file));
      tled.migrations = tled.migrations.filter((m: any) => m.file < 't017');
      await writeFile(path.join(tdir, 'migrate.json'), JSON.stringify(tled));
      await bootstrapFamily(tdb.adminUrl, 'ledger');
      const run = async (dir: string, appDir = path.join(LEDGER_ROOT, 'migrations')) => migrate({ adminUrl: tdb.adminUrl, schema: 'ledger', sources: { dir: appDir, prepend: await templateFiles(dir) }, lintExempt: TEMPLATE_INFRA_TABLES });
      await run(tdir, (beforeDir = await appMigrationsBefore(path.join(LEDGER_ROOT, 'migrations'), '010')));
      const pool = createPool(roleUrl(tdb.adminUrl, 'ledger_app'));
      const admin = new pg.Client({ connectionString: tdb.adminUrl });
      await admin.connect();
      try {
        await seedLedger(pool, CO);
        await admin.query("insert into ledger.installs (company_id, status, company_name, time_zone, matrix_user) values ($1, 'active', 'Old Co', 'Asia/Kolkata', '@ledger_old:hs')", [CO]);
        await admin.query("insert into ledger.people (company_id, matrix_id, user_id, name, role, chat_person) values ($1, '@priya:hs', 'aaaaaaaa-0000-0000-0000-000000000001', 'Priya', 'admin', true)", [CO]);
        const count = async () => (await admin.query('select (select count(*) from ledger.people) + (select count(*) from ledger.installs) + (select count(*) from ledger.accounts) as n')).rows[0].n;
        const before = await count();
        const applied = await run(TEMPLATE_MIGRATIONS);
        expect(applied.map((m) => m.name)).toContain('t017_acted_for.sql');
        expect(await count()).toBe(before);
        expect((await admin.query('select count(*)::int as n from ledger.acted_for')).rows[0].n).toBe(0);
        const row = (co: string) => `insert into ledger.acted_for (company_id, user_id, name, role) values ('${co}', 'aaaaaaaa-0000-0000-0000-000000000002', 'Rahul', 'member')`;
        await expect(withCompany(pool, CO, (c) => c.query(row(CO)))).rejects.toThrow(/permission denied/); // the app only reads it
        await admin.query(row(CO));
        expect((await withCompany(pool, CO, (c) => c.query('select name from ledger.acted_for'))).rows).toEqual([{ name: 'Rahul' }]);
        expect((await withCompany(pool, '99999999-2222-3333-4444-555555555555', (c) => c.query('select 1 from ledger.acted_for'))).rowCount).toBe(0);
      } finally {
        await admin.end();
        await pool.end();
      }
    } finally {
      await tdb.drop();
      await rm(tdir, { recursive: true, force: true });
      if (beforeDir) await rm(beforeDir, { recursive: true, force: true });
    }
  });
});
