// matrix-client.test · the Matrix CLIENT road (MATRIX_MODE=client), ported from the handoff's
// tests/matrix-client.test.mjs onto our architecture. Ledger's account (@ledger:hs.test, an operator token) pulls
// with /sync in the PLATFORM process; each plain m.text in a 1:1 DM from an allowlisted sender becomes a task row and
// a signed tasks.open through the gateway, and gets EXACTLY ONE m.notice reply (m.in_reply_to, txnId
// reply-<event_id>) when the task settles as the outbox reports it. End to end: real platform + gateway + L3 +
// runner + scripted agent, against an in-memory fake client homeserver.
//
// Deliberately unlike the handoff §6: a bridge's "go ahead" is NEVER a yes. Only a person approves — in their own
// recorded DM, as a reply to the card shown there, through platform.answer() with that card's fingerprint.
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFamily, createPool, createTestDatabase, migrate } from '@neop/pgkit';
import { ChatClient, chatClientConfigFromEnv, FIXED_FAILURE, PLATFORM_MIGRATIONS, replyTxnId, startChatClients } from '@neop/platform';
import { bootPilot, call, fakeClientHomeserver, finish, type FakeClientHomeserver, type Pilot } from './harness.ts';

const ME = '@ledger:hs.test';
const AGENT = '@reasoning_agent:hs.test'; // a bridge
const PLATFORM = '@neos-platform:hs.test'; // a bridge with nobody to relay for
const PRIYA = '@priya:hs.test'; // a linked, allowlisted person (admin)
const RAHUL = '@rahul:hs.test'; // linked, not allowlisted
const STRANGER = '@mallory:hs.test';
const text = (body: string, extra: Record<string, unknown> = {}) => ({ msgtype: 'm.text', body, ...extra });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inReplyTo = (e: { content: any }) => e.content?.['m.relates_to']?.['m.in_reply_to']?.event_id;

let P: Pilot;
const running: ChatClient[] = [];

