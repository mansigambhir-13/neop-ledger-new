// presence-client.test · v3 S4 · the Matrix CLIENT road run by the NEOP ITSELF (NEOP_PRESENCE=client), the same
// checks as matrix-client.test (which keeps proving the platform's road, NEOP_PRESENCE=off). Ledger's account
// (@ledger:hs.test, an operator token) pulls with /sync in the LEDGER BACKEND; the company is the install whose
// ledger.installs.matrix_user is that account; people and bridges come from ledger.people / installs.agent_senders
// (written through by the platform). Each plain m.text in a 1:1 DM from an allowlisted sender opens a job in
// ledger's own schema (origin = the event id) and gets EXACTLY ONE m.notice reply when the job settles as the book
// says. Only a person says yes: in their own DM, through ledger.answer_proposal().
import { readdir } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PRESENCE_FIXED_FAILURE as FIXED_FAILURE, presenceConfigFromEnv, presenceReplyTxnId as replyTxnId, type PresenceClient } from '@neop/template';
import { bootPilot, call, fakeClientHomeserver, finish, type FakeClientHomeserver, type Pilot } from './harness.ts';

const ME = '@ledger:hs.test';
const AGENT = '@reasoning_agent:hs.test'; // a bridge relaying for Priya
const PLATFORM = '@neos-platform:hs.test'; // a bridge with nobody to relay for
const PRIYA = '@priya:hs.test'; // a linked, allowlisted person (admin)
const RAHUL = '@rahul:hs.test'; // linked, not allowlisted
const STRANGER = '@mallory:hs.test';
const text = (body: string, extra: Record<string, unknown> = {}) => ({ msgtype: 'm.text', body, ...extra });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inReplyTo = (e: { content: any }) => e.content?.['m.relates_to']?.['m.in_reply_to']?.event_id;

let P: Pilot;
const running: PresenceClient[] = [];
const db = () => P.backend.core.runnerPool;

beforeAll(async () => {
  P = await bootPilot({ presence: 'client', neuralchat: false });
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
  const id = await P.api('PUT', '/api/chat/presence', { app: 'ledger', matrix_user: ME });
  expect(id.status, JSON.stringify(id.body)).toBe(200);
});
afterEach(async () => {
  while (running.length) await P.presence!.removeClient(running.pop()!);
});
afterAll(async () => P?.close());

/** Ledger's own client on a homeserver. `fresh` forgets the cursor and owed replies of an earlier homeserver. */
async function client(hs: FakeClientHomeserver, o: { deadlineMs?: number; fresh?: boolean; account?: string } = {}) {
  if (o.fresh !== false) {
    await db().query('update ledger.presence_accounts set next_batch = null where account = $1', [ME]);
    await db().query("update ledger.inbound_events set reply_status = 'sent' where account = $1 and reply_status in ('waiting', 'sending')", [ME]);
  }
  P.presence!.inbound.replyDeadlineMs = o.deadlineMs ?? 50_000;
  const c = await P.presence!.addClient({ account: o.account ?? ME, accessToken: hs.token }, { homeserverUrl: 'http://hs.test', fetchImpl: hs.fetchImpl, syncTimeoutMs: 100, replyEveryMs: 50 });
  running.push(c);
  return c;
}
/** `from` invites Ledger to a new 1:1 room; it is joined and recorded as their DM. */
async function dmWith(hs: FakeClientHomeserver, from: string) {
  const dm = hs.invite(from);
  await P.waitFor(async () => hs.rooms.get(dm)!.members.has(ME) && (await db().query('select 1 from ledger.presence_dms where account = $1 and peer = $2 and room_id = $3', [ME, from, dm])).rowCount, `${from}'s DM`);
  return dm;
}
const nNotices = (hs: FakeClientHomeserver, room: string, n: number, what: string) => P.waitFor(async () => hs.notices(room).length >= n && hs.notices(room), what);
const jobs = async () => (await db().query('select count(*)::int as n from ledger.jobs')).rows[0].n as number;
const jobOf = async (eventId: string) => (await db().query('select j.* from ledger.jobs j join ledger.inbound_events e on e.job_id = j.id where e.event_id = $1', [eventId])).rows[0];
const pnlBrain = (answer = 'Net profit for August 2026 came from 8 entries.') =>
  P.setBrain((v) => (v.calls === 0 ? call('ledger.report.pnl', { from: '2026-08-01', to: '2026-08-31' }) : finish(answer, 'done', { sources: ['ledger.report.pnl'] })));
