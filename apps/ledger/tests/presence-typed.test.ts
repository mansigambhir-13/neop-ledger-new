// presence-typed.test · v3 S4 · §8 TYPED MATRIX EVENTS handled by the NEOP itself, on both of its roads — the same
// checks as matrix-typed.test (the platform's roads), end to end (real platform + L3 + runner + scripted agent):
//   in   by sender CLASS (contracts TYPED_SENDERS) from ledger's own schema — people: task/answer/approve · the
//        reasoning agent: task/answer, NEVER approve · other NEOPs (@neop_…): task/ask/answer/propose/done/note, NEVER
//        approve. Bodies validated (invalid → dropped, recorded), deduped on event_id, thread-correlated; a closed wait
//        → a `stale` note back. task → a job in ledger's book; answer → the wait; approve → ledger.answer_proposal().
//   out  runner/mirror.ts, in the thread rooted at the typed task: note ("on it", then each step once), ask, propose
//        (fingerprint, expires), done (THEIR task_id) — each with the m.notice text as `body`.
import { readdir } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PresenceClient } from '@neop/template';
import { bootPilot, call, fakeClientHomeserver, finish, MATRIX, type BrainView, type FakeClientHomeserver, type Pilot } from './harness.ts';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ASK = { text: 'Which bank account did the ₹12,000 deposit go into?', why: 'Two accounts show a deposit that day.', fields: [{ key: 'account_code', label: 'Bank account code' }] };
const pnlBrain = (P: Pilot) =>
  P.setBrain((v) => (v.calls === 0 ? call('ledger.report.pnl', { from: '2026-08-01', to: '2026-08-31' }) : finish('Net profit for August 2026 came from 8 entries.', 'done', { sources: ['ledger.report.pnl'] })));
const askingBrain = (P: Pilot, woke: string[]) =>
  P.setBrain((v: BrainView) => (v.job.includes('You asked:') ? (woke.push(v.job), finish('Recorded the deposit to the account you named.')) : v.calls === 0 ? call('job.ask', ASK) : { text: 'waiting' }));
const emailBrain = (P: Pilot) =>
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
const outcomeOf = (P: Pilot, eventId: string) =>
  P.waitFor(async () => {
    const o = (await P.backend.core.runnerPool.query<{ outcome: string }>('select outcome from ledger.inbound_events where event_id = $1', [eventId])).rows[0]?.outcome;
    return o && o !== 'typed:received' && o !== 'received' ? o : null;
  }, `outcome of ${eventId}`);