beforeAll(async () => {
  P = await bootPilot();
  expect((await P.api('PUT', `/api/users/${P.admin.id}/chat`, { matrix_user_id: PRIYA })).status).toBe(200);
  expect((await P.api('PUT', `/api/users/${P.member.id}/chat`, { matrix_user_id: RAHUL })).status).toBe(200);
  for (const e of [
    { app: 'ledger', matrix_id: PRIYA, kind: 'person' },
    { app: 'ledger', matrix_id: AGENT, kind: 'bridge', acts_for: P.admin.id },
    { app: 'ledger', matrix_id: PLATFORM, kind: 'bridge' },
  ]) {
    const r = await P.api('PUT', '/api/chat/allowlist', e);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
});
afterEach(async () => {
  while (running.length) await running.pop()!.stop();
});
afterAll(async () => P?.close());

/** Ledger's client on a homeserver. `fresh` forgets the cursor and owed replies of an earlier homeserver. */
async function client(hs: FakeClientHomeserver, o: { deadlineMs?: number; fresh?: boolean; logs?: { msg: string; [k: string]: unknown }[] } = {}) {
  if (o.fresh !== false) {
    await P.platform.db.query('update neos.chat_accounts set next_batch = null where account = $1', [ME]);
    await P.platform.db.query("update neos.chat_client_events set reply_status = 'sent' where account = $1 and reply_status in ('waiting', 'sending')", [ME]);
  }
  const c = new ChatClient(
    P.platform,
    { account: ME, company: P.company.id, app: 'ledger', accessToken: hs.token },
    { homeserverUrl: 'http://hs.test', fetchImpl: hs.fetchImpl, syncTimeoutMs: 100, replyEveryMs: 50, replyDeadlineMs: o.deadlineMs ?? 50_000, log: (msg, extra) => o.logs?.push({ msg, ...extra }) },
  );
  await c.start();
  running.push(c);
  return c;
}
/** `from` invites Ledger to a new 1:1 room; it is joined and recorded as their DM. */
async function dmWith(hs: FakeClientHomeserver, from: string) {
  const dm = hs.invite(from);
  await P.waitFor(async () => hs.rooms.get(dm)!.members.has(ME) && (await P.platform.db.query('select 1 from neos.chat_dms where account = $1 and peer = $2 and room_id = $3', [ME, from, dm])).rowCount, `${from}'s DM`);
  return dm;
}
const nNotices = (hs: FakeClientHomeserver, room: string, n: number, what: string) => P.waitFor(async () => hs.notices(room).length >= n && hs.notices(room), what);
const tasks = async () => (await P.platform.db.query('select count(*)::int as n from neos.tasks')).rows[0].n as number;
const pnlBrain = (answer = 'Net profit for August 2026 came from 8 entries.') =>
  P.setBrain((v) => (v.calls === 0 ? call('ledger.report.pnl', { from: '2026-08-01', to: '2026-08-31' }) : finish(answer, 'done', { sources: ['ledger.report.pnl'] })));

describe('the Matrix client road (handoff checks)', () => {
  it("an allowlisted sender's invite is joined at once and recorded; a stranger's is not (no join, no reply)", async () => {
    const hs = fakeClientHomeserver({ me: ME });
    const c = await client(hs);
    expect(c.status()).toMatchObject({ account: ME, running: true, stopped: null });
    const t0 = Date.now();
    await dmWith(hs, AGENT);
    expect(Date.now() - t0).toBeLessThan(5000);
    const bad = hs.invite(STRANGER);
    const unlinked = hs.invite(RAHUL); // linked to a person, but not on this install's allowlist
    const group = hs.invite(PRIYA, { also: [STRANGER] }); // allowlisted, but not 1:1: joined, checked, left
    await P.waitFor(async () => (await P.platform.db.query('select 1 from neos.chat_dms where account = $1 and peer = $2', [ME, PRIYA])).rowCount === 0 && hs.requests > 10, 'settle');
    await pause(300);
    expect(hs.rooms.get(bad)!.members.has(ME)).toBe(false);
    expect(hs.rooms.get(unlinked)!.members.has(ME)).toBe(false);
    expect(hs.rooms.get(group)!.members.has(ME)).toBe(false);
    expect(hs.notices()).toHaveLength(0);
  });

  it('a fresh m.text → exactly ONE m.notice, in reply to it, with the typed result; the task is a signed tasks.open for the person the bridge relays for', async () => {
    const logs: { msg: string; [k: string]: unknown }[] = [];
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs, { logs });
    const dm = await dmWith(hs, AGENT);
    pnlBrain();
    const q1 = hs.say(dm, AGENT, text('What was our net profit in August 2026?'));
    const [r1] = await nNotices(hs, dm, 1, 'first reply');
    expect(r1!.content.msgtype).toBe('m.notice');
    expect(inReplyTo(r1!)).toBe(q1.event_id);
    expect(r1!.content.body).toBe('Net profit for August 2026 came from 8 entries.');
    expect(r1!.txn_id).toBe(replyTxnId(q1.event_id));
    expect(hs.sent).toHaveLength(1); // no "on it", no step notes — one message only
    const row = await P.waitFor(async () => (await P.platform.db.query("select * from neos.chat_client_events where event_id = $1 and reply_status = 'sent'", [q1.event_id])).rows[0], 'reply recorded');
    expect(row).toMatchObject({ direction: 'inbound', sender: AGENT, sender_kind: 'bridge', user_id: P.admin.id, outcome: 'task_opened', reply_status: 'sent', reply_event_id: r1!.event_id });
    const task = (await P.platform.db.query('select * from neos.tasks where id = $1', [row.task_id])).rows[0];
    expect(task).toMatchObject({ requester: `user:${P.admin.id}`, origin: 'app', status: 'COMPLETED', ask: 'What was our net profit in August 2026?' });
    // It went through the gateway as a signed tasks.open, like a desk ask.
    const gw = await P.platform.db.query("select caller, status from neos.gateway_ledger where target_app = 'ledger' and endpoint = 'tasks.open' and idem_key = $1", [`task:${task.id}`]);
    expect(gw.rows).toEqual([{ caller: 'platform', status: 200 }]);

    // a second message gets its own one reply; a message naming who it is for is opened for that person
    pnlBrain('Your vendor is Tata Power.');
    const q2 = hs.say(dm, AGENT, text('Who are my vendors?', { 'neos.on_behalf_of': RAHUL }));
    const replies = await nNotices(hs, dm, 2, 'second reply');
    expect(inReplyTo(replies[1]!)).toBe(q2.event_id);
    expect(replies[1]!.content.body).toBe('Your vendor is Tata Power.');
    const t2 = (await P.platform.db.query('select t.requester from neos.chat_client_events e join neos.tasks t on t.id = e.task_id where e.event_id = $1', [q2.event_id])).rows[0];
    expect(t2.requester).toBe(`user:${P.member.id}`);
    await pause(300);
    expect(hs.notices(dm)).toHaveLength(2);
    // logs hold event ids and outcomes — never the message's text or the token
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain('net profit');
    expect(logged).not.toContain('Tata Power');
    expect(logged).not.toContain(hs.token);
    expect(logs.some((l) => l.msg === 'chat-client: replied' && l.event === q1.event_id)).toBe(true);
  });

  it('a person asks in their own DM: the task is theirs, and the answer comes back as the one reply', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, PRIYA);
    pnlBrain();
    const q = hs.say(dm, PRIYA, text('P&L for August 2026 please'));
    const [r] = await nNotices(hs, dm, 1, 'reply');
    expect(inReplyTo(r!)).toBe(q.event_id);
    expect(r!.content.body).toMatch(/^Net profit for August 2026/);
    const t = (await P.platform.db.query('select t.requester from neos.chat_client_events e join neos.tasks t on t.id = e.task_id where e.event_id = $1', [q.event_id])).rows[0];
    expect(t.requester).toBe(`user:${P.admin.id}`);
  });

  it('backlog, notices, other msgtypes, empty bodies, strangers and non-direct rooms get nothing — no task, no reply', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    const old = hs.joinedRoom(AGENT);
    hs.say(old, AGENT, text('an old question from before startup')); // backlog: never answered
    const before = await tasks();
    await client(hs);
    await pause(300);
    hs.say(old, AGENT, text('sent before startup, delivered late'), { ts: Date.now() - 60 * 60_000 });
    hs.say(old, AGENT, { msgtype: 'm.notice', body: 'a notice is never answered' });
    hs.say(old, AGENT, { msgtype: 'm.emote', body: 'waves' });
    hs.say(old, AGENT, text('   '));
    const strangers = hs.joinedRoom(STRANGER);
    hs.say(strangers, STRANGER, text('hello from someone not on the allowlist'));
    const unlisted = hs.joinedRoom(RAHUL);
    hs.say(unlisted, RAHUL, text('linked, but not allowlisted for Ledger'));
    const group = hs.joinedRoom(AGENT, { also: [STRANGER] });
    hs.say(group, AGENT, text('a room that is not 1:1'));
    await pause(800);
    expect(hs.notices()).toHaveLength(0);
    expect(await tasks()).toBe(before);
  });

  it('a restart never re-answers old messages (the cursor and the owed replies are in the database)', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    const c1 = await client(hs);
    const dm = await dmWith(hs, AGENT);
    pnlBrain('first answer');
    const q = hs.say(dm, AGENT, text('first question'));
    await nNotices(hs, dm, 1, 'first reply');
    await c1.stop();
    running.splice(running.indexOf(c1), 1);
    hs.say(dm, AGENT, text('sent while Ledger was down')); // before the new start: not answered
    await pause(20);
    const cursor = (await P.platform.db.query('select next_batch from neos.chat_accounts where account = $1', [ME])).rows[0].next_batch;
    expect(cursor).toMatch(/^s\d+$/);
    await client(hs, { fresh: false });
    await pause(300);
    pnlBrain('answer after restart');
    const fresh = hs.say(dm, AGENT, text('a question after the restart'));
    await nNotices(hs, dm, 2, 'reply after restart');
    await pause(300);
    const replies = hs.notices(dm);
    expect(replies).toHaveLength(2);
    expect(inReplyTo(replies[0]!)).toBe(q.event_id);
    expect(inReplyTo(replies[1]!)).toBe(fresh.event_id);
    expect(replies[1]!.content.body).toBe('answer after restart');
  });

  it('a failed job → the fixed sentence, never an error or a stack trace', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT);
    P.setBrain(() => finish('upstream 402 — all models failed at /srv/agent.ts:12', 'failed'));
    hs.say(dm, AGENT, text('what is my bank balance?'));
    const [r] = await nNotices(hs, dm, 1, 'fixed sentence');
    expect(r!.content.body).toBe(FIXED_FAILURE);
  });

  it('a bridge with nobody to relay for is told so, once; nothing is opened', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, PLATFORM);
    const before = await tasks();
    const q = hs.say(dm, PLATFORM, text('What do I owe?'));
    const [r] = await nNotices(hs, dm, 1, 'reply');
    expect(inReplyTo(r!)).toBe(q.event_id);
    expect(r!.content.body).toMatch(/no person is on record/);
    expect(await tasks()).toBe(before);
  });
});

