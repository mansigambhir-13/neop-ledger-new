// matrix-typed.test · v3 §8 TYPED MATRIX EVENTS on both roads, end to end (real platform + gateway + L3 + runner +
// scripted agent): neos.neop.task | ask | answer | propose | approve | done | note. An ADDITIONAL, stricter road next
// to the plain-text one (which the other matrix tests keep proving unchanged):
//   in   by sender CLASS — people: task/answer/approve · the reasoning agent (a bridge): task/answer, NEVER approve ·
//        other NEOPs (@neop_…): task/ask/answer/propose/done/note, NEVER approve. Bodies validated (invalid → dropped,
//        audited), deduped on event_id, thread-correlated; a closed wait → a `stale` note back.
//   out  in the thread rooted at the typed task: note ("on it", then each step once), ask, propose (fingerprint,
//        expires), done (their task_id) — each with today's m.notice text as `body`.
import { readdir } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ChatClient } from '@neop/platform';
import { TYPED_EVENT_TYPES, maySend, threadRootOf, validateTypedBody, type TypedEventType } from '@neop/contracts';
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

describe('the typed-event contract (v3 §8)', () => {
  it('seven types; who may send what; bodies validated exactly as the table', () => {
    expect(TYPED_EVENT_TYPES).toEqual(['neos.neop.task', 'neos.neop.ask', 'neos.neop.answer', 'neos.neop.propose', 'neos.neop.approve', 'neos.neop.done', 'neos.neop.note']);
    const may = (c: 'person' | 'agent' | 'neop') => TYPED_EVENT_TYPES.filter((t) => maySend(c, t)).map((t) => t.slice(10));
    expect(may('person')).toEqual(['task', 'answer', 'approve']);
    expect(may('agent')).toEqual(['task', 'answer']);
    expect(may('neop')).toEqual(['task', 'ask', 'answer', 'propose', 'done', 'note']); // never approve
    const ok: Record<TypedEventType, unknown> = {
      'neos.neop.task': { task_id: 'T-1', company: 'acme', on_behalf_of: '@priya:hs', text: 'P&L', fields: { period: '2026-08' } },
      'neos.neop.ask': { job_id: 'j', wait_id: 'w12', question: { text: 'which?', why: 'two', fields: [{ key: 'cc', label: 'Cost centre' }] }, due: '2026-10-01T00:00:00Z' },
      'neos.neop.answer': { wait_id: 'w12', answers: { cc: 'digital' } },
      'neos.neop.propose': { proposal_id: 'p', fingerprint: 'f', text: 'card', expires: '2026-10-01T00:00:00.000Z' },
      'neos.neop.approve': { proposal_id: 'p', fingerprint: 'f', decision: 'yes' },
      'neos.neop.done': { task_id: 'T-1', job_id: 'j', result: { remaining: 1240000 }, could_not: [] },
      'neos.neop.note': { job_id: 'j', step_id: '3', text: 'read the ledger' },
    };
    for (const t of TYPED_EVENT_TYPES) {
      // The m.notice fallback and the thread ride along; they are not part of the typed body.
      const v = validateTypedBody(t, { ...(ok[t] as object), msgtype: 'm.notice', body: 'fallback', 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } });
      expect(v.ok, `${t}: ${JSON.stringify(v)}`).toBe(true);
      expect(validateTypedBody(t, { ...(ok[t] as object), extra: 1 }).ok).toBe(false);
    }
    expect(validateTypedBody('neos.neop.approve', { proposal_id: 'p', fingerprint: 'f', decision: 'maybe' })).toEqual({ ok: false, error: 'decision must be one of yes, no, change, withdraw' });
    expect(validateTypedBody('neos.neop.task', { task_id: 'T', company: 'c', on_behalf_of: 'priya', text: 'x' }).ok).toBe(false);
    expect(validateTypedBody('neos.neop.answer', { wait_id: 'w', answers: [] }).ok).toBe(false);
    expect(threadRootOf({ 'm.relates_to': { rel_type: 'm.thread', event_id: '$r' } })).toBe('$r');
    expect(threadRootOf({ 'm.relates_to': { 'm.in_reply_to': { event_id: '$r' } } })).toBeNull();
  });
});