const proposal = async (id: string) => (await db().query('select status, decided_by, feedback, answered_at from ledger.proposals where id = $1', [id])).rows[0];

describe('the NEOP’s own client road (handoff checks)', () => {
  it('the platform wrote who is who into ledger’s schema; the app reads nothing else', async () => {
    const inst = (await db().query('select matrix_user, agent_senders, agent_acts_for, company_slug from ledger.installs where company_id = $1', [P.company.id])).rows[0];
    expect(inst).toMatchObject({ matrix_user: ME, agent_senders: [PLATFORM, AGENT].sort(), agent_acts_for: { [AGENT]: P.admin.id } });
    const people = (await db().query('select matrix_id, user_id, role, chat_person from ledger.people where company_id = $1 order by matrix_id', [P.company.id])).rows;
    expect(people).toEqual([
      { matrix_id: PRIYA, user_id: P.admin.id, role: 'admin', chat_person: true },
      { matrix_id: RAHUL, user_id: P.member.id, role: 'member', chat_person: false },
    ]);
    // The app role reads people, never writes them (the desk does, through the platform).
    await expect(P.backend.core.appPool.query("insert into ledger.people (company_id, matrix_id, user_id) values ($1, '@x:hs', $2)", [P.company.id, P.admin.id])).rejects.toThrow(/permission denied/);
  });

  it("an allowlisted sender's invite is joined at once and recorded; a stranger's is not (no join, no reply)", async () => {
    const hs = fakeClientHomeserver({ me: ME });
    const c = await client(hs);
    expect(c.status()).toMatchObject({ account: ME, company_id: P.company.id, running: true, stopped: null });
    await dmWith(hs, AGENT);
    const bad = hs.invite(STRANGER);
    const unlinked = hs.invite(RAHUL); // linked to a person, but not on this install's allowlist
    const group = hs.invite(PRIYA, { also: [STRANGER] }); // allowlisted, but not 1:1: joined, checked, left
    await P.waitFor(async () => hs.requests > 10, 'settle');
    await pause(500);
    expect(hs.rooms.get(bad)!.members.has(ME)).toBe(false);
    expect(hs.rooms.get(unlinked)!.members.has(ME)).toBe(false);
    expect(hs.rooms.get(group)!.members.has(ME)).toBe(false);
    expect((await db().query('select 1 from ledger.presence_dms where account = $1 and peer = $2', [ME, PRIYA])).rowCount).toBe(0);
    expect(hs.notices()).toHaveLength(0);
  });

  it('a fresh m.text → exactly ONE m.notice, in reply to it, with the result; the job is in ledger’s book for the person the bridge relays for', async () => {
    const logs: { msg: string; [k: string]: unknown }[] = [];
    const log0 = P.backend.core.cfg.log;
    (P.backend.core.cfg as any).log = (msg: string, extra?: Record<string, unknown>) => logs.push({ msg, ...(extra ?? {}) });
    try {
      const hs = fakeClientHomeserver({ me: ME });
      await client(hs);
      const dm = await dmWith(hs, AGENT);
      pnlBrain();
      const q1 = hs.say(dm, AGENT, text('What was our net profit in August 2026?'));
      const [r1] = await nNotices(hs, dm, 1, 'first reply');
      expect(r1!.content.msgtype).toBe('m.notice');
      expect(inReplyTo(r1!)).toBe(q1.event_id);
      expect(r1!.content.body).toBe('Net profit for August 2026 came from 8 entries.');
      expect(r1!.txn_id).toBe(replyTxnId(q1.event_id));
      expect(hs.sent).toHaveLength(1); // no "on it", no step notes — one message only
      const row = await P.waitFor(async () => (await db().query("select * from ledger.inbound_events where event_id = $1 and reply_status = 'sent'", [q1.event_id])).rows[0], 'reply recorded');
      expect(row).toMatchObject({ road: 'client', sender: AGENT, sender_class: 'agent', person_id: `user:${P.admin.id}`, outcome: 'task_opened', reply_status: 'sent', reply_event_id: r1!.event_id });
      const job = (await db().query('select * from ledger.jobs where id = $1', [row.job_id])).rows[0];
      expect(job).toMatchObject({ requester: `user:${P.admin.id}`, on_behalf_of: `user:${P.admin.id}`, status: 'DONE', ask: 'What was our net profit in August 2026?', origin: q1.event_id });
      // Nothing went through the platform: no task row, no gateway call.
      expect((await P.platform.db.query('select count(*)::int as n from neos.tasks')).rows[0].n).toBe(0);

      // a second message gets its own one reply; a message naming who it is for is opened for that (linked) person
      pnlBrain('Your vendor is Tata Power.');
      const q2 = hs.say(dm, AGENT, text('Who are my vendors?', { 'neos.on_behalf_of': RAHUL }));
      const replies = await nNotices(hs, dm, 2, 'second reply');
      expect(inReplyTo(replies[1]!)).toBe(q2.event_id);
      expect(replies[1]!.content.body).toBe('Your vendor is Tata Power.');
      expect((await jobOf(q2.event_id)).requester).toBe(`user:${P.member.id}`);
      await pause(300);
      expect(hs.notices(dm)).toHaveLength(2);
      // logs hold event ids and outcomes — never the message's text or the token
      const logged = JSON.stringify(logs);
      expect(logged).not.toContain('net profit');
      expect(logged).not.toContain('Tata Power');
      expect(logged).not.toContain(hs.token);
      expect(logs.some((l) => /presence: replied/.test(l.msg) && l.event === q1.event_id)).toBe(true);
    } finally {
      (P.backend.core.cfg as any).log = log0;
    }
  });

  it('a person asks in their own DM: the job is theirs, and the answer comes back as the one reply', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, PRIYA);
    pnlBrain();
    const q = hs.say(dm, PRIYA, text('P&L for August 2026 please'));
    const [r] = await nNotices(hs, dm, 1, 'reply');
    expect(inReplyTo(r!)).toBe(q.event_id);
    expect(r!.content.body).toMatch(/^Net profit for August 2026/);
    expect((await jobOf(q.event_id)).requester).toBe(`user:${P.admin.id}`);
  });

  it('backlog, notices, other msgtypes, empty bodies, strangers and non-direct rooms get nothing — no job, no reply', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    const old = hs.joinedRoom(AGENT);
    hs.say(old, AGENT, text('an old question from before startup')); // backlog: never answered
    const before = await jobs();
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
    expect(await jobs()).toBe(before);
  });

  it('a restart never re-answers old messages (the cursor and the owed replies are in ledger’s schema)', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    const c1 = await client(hs);
    const dm = await dmWith(hs, AGENT);
    pnlBrain('first answer');
    const q = hs.say(dm, AGENT, text('first question'));
    await nNotices(hs, dm, 1, 'first reply');
    await P.presence!.removeClient(c1);
    running.splice(running.indexOf(c1), 1);
    hs.say(dm, AGENT, text('sent while Ledger was down')); // before the new start: not answered
    await pause(20);
    const cursor = (await db().query('select next_batch from ledger.presence_accounts where account = $1', [ME])).rows[0].next_batch;
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
    const before = await jobs();
    const q = hs.say(dm, PLATFORM, text('What do I owe?'));
    const [r] = await nNotices(hs, dm, 1, 'reply');
    expect(inReplyTo(r!)).toBe(q.event_id);
    expect(r!.content.body).toMatch(/no person is on record/);
    expect(await jobs()).toBe(before);
  });
});