describe('approvals on the client road: only a person says yes', () => {
  it("a bridge's job that raises a card: the one reply states the proposal and that it awaits a person; the bridge's 'go ahead' is NOT a yes; the person's yes in their own DM carries it out", async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const agentDm = await dmWith(hs, AGENT);
    const priyaDm = await dmWith(hs, PRIYA);
    P.setBrain((v) =>
      v.job.includes('WOKEN')
        ? finish('Sent the August close pack to cfo@acme.example.')
        : v.calls === 0
          ? call('ledger.close_pack.email', {
              period: { from: '2026-08-01', to: '2026-08-31' },
              to: ['cfo@acme.example'],
              card: { what: 'Email the August close pack to the CFO', why: 'close', changes: 'one email leaves the company', if_no_answer: 'nothing is sent' },
            })
          : { text: 'waiting' },
    );
    const mailsBefore = (await readdir(P.mailDir)).length;
    const ask = hs.say(agentDm, AGENT, text('Email the August close pack to cfo@acme.example'));
    const [proposal] = await nNotices(hs, agentDm, 1, 'the proposal reply');
    const approval = (await P.platform.db.query("select * from neos.approvals where status = 'PENDING' order by created_at desc limit 1")).rows[0];
    expect(inReplyTo(proposal!)).toBe(ask.event_id);
    expect(proposal!.content.body).toMatch(/proposes: Email the August close pack to the CFO/);
    expect(proposal!.content.body).toMatch(/awaits a person's approval — a bridge cannot approve it/);
    expect(proposal!.content.body).toContain(`card ${approval.id.slice(0, 8)}`);
    expect(proposal!.content.body).toContain('Priya can say yes on the NEOS desk');
    // the card itself is shown in the person's own DM, with its fingerprint
    const [card] = await nNotices(hs, priyaDm, 1, 'card in Priya’s DM');
    expect(card!.content.body).toContain(`Fingerprint: ${approval.fingerprint}`);
    expect(card!.txn_id).toBe(`card-${approval.id}`);
    expect((await readdir(P.mailDir)).length).toBe(mailsBefore);

    // THE RULE: the bridge's "go ahead" is not a yes — even as a reply to the proposal
    const before = await tasks();
    const consent = hs.say(agentDm, AGENT, text('Yes, go ahead and send it.', { 'm.relates_to': { 'm.in_reply_to': { event_id: proposal!.event_id } } }));
    const replies = await nNotices(hs, agentDm, 2, 'the refusal');
    expect(inReplyTo(replies[1]!)).toBe(consent.event_id);
    expect(replies[1]!.content.body).toMatch(/^Nothing was done: a bridge cannot approve\./);
    expect(replies[1]!.content.body).toContain(`card ${approval.id.slice(0, 8)}`);
    expect(replies[1]!.content.body).toMatch(/waiting for a person's yes — Priya can answer it on the NEOS desk or in their own DM with @ledger:hs\.test/);
    await pause(400);
    expect((await P.platform.db.query('select status, decided_by from neos.approvals where id = $1', [approval.id])).rows[0]).toEqual({ status: 'PENDING', decided_by: null });
    expect(await tasks()).toBe(before);
    expect((await readdir(P.mailDir)).length).toBe(mailsBefore);
    const audit = await P.platform.db.query("select actor, outcome from neos.audit where action = 'chat.bridge_consent'");
    expect(audit.rows).toContainEqual({ actor: `chat:${AGENT}`, outcome: 'not_a_yes' });

    // the person's explicit yes, in her own recorded DM, as a reply to the card: platform.answer with that fingerprint
    const yes = hs.say(priyaDm, PRIYA, text(`> <${ME}> Ledger asks first…\n\nyes`, { 'm.relates_to': { 'm.in_reply_to': { event_id: card!.event_id } } }));
    const priya = await nNotices(hs, priyaDm, 2, 'the result for Priya');
    expect(inReplyTo(priya[1]!)).toBe(yes.event_id);
    expect(priya[1]!.content.body).toBe('Sent the August close pack to cfo@acme.example.');
    expect((await P.platform.db.query('select status, decided_by, fingerprint_seen from neos.approvals where id = $1', [approval.id])).rows[0]).toEqual({
      status: 'EXECUTED',
      decided_by: P.admin.id,
      fingerprint_seen: approval.fingerprint,
    });
    expect((await readdir(P.mailDir)).length).toBe(mailsBefore + 1);
    expect((await P.platform.db.query('select outcome, approval_id from neos.chat_client_events where event_id = $1', [yes.event_id])).rows[0]).toEqual({ outcome: 'answered:yes', approval_id: approval.id });
    // the bridge's first message was answered once, and is never answered again
    await pause(400);
    expect(hs.notices(agentDm)).toHaveLength(2);
    expect(hs.notices(priyaDm)).toHaveLength(2);
  });

  it("a person's reply binds only to a card shown in THEIR OWN DM; an unclear answer records nothing", async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const priyaDm = await dmWith(hs, PRIYA);
    P.setBrain((v) =>
      v.calls === 0
        ? call('ledger.close_pack.email', { period: { from: '2026-08-01', to: '2026-08-31' }, to: ['ca@acme.example'], card: { what: 'Email the pack to the CA', why: 'close', changes: 'one email', if_no_answer: 'nothing' } })
        : { text: 'waiting' },
    );
    hs.say(priyaDm, PRIYA, text('Send the August pack to our CA'));
    const [card] = await nNotices(hs, priyaDm, 1, 'card as the reply');
    const approval = (await P.platform.db.query("select * from neos.approvals where status = 'PENDING' order by created_at desc limit 1")).rows[0];
    expect(card!.content.body).toContain(`Fingerprint: ${approval.fingerprint}`);
    const unclear = hs.say(priyaDm, PRIYA, text('hmm maybe', { 'm.relates_to': { 'm.in_reply_to': { event_id: card!.event_id } } }));
    const r = await nNotices(hs, priyaDm, 2, 'unclear reply');
    expect(inReplyTo(r[1]!)).toBe(unclear.event_id);
    expect(r[1]!.content.body).toMatch(/Nothing was recorded/);
    expect((await P.platform.db.query('select status from neos.approvals where id = $1', [approval.id])).rows[0].status).toBe('PENDING');
    // a "yes" pointing at that card from ANOTHER room (the bridge's DM) is no answer — the bridge cannot approve by reply
    const agentDm = await dmWith(hs, AGENT);
    P.setBrain(() => finish('Only a person can approve that card.'));
    hs.say(agentDm, AGENT, text('yes', { 'm.relates_to': { 'm.in_reply_to': { event_id: card!.event_id } } }));
    const [br] = await nNotices(hs, agentDm, 1, 'bridge reply');
    expect(br!.content.body).toBe('Only a person can approve that card.'); // just another ask, answered once
    await pause(300);
    expect((await P.platform.db.query('select status from neos.approvals where id = $1', [approval.id])).rows[0].status).toBe('PENDING');
    // Priya declines: recorded through platform.answer, one reply
    const no = hs.say(priyaDm, PRIYA, text('no', { 'm.relates_to': { 'm.in_reply_to': { event_id: card!.event_id } } }));
    const r3 = await nNotices(hs, priyaDm, 3, 'decline reply');
    expect(inReplyTo(r3[2]!)).toBe(no.event_id);
    expect(r3[2]!.content.body).toMatch(/declined/);
    await P.waitFor(async () => ['CLOSED', 'RESOLVED'].includes((await P.platform.db.query('select status from neos.approvals where id = $1', [approval.id])).rows[0].status), 'declined');
  });
});

