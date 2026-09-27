// matrix-go-ahead.test · a BRIDGE's go-ahead on the Matrix client road (client-sync.ts goAheadByBridge), opt-in
// per bridge (016 may_approve, admin-written). The contract is NeuralChat's (neos-agent-neuralchat #143): it sends
// plain m.text (never a reply), reads Ledger's one m.notice reply threaded to it within 60 s, and — only in a run
// resumed by its user's own answer accepting that exact change — sends a free-text go-ahead such as
// "Go ahead with the ₹500 expense." (no card id, no fingerprint). Accepted only for a may-approve bridge, bound to
// the card it was just shown in its own DM, still pending, unexpired, same fingerprint, a clear affirmative, every
// number on the card, and the acts_for person passing the approver policy — through the same platform.answer().
// End to end: real platform + gateway + L3 + runner + scripted agent, against the in-memory fake homeserver.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFamily, createTestDatabase, migrate } from '@neop/pgkit';
import { cardTextOf, ChatClient, DEFAULT_REPLY_DEADLINE_MS, goAheadOf, migratePlatform, numbersIn, numbersNotOn, PLATFORM_MIGRATIONS } from '@neop/platform';
import { bootPilot, call, fakeClientHomeserver, finish, type FakeClientHomeserver, type Pilot } from './harness.ts';

const ME = '@ledger:hs.test';
const AGENT = '@reasoning_agent:hs.test'; // may_approve, relays for Priya (admin)
const AGENT2 = '@reasoning_agent_two:hs.test'; // may_approve too, its own DM
const PLAIN = '@neuralchat_plain:hs.test'; // a bridge WITHOUT may_approve (today's behaviour)
const FOR_MEMBER = '@reasoning_member:hs.test'; // may_approve, relays for Rahul (member)
const PRIYA = '@priya:hs.test';
const text = (body: string, extra: Record<string, unknown> = {}) => ({ msgtype: 'm.text', body, ...extra });
const replyTo = (ev: { event_id: string }) => ({ 'm.relates_to': { 'm.in_reply_to': { event_id: ev.event_id } } });
const inReplyTo = (e: { content: any }) => e.content?.['m.relates_to']?.['m.in_reply_to']?.event_id;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

let P: Pilot;
const running: ChatClient[] = [];

beforeAll(async () => {
  P = await bootPilot();
  expect((await P.api('PUT', `/api/users/${P.admin.id}/chat`, { matrix_user_id: PRIYA })).status).toBe(200);
  for (const e of [
    { app: 'ledger', matrix_id: PRIYA, kind: 'person' },
    { app: 'ledger', matrix_id: AGENT, kind: 'bridge', acts_for: P.admin.id, may_approve: true },
    { app: 'ledger', matrix_id: AGENT2, kind: 'bridge', acts_for: P.admin.id, may_approve: true },
    { app: 'ledger', matrix_id: PLAIN, kind: 'bridge', acts_for: P.admin.id },
    { app: 'ledger', matrix_id: FOR_MEMBER, kind: 'bridge', acts_for: P.member.id, may_approve: true },
  ]) {
    const r = await P.api('PUT', '/api/chat/allowlist', e);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
});
const stopClients = async () => {
  while (running.length) await running.pop()!.stop();
};
afterEach(stopClients);
afterAll(async () => P?.close());

async function client(hs: FakeClientHomeserver) {
  await P.platform.db.query('update neos.chat_accounts set next_batch = null where account = $1', [ME]);
  await P.platform.db.query("update neos.chat_client_events set reply_status = 'sent' where account = $1 and reply_status in ('waiting', 'sending')", [ME]);
  const c = new ChatClient(P.platform, { account: ME, company: P.company.id, app: 'ledger', accessToken: hs.token }, { homeserverUrl: 'http://hs.test', fetchImpl: hs.fetchImpl, syncTimeoutMs: 100, replyEveryMs: 50 });
  await c.start();
  running.push(c);
  return c;
}
async function dmWith(hs: FakeClientHomeserver, from: string) {
  const dm = hs.invite(from);
  await P.waitFor(async () => hs.rooms.get(dm)!.members.has(ME) && (await P.platform.db.query('select 1 from neos.chat_dms where account = $1 and peer = $2 and room_id = $3', [ME, from, dm])).rowCount, `${from}'s DM`);
  return dm;
}
const notices = (hs: FakeClientHomeserver, room: string, n: number, what: string) => P.waitFor(async () => hs.notices(room).length >= n && hs.notices(room), what);
const tasks = async () => (await P.platform.db.query('select count(*)::int as n from neos.tasks')).rows[0].n as number;
const approval = async (id: string) => (await P.platform.db.query('select status, decision, decided_by, fingerprint_seen, feedback from neos.approvals where id = $1', [id])).rows[0];
const goAheadAudit = async (approvalId: string) =>
  (await P.platform.db.query("select actor, outcome from neos.audit where action = 'chat.bridge_go_ahead' and detail->>'approval_id' = $1 order by id", [approvalId])).rows;

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
  const proposal = all[n - 1]!;
  expect(inReplyTo(proposal)).toBe(ask.event_id);
  const card = await P.waitFor(
    async () => (await P.platform.db.query("select * from neos.approvals where status = 'PENDING' and card->>'what' like $1 order by created_at desc limit 1", [`%${description}`])).rows[0],
    'the card',
  );
  return { ask, proposal, card, id8: String(card.id).slice(0, 8) };
}