// ── the client road (ordinary @ledger account, DMs, allowlist) ─────────────────────────────────────────────────
describe('typed events on the Matrix client road (DMs)', () => {
  const ME = '@ledger:hs.test';
  const AGENT = '@neuralchat_acme:hs.test'; // the reasoning agent: a bridge relaying for Priya
  const MKT = '@neop_marketing_acmetraders:hs.test'; // another NEOP
  const PRIYA = '@priya:hs.test';
  const RAHUL = '@rahul:hs.test';
  let P: Pilot;
  const running: ChatClient[] = [];
  beforeAll(async () => {
    P = await bootPilot();
    expect((await P.api('PUT', `/api/users/${P.admin.id}/chat`, { matrix_user_id: PRIYA })).status).toBe(200);
    expect((await P.api('PUT', `/api/users/${P.member.id}/chat`, { matrix_user_id: RAHUL })).status).toBe(200);
    for (const e of [
      { app: 'ledger', matrix_id: PRIYA, kind: 'person' },
      { app: 'ledger', matrix_id: AGENT, kind: 'bridge', acts_for: P.admin.id },
      { app: 'ledger', matrix_id: MKT, kind: 'bridge' },
    ]) expect((await P.api('PUT', '/api/chat/allowlist', e)).status).toBe(200);
  });
  afterEach(async () => {
    while (running.length) await running.pop()!.stop();
  });
  afterAll(async () => P?.close());

  async function client(hs: FakeClientHomeserver) {
    await P.platform.db.query('update neos.chat_accounts set next_batch = null where account = $1', [ME]);
    await P.platform.db.query("update neos.chat_client_events set reply_status = 'sent' where account = $1 and reply_status in ('waiting', 'sending')", [ME]);
    const c = new ChatClient(P.platform, { account: ME, company: P.company.id, app: 'ledger', accessToken: hs.token }, { homeserverUrl: 'http://hs.test', fetchImpl: hs.fetchImpl, syncTimeoutMs: 100, replyEveryMs: 50 });
    await c.start();
    running.push(c);
  }
  async function dmWith(hs: FakeClientHomeserver, from: string) {
    const dm = hs.invite(from);
    await P.waitFor(async () => hs.rooms.get(dm)!.members.has(ME) && (await P.platform.db.query('select 1 from neos.chat_dms where account = $1 and peer = $2 and room_id = $3', [ME, from, dm])).rowCount, `${from}'s DM`);
    return dm;
  }
  const outcome = (eventId: string) =>
    P.waitFor(async () => {
      const o = (await P.platform.db.query<{ outcome: string }>('select outcome from neos.chat_client_events where event_id = $1', [eventId])).rows[0]?.outcome;
      return o && o !== 'typed:received' ? o : null;
    }, `outcome of ${eventId}`);
  const typedOut = (hs: FakeClientHomeserver, room: string, type: string, what: string, pred: (e: any) => boolean = () => true) => P.waitFor(async () => hs.typed(room, type).find(pred), what);
  const task = (text: string, onBehalf = PRIYA, id = `T-${Math.random().toString(36).slice(2, 8)}`) => ({ task_id: id, company: P.company.id, on_behalf_of: onBehalf, text });
  const inThread = (e: any, root: string) => e.content['m.relates_to']?.rel_type === 'm.thread' && e.content['m.relates_to']?.event_id === root;

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
    const row = (await P.platform.db.query("select * from neos.tasks where requester = $1 order by created_at desc limit 1", [`user:${P.admin.id}`])).rows[0];
    expect(row).toMatchObject({ status: 'COMPLETED', ask: 'What was our net profit in August 2026?' });
    expect(done.content.job_id).toBe(row.job_id);
    const notes = hs.typed(dm, 'neos.neop.note');
    expect(notes[0]!.content).toMatchObject({ job_id: row.job_id, step_id: 'ack', text: 'on it' });
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
    await pause(300);
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
    const q = (await P.platform.db.query('select status, answered_via from neos.questions where wait_id = $1', [wait])).rows[0];
    expect(q).toEqual({ status: 'ANSWERED', answered_via: 'chat' });
    hs.redeliver(a); // Matrix redelivers: once per event_id, ever
    const late = hs.sayTyped(dm, PRIYA, 'neos.neop.answer', { wait_id: wait, answers: { account_code: '1020' }, ...thread });
    expect(await outcome(late.event_id)).toBe('typed:stale');
    const stale = await typedOut(hs, dm, 'neos.neop.note', 'stale note', (e) => /^stale/.test(e.content.text));
    expect(inThread(stale, t.event_id)).toBe(true);
    expect(stale.content.step_id).toBe(`stale-${wait}`);
    const audits = await P.platform.db.query("select outcome from neos.audit where action = 'question.answered' and detail->>'wait_id' = $1", [wait]);
    expect(audits.rowCount).toBe(1);
  });

  it('propose carries fingerprint + expiry; a bridge’s and a NEOP’s typed approve are refused; a stale fingerprint is refused; the right one → EXECUTED once', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, PRIYA);
    const agentDm = await dmWith(hs, AGENT);
    const mktDm = await dmWith(hs, MKT);
    emailBrain(P);
    const mails = (await readdir(P.mailDir)).length;
    const t = hs.sayTyped(dm, PRIYA, 'neos.neop.task', task('Email the August close pack to cfo@acme.example'));
    const propose = await typedOut(hs, dm, 'neos.neop.propose', 'typed propose');
    const a = (await P.platform.db.query("select * from neos.v_desk_cards where status = 'PENDING' order by created_at desc limit 1")).rows[0];
    expect(propose.content).toMatchObject({ proposal_id: String(a.proposal_id), fingerprint: a.fingerprint, expires: new Date(a.expires_at).toISOString() });
    expect(propose.content.text).toContain(`Fingerprint: ${a.fingerprint}`);
    expect(inThread(propose, t.event_id)).toBe(true);
    const approve = (fingerprint: string, thread = true) => ({ proposal_id: String(a.proposal_id), fingerprint, decision: 'yes', ...(thread ? { 'm.relates_to': { rel_type: 'm.thread', event_id: t.event_id } } : {}) });

    const byAgent = hs.sayTyped(agentDm, AGENT, 'neos.neop.approve', approve(a.fingerprint, false));
    expect(await outcome(byAgent.event_id)).toBe('typed:refused:approve');
    const byNeop = hs.sayTyped(mktDm, MKT, 'neos.neop.approve', approve(a.fingerprint, false));
    expect(await outcome(byNeop.event_id)).toBe('typed:refused:approve');
    const stale = hs.sayTyped(dm, PRIYA, 'neos.neop.approve', approve('0'.repeat(64)));
    expect(await outcome(stale.event_id)).toBe('typed:approve_refused');
    const refusal = await P.waitFor(async () => hs.notices(dm).find((n) => n.content['m.relates_to']?.['m.in_reply_to']?.event_id === stale.event_id), 'refusal');
    expect(refusal.content.body).toMatch(/^That answer was not recorded: what you approved is not what is on the card now/);
    expect((await P.platform.db.query('select status from neos.v_desk_cards where id = $1', [a.id])).rows[0].status).toBe('PENDING');
    const refused = (await P.platform.db.query("select outcome, detail->>'class' as cls from neos.audit where action = 'chat.typed_in' and detail->>'event_id' = any($1) order by id", [[byAgent.event_id, byNeop.event_id]])).rows;
    expect(refused).toEqual([
      { outcome: 'refused:approve', cls: 'agent' },
      { outcome: 'refused:approve', cls: 'neop' },
    ]);

    const yes = hs.sayTyped(dm, PRIYA, 'neos.neop.approve', approve(a.fingerprint));
    expect(await outcome(yes.event_id)).toBe('typed:answered:yes');
    await P.waitFor(async () => (await P.platform.db.query('select status from neos.v_desk_cards where id = $1', [a.id])).rows[0].status === 'EXECUTED', 'EXECUTED');
    expect((await P.platform.db.query('select decided_by, fingerprint_seen from neos.v_desk_cards where id = $1', [a.id])).rows[0]).toEqual({ decided_by: P.admin.id, fingerprint_seen: a.fingerprint });
    const done = await typedOut(hs, dm, 'neos.neop.done', 'done after the yes');
    expect(done.content.result.summary).toBe('Sent the August close pack to cfo@acme.example.');
    hs.redeliver(yes);
    const again = hs.sayTyped(dm, PRIYA, 'neos.neop.approve', approve(a.fingerprint));
    expect(await outcome(again.event_id)).toBe('typed:approve_refused');
    await pause(300);
    expect((await readdir(P.mailDir)).length).toBe(mails + 1); // carried out exactly once
  });

  it('invalid bodies are dropped and audited (no task, no reply); a type the class may not send is refused', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const dm = await dmWith(hs, PRIYA);
    const agentDm = await dmWith(hs, AGENT);
    const before = (await P.platform.db.query('select count(*)::int as n from neos.tasks')).rows[0].n;
    const bad = [
      hs.sayTyped(dm, PRIYA, 'neos.neop.task', { task_id: 'T-x', company: P.company.id, on_behalf_of: PRIYA }), // no text
      hs.sayTyped(dm, PRIYA, 'neos.neop.answer', { wait_id: 'w1', answers: 'yes' }),
      hs.sayTyped(dm, PRIYA, 'neos.neop.approve', { proposal_id: 'p', fingerprint: 'f', decision: 'maybe' }),
      hs.sayTyped(dm, PRIYA, 'neos.neop.task', 'not even an object'),
    ];
    for (const e of bad) expect(await outcome(e.event_id)).toBe('typed:invalid');
    const why = (await P.platform.db.query("select detail->>'error' as error from neos.audit where action = 'chat.typed_in' and outcome = 'invalid' and detail->>'event_id' = $1", [bad[0]!.event_id])).rows[0];
    expect(why.error).toBe('text is required');
    // A person may not post a NEOP's done; the agent may not post an ask.
    const p = hs.sayTyped(dm, PRIYA, 'neos.neop.done', { task_id: 'T', job_id: 'j', result: {}, could_not: [] });
    expect(await outcome(p.event_id)).toBe('typed:refused:done');
    const g = hs.sayTyped(agentDm, AGENT, 'neos.neop.ask', { job_id: 'j', wait_id: 'w', question: { text: 't', why: 'w', fields: [] }, due: '2026-10-01T00:00:00Z' });
    expect(await outcome(g.event_id)).toBe('typed:refused:ask');
    // A person asks only for themselves; a task for another company is dropped.
    const other = hs.sayTyped(dm, PRIYA, 'neos.neop.task', task('P&L please', RAHUL));
    expect(await outcome(other.event_id)).toBe('typed:not_on_behalf');
    const wrong = hs.sayTyped(dm, PRIYA, 'neos.neop.task', { ...task('P&L please'), company: 'globex' });
    expect(await outcome(wrong.event_id)).toBe('typed:wrong_company');
    await pause(300);
    expect((await P.platform.db.query('select count(*)::int as n from neos.tasks')).rows[0].n).toBe(before);
    expect(hs.notices(dm)).toHaveLength(0);
    expect(hs.notices(agentDm)).toHaveLength(0);
  });

  it('the reasoning agent and another NEOP open tasks for the person they name; a NEOP’s ask/done/note is information only; a thread that is not the task’s is refused', async () => {
    const hs = fakeClientHomeserver({ me: ME });
    await client(hs);
    const agentDm = await dmWith(hs, AGENT);
    const mktDm = await dmWith(hs, MKT);
    pnlBrain(P);
    const byAgent = hs.sayTyped(agentDm, AGENT, 'neos.neop.task', task('P&L for August 2026', RAHUL, 'NC-1'));
    expect(await outcome(byAgent.event_id)).toBe('typed:task_opened');
    const t1 = (await P.platform.db.query('select t.* from neos.tasks t join neos.chat_client_events e on e.task_id = t.id where e.event_id = $1', [byAgent.event_id])).rows[0];
    expect(t1.requester).toBe(`user:${P.member.id}`); // the linked person it names
    await typedOut(hs, agentDm, 'neos.neop.done', 'done for the agent', (e) => e.content.task_id === 'NC-1');
    pnlBrain(P);
    const byNeop = hs.sayTyped(mktDm, MKT, 'neos.neop.task', task('Diwali budget check: P&L for August 2026', PRIYA, 'MKT-77'));
    expect(await outcome(byNeop.event_id)).toBe('typed:task_opened');
    const t2 = (await P.platform.db.query('select t.* from neos.tasks t join neos.chat_client_events e on e.task_id = t.id where e.event_id = $1', [byNeop.event_id])).rows[0];
    expect(t2.requester).toBe(`user:${P.admin.id}`);
    const done = await typedOut(hs, mktDm, 'neos.neop.done', 'done for the NEOP', (e) => e.content.task_id === 'MKT-77');
    expect(done.content['m.relates_to'].event_id).toBe(byNeop.event_id);
    // Its own ask / done / note: recorded as information; no work is taken from them.
    const before = (await P.platform.db.query('select count(*)::int as n from neos.tasks')).rows[0].n;
    const info = [
      hs.sayTyped(mktDm, MKT, 'neos.neop.note', { job_id: 'm-77', step_id: '1', text: 'checked the budget sheet' }),
      hs.sayTyped(mktDm, MKT, 'neos.neop.done', { task_id: 'L-1', job_id: 'm-77', result: { ok: true }, could_not: [] }),
      // A NEOP may post its own card (v3 §8); it is information here — only a person's approve answers a card.
      hs.sayTyped(mktDm, MKT, 'neos.neop.propose', { proposal_id: 'mp-1', fingerprint: 'fp', text: 'Marketing asks first — boost the Diwali post', expires: '2026-10-01T00:00:00Z' }),
    ];
    expect(await outcome(info[0]!.event_id)).toBe('typed:info:note');
    expect(await outcome(info[1]!.event_id)).toBe('typed:info:done');
    expect(await outcome(info[2]!.event_id)).toBe('typed:info:propose');
    // A person or the reasoning agent may not post a propose.
    const agentDm2 = await dmWith(hs, AGENT);
    const byAgentPropose = hs.sayTyped(agentDm2, AGENT, 'neos.neop.propose', { proposal_id: 'x', fingerprint: 'fp', text: 'card', expires: '2026-10-01T00:00:00Z' });
    expect(await outcome(byAgentPropose.event_id)).toBe('typed:refused:propose');
    expect((await P.platform.db.query('select count(*)::int as n from neos.tasks')).rows[0].n).toBe(before);
    // An answer threaded under a task that is not the wait's: dropped.
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
    expect((await P.platform.db.query('select answered_by, answered_via from neos.questions where wait_id = $1', [ask.content.wait_id])).rows[0]).toEqual({ answered_by: `app:${MKT}`, answered_via: 'bridge' });
    expect(woke[0]).toContain(`relayed by app:${MKT}`); // another app's words are data
    expect(woke[0]).toMatch(/<data source="answer\.bridge" trust="untrusted">[\s\S]*"account_code": "1010"/);
  });
});