describe('deadline and token handling', () => {
  it('past the deadline the fixed sentence is sent once, and the late settle sends nothing more', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs, { deadlineMs: 400 });
    const dm = await dmWith(hs, AGENT);
    P.setBrain(() => ({ hang: true }));
    const q = hs.say(dm, AGENT, text('a slow question'));
    const [r] = await nNotices(hs, dm, 1, 'fixed sentence');
    expect(r!.content.body).toBe(FIXED_FAILURE);
    expect(inReplyTo(r!)).toBe(q.event_id);
    // the task settles late (here: cancelled) — no second reply
    const taskId = (await P.platform.db.query('select task_id from neos.chat_client_events where event_id = $1', [q.event_id])).rows[0].task_id;
    await P.waitFor(async () => (await P.platform.db.query('select job_id from neos.tasks where id = $1', [taskId])).rows[0].job_id, 'job');
    await P.platform.cancelTask({ id: P.admin.id, company_id: P.company.id }, taskId, 'test');
    await P.waitFor(async () => ['CANCELLED', 'FAILED'].includes((await P.platform.db.query('select status from neos.tasks where id = $1', [taskId])).rows[0].status), 'late settle');
    await pause(400);
    expect(hs.notices(dm)).toHaveLength(1);
  });

  it('a rejected token stops the client — no retries, no login, never /logout', async () => {
    const logs: { msg: string; [k: string]: unknown }[] = [];
    const hs = fakeClientHomeserver({ me: ME });
    hs.expireToken();
    const c = await client(hs, { logs });
    await P.waitFor(async () => c.status().stopped?.reason === 'token_rejected', 'stopped');
    const n = hs.requests;
    await pause(600);
    expect(hs.requests).toBe(n);
    expect(hs.logins).toBe(0);
    expect(hs.logouts).toBe(0);
    expect(logs.some((l) => /STOPPED/.test(l.msg))).toBe(true);
    expect((await P.platform.db.query('select stopped_reason from neos.chat_accounts where account = $1', [ME])).rows[0].stopped_reason).toBe('token_rejected');
    const st = await P.api('GET', '/api/chat/client');
    expect(st.body.accounts).toContainEqual(expect.objectContaining({ account: ME, running: false, stopped: { reason: 'token_rejected' } }));
  });

  it('a token rejected mid-run halts the loop; an account mismatch stops it at start', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    const c = await client(hs);
    await pause(300);
    hs.expireToken();
    await P.waitFor(async () => c.status().stopped?.reason === 'token_rejected', 'halted mid-run');
    const n = hs.requests;
    await pause(500);
    expect(hs.requests).toBe(n);
    const other = fakeClientHomeserver({ me: ME, whoamiAs: '@someone_else:hs.test' });
    const c2 = await client(other);
    await P.waitFor(async () => c2.status().stopped?.reason === 'account_mismatch', 'mismatch');
    expect(other.logouts).toBe(0);
    expect(other.logins).toBe(0);
  });
});