// ── the client road (an ordinary @ledger account, DMs) ──────────────────────────────────────────────────────────
describe('typed events on the NEOP’s client road (DMs)', () => {
  const ME = '@ledger:hs.test';
  const AGENT = '@neuralchat_acme:hs.test'; // the reasoning agent: a bridge relaying for Priya
  const MKT = '@neop_marketing_acmetraders:hs.test'; // another NEOP
  const PRIYA = '@priya:hs.test';
  const RAHUL = '@rahul:hs.test';
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
      { app: 'ledger', matrix_id: MKT, kind: 'bridge' },
    ]) expect((await P.api('PUT', '/api/chat/allowlist', e)).status).toBe(200);
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
  const outcome = (eventId: string) => outcomeOf(P, eventId);
  const typedOut = (hs: FakeClientHomeserver, room: string, type: string, what: string, pred: (e: any) => boolean = () => true) => P.waitFor(async () => hs.typed(room, type).find(pred), what);
  const task = (text: string, onBehalf = PRIYA, id = `T-${Math.random().toString(36).slice(2, 8)}`) => ({ task_id: id, company: P.company.id, on_behalf_of: onBehalf, text });
  const inThread = (e: any, root: string) => e.content['m.relates_to']?.rel_type === 'm.thread' && e.content['m.relates_to']?.event_id === root;
  const jobs = async () => (await db().query('select count(*)::int as n from ledger.jobs')).rows[0].n as number;
  const jobOf = async (eventId: string) => (await db().query('select j.* from ledger.jobs j where j.origin = $1', [eventId])).rows[0];

  it('task → a job; out in its thread: note "on it", a note per step (once each), done with THEIR task_id; the one m.notice reply is in the thread', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, PRIYA);
    pnlBrain(P);
    const t = hs.sayTyped(dm, PRIYA, 'neos.neop.task', task('What was our net profit in August 2026?', PRIYA, 'T-91'));
    const done = await typedOut(hs, dm, 'neos.neop.done', 'typed done');
    expect(done.content).toMatchObject({ task_id: 'T-91', could_not: [], msgtype: 'm.notice' });
    expect(done.content.result.summary).toBe('Net profit for August 2026 came from 8 entries.');
    expect(done.content.body).toMatch(/^Ledger: Net profit for August 2026/); // the plain-client fallback
    expect(inThread(done, t.event_id)).toBe(true);
    const job = await jobOf(t.event_id);
    expect(job).toMatchObject({ status: 'DONE', ask: 'What was our net profit in August 2026?', requester: `user:${P.admin.id}` });
    expect(done.content.job_id).toBe(job.id);
    const notes = hs.typed(dm, 'neos.neop.note');
    expect(notes[0]!.content).toMatchObject({ job_id: job.id, step_id: 'ack', text: 'on it' });
    expect(notes.every((n) => inThread(n, t.event_id))).toBe(true);
    expect(notes.some((n) => /Profit and loss/.test(n.content.text))).toBe(true);
    const ids = notes.map((n) => n.content.step_id);
    expect(new Set(ids).size).toBe(ids.length); // deduped by step id
    // The one plain reply: an m.notice, in the thread, replying to the task event.
    const [reply] = await P.waitFor(async () => hs.notices(dm).length >= 1 && hs.notices(dm), 'the one reply');
    expect(reply!.content.body).toBe('Net profit for August 2026 came from 8 entries.');
    expect(reply!.content['m.relates_to']).toMatchObject({ rel_type: 'm.thread', event_id: t.event_id, 'm.in_reply_to': { event_id: t.event_id } });
    // Nothing more, however many ticks pass (done is the last word; notes are not re-sent).
    const n = hs.typed(dm).length;
    await pause(400);
    expect(hs.typed(dm).length).toBe(n);
    expect(hs.notices(dm)).toHaveLength(1);
  });

  it('ask → answer in the thread wakes the job; a second answer to the closed wait gets a `stale` note; a redelivered answer is ignored', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, PRIYA);
    const woke: string[] = [];
    askingBrain(P, woke);
    const t = hs.sayTyped(dm, PRIYA, 'neos.neop.task', task('Record the ₹12,000 deposit from 3 September'));
    const ask = await typedOut(hs, dm, 'neos.neop.ask', 'typed ask');
    expect(inThread(ask, t.event_id)).toBe(true);
    expect(ask.content.question).toMatchObject({ text: ASK.text, why: ASK.why, fields: [{ key: 'account_code', label: 'Bank account code' }] });
    expect(ask.content.body).toMatch(/^Question: Ledger needs an answer/);
    const wait = ask.content.wait_id as string;
    const thread = { 'm.relates_to': { rel_type: 'm.thread', event_id: t.event_id } };
    const a = hs.sayTyped(dm, PRIYA, 'neos.neop.answer', { wait_id: wait, answers: { account_code: '1010' }, ...thread });
    expect(await outcome(a.event_id)).toBe('typed:answered');
    await typedOut(hs, dm, 'neos.neop.done', 'done after the answer');
    expect(woke[0]).toContain('account_code: 1010');
    expect(woke[0]).toContain(`user:${P.admin.id} answered (chat)`);
    expect((await db().query('select outcome, answered_by from ledger.waits where id = $1', [wait])).rows[0]).toEqual({ outcome: 'ANSWERED', answered_by: `user:${P.admin.id}` });
    hs.redeliver(a); // Matrix redelivers: once per event_id, ever
    const late = hs.sayTyped(dm, PRIYA, 'neos.neop.answer', { wait_id: wait, answers: { account_code: '1020' }, ...thread });
    expect(await outcome(late.event_id)).toBe('typed:stale');
    const stale = await typedOut(hs, dm, 'neos.neop.note', 'stale note', (e) => /^stale/.test(e.content.text));
    expect(inThread(stale, t.event_id)).toBe(true);
    expect(stale.content.step_id).toBe(`stale-${wait}`);
    // The answer was written once: one fact per field, one step.
    expect((await db().query("select count(*)::int as n from ledger.facts where subject = 'answer:account_code' and source like $1", [`%question ${wait.slice(0, 8)}%`])).rows[0].n).toBe(1);
  });

  it('propose carries fingerprint + expiry; a bridge’s and a NEOP’s typed approve are refused; a stale fingerprint is refused; the right one → DONE once', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, PRIYA);
    const agentDm = await dmWith(hs, AGENT);
    const mktDm = await dmWith(hs, MKT);
    emailBrain(P);
    const mails = (await readdir(P.mailDir)).length;
    const t = hs.sayTyped(dm, PRIYA, 'neos.neop.task', task('Email the August close pack to cfo@acme.example'));
    const propose = await typedOut(hs, dm, 'neos.neop.propose', 'typed propose');
    const p = (await db().query("select * from ledger.proposals where status = 'PROPOSED' order by created_at desc limit 1")).rows[0];
    expect(propose.content).toMatchObject({ proposal_id: p.id, fingerprint: p.fingerprint, expires: new Date(p.expires_at).toISOString() });
    expect(propose.content.text).toContain(`Fingerprint: ${p.fingerprint}`);
    expect(inThread(propose, t.event_id)).toBe(true);
    const approve = (fingerprint: string, thread = true) => ({ proposal_id: p.id, fingerprint, decision: 'yes', ...(thread ? { 'm.relates_to': { rel_type: 'm.thread', event_id: t.event_id } } : {}) });

    const byAgent = hs.sayTyped(agentDm, AGENT, 'neos.neop.approve', approve(p.fingerprint, false));
    expect(await outcome(byAgent.event_id)).toBe('typed:refused:approve');
    const byNeop = hs.sayTyped(mktDm, MKT, 'neos.neop.approve', approve(p.fingerprint, false));
    expect(await outcome(byNeop.event_id)).toBe('typed:refused:approve');
    const stale = hs.sayTyped(dm, PRIYA, 'neos.neop.approve', approve('0'.repeat(64)));
    expect(await outcome(stale.event_id)).toBe('typed:approve_refused');
    const refusal = await P.waitFor(async () => hs.notices(dm).find((n) => n.content['m.relates_to']?.['m.in_reply_to']?.event_id === stale.event_id), 'refusal');
    expect(refusal.content.body).toMatch(/^That answer was not recorded: what you approved is not what is on the card now/);
    expect((await db().query('select status from ledger.proposals where id = $1', [p.id])).rows[0].status).toBe('PROPOSED');
    const refused = (await db().query("select outcome, detail->>'class' as cls from ledger.inbound_events where event_id = any($1) order by at", [[byAgent.event_id, byNeop.event_id]])).rows;
    expect(refused).toEqual([
      { outcome: 'typed:refused:approve', cls: 'agent' },
      { outcome: 'typed:refused:approve', cls: 'neop' },
    ]);
    // A stale fingerprint is kept in the book as a refused answer (answer_proposal), and changes nothing.
    expect((await db().query("select actor from ledger.proposal_events where proposal_id = $1 and event = 'answer_refused:fingerprint'", [p.id])).rows).toEqual([{ actor: `user:${P.admin.id}` }]);

    const yes = hs.sayTyped(dm, PRIYA, 'neos.neop.approve', approve(p.fingerprint));
    expect(await outcome(yes.event_id)).toBe('typed:answered:yes');
    await P.waitFor(async () => (await db().query('select status from ledger.proposals where id = $1', [p.id])).rows[0].status === 'DONE', 'DONE');
    expect((await db().query('select decided_by from ledger.proposals where id = $1', [p.id])).rows[0].decided_by).toBe(`user:${P.admin.id}`);
    const done = await typedOut(hs, dm, 'neos.neop.done', 'done after the yes');
    expect(done.content.result.summary).toBe('Sent the August close pack to cfo@acme.example.');
    hs.redeliver(yes);
    const again = hs.sayTyped(dm, PRIYA, 'neos.neop.approve', approve(p.fingerprint));
    expect(await outcome(again.event_id)).toBe('typed:approve_refused'); // the book changes nothing: said so
    await pause(300);
    expect((await readdir(P.mailDir)).length).toBe(mails + 1); // carried out exactly once
    expect((await db().query("select count(*)::int as n from ledger.operations where ability_key = 'ledger.close_pack.email' and idempotency_key = $1", [`ledger:proposal:${p.id}`])).rows[0].n).toBe(1);
  });

  it('invalid bodies are dropped and recorded (no job, no reply); a type the class may not send is refused', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, PRIYA);
    const agentDm = await dmWith(hs, AGENT);
    const before = await jobs();
    const bad = [
      hs.sayTyped(dm, PRIYA, 'neos.neop.task', { task_id: 'T-x', company: P.company.id, on_behalf_of: PRIYA }), // no text
      hs.sayTyped(dm, PRIYA, 'neos.neop.answer', { wait_id: 'w1', answers: 'yes' }),
      hs.sayTyped(dm, PRIYA, 'neos.neop.approve', { proposal_id: 'p', fingerprint: 'f', decision: 'maybe' }),
      hs.sayTyped(dm, PRIYA, 'neos.neop.task', 'not even an object'),
    ];
    for (const e of bad) expect(await outcome(e.event_id)).toBe('typed:invalid');
    const why = (await db().query("select detail->>'error' as error from ledger.inbound_events where event_id = $1", [bad[0]!.event_id])).rows[0];
    expect(why.error).toBe('text is required');
    // A person may not post a NEOP's done; the agent may not post an ask.
    const p = hs.sayTyped(dm, PRIYA, 'neos.neop.done', { task_id: 'T', job_id: 'j', result: {}, could_not: [] });
    expect(await outcome(p.event_id)).toBe('typed:refused:done');
    const g = hs.sayTyped(agentDm, AGENT, 'neos.neop.ask', { job_id: 'j', wait_id: 'w', question: { text: 't', why: 'w', fields: [] }, due: '2026-10-01T00:00:00Z' });
    expect(await outcome(g.event_id)).toBe('typed:refused:ask');
    // A person asks only for themselves; a task for another company is dropped (by id or short name).
    const other = hs.sayTyped(dm, PRIYA, 'neos.neop.task', task('P&L please', RAHUL));
    expect(await outcome(other.event_id)).toBe('typed:not_on_behalf');
    const wrong = hs.sayTyped(dm, PRIYA, 'neos.neop.task', { ...task('P&L please'), company: 'globex' });
    expect(await outcome(wrong.event_id)).toBe('typed:wrong_company');
    await pause(300);
    expect(await jobs()).toBe(before);
    expect(hs.notices(dm)).toHaveLength(0);
    expect(hs.notices(agentDm)).toHaveLength(0);
  });

  it('the reasoning agent and another NEOP open jobs for the person they name; a NEOP’s ask/done/note/propose is information only; a thread that is not the task’s is refused', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const agentDm = await dmWith(hs, AGENT);
    const mktDm = await dmWith(hs, MKT);
    pnlBrain(P);
    const byAgent = hs.sayTyped(agentDm, AGENT, 'neos.neop.task', task('P&L for August 2026', RAHUL, 'NC-1'));
    expect(await outcome(byAgent.event_id)).toBe('typed:task_opened');
    expect((await jobOf(byAgent.event_id)).requester).toBe(`user:${P.member.id}`); // the linked person it names
    await typedOut(hs, agentDm, 'neos.neop.done', 'done for the agent', (e) => e.content.task_id === 'NC-1');
    pnlBrain(P);
    const byNeop = hs.sayTyped(mktDm, MKT, 'neos.neop.task', { ...task('Diwali budget check: P&L for August 2026', PRIYA, 'MKT-77'), company: 'acmetraders' });
    expect(await outcome(byNeop.event_id)).toBe('typed:task_opened');
    expect((await jobOf(byNeop.event_id)).requester).toBe(`user:${P.admin.id}`);
    const done = await typedOut(hs, mktDm, 'neos.neop.done', 'done for the NEOP', (e) => e.content.task_id === 'MKT-77');
    expect(done.content['m.relates_to'].event_id).toBe(byNeop.event_id);
    // Its own ask / done / note / propose: recorded as information; no work is taken from them.
    const before = await jobs();
    const info = [
      hs.sayTyped(mktDm, MKT, 'neos.neop.note', { job_id: 'm-77', step_id: '1', text: 'checked the budget sheet' }),
      hs.sayTyped(mktDm, MKT, 'neos.neop.done', { task_id: 'L-1', job_id: 'm-77', result: { ok: true }, could_not: [] }),
      hs.sayTyped(mktDm, MKT, 'neos.neop.propose', { proposal_id: 'mp-1', fingerprint: 'fp', text: 'Marketing asks first — boost the Diwali post', expires: '2026-10-01T00:00:00Z' }),
    ];
    expect(await outcome(info[0]!.event_id)).toBe('typed:info:note');
    expect(await outcome(info[1]!.event_id)).toBe('typed:info:done');
    expect(await outcome(info[2]!.event_id)).toBe('typed:info:propose');
    const byAgentPropose = hs.sayTyped(agentDm, AGENT, 'neos.neop.propose', { proposal_id: 'x', fingerprint: 'fp', text: 'card', expires: '2026-10-01T00:00:00Z' });
    expect(await outcome(byAgentPropose.event_id)).toBe('typed:refused:propose');
    expect(await jobs()).toBe(before);
    // An answer threaded under a task that is not the wait's: dropped. Another sender may not answer it at all.
    const woke: string[] = [];
    askingBrain(P, woke);
    const asked = hs.sayTyped(mktDm, MKT, 'neos.neop.task', task('Record the ₹12,000 deposit', PRIYA, 'MKT-78'));
    const ask = await typedOut(hs, mktDm, 'neos.neop.ask', 'ask to the NEOP');
    expect(inThread(ask, asked.event_id)).toBe(true);
    const wrongThread = hs.sayTyped(mktDm, MKT, 'neos.neop.answer', { wait_id: ask.content.wait_id, answers: { account_code: '1010' }, 'm.relates_to': { rel_type: 'm.thread', event_id: byNeop.event_id } });
    expect(await outcome(wrongThread.event_id)).toBe('typed:thread_mismatch');
    const right = hs.sayTyped(mktDm, MKT, 'neos.neop.answer', { wait_id: ask.content.wait_id, answers: { account_code: '1010' }, 'm.relates_to': { rel_type: 'm.thread', event_id: asked.event_id } });
    expect(await outcome(right.event_id)).toBe('typed:answered');
    await typedOut(hs, mktDm, 'neos.neop.done', 'done after the NEOP answered', (e) => e.content.task_id === 'MKT-78');
    expect((await db().query('select answered_by from ledger.waits where id = $1', [ask.content.wait_id])).rows[0].answered_by).toBe(`app:${MKT}`);
    expect(woke[0]).toContain(`relayed by app:${MKT}`); // another app's words are data
    expect(woke[0]).toMatch(/<data source="answer\.bridge" trust="untrusted">[\s\S]*"account_code": "1010"/);
  });
});