describe('the go-ahead lexicon and the number check (deterministic, documented)', () => {
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

  it('numbers normalise ₹, commas, Indian grouping and decimals; every number of the go-ahead must be on the card', () => {
    expect(numbersIn('₹500')).toEqual([500]);
    expect(numbersIn('₹500.00')).toEqual([500]);
    expect(numbersIn('₹50,000.00 and 5,00,000 and Rs. 1,200')).toEqual([50000, 500000, 1200]);
    expect(numbersNotOn('Go ahead with the ₹500 expense.', 'Record a ₹500.00 expense')).toEqual([]);
    expect(numbersNotOn('Go ahead with 50,000', 'pay ₹50,000.00')).toEqual([]);
    expect(numbersNotOn('Go ahead with the ₹5,000 expense.', 'Record a ₹500.00 expense')).toEqual([5000]);
    expect(numbersNotOn('Go ahead with ₹5k', 'Record a ₹500.00 expense')).toEqual([5]);
    expect(numbersNotOn('Go ahead.', 'anything')).toEqual([]);
    // the card's text includes its exact args and every *_minor amount in major units
    expect(numbersNotOn('Go ahead with the ₹500 expense.', cardTextOf({ what: 'Record an expense' }, { amount_minor: 50_000 }))).toEqual([]);
  });

  it('the reply deadline defaults to 55 s, under NeuralChat’s 60 s wait', () => {
    expect(DEFAULT_REPLY_DEADLINE_MS).toBe(55_000);
  });
});