describe('the allowlist admin API', () => {
  it('admins view and edit it, audited; members cannot; a person must be linked; a person cannot be a bridge', async () => {
    const list = await P.api('GET', '/api/chat/allowlist?app=ledger');
    expect(list.status).toBe(200);
    expect(list.body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ matrix_id: PRIYA, kind: 'person', user_id: P.admin.id }),
        expect.objectContaining({ matrix_id: AGENT, kind: 'bridge', acts_for: P.admin.id }),
      ]),
    );
    expect((await P.api('GET', '/api/chat/allowlist', undefined, P.member.token)).status).toBe(403);
    expect((await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: '@bob:hs.test', kind: 'person' }, P.member.token)).status).toBe(403);
    expect((await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: '@nobody:hs.test', kind: 'person' })).status).toBe(400);
    expect((await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: RAHUL, kind: 'bridge' })).status).toBe(400);
    expect((await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: 'rahul', kind: 'person' })).status).toBe(400);
    expect((await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: '@x:hs.test', kind: 'admin' })).status).toBe(400);
    expect((await P.api('PUT', '/api/chat/allowlist', { app: 'nope', matrix_id: '@x:hs.test', kind: 'bridge' })).status).not.toBe(200);
    expect((await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: RAHUL, kind: 'person' })).status).toBe(200);
    expect((await P.api('DELETE', `/api/chat/allowlist/ledger/${encodeURIComponent(RAHUL)}`)).status).toBe(200);
    expect((await P.api('DELETE', `/api/chat/allowlist/ledger/${encodeURIComponent(RAHUL)}`)).status).toBe(404);
    const audit = (await P.api('GET', '/api/audit?action=chat.')).body.rows.map((r: any) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['chat.allowlist_set', 'chat.allowlist_removed', 'chat.user_linked']));
  });
});