describe('approvals on the NEOP’s client road: only a person says yes', () => {
  it("a bridge's job that raises a card: the one reply states the proposal and that it awaits a person; the bridge's 'go ahead' is NOT a yes; the person's yes in their own DM carries it out once", async () => {
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
    const [prop] = await nNotices(hs, agentDm, 1, 'the proposal reply');
    const p = (await db().query("select * from ledger.proposals where status = 'PROPOSED' order by created_at desc limit 1")).rows[0];
    expect(inReplyTo(prop!)).toBe(ask.event_id);
    expect(prop!.content.body).toMatch(/proposes: Email the August close pack to the CFO/);
    expect(prop!.content.body).toMatch(/awaits a person's approval — a bridge cannot approve it/);
    expect(prop!.content.body).toContain(`card ${p.id.slice(0, 8)}`);
    expect(prop!.content.body).toContain('Priya can say yes on My Desk in NEOS');
    // the card itself is shown in the person's own DM, with its fingerprint
    const [card] = await nNotices(hs, priyaDm, 1, 'card in Priya’s DM');
    expect(card!.content.body).toContain(`Fingerprint: ${p.fingerprint}`);
    expect(card!.txn_id).toBe(`card-${p.id}`);
    expect((await readdir(P.mailDir)).length).toBe(mailsBefore);

    // THE RULE: the bridge's "go ahead" is not a yes — even as a reply to the proposal
    const before = await jobs();
    const consent = hs.say(agentDm, AGENT, text('Yes, go ahead and send it.', { 'm.relates_to': { 'm.in_reply_to': { event_id: prop!.event_id } } }));
    const replies = await nNotices(hs, agentDm, 2, 'the refusal');
    expect(inReplyTo(replies[1]!)).toBe(consent.event_id);
    expect(replies[1]!.content.body).toMatch(/^Nothing was done: a bridge cannot approve\./);
    expect(replies[1]!.content.body).toContain(`card ${p.id.slice(0, 8)}`);
    expect(replies[1]!.content.body).toMatch(/waiting for a person's yes — Priya can answer it on My Desk in NEOS or in their own DM with @ledger:hs\.test/);
    await pause(400);
    expect(await proposal(p.id)).toMatchObject({ status: 'PROPOSED', decided_by: null, answered_at: null });
    expect(await jobs()).toBe(before);
    expect((await readdir(P.mailDir)).length).toBe(mailsBefore);
    expect((await db().query('select outcome, detail from ledger.inbound_events where event_id = $1', [consent.event_id])).rows[0]).toEqual({
      outcome: 'bridge_consent_refused',
      detail: { consent: 'not_a_yes', proposals: [p.id] },
    });

    // the person's explicit yes, in her own recorded DM, as a reply to the card: answer_proposal with that fingerprint
    const yes = hs.say(priyaDm, PRIYA, text(`> <${ME}> Ledger asks first…\n\nyes`, { 'm.relates_to': { 'm.in_reply_to': { event_id: card!.event_id } } }));
    const priya = await nNotices(hs, priyaDm, 2, 'the result for Priya');
    expect(inReplyTo(priya[1]!)).toBe(yes.event_id);
    expect(priya[1]!.content.body).toBe('Sent the August close pack to cfo@acme.example.');
    expect(await proposal(p.id)).toMatchObject({ status: 'DONE', decided_by: `user:${P.admin.id}` });
    const answered = (await db().query("select actor, fingerprint_seen from ledger.proposal_events where proposal_id = $1 and event = 'answered:yes'", [p.id])).rows;
    expect(answered).toEqual([{ actor: `user:${P.admin.id}`, fingerprint_seen: p.fingerprint }]);
    expect((await readdir(P.mailDir)).length).toBe(mailsBefore + 1);
    expect((await db().query('select outcome, proposal_id from ledger.inbound_events where event_id = $1', [yes.event_id])).rows[0]).toEqual({ outcome: 'answered:yes', proposal_id: p.id });
    // the desk's card is the book's own row (neos.v_desk_cards): carried out, once
    await P.waitFor(async () => (await P.desk()).find((c: any) => c.proposal_id === p.id && c.status === 'EXECUTED'), 'desk card follows');
    await pause(400);
    expect((await readdir(P.mailDir)).length).toBe(mailsBefore + 1);
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
    const p = (await db().query("select * from ledger.proposals where status = 'PROPOSED' order by created_at desc limit 1")).rows[0];
    expect(card!.content.body).toContain(`Fingerprint: ${p.fingerprint}`);
    const unclear = hs.say(priyaDm, PRIYA, text('hmm maybe', { 'm.relates_to': { 'm.in_reply_to': { event_id: card!.event_id } } }));
    const r = await nNotices(hs, priyaDm, 2, 'unclear reply');
    expect(inReplyTo(r[1]!)).toBe(unclear.event_id);
    expect(r[1]!.content.body).toMatch(/Nothing was recorded/);
    expect((await proposal(p.id)).status).toBe('PROPOSED');
    // a "yes" pointing at that card from ANOTHER room (the bridge's DM) is no answer — the bridge cannot approve by reply
    const agentDm = await dmWith(hs, AGENT);
    P.setBrain(() => finish('Only a person can approve that card.'));
    hs.say(agentDm, AGENT, text('yes', { 'm.relates_to': { 'm.in_reply_to': { event_id: card!.event_id } } }));
    const [br] = await nNotices(hs, agentDm, 1, 'bridge reply');
    expect(br!.content.body).toBe('Only a person can approve that card.'); // just another ask, answered once
    await pause(300);
    expect((await proposal(p.id)).status).toBe('PROPOSED');
    // Priya declines: recorded through answer_proposal, one reply
    const no = hs.say(priyaDm, PRIYA, text('no', { 'm.relates_to': { 'm.in_reply_to': { event_id: card!.event_id } } }));
    const r3 = await nNotices(hs, priyaDm, 3, 'decline reply');
    expect(inReplyTo(r3[2]!)).toBe(no.event_id);
    expect(r3[2]!.content.body).toBe(`Recorded: card ${p.id.slice(0, 8)} declined.`);
    expect(await proposal(p.id)).toMatchObject({ status: 'REJECTED', decided_by: `user:${P.admin.id}` });
  });

  it('the company’s approver policy holds in a DM too: a member may not say yes where only admins may', async () => {
    // (the board is the app's own; written through the platform's API)
    const put = await P.api('PUT', '/api/switchboards/ledger', { approvals: { 'ledger.close_pack.email': { roles: ['admin'] } } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    // Rahul is linked; put him on the allowlist as a person so he may DM Ledger.
    expect((await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: RAHUL, kind: 'person' })).status).toBe(200);
    try {
      const hs = fakeClientHomeserver({ me: ME });
      const originalFetch = hs.fetchImpl;
      let repliedBeforeReceipt = false;
      // Matrix can expose a card to its recipient before the sender has received its HTTP response
      // and persisted the returned event ID. A fast reply must still bind to that card.
      hs.fetchImpl = async (input, init) => {
        const response = await originalFetch(input, init);
        if (!repliedBeforeReceipt && init?.method === 'PUT' && String(input).includes('/send/m.room.message/')) {
          const content = JSON.parse(String(init.body));
          if (content.body?.includes('Email the pack to the bank') && content.body.includes('Fingerprint:')) {
            repliedBeforeReceipt = true;
            const room = decodeURIComponent(String(input).split('/rooms/')[1]!.split('/send/')[0]!);
            const { event_id } = await response.json() as { event_id: string };
            hs.say(room, RAHUL, text('yes', { 'm.relates_to': { 'm.in_reply_to': { event_id } } }));
            await pause(250);
          }
        }
        return response;
      };
      await client(hs);
      const dm = await dmWith(hs, RAHUL);
      P.setBrain((v) =>
        v.calls === 0
          ? call('ledger.close_pack.email', { period: { from: '2026-08-01', to: '2026-08-31' }, to: ['bank2@acme.example'], card: { what: 'Email the pack to the bank', why: 'close', changes: 'one email', if_no_answer: 'nothing' } })
          : { text: 'waiting' },
      );
      hs.say(dm, RAHUL, text('Send the August pack to the bank'));
      const [card] = await nNotices(hs, dm, 1, 'card');
      const p = (await db().query("select * from ledger.proposals where status = 'PROPOSED' and card->>'what' = 'Email the pack to the bank'")).rows[0];
      const r = await nNotices(hs, dm, 2, 'refusal');
      expect(repliedBeforeReceipt).toBe(true);
      expect(r[1]!.content.body).toBe('That answer was not recorded: only admin may approve ledger.close_pack.email.');
      expect((await proposal(p.id)).status).toBe('PROPOSED');
      await db().query("update ledger.proposals set status = 'WITHDRAWN' where id = $1", [p.id]);
    } finally {
      expect((await P.api('DELETE', `/api/chat/allowlist/ledger/${encodeURIComponent(RAHUL)}`)).status).toBe(200);
      expect((await P.api('PUT', '/api/switchboards/ledger', { approvals: { 'ledger.close_pack.email': {} } })).status).toBe(200);
    }
  });
});

describe("a bridge's clear no is taken (a model may add caution, never remove it)", () => {
  const closePack = (to: string, what: string) =>
    P.setBrain((v) =>
      v.job.includes('WOKEN')
        ? finish('The close pack was not sent.')
        : v.calls === 0
          ? call('ledger.close_pack.email', { period: { from: '2026-08-01', to: '2026-08-31' }, to: [to], card: { what, why: 'close', changes: 'one email leaves the company', if_no_answer: 'nothing is sent' } })
          : { text: 'waiting' },
    );

  it('a decline in reply to the card it was shown: recorded as the person’s no, via the bridge; nothing is sent', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const agentDm = await dmWith(hs, AGENT);
    closePack('auditor@acme.example', 'Email the August pack to the auditor');
    const mailsBefore = (await readdir(P.mailDir)).length;
    hs.say(agentDm, AGENT, text('Email the August close pack to auditor@acme.example'));
    const [prop] = await nNotices(hs, agentDm, 1, 'the proposal reply');
    const p = (await db().query("select * from ledger.proposals where status = 'PROPOSED' and card->>'what' = 'Email the August pack to the auditor'")).rows[0];
    expect(prop!.content.body).toContain(`card ${p.id.slice(0, 8)}`);
    expect(prop!.content.body).toContain('To drop it instead, reply "no" to this message.');
    const before = await jobs();
    const no = hs.say(agentDm, AGENT, text('No, drop it — the user declined.', { 'm.relates_to': { 'm.in_reply_to': { event_id: prop!.event_id } } }));
    const replies = await nNotices(hs, agentDm, 2, 'the decline reply');
    expect(inReplyTo(replies[1]!)).toBe(no.event_id);
    expect(replies[1]!.content.body).toBe(`Recorded: card ${p.id.slice(0, 8)} declined for Priya, via ${AGENT}. Nothing will be done.`);
    expect(await proposal(p.id)).toMatchObject({ status: 'REJECTED', decided_by: `user:${P.admin.id}`, feedback: `declined via ${AGENT} on behalf of Priya` });
    const ev = (await db().query("select fingerprint_seen from ledger.proposal_events where proposal_id = $1 and event = 'answered:no'", [p.id])).rows[0];
    expect(ev.fingerprint_seen).toBe(p.fingerprint);
    expect((await db().query('select detail from ledger.inbound_events where event_id = $1', [no.event_id])).rows[0].detail).toMatchObject({ declined: p.id, on_behalf_of: P.admin.id, via: AGENT });
    expect(await jobs()).toBe(before); // a decision, not a new job
    await pause(300);
    expect((await readdir(P.mailDir)).length).toBe(mailsBefore);
  });

  it('a decline naming the card id binds too; a go-ahead naming it stays refused and points to My Desk', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const agentDm = await dmWith(hs, AGENT);
    closePack('bank@acme.example', 'Email the August pack to the bank');
    hs.say(agentDm, AGENT, text('Email the August close pack to bank@acme.example'));
    await nNotices(hs, agentDm, 1, 'the proposal reply');
    const p = (await db().query("select * from ledger.proposals where status = 'PROPOSED' and card->>'what' = 'Email the August pack to the bank'")).rows[0];
    const id8 = p.id.slice(0, 8);
    hs.say(agentDm, AGENT, text(`Go ahead with card ${id8}.`));
    const r = await nNotices(hs, agentDm, 2, 'the refusal');
    expect(r[1]!.content.body).toMatch(/^Nothing was done: a bridge cannot approve\./);
    expect(r[1]!.content.body).toContain(`card ${id8}`);
    expect(r[1]!.content.body).toContain('My Desk in NEOS');
    expect((await proposal(p.id)).status).toBe('PROPOSED');
    hs.say(agentDm, AGENT, text(`Please decline card ${id8}, they changed their mind.`));
    const r2 = await nNotices(hs, agentDm, 3, 'the decline');
    expect(r2[2]!.content.body).toMatch(new RegExp(`^Recorded: card ${id8} declined for Priya`));
    expect(await proposal(p.id)).toMatchObject({ status: 'REJECTED', decided_by: `user:${P.admin.id}` });
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
    // the job settles late (here: cancelled by the DBA's hand) — no second reply
    const job = await P.waitFor(async () => jobOf(q.event_id), 'job');
    const admin = new pg.Client({ connectionString: P.adminUrl });
    await admin.connect();
    try {
      await admin.query("update ledger.jobs set status = 'CANCELLED', claimed_by = null, claimed_until = null where id = $1", [job.id]);
    } finally {
      await admin.end();
    }
    await pause(500);
    expect(hs.notices(dm)).toHaveLength(1);
  });

  it('a rejected token stops the client — no retries, no login, never /logout', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    hs.expireToken();
    const c = await client(hs);
    await P.waitFor(async () => c.status().stopped?.reason === 'token_rejected', 'stopped');
    const n = hs.requests;
    await pause(600);
    expect(hs.requests).toBe(n);
    expect(hs.logins).toBe(0);
    expect(hs.logouts).toBe(0);
  });

  it('a token rejected mid-run halts the loop (recorded); an account mismatch and an account no install speaks as stop it at start', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    const c = await client(hs);
    await pause(300);
    hs.expireToken();
    await P.waitFor(async () => c.status().stopped?.reason === 'token_rejected', 'halted mid-run');
    const n = hs.requests;
    await pause(500);
    expect(hs.requests).toBe(n);
    expect((await db().query('select stopped_reason from ledger.presence_accounts where account = $1', [ME])).rows[0].stopped_reason).toBe('token_rejected');
    const other = fakeClientHomeserver({ me: ME, whoamiAs: '@someone_else:hs.test' });
    const c2 = await client(other);
    expect(c2.status().stopped?.reason).toBe('account_mismatch');
    expect(other.logouts).toBe(0);
    expect(other.logins).toBe(0);
    const nobody = fakeClientHomeserver({ me: '@nobody_speaks_as_me:hs.test' });
    const c3 = await client(nobody, { account: '@nobody_speaks_as_me:hs.test' });
    expect(c3.status().stopped?.reason).toBe('no_install');
  });

  it('a homeserver not reachable at boot (found in a dry run): the client keeps trying and starts once it answers', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    let down = true;
    const flaky = (async (url: any, init?: any) => {
      if (down) throw new TypeError('fetch failed');
      return hs.fetchImpl(url, init);
    }) as typeof hs.fetchImpl;
    await db().query('update ledger.presence_accounts set next_batch = null where account = $1', [ME]);
    const c = await P.presence!.addClient({ account: ME, accessToken: hs.token }, { homeserverUrl: 'http://hs.test', fetchImpl: flaky, syncTimeoutMs: 100, replyEveryMs: 50 });
    running.push(c);
    expect(c.status().stopped?.reason).toBe('unreachable');
    down = false;
    await P.waitFor(async () => c.status().running, 'started after the homeserver came back', 15_000);
    expect(c.status().stopped).toBeNull();
  });
});