describe('a may-approve bridge’s go-ahead, end to end (NeuralChat-shaped: plain messages, never replies)', () => {
  it('plain ask → proposal ending "Shall I go ahead?" → plain "Go ahead with the ₹500 change." → EXECUTED once, decided by the person, the reply states the result', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT);
    const { proposal, card, id8 } = await propose(hs, dm, AGENT, 'office supplies');
    const body = String(proposal.content.body);
    expect(body).toMatch(/^Ledger proposes: Record a ₹500\.00 expense: office supplies/);
    expect(body).toContain('What changes: one expense entry in the books');
    expect(body).toContain('Amounts: amount ₹500.00');
    expect(body).toContain(`Card ${id8}`);
    expect(body.endsWith('Shall I go ahead?')).toBe(true);
    expect(body).not.toContain('a bridge cannot approve');
    // the card shown here is recorded with its fingerprint, so a go-ahead binds to it
    expect((await P.platform.db.query("select approval_id, fingerprint_shown from neos.chat_client_events where event_id = $1 and direction = 'outbound'", [proposal.event_id])).rows[0]).toEqual({
      approval_id: card.id,
      fingerprint_shown: card.fingerprint,
    });

    const before = await tasks();
    const go = hs.say(dm, AGENT, text('Go ahead with the ₹500 change.'));
    const replies = await notices(hs, dm, 2, 'the result');
    expect(inReplyTo(replies[1]!)).toBe(go.event_id);
    expect(replies[1]!.content.body).toBe(DONE);
    await P.waitFor(async () => (await approval(card.id)).status === 'EXECUTED', 'executed');
    expect(await approval(card.id)).toEqual({ status: 'EXECUTED', decision: 'yes', decided_by: P.admin.id, fingerprint_seen: card.fingerprint, feedback: `approved via ${AGENT} on behalf of Priya` });
    expect(await tasks()).toBe(before); // a decision, not a new job
    expect(await goAheadAudit(card.id)).toEqual([{ actor: `chat:${AGENT}`, outcome: 'recorded_yes' }]);
    expect((await P.platform.db.query("select count(*)::int as n from neos.audit where action = 'desk.answer' and outcome = 'yes' and detail->>'approval_id' = $1", [card.id])).rows[0].n).toBe(1);
    expect((await P.platform.db.query('select outcome, approval_id, fingerprint_shown from neos.chat_client_events where event_id = $1', [go.event_id])).rows[0]).toEqual({
      outcome: 'go_ahead:yes',
      approval_id: card.id,
      fingerprint_shown: card.fingerprint,
    });
    await pause(300);
    expect(hs.notices(dm)).toHaveLength(2); // one reply per message, nothing more
  });

  it('a bridge WITHOUT may_approve: today’s wording and today’s refusal — nothing is approved', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, PLAIN);
    const { proposal, card, id8 } = await propose(hs, dm, PLAIN, 'printer paper');
    expect(proposal.content.body).toMatch(/awaits a person's approval — a bridge cannot approve it/);
    expect(proposal.content.body).not.toContain('Shall I go ahead?');
    const before = await tasks();
    hs.say(dm, PLAIN, text('Go ahead with the ₹500 change.'));
    const r = await notices(hs, dm, 2, 'the refusal');
    expect(r[1]!.content.body).toMatch(/^Nothing was done: a bridge cannot approve\./);
    expect(r[1]!.content.body).toContain(`card ${id8}`);
    await pause(300);
    expect((await approval(card.id)).status).toBe('PENDING');
    expect(await tasks()).toBe(before);
    expect(await goAheadAudit(card.id)).toEqual([]);
  });
});

