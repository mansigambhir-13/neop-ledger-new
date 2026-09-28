// presence-go-ahead.test · v3 S4 · "only a person can say yes; the reasoning agent never approves" on the client
// road run by the NEOP itself (NEOP_PRESENCE=client) — the same checks as matrix-go-ahead.test. NeuralChat
// (neos-agent-neuralchat #143) sends plain m.text and may send a free-text go-ahead ("Go ahead with the ₹500
// expense.") — never a yes. The one reply re-shows the card and says "I can't take a yes through NeuralChat. Please
// approve #<id> on your desk."; nothing executes and no job opens. A person's yes on the desk then executes it once.
// A bridge's clear DECLINE still binds (PLAIN_DECLINE, never when it only postpones).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cardTextOf, goAheadOf, numbersIn, numbersNotOn, PRESENCE_REPLY_DEADLINE_MS, type PresenceClient } from '@neop/template';
import { bootPilot, call, fakeClientHomeserver, finish, type FakeClientHomeserver, type Pilot } from './harness.ts';

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

beforeAll(async () => {
  P = await bootPilot({ presence: 'client' });
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
    hs.say(dm, AGENT2, text('Approved — apply it.', replyTo(prop)));
    const r = await notices(hs, dm, 2, 'the refusal');
    expect(r[1]!.content.body).toContain(`Please approve #${id8} on your desk.`);
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