describe('the identity API (PUT /api/chat/presence) and NEOP_PRESENCE', () => {
  it('admins set the app’s name and rooms in its schema, audited; members cannot; bad ids are refused', async () => {
    const got = await P.api('GET', '/api/chat/presence?app=ledger');
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ app: 'ledger', matrix_user: ME });
    expect((await P.api('GET', '/api/chat/presence?app=ledger', undefined, P.member.token)).status).toBe(403);
    expect((await P.api('PUT', '/api/chat/presence', { app: 'ledger', matrix_user: ME }, P.member.token)).status).toBe(403);
    expect((await P.api('PUT', '/api/chat/presence', { app: 'ledger', matrix_user: 'ledger' })).status).toBe(400);
    expect((await P.api('PUT', '/api/chat/presence', { app: 'ledger', room_ids: ['not-a-room'] })).status).toBe(400);
    expect((await P.api('PUT', '/api/chat/presence', { app: 'ledger' })).status).toBe(400);
    expect((await P.api('PUT', '/api/chat/presence', { app: 'nope', matrix_user: ME })).status).not.toBe(200);
    const set = await P.api('PUT', '/api/chat/presence', { app: 'ledger', matrix_user: ME, room_ids: ['!books:hs.test'] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ matrix_user: ME, room_ids: ['!books:hs.test'] });
    expect((await P.api('PUT', '/api/chat/presence', { app: 'ledger', room_ids: [] })).status).toBe(200);
    const audit = (await P.api('GET', '/api/audit?action=chat.')).body.rows.map((r: any) => r.action);
    expect(audit).toContain('chat.presence_set');
  });

  it('NEOP_PRESENCE: the client road by default, never off (v3 S9); each road needs its settings', () => {
    // v3 S9: the NEOP's own presence is the only road to it — there is no "off" (no platform bridge to fall back to).
    expect(() => presenceConfigFromEnv({})).toThrow(/NEOP_MATRIX_HOMESERVER_URL/); // the default road, client, needs its settings
    expect(() => presenceConfigFromEnv({ NEOP_PRESENCE: 'off', NEOP_MATRIX_HOMESERVER_URL: 'http://hs' })).toThrow(/appservice or client[\s\S]*only road/);
    expect(() => presenceConfigFromEnv({ NEOP_PRESENCE: 'bridge' })).toThrow(/appservice or client/);
    expect(() => presenceConfigFromEnv({ NEOP_PRESENCE: 'client' })).toThrow(/NEOP_MATRIX_HOMESERVER_URL/);
    expect(() => presenceConfigFromEnv({ NEOP_PRESENCE: 'client', NEOP_MATRIX_HOMESERVER_URL: 'http://hs' })).toThrow(/NEOP_MATRIX_CLIENT_ACCOUNTS/);
    expect(() => presenceConfigFromEnv({ NEOP_PRESENCE: 'appservice', NEOP_MATRIX_HOMESERVER_URL: 'http://hs' })).toThrow(/HS_TOKEN/);
    expect(presenceConfigFromEnv({ NEOP_PRESENCE: 'client', NEOP_MATRIX_HOMESERVER_URL: 'http://hs', NEOP_MATRIX_CLIENT_ACCOUNTS: JSON.stringify([{ account: ME, token_file: '/run/secrets/matrix_ledger_token' }]), MATRIX_REPLY_DEADLINE_MS: '1234' })).toEqual({
      mode: 'client',
      homeserverUrl: 'http://hs',
      replyDeadlineMs: 1234,
      client: { accounts: [{ account: ME, tokenFile: '/run/secrets/matrix_ledger_token' }], syncTimeoutMs: undefined },
    });
    expect(presenceConfigFromEnv({ NEOP_PRESENCE: 'appservice', NEOP_MATRIX_HOMESERVER_URL: 'http://hs', NEOP_MATRIX_HS_TOKEN: 'synthetic-h', NEOP_MATRIX_AS_TOKEN: 'synthetic-a' })).toMatchObject({
      mode: 'appservice',
      appservice: { hsToken: 'h', asToken: 'a', port: 4104 },
    });
  });
});