describe('a go-ahead is refused — one reply saying why, no job — unless every rule holds', () => {
  it('the DM moved on past the card: a later plain go-ahead no longer binds to it', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT);
    const { card, id8 } = await propose(hs, dm, AGENT, 'courier charges');
    P.setBrain(() => finish('Net profit for August 2026 was ₹1,000.'));
    hs.say(dm, AGENT, text('What was our net profit in August 2026?'));
    await notices(hs, dm, 2, 'the answer to the new request');
    const before = await tasks();
    const go = hs.say(dm, AGENT, text('Go ahead with the ₹500 change.'));
    const r = await notices(hs, dm, 3, 'the refusal');
    expect(inReplyTo(r[2]!)).toBe(go.event_id);
    expect(r[2]!.content.body).toBe(
      `Nothing was done: the conversation here has moved on since I proposed card ${id8}, so a go-ahead no longer binds to it. Ask me again for the change and I will propose it, or it can be approved on My Desk in NEOS.`,
    );
    await pause(300);
    expect((await approval(card.id)).status).toBe('PENDING');
    expect(await tasks()).toBe(before);
    expect(await goAheadAudit(card.id)).toEqual([{ actor: `chat:${AGENT}`, outcome: 'refused:not_bound' }]);
  });

  it('an amount that is not on the card: "that does not match the change I proposed"', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT);
    const { card, id8 } = await propose(hs, dm, AGENT, 'tea and snacks');
    const before = await tasks();
    hs.say(dm, AGENT, text('Go ahead with the ₹5,000 expense.'));
    const r = await notices(hs, dm, 2, 'the refusal');
    expect(r[1]!.content.body).toMatch(new RegExp(`^Nothing was done: that does not match the change I proposed — 5000 is not on card ${id8} \\(Record a ₹500\\.00 expense: tea and snacks\\)`));
    await pause(300);
    expect((await approval(card.id)).status).toBe('PENDING');
    expect(await tasks()).toBe(before);
    expect(await goAheadAudit(card.id)).toEqual([{ actor: `chat:${AGENT}`, outcome: 'refused:amount_mismatch' }]);
  });

  it('a negation ("don’t go ahead") is not a go-ahead: nothing is approved; it is an ordinary request', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT);
    const { card } = await propose(hs, dm, AGENT, 'stationery');
    const before = await tasks();
    P.setBrain(() => finish('Understood — nothing was applied.'));
    hs.say(dm, AGENT, text("Don't go ahead with the ₹500 expense yet."));
    const r = await notices(hs, dm, 2, 'the reply');
    expect(r[1]!.content.body).toBe('Understood — nothing was applied.');
    await pause(300);
    expect((await approval(card.id)).status).toBe('PENDING');
    expect(await tasks()).toBe(before + 1);
    expect(await goAheadAudit(card.id)).toEqual([]);
  });

  it('a card that changed after it was shown, one no longer pending (superseded/closed), or one expired, is refused', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    // changed: the card's fingerprint is no longer the one shown in this DM
    const dm1 = await dmWith(hs, AGENT);
    const a = await propose(hs, dm1, AGENT, 'cleaning supplies');
    await P.platform.db.query("update neos.approvals set fingerprint = fingerprint || '-changed' where id = $1", [a.card.id]);
    const before = await tasks();
    hs.say(dm1, AGENT, text('Go ahead with the ₹500 change.'));
    const r1 = await notices(hs, dm1, 2, 'refused: changed');
    expect(r1[1]!.content.body).toBe(`Nothing was done: card ${a.id8} changed after I showed it here, so this go-ahead does not cover it. Ask me to show it again and answer what it says now.`);
    expect((await approval(a.card.id)).status).toBe('PENDING');
    expect(await goAheadAudit(a.card.id)).toEqual([{ actor: `chat:${AGENT}`, outcome: 'refused:changed' }]);
    await P.platform.db.query("update neos.approvals set status = 'CLOSED', decision = 'withdraw' where id = $1", [a.card.id]); // tidy: never answerable again

    // superseded / closed: no longer PENDING
    await stopClients(); // one client per account at a time, as in production
    const hs2 = fakeClientHomeserver({ me: ME });
    await client(hs2);
    const dm2 = await dmWith(hs2, AGENT);
    const b = await propose(hs2, dm2, AGENT, 'pantry restock');
    await P.platform.db.query("update neos.approvals set status = 'CLOSED', decision = 'withdraw' where id = $1", [b.card.id]);
    hs2.say(dm2, AGENT, text('Yes, go ahead.'));
    const r2 = await notices(hs2, dm2, 2, 'refused: not open');
    expect(r2[1]!.content.body).toBe(`Nothing was done: card ${b.id8} is already closed, so there is nothing to go ahead with. Ask me again if a change is still needed.`);
    expect(await goAheadAudit(b.card.id)).toEqual([{ actor: `chat:${AGENT}`, outcome: 'refused:not_open' }]);

    // expired
    await stopClients(); // one client per account at a time, as in production
    const hs3 = fakeClientHomeserver({ me: ME });
    await client(hs3);
    const dm3 = await dmWith(hs3, AGENT);
    const c = await propose(hs3, dm3, AGENT, 'water cans');
    await P.platform.db.query("update neos.approvals set expires_at = now() - interval '1 second' where id = $1", [c.card.id]);
    hs3.say(dm3, AGENT, text('Go ahead with the ₹500 expense.'));
    const r3 = await notices(hs3, dm3, 2, 'refused: expired');
    expect(r3[1]!.content.body).toBe(`Nothing was done: card ${c.id8} has expired. Ask me again and I will propose the change afresh.`);
    expect((await approval(c.card.id)).decided_by).toBeNull();
    expect(await goAheadAudit(c.card.id)).toEqual([{ actor: `chat:${AGENT}`, outcome: 'refused:expired' }]);
    await P.platform.db.query("update neos.approvals set status = 'CLOSED', decision = 'withdraw' where id = $1", [c.card.id]);
    expect(await tasks()).toBe(before + 2); // the two later asks only: no refused go-ahead opened a job
  });

  it('the approver policy holds: four-eyes refuses the asker’s own go-ahead; an approver role the person lacks is refused', async () => {
    expect((await P.api('PUT', '/api/switchboards/ledger', { approvals: { 'ledger.expense.record': { four_eyes: true } } })).status).toBe(200);
    try {
      const hs = fakeClientHomeserver({ me: ME });
      await client(hs);
      const dm = await dmWith(hs, AGENT);
      const { card, id8 } = await propose(hs, dm, AGENT, 'team lunch');
      hs.say(dm, AGENT, text('Go ahead with the ₹500 change.'));
      const r = await notices(hs, dm, 2, 'refused: four-eyes');
      expect(r[1]!.content.body).toBe(`Nothing was done: the person who asked cannot also approve this. Card ${id8} is still waiting for a yes on My Desk in NEOS.`);
      expect((await approval(card.id)).status).toBe('PENDING');
      expect(await goAheadAudit(card.id)).toEqual([{ actor: `chat:${AGENT}`, outcome: 'refused:four_eyes' }]);
      await P.platform.db.query("update neos.approvals set status = 'CLOSED', decision = 'withdraw' where id = $1", [card.id]);

      expect((await P.api('PUT', '/api/switchboards/ledger', { approvals: { 'ledger.expense.record': { roles: ['admin'] } } })).status).toBe(200);
      await stopClients(); // one client per account at a time, as in production
      const hs2 = fakeClientHomeserver({ me: ME });
      await client(hs2);
      const dm2 = await dmWith(hs2, FOR_MEMBER); // relays for Rahul, a member
      const m = await propose(hs2, dm2, FOR_MEMBER, 'client gift');
      hs2.say(dm2, FOR_MEMBER, text('Go ahead with the ₹500 change.'));
      const r2 = await notices(hs2, dm2, 2, 'refused: not an approver');
      expect(r2[1]!.content.body).toMatch(/^Nothing was done: only admin may approve ledger\.expense\.record\./);
      expect((await approval(m.card.id)).status).toBe('PENDING');
      expect(await goAheadAudit(m.card.id)).toEqual([{ actor: `chat:${FOR_MEMBER}`, outcome: 'refused:not_an_approver' }]);
      await P.platform.db.query("update neos.approvals set status = 'CLOSED', decision = 'withdraw' where id = $1", [m.card.id]);
    } finally {
      await P.api('PUT', '/api/switchboards/ledger', { approvals: { 'ledger.expense.record': {} } });
    }
  });

  it('a go-ahead can never approve a card shown in ANOTHER DM — not as a reply to it, not plainly', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dmA = await dmWith(hs, AGENT);
    const dmB = await dmWith(hs, AGENT2);
    const A = await propose(hs, dmA, AGENT, 'visitor parking');
    const B = await propose(hs, dmB, AGENT2, 'office plants');
    const before = await tasks();
    // AGENT2 replies to the card notice shown in AGENT's DM: it binds to nothing in its own DM
    hs.say(dmB, AGENT2, text('Go ahead with the ₹500 change.', replyTo(A.proposal)));
    const r = await notices(hs, dmB, 2, 'refused: not bound');
    expect(r[1]!.content.body).toMatch(new RegExp(`^Nothing was done: that message is not a proposal I showed here, so there is nothing to go ahead with\\. Card ${B.id8} is still waiting`));
    await pause(300);
    expect((await approval(A.card.id)).status).toBe('PENDING');
    expect((await approval(B.card.id)).status).toBe('PENDING');
    expect(await tasks()).toBe(before);
    // … and plainly: its own DM has moved on, and AGENT's card is never within reach from here
    hs.say(dmB, AGENT2, text('Yes, go ahead with the ₹500 change.'));
    const r2 = await notices(hs, dmB, 3, 'refused again');
    expect(r2[2]!.content.body).toMatch(/^Nothing was done: the conversation here has moved on since I proposed card /);
    await pause(300);
    expect((await approval(A.card.id)).status).toBe('PENDING');
    expect((await approval(B.card.id)).status).toBe('PENDING');
    expect(await tasks()).toBe(before);
    expect(hs.notices(dmA)).toHaveLength(1);
    for (const id of [A.card.id, B.card.id]) await P.platform.db.query("update neos.approvals set status = 'CLOSED', decision = 'withdraw' where id = $1", [id]);
  });

  it('a may-approve bridge’s clear decline still binds to the card it was shown (unchanged)', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT);
    const { proposal, card, id8 } = await propose(hs, dm, AGENT, 'magazine subscription');
    P.setBrain((v) => (v.job.includes('WOKEN') ? finish('Nothing was recorded.') : { text: 'waiting' }));
    hs.say(dm, AGENT, text('No, drop it — the user declined.', replyTo(proposal)));
    const r = await notices(hs, dm, 2, 'the decline');
    expect(r[1]!.content.body).toBe(`Recorded: card ${id8} declined for Priya, via ${AGENT}. Nothing will be done.`);
    expect(await approval(card.id)).toMatchObject({ decision: 'no', decided_by: P.admin.id, fingerprint_seen: card.fingerprint });
    expect(await goAheadAudit(card.id)).toEqual([]);
  });
});