// ── the appservice road (rooms) ────────────────────────────────────────────────────────────────────────────────
describe('typed events in appservice rooms', () => {
  const ROOM = '!ledger-typed:acme.example';
  const PRIYA = '@priya:acme.example';
  const AGENT = `@neuralchat_acmetraders:${MATRIX.serverName}`;
  const MKT = `@neop_marketing_acmetraders:${MATRIX.serverName}`;
  let P: Pilot;
  beforeAll(async () => {
    P = await bootPilot({ chat: true });
    for (const e of [
      { app: 'ledger', matrix_id: AGENT, kind: 'bridge', acts_for: P.admin.id },
      { app: 'ledger', matrix_id: MKT, kind: 'bridge' },
    ]) expect((await P.api('PUT', '/api/chat/allowlist', e)).status).toBe(200);
    // The room's power levels give Priya (a person) the approve level; bots, bridges and NEOPs sit below it.
    P.hs!.setState(ROOM, 'm.room.power_levels', { users: { [PRIYA]: 50 }, users_default: 0, events_default: 0, state_default: 50, events: { 'neos.neop.approve': 50 } });
    await P.bridge!.createAppRoom(P.company.id, 'ledger', ROOM);
    await P.bridge!.linkUser(P.admin.id, PRIYA);
  });
  afterAll(async () => P?.close());

  const outcome = (eventId: string) =>
    P.waitFor(async () => {
      const o = (await P.platform.db.query<{ outcome: string }>('select outcome from neos.room_events where event_id = $1', [eventId])).rows[0]?.outcome;
      return o && o !== 'typed:received' ? o : null;
    }, `outcome of ${eventId}`);
  const typedOut = (type: string, what: string, pred: (e: any) => boolean = () => true) => P.waitFor(async () => P.hs!.typed.find((e) => e.room === ROOM && e.type === type && pred(e)), what);
  const task = (text: string, id: string, onBehalf = PRIYA) => ({ task_id: id, company: 'acmetraders', on_behalf_of: onBehalf, text });
  const thread = (root: string) => ({ 'm.relates_to': { rel_type: 'm.thread', event_id: root } });

  it('task from a person → job; the room gets its plain notices AND the typed note/done in the thread, as the app’s identity', async () => {
    pnlBrain(P);
    const t = await P.hs!.pushTyped({ room_id: ROOM, sender: PRIYA, type: 'neos.neop.task', content: task('P&L for August 2026', 'T-1') });
    expect(t.status).toBe(200);
    const done = await typedOut('neos.neop.done', 'typed done', (e) => e.content.task_id === 'T-1');
    expect(done.user).toBe(`@neop_ledger_acmetraders:${MATRIX.serverName}`);
    expect(done.content['m.relates_to']).toMatchObject({ rel_type: 'm.thread', event_id: t.event_id });
    expect(done.content.body).toMatch(/^Ledger: Net profit/);
    const notes = P.hs!.typed.filter((e) => e.type === 'neos.neop.note' && e.content['m.relates_to']?.event_id === t.event_id);
    expect(notes[0]!.content.step_id).toBe('ack');
    expect(new Set(notes.map((n) => n.content.step_id)).size).toBe(notes.length);
    await P.waitFor(async () => P.hs!.sent.find((m) => m.room === ROOM && /^Ledger: Net profit/.test(m.body)), 'the plain result too');
    const row = (await P.platform.db.query('select t.origin, t.requester from neos.tasks t join neos.room_events e on e.task_id = t.id where e.event_id = $1', [t.event_id])).rows[0];
    expect(row).toEqual({ origin: 'room', requester: `user:${P.admin.id}` });
    // Our own typed events come back from the homeserver: never acted on.
    expect(await P.bridge!.onTyped({ event_id: done.event_id, room_id: ROOM, sender: done.user, type: done.type, content: done.content })).toBe('ignored_bot');
  });

  it('approve: a bridge’s and a NEOP’s are refused, a stale fingerprint is refused, a person’s right one → EXECUTED once; redelivery is a duplicate', async () => {
    emailBrain(P);
    const mails = (await readdir(P.mailDir)).length;
    const t = await P.hs!.pushTyped({ room_id: ROOM, sender: PRIYA, type: 'neos.neop.task', content: task('Email the August close pack to cfo@acme.example', 'T-2') });
    const propose = await typedOut('neos.neop.propose', 'typed propose', (e) => e.content['m.relates_to']?.event_id === t.event_id);
    const a = (await P.platform.db.query('select * from neos.v_desk_cards where proposal_id::text = $1', [propose.content.proposal_id])).rows[0];
    expect(propose.content).toMatchObject({ fingerprint: a.fingerprint, expires: new Date(a.expires_at).toISOString() });
    const approve = (fingerprint: string) => ({ proposal_id: propose.content.proposal_id, fingerprint, decision: 'yes', ...thread(t.event_id) });
    const byAgent = await P.hs!.pushTyped({ room_id: ROOM, sender: AGENT, type: 'neos.neop.approve', content: approve(a.fingerprint) });
    expect(await outcome(byAgent.event_id)).toBe('typed:refused:approve');
    const byNeop = await P.hs!.pushTyped({ room_id: ROOM, sender: MKT, type: 'neos.neop.approve', content: approve(a.fingerprint) });
    expect(await outcome(byNeop.event_id)).toBe('typed:refused:approve');
    const stranger = await P.hs!.pushTyped({ room_id: ROOM, sender: '@mallory:evil.example', type: 'neos.neop.approve', content: approve(a.fingerprint) });
    expect(await outcome(stranger.event_id)).toBe('typed:unknown_sender');
    // A linked person without the approve level in this room is refused by the fail-safe too.
    await P.platform.db.query('update neos.users set matrix_user_id = $2 where id = $1', [P.member.id, '@rahul:acme.example']);
    const low = await P.hs!.pushTyped({ room_id: ROOM, sender: '@rahul:acme.example', type: 'neos.neop.approve', content: approve(a.fingerprint) });
    expect(await outcome(low.event_id)).toBe('typed:below_approve_level');
    const stale = await P.hs!.pushTyped({ room_id: ROOM, sender: PRIYA, type: 'neos.neop.approve', content: approve('f'.repeat(64)) });
    expect(await outcome(stale.event_id)).toBe('typed:approve_refused');
    await P.waitFor(async () => P.hs!.sent.find((m) => m.room === ROOM && /That answer was not recorded: what you approved is not what is on the card now/.test(m.body)), 'refusal notice');
    expect((await P.platform.db.query('select status from neos.v_desk_cards where id = $1', [a.id])).rows[0].status).toBe('PENDING');
    const yes = await P.hs!.pushTyped({ room_id: ROOM, sender: PRIYA, type: 'neos.neop.approve', content: approve(a.fingerprint) });
    expect(await outcome(yes.event_id)).toBe('typed:answered:yes');
    await P.waitFor(async () => (await P.platform.db.query('select status from neos.v_desk_cards where id = $1', [a.id])).rows[0].status === 'EXECUTED', 'EXECUTED');
    await typedOut('neos.neop.done', 'done after the yes', (e) => e.content.task_id === 'T-2');
    const again = await P.hs!.pushTyped({ room_id: ROOM, sender: PRIYA, type: 'neos.neop.approve', content: approve(a.fingerprint), event_id: yes.event_id });
    expect(again.status).toBe(200);
    expect(await P.bridge!.onTyped({ event_id: yes.event_id, room_id: ROOM, sender: PRIYA, type: 'neos.neop.approve', content: approve(a.fingerprint) })).toBe('duplicate');
    await pause(300);
    expect((await readdir(P.mailDir)).length).toBe(mails + 1);
  });

  it('ask → a NEOP answers in its own thread; the closed wait gets a stale note; invalid bodies are dropped', async () => {
    const woke: string[] = [];
    askingBrain(P, woke);
    const t = await P.hs!.pushTyped({ room_id: ROOM, sender: MKT, type: 'neos.neop.task', content: task('Record the ₹12,000 deposit', 'MKT-9') });
    expect(await outcome(t.event_id)).toBe('typed:task_opened');
    const ask = await typedOut('neos.neop.ask', 'typed ask', (e) => e.content['m.relates_to']?.event_id === t.event_id);
    // The reasoning agent did not open this task: it may not answer its question.
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
    const audit = (await P.platform.db.query("select detail->>'error' as error from neos.audit where action = 'chat.typed_in' and detail->>'event_id' = $1", [bad.event_id])).rows[0];
    expect(audit.error).toBe('evil is not allowed');
  });
});