describe('configuration (MATRIX_MODE=client)', () => {
  it('reads the accounts and the operator token from a secret file; appservice mode is the default', async () => {
    expect(chatClientConfigFromEnv({})).toBeNull();
    expect(chatClientConfigFromEnv({ MATRIX_MODE: 'appservice', MATRIX_HOMESERVER_URL: 'http://hs' })).toBeNull();
    expect(() => chatClientConfigFromEnv({ MATRIX_MODE: 'client', MATRIX_HOMESERVER_URL: 'http://hs' })).toThrow(/MATRIX_CLIENT_ACCOUNTS/);
    expect(() => chatClientConfigFromEnv({ MATRIX_MODE: 'client', MATRIX_HOMESERVER_URL: 'http://hs', MATRIX_CLIENT_ACCOUNTS: '[{"account":"ledger","company":"x","app":"ledger"}]' })).toThrow(/token_file/);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neos-tok-'));
    try {
      const hs = fakeClientHomeserver({ me: ME, token: 'tok-from-file' });
      await writeFile(path.join(dir, 'matrix_ledger_token'), 'tok-from-file\n');
      const cfg = chatClientConfigFromEnv({
        MATRIX_MODE: 'client',
        MATRIX_HOMESERVER_URL: 'http://hs.test',
        MATRIX_CLIENT_ACCOUNTS: JSON.stringify([{ account: ME, company: P.company.id, app: 'ledger', token_file: path.join(dir, 'matrix_ledger_token') }]),
        MATRIX_REPLY_DEADLINE_MS: '1234',
      })!;
      expect(cfg).toMatchObject({ homeserverUrl: 'http://hs.test', replyDeadlineMs: 1234, accounts: [{ account: ME, app: 'ledger' }] });
      await P.platform.db.query('update neos.chat_accounts set next_batch = null where account = $1', [ME]);
      const [c] = await startChatClients(P.platform, { ...cfg, fetchImpl: hs.fetchImpl, syncTimeoutMs: 100 });
      running.push(c!);
      await dmWith(hs, AGENT); // the token from the file is the one the homeserver accepts
      // an account whose token file is missing is not started — and does not take the platform down
      expect(await startChatClients(P.platform, { ...cfg, accounts: [{ ...cfg.accounts[0]!, tokenFile: path.join(dir, 'missing') }] })).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('migration 012', () => {
  it('012 is proven on a populated platform database', async () => {
    const db = await createTestDatabase();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neos-mig-'));
    try {
      await cp(PLATFORM_MIGRATIONS, dir, { recursive: true });
      const led = JSON.parse(await readFile(path.join(dir, 'migrate.json'), 'utf8'));
      const later = led.migrations.filter((m: any) => m.file >= '012');
      await rm(path.join(dir, '012_chat_client.sql'));
      for (const m of later.filter((x: any) => x.file > '012')) await rm(path.join(dir, m.file)).catch(() => {});
      await writeFile(path.join(dir, 'migrate.json'), JSON.stringify({ ...led, migrations: led.migrations.filter((m: any) => m.file < '012') }));
      await bootstrapFamily(db.adminUrl, 'neos');
      await migrate({ adminUrl: db.adminUrl, schema: 'neos', sources: { dir }, tenantLint: false });
      // populate: a company, people (one linked), an app and its install, a task, a card and the appservice's rows
      const pool = createPool(db.adminUrl, 2);
      const co = (await pool.query("insert into neos.companies (name, slug) values ('Acme', 'acme') returning id")).rows[0].id;
      const u = (await pool.query("insert into neos.users (company_id, name, email, role, matrix_user_id) values ($1, 'Priya', 'p@a.example', 'admin', '@priya:hs') returning id", [co])).rows[0].id;
      await pool.query("insert into neos.apps (key, l3_url, manifest, contract_version, service_secret_hash) values ('ledger', 'http://l3', '{\"name\":\"Ledger\"}', '1.0', 'x')");
      await pool.query("insert into neos.installs (company_id, app_key, status) values ($1, 'ledger', 'active')", [co]);
      const task = (await pool.query("insert into neos.tasks (company_id, app_key, requester, ask) values ($1, 'ledger', $2, 'P&L please') returning id", [co, `user:${u}`])).rows[0].id;
      const before = (await pool.query('select (select count(*) from neos.tasks) + (select count(*) from neos.users) + (select count(*) from neos.installs) as n')).rows[0].n;
      // now the real directory: only 012 (and anything after it) runs, on the populated copy
      const applied = await migrate({ adminUrl: db.adminUrl, schema: 'neos', sources: { dir: PLATFORM_MIGRATIONS }, tenantLint: false });
      expect(applied.map((m) => m.name)[0]).toBe('012_chat_client.sql');
      expect((await pool.query('select (select count(*) from neos.tasks) + (select count(*) from neos.users) + (select count(*) from neos.installs) as n')).rows[0].n).toBe(before);
      await pool.query("insert into neos.chat_allowlist (company_id, app_key, matrix_id, kind) values ($1, 'ledger', '@priya:hs', 'person')", [co]);
      await pool.query("insert into neos.chat_accounts (account, company_id, app_key) values ('@ledger:hs', $1, 'ledger')", [co]);
      await pool.query("insert into neos.chat_dms (account, peer, room_id) values ('@ledger:hs', '@priya:hs', '!dm:hs')");
      await pool.query("insert into neos.chat_client_events (event_id, account, room_id, direction, sender, sender_kind, user_id, task_id, outcome) values ('$1', '@ledger:hs', '!dm:hs', 'inbound', '@priya:hs', 'person', $1, $2, 'task_opened')", [u, task]);
      await expect(pool.query("insert into neos.chat_allowlist (company_id, app_key, matrix_id, kind, acts_for) values ($1, 'ledger', '@p2:hs', 'person', $2)", [co, u])).rejects.toThrow(/check/);
      await expect(pool.query("insert into neos.chat_allowlist (company_id, app_key, matrix_id, kind) values ($1, 'ledger', 'not-an-id', 'bridge')", [co])).rejects.toThrow(/check/);
      await pool.end();
    } finally {
      await rm(dir, { recursive: true, force: true });
      await db.drop();
    }
  });
});