describe('may_approve is admin-written, per bridge, default false', () => {
  const OTHER = '@other_agent:hs.test';
  const entry = async (id: string) => ((await P.api('GET', '/api/chat/allowlist?app=ledger')).body.entries as any[]).find((e) => e.matrix_id === id);

  it('only an admin grants it, only to a bridge with acts_for, audited; any PUT without it revokes; a member gets 403', async () => {
    // a member (not an admin) cannot grant it — whoever they are
    expect((await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: OTHER, kind: 'bridge', acts_for: P.member.id, may_approve: true }, P.member.token)).status).toBe(403);
    expect(await entry(OTHER)).toBeUndefined();
    // default false
    expect((await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: OTHER, kind: 'bridge', acts_for: P.admin.id })).body).toMatchObject({ ok: true, may_approve: false });
    expect(await entry(OTHER)).toMatchObject({ kind: 'bridge', may_approve: false });
    // bridges only, with acts_for, and a boolean
    expect((await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: PRIYA, kind: 'person', may_approve: true })).status).toBe(400);
    expect((await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: OTHER, kind: 'bridge', may_approve: true })).status).toBe(400);
    expect((await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: OTHER, kind: 'bridge', acts_for: P.admin.id, may_approve: 'yes' })).status).toBe(400);
    expect(await entry(OTHER)).toMatchObject({ may_approve: false });
    // an admin grants it: audited with may_approve in the detail
    const g = await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: OTHER, kind: 'bridge', acts_for: P.admin.id, may_approve: true });
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ may_approve: true, acts_for: P.admin.id });
    expect(await entry(OTHER)).toMatchObject({ may_approve: true, acts_for: P.admin.id });
    const audit = (await P.platform.db.query("select actor, detail from neos.audit where action = 'chat.allowlist_set' and detail->>'matrix_id' = $1 order by id", [OTHER])).rows;
    expect(audit.map((r: any) => r.detail.may_approve)).toEqual([false, true]);
    expect(audit[1].actor).toBe(`user:${P.admin.id}`);
    // a PUT that leaves it out revokes it (never kept by accident); may_approve:false revokes explicitly
    await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: OTHER, kind: 'bridge', acts_for: P.admin.id, may_approve: true });
    await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: OTHER, kind: 'bridge', acts_for: P.admin.id });
    expect(await entry(OTHER)).toMatchObject({ may_approve: false });
    await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: OTHER, kind: 'bridge', acts_for: P.admin.id, may_approve: true });
    await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: OTHER, kind: 'bridge', acts_for: P.admin.id, may_approve: false });
    expect(await entry(OTHER)).toMatchObject({ may_approve: false });
    // the database refuses a may-approve row that is not a bridge relaying for someone
    await expect(P.platform.db.query("update neos.chat_allowlist set may_approve = true where matrix_id = $1 and company_id = $2", [PRIYA, P.company.id])).rejects.toThrow(/chat_allowlist_may_approve_check/);
    expect((await P.api('DELETE', `/api/chat/allowlist/ledger/${encodeURIComponent(OTHER)}`)).status).toBe(200);
  });

  it('a revoke is live: the same go-ahead after may_approve is set to false gets today’s refusal', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, AGENT2);
    const { card } = await propose(hs, dm, AGENT2, 'desk lamps');
    expect((await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: AGENT2, kind: 'bridge', acts_for: P.admin.id, may_approve: false })).status).toBe(200);
    try {
      hs.say(dm, AGENT2, text('Go ahead with the ₹500 change.'));
      const r = await notices(hs, dm, 2, 'the refusal');
      expect(r[1]!.content.body).toMatch(/^Nothing was done: a bridge cannot approve\./);
      expect((await approval(card.id)).status).toBe('PENDING');
    } finally {
      await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: AGENT2, kind: 'bridge', acts_for: P.admin.id, may_approve: true });
      await P.platform.db.query("update neos.approvals set status = 'CLOSED', decision = 'withdraw' where id = $1", [card.id]);
    }
  });
});