// ── the appservice road (rooms; the backend is the application service) ──────────────────────────────────────────
describe('typed events in the NEOP’s own appservice rooms', () => {
  const ROOM = '!ledger-typed:acme.example';
  const PRIYA = '@priya:acme.example';
  const AGENT = `@neuralchat_acmetraders:${MATRIX.serverName}`;
  const MKT = `@neop_marketing_acmetraders:${MATRIX.serverName}`;
  let P: Pilot;
  const db = () => P.backend.core.runnerPool;
  beforeAll(async () => {
    P = await bootPilot({ presence: 'appservice', neuralchat: false });
    for (const e of [
      { app: 'ledger', matrix_id: AGENT, kind: 'bridge', acts_for: P.admin.id },
      { app: 'ledger', matrix_id: MKT, kind: 'bridge' },
    ]) expect((await P.api('PUT', '/api/chat/allowlist', e)).status).toBe(200);
    // The room's power levels give Priya (a person) the approve level; bots, bridges and NEOPs sit below it.
    P.hs!.setState(ROOM, 'm.room.power_levels', { users: { [PRIYA]: 50 }, users_default: 0, events_default: 0, state_default: 50, events: { 'neos.neop.approve': 50 } });
    expect((await P.api('PUT', '/api/chat/presence', { app: 'ledger', room_ids: [ROOM] })).status).toBe(200);
    expect((await P.api('PUT', `/api/users/${P.admin.id}/chat`, { matrix_user_id: PRIYA })).status).toBe(200);
  });
  afterAll(async () => P?.close());

  const outcome = (eventId: string) => outcomeOf(P, eventId);
  const typedOut = (type: string, what: string, pred: (e: any) => boolean = () => true) => P.waitFor(async () => P.hs!.typed.find((e) => e.room === ROOM && e.type === type && pred(e)), what);
  const task = (text: string, id: string, onBehalf = PRIYA) => ({ task_id: id, company: 'acmetraders', on_behalf_of: onBehalf, text });
  const thread = (root: string) => ({ 'm.relates_to': { rel_type: 'm.thread', event_id: root } });

  it('task from a person → job; the room gets its plain notices AND the typed note/done in the thread, as the app’s own name', async () => {
    pnlBrain(P);
    const t = await P.hs!.pushTyped({ room_id: ROOM, sender: PRIYA, type: 'neos.neop.task', content: task('P&L for August 2026', 'T-1') });
    expect(t.status).toBe(200);
    const done = await typedOut('neos.neop.done', 'typed done', (e) => e.content.task_id === 'T-1');
    expect(done.user).toBe(P.neopUser);
    expect(done.user).toBe(`@neop_ledger_acmetraders:${MATRIX.serverName}`);
    expect(done.content['m.relates_to']).toMatchObject({ rel_type: 'm.thread', event_id: t.event_id });
    expect(done.content.body).toMatch(/^Ledger: Net profit/);
    const notes = P.hs!.typed.filter((e) => e.type === 'neos.neop.note' && e.content['m.relates_to']?.event_id === t.event_id);
    expect(notes[0]!.content.step_id).toBe('ack');
    expect(new Set(notes.map((n) => n.content.step_id)).size).toBe(notes.length);
    await P.waitFor(async () => P.hs!.sent.find((m) => m.room === ROOM && /^Ledger: Net profit/.test(m.body)), 'the plain result too');
    const job = (await db().query('select source, origin, requester from ledger.jobs where origin = $1', [t.event_id])).rows[0];
    expect(job).toEqual({ source: 'room', origin: t.event_id, requester: `user:${P.admin.id}` });
    // Our own typed events come back from the homeserver: never acted on (no record at all).
    await P.hs!.pushTyped({ room_id: ROOM, sender: done.user, type: done.type, content: done.content, event_id: done.event_id });
    await pause(200);
    expect((await db().query('select 1 from ledger.inbound_events where event_id = $1', [done.event_id])).rowCount).toBe(0);
  });

  it('approve: a bridge’s and a NEOP’s are refused, a stranger is unknown, a person below the approve level is refused, a stale fingerprint is refused, the right one → DONE once; redelivery is a duplicate', async () => {
    emailBrain(P);
    const mails = (await readdir(P.mailDir)).length;
    const t = await P.hs!.pushTyped({ room_id: ROOM, sender: PRIYA, type: 'neos.neop.task', content: task('Email the August close pack to cfo@acme.example', 'T-2') });
    const propose = await typedOut('neos.neop.propose', 'typed propose', (e) => e.content['m.relates_to']?.event_id === t.event_id);
    const p = (await db().query('select * from ledger.proposals where id = $1', [propose.content.proposal_id])).rows[0];
    expect(propose.content).toMatchObject({ fingerprint: p.fingerprint, expires: new Date(p.expires_at).toISOString() });
    const approve = (fingerprint: string) => ({ proposal_id: propose.content.proposal_id, fingerprint, decision: 'yes', ...thread(t.event_id) });
    const byAgent = await P.hs!.pushTyped({ room_id: ROOM, sender: AGENT, type: 'neos.neop.approve', content: approve(p.fingerprint) });
    expect(await outcome(byAgent.event_id)).toBe('typed:refused:approve');
    const byNeop = await P.hs!.pushTyped({ room_id: ROOM, sender: MKT, type: 'neos.neop.approve', content: approve(p.fingerprint) });
    expect(await outcome(byNeop.event_id)).toBe('typed:refused:approve');
    const stranger = await P.hs!.pushTyped({ room_id: ROOM, sender: '@mallory:evil.example', type: 'neos.neop.approve', content: approve(p.fingerprint) });
    expect(await outcome(stranger.event_id)).toBe('typed:unknown_sender');
    // A linked person without the approve level in this room is refused by the fail-safe too.
    expect((await P.api('PUT', `/api/users/${P.member.id}/chat`, { matrix_user_id: '@rahul:acme.example' })).status).toBe(200);
    const low = await P.hs!.pushTyped({ room_id: ROOM, sender: '@rahul:acme.example', type: 'neos.neop.approve', content: approve(p.fingerprint) });
    expect(await outcome(low.event_id)).toBe('typed:below_approve_level');
    const stale = await P.hs!.pushTyped({ room_id: ROOM, sender: PRIYA, type: 'neos.neop.approve', content: approve('f'.repeat(64)) });
    expect(await outcome(stale.event_id)).toBe('typed:approve_refused');
    await P.waitFor(async () => P.hs!.sent.find((m) => m.room === ROOM && /That answer was not recorded: what you approved is not what is on the card now/.test(m.body)), 'refusal notice');
    expect((await db().query('select status from ledger.proposals where id = $1', [p.id])).rows[0].status).toBe('PROPOSED');
    const yes = await P.hs!.pushTyped({ room_id: ROOM, sender: PRIYA, type: 'neos.neop.approve', content: approve(p.fingerprint) });
    expect(await outcome(yes.event_id)).toBe('typed:answered:yes');
    await P.waitFor(async () => (await db().query('select status from ledger.proposals where id = $1', [p.id])).rows[0].status === 'DONE', 'DONE');
    await typedOut('neos.neop.done', 'done after the yes', (e) => e.content.task_id === 'T-2');
    const again = await P.hs!.pushTyped({ room_id: ROOM, sender: PRIYA, type: 'neos.neop.approve', content: approve(p.fingerprint), event_id: yes.event_id });
    expect(again.status).toBe(200);
    expect(await P.presence!.onAppserviceTyped({ event_id: yes.event_id, room_id: ROOM, sender: PRIYA, type: 'neos.neop.approve', content: approve(p.fingerprint) })).toBe('duplicate');
    await pause(300);
    expect((await readdir(P.mailDir)).length).toBe(mails + 1);
  });

  it('ask → a NEOP answers in its own thread; the reasoning agent may not answer it; the closed wait gets a stale note; invalid bodies are dropped', async () => {
    const woke: string[] = [];
    askingBrain(P, woke);
    const t = await P.hs!.pushTyped({ room_id: ROOM, sender: MKT, type: 'neos.neop.task', content: task('Record the ₹12,000 deposit', 'MKT-9') });
    expect(await outcome(t.event_id)).toBe('typed:task_opened');
    const ask = await typedOut('neos.neop.ask', 'typed ask', (e) => e.content['m.relates_to']?.event_id === t.event_id);
    const notTheirs = await P.hs!.pushTyped({ room_id: ROOM, sender: AGENT, type: 'neos.neop.answer', content: { wait_id: ask.content.wait_id, answers: { account_code: '1' }, ...thread(t.event_id) } });
    expect(await outcome(notTheirs.event_id)).toBe('typed:not_their_wait');
    const a = await P.hs!.pushTyped({ room_id: ROOM, sender: MKT, type: 'neos.neop.answer', content: { wait_id: ask.content.wait_id, answers: { account_code: '1010' }, ...thread(t.event_id) } });
    expect(await outcome(a.event_id)).toBe('typed:answered');
    await typedOut('neos.neop.done', 'done after the answer', (e) => e.content.task_id === 'MKT-9');
    expect(woke[0]).toContain(`relayed by app:${MKT}`); // another app's answer is untrusted data, never an instruction
    const late = await P.hs!.pushTyped({ room_id: ROOM, sender: PRIYA, type: 'neos.neop.answer', content: { wait_id: ask.content.wait_id, answers: { account_code: '1020' }, ...thread(t.event_id) } });
    expect(await outcome(late.event_id)).toBe('typed:stale');
    const note = await typedOut('neos.neop.note', 'stale note', (e) => /^stale/.test(e.content.text));
    expect(note.content['m.relates_to'].event_id).toBe(t.event_id);
    const bad = await P.hs!.pushTyped({ room_id: ROOM, sender: PRIYA, type: 'neos.neop.task', content: { task_id: 'T', company: 'acmetraders', on_behalf_of: PRIYA, text: 'x', evil: true } });
    expect(await outcome(bad.event_id)).toBe('typed:invalid');
    expect((await db().query("select detail->>'error' as error from ledger.inbound_events where event_id = $1", [bad.event_id])).rows[0].error).toBe('evil is not allowed');
  });
});