describe('migration 016', () => {
  it('016 applies forward on a populated platform database (allowlist rows kept, may_approve false)', async () => {
    const db = await createTestDatabase();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neos-016-'));
    try {
      await cp(PLATFORM_MIGRATIONS, dir, { recursive: true });
      const led = JSON.parse(await readFile(path.join(dir, 'migrate.json'), 'utf8'));
      for (const m of led.migrations.filter((x: any) => x.file >= '016')) await rm(path.join(dir, m.file));
      led.migrations = led.migrations.filter((m: any) => m.file < '016');
      await writeFile(path.join(dir, 'migrate.json'), JSON.stringify(led));
      await bootstrapFamily(db.adminUrl, 'neos', { runner: false });
      await migrate({ adminUrl: db.adminUrl, schema: 'neos', sources: { dir }, tenantLint: false });
      const c = new pg.Client({ connectionString: db.adminUrl });
      await c.connect();
      try {
        const co = (await c.query("insert into neos.companies (name, slug) values ('Acme', 'acme') returning id")).rows[0].id;
        const u = (await c.query("insert into neos.users (company_id, name, email, role, token_hash, matrix_user_id) values ($1, 'P', 'p@x', 'admin', 'h', '@p:hs') returning id", [co])).rows[0].id;
        await c.query(`insert into neos.apps (key, l3_url, manifest, contract_version, service_secret_hash) values ('ledger', 'http://l3', '{"name":"Ledger","abilities":[]}', '1', 'h')`);
        await c.query("insert into neos.chat_allowlist (company_id, app_key, matrix_id, kind) values ($1, 'ledger', '@p:hs', 'person')", [co]);
        await c.query("insert into neos.chat_allowlist (company_id, app_key, matrix_id, kind, acts_for) values ($1, 'ledger', '@agent:hs', 'bridge', $2)", [co, u]);
        await c.query("insert into neos.chat_allowlist (company_id, app_key, matrix_id, kind) values ($1, 'ledger', '@platform:hs', 'bridge')", [co]);
        const before = (await c.query("select md5(string_agg(matrix_id || kind || coalesce(acts_for::text, '-'), ',' order by matrix_id)) h from neos.chat_allowlist")).rows[0];

        const applied = await migratePlatform(db.adminUrl);
        expect(applied.map((m) => m.name)).toEqual(['016_bridge_approve.sql']);
        expect((await c.query("select md5(string_agg(matrix_id || kind || coalesce(acts_for::text, '-'), ',' order by matrix_id)) h from neos.chat_allowlist")).rows[0]).toEqual(before);
        expect((await c.query('select matrix_id, may_approve from neos.chat_allowlist order by matrix_id')).rows).toEqual([
          { matrix_id: '@agent:hs', may_approve: false },
          { matrix_id: '@p:hs', may_approve: false },
          { matrix_id: '@platform:hs', may_approve: false },
        ]);
        await c.query("update neos.chat_allowlist set may_approve = true where matrix_id = '@agent:hs'");
        await expect(c.query("update neos.chat_allowlist set may_approve = true where matrix_id = '@p:hs'")).rejects.toThrow(/may_approve_check/);
        await expect(c.query("update neos.chat_allowlist set may_approve = true where matrix_id = '@platform:hs'")).rejects.toThrow(/may_approve_check/);
      } finally {
        await c.end();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await db.drop();
    }
  });
});
