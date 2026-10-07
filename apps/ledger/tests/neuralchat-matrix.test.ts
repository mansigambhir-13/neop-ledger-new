// neuralchat-matrix.test · v3 S5 "NeuralChat speaks Matrix" (WP v3 §1 steps 3–8, §7, §8), on both roads (the app's
// NEOP presence and NeuralChat on the same one: appservice — @neuralchat_<co> and @neop_ledger_<co> in the app's room,
// the fake homeserver routing every event between the two registrations; client — @neuralchat_<co>:hs.test and
// @ledger:hs.test, two accounts on one shared homeserver, NeuralChat's 1:1 room with the app):
//   · an ask in Conversations → ONE typed neos.neop.task in the app's room/DM, posted by NeuralChat as itself, the thread
//     rooted there; no tasks.open through the gateway; the job opened once (Matrix redelivery, a resend with the same
//     txnId, a second event for the same task — all the same job)
//   · note / ask / propose / done from the app's thread land in the conversation and in neos.tasks (NeuralChat's store)
//   · an ask answered by the person in Conversations → a typed answer in the thread → the wait through answer_wait()
//   · a proposal is approved ONLY on the desk (DeskHarness → answer_proposal); NeuralChat never posts approve
//   · files by reference (sha256 + a signed platform link; no bytes in any event); the platform keeps no bytes after
//   · one trace from the ask into the app's job
import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, call, DeskHarness, finish, MATRIX, type BrainView, type Pilot } from './harness.ts';

const ASK = { text: 'Which bank account did the ₹12,000 deposit go into?', why: 'Two accounts show a deposit that day.', fields: [{ key: 'account_code', label: 'Bank account code' }] };
const csv = 'Date,Vendor,Amount\n2026-09-12,CloudSoft India,14160.00\n2026-09-15,"Kapoor, Traders",5900.00\n';

describe.each(['appservice', 'client'] as const)('NeuralChat speaks Matrix — %s road', (mode) => {
  let P: Pilot;
  let desk: DeskHarness;
  const db = () => P.backend.core.runnerPool;
  beforeAll(async () => {
    P = await bootPilot({ presence: mode, neuralchat: true });
    desk = await DeskHarness.connect(P.adminUrl);
  }, 180_000);
  afterAll(async () => {
    await desk?.close();
    await P?.close();
  }, 120_000);

  /** Every typed event posted on the road: [{event_id, room, sender, type, content}]. */
  const typed = () =>
    mode === 'appservice'
      ? P.hs!.typed.map((e) => ({ event_id: e.event_id, room: e.room, sender: e.user, type: e.type, content: e.content }))
      : P.mx!.typed().map((e) => ({ event_id: e.event_id, room: e.room_id, sender: e.sender, type: e.type, content: e.content }));
  const taskEvent = (taskId: string) => P.waitFor(async () => typed().find((e) => e.type === 'neos.neop.task' && e.content.task_id === taskId), `typed task ${taskId}`).catch(async (e) => { throw new Error(`${e.message}: ${JSON.stringify(await task(taskId))}`); });
  const inThread = (e: { content: any }, root: string) => e.content['m.relates_to']?.rel_type === 'm.thread' && e.content['m.relates_to']?.event_id === root;
  const task = async (id: string) => (await P.platform.db.query('select * from neos.tasks where id = $1', [id])).rows[0];
  const conv = async (id: string) => (await P.api('GET', `/api/conversations/${id}`)).body.messages as { kind: string; body: string; author: string }[];
  const jobsOf = async (taskId: string) => (await db().query('select * from ledger.jobs where task_id = $1', [taskId])).rows;
  /** Post as NeuralChat directly on the road (what a resend or a second event would be). */
  async function sendAsNeuralChat(room: string, type: string, content: unknown, txn: string): Promise<string> {
    if (mode === 'appservice') {
      const res = await fetch(`${P.hs!.url}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/${type}/${txn}?user_id=${encodeURIComponent(P.neuralchatUser!)}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${MATRIX.asToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(content),
      });
      return (await res.json()).event_id;
    }
    const res = await P.mx!.fetchImpl(`http://hs.test/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/${type}/${txn}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${P.mx!.account(P.neuralchatUser!)}` },
      body: JSON.stringify(content),
    });
    return (await res.json()).event_id;
  }
  const redeliver = async (eventId: string) => (mode === 'appservice' ? P.hs!.redeliver(eventId) : P.mx!.redeliver(eventId));

  it('an ask in Conversations → one typed task posted by NeuralChat as itself in the app’s room; the job is opened once; note and done land in the conversation and neos.tasks', async () => {
    P.setBrain((v) => (v.calls === 0 ? call('ledger.report.pnl', { from: '2026-08-01', to: '2026-08-31' }) : finish('Net profit for August 2026 came from 8 entries.', 'done', { sources: ['ledger.report.pnl'] })));
    expect((await P.platform.db.query("select to_regclass('neos.gateway_ledger') as r")).rows[0].r).toBeNull();
    const r = await P.api('POST', '/api/ask', { text: 'What was our net profit in August 2026?', app: 'ledger' });
    expect(r.status).toBe(200);
    expect(r.body.handed_to).toBe('ledger');
    const ev = await taskEvent(r.body.task_id);
    expect(ev.sender).toBe(P.neuralchatUser);
    expect(P.neuralchatUser).toBe(mode === 'appservice' ? `@neuralchat_acmetraders:${MATRIX.serverName}` : '@neuralchat_acmetraders:hs.test');
    expect(ev.content).toMatchObject({ task_id: r.body.task_id, company: 'acmetraders', text: 'What was our net profit in August 2026?', msgtype: 'm.notice' });
    // Priya has no Matrix id of her own: the app's people rows know her by NeuralChat's name for her.
    expect(ev.content.on_behalf_of).toMatch(new RegExp(`^@neuralchat_acmetraders_person_${P.admin.id.replace(/-/g, '')}:`));
    if (mode === 'appservice') expect(ev.room).toBe('!ledger-room:acme.example');
    else expect(P.mx!.rooms.get(ev.room)!.members).toEqual(new Set([P.neuralchatUser!, P.neopUser!])); // NeuralChat's 1:1 room with the app
    const t = await P.waitFor(async () => {
      const x = await task(r.body.task_id);
      return x.status === 'COMPLETED' && x;
    }, 'task completed', 30_000);
    expect(t).toMatchObject({ road: 'matrix', matrix_event_id: ev.event_id, matrix_room: ev.room, matrix_account: P.neuralchatUser, attachments: null });
    expect(t.result).toMatchObject({ outcome: 'done', summary: 'Net profit for August 2026 came from 8 entries.', sources: ['ledger.report.pnl'] });
    // The job: one, in the app's book, opened from the event, for Priya, under NeuralChat's task id.
    const jobs = await jobsOf(r.body.task_id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ origin: ev.event_id, requester: `user:${P.admin.id}`, on_behalf_of: `user:${P.admin.id}`, status: 'DONE' });
    expect(t.job_id).toBe(jobs[0].id);
    // The thread: the app's note "on it", its steps, its done — each in the thread rooted at the task.
    const replies = typed().filter((e) => e.sender === P.neopUser && inThread(e, ev.event_id));
    expect(replies.find((e) => e.type === 'neos.neop.note' && e.content.step_id === 'ack')).toBeTruthy();
    expect(replies.find((e) => e.type === 'neos.neop.done')!.content).toMatchObject({ task_id: r.body.task_id, job_id: jobs[0].id });
    // The conversation: the ask, the hand-off, "on it", the steps (· …), the result — nothing from the gateway road.
    const m = await conv(r.body.conversation_id);
    expect(m.filter((x) => x.kind !== 'step').map((x) => x.kind)).toEqual(['message', 'handoff', 'ack', 'result']);
    expect(m.some((x) => x.kind === 'step' && /^· /.test(x.body)), JSON.stringify({ m, read: (await P.platform.db.query('select type, outcome from neos.neuralchat_events where task_id = $1 order by at', [r.body.task_id])).rows, thread: typed().filter((e) => inThread(e, ev.event_id)).map((e) => [e.type, e.content.step_id]) })).toBe(true);
    expect(m.at(-1)).toMatchObject({ kind: 'result', body: 'Net profit for August 2026 came from 8 entries.', author: 'app:ledger' });
    // Every event NeuralChat read from the thread, once each.
    const read = (await P.platform.db.query('select type, outcome from neos.neuralchat_events where task_id = $1 order by at', [r.body.task_id])).rows;
    expect(read.at(0)).toEqual({ type: 'neos.neop.note', outcome: 'note:ack' });
    expect(read.at(-1)).toEqual({ type: 'neos.neop.done', outcome: 'done' });

    // Matrix redelivers the task; NeuralChat resends with the same txnId; a second event for the same task arrives:
    // still one job (the app dedupes on event_id and on NeuralChat's task id).
    await redeliver(ev.event_id);
    await P.platform.db.query('update neos.tasks set matrix_event_id = null where id = $1', [r.body.task_id]);
    expect(await P.platform.neuralchat!.deliver(r.body.task_id)).toBe(ev.event_id); // same txn → the same event
    const second = await sendAsNeuralChat(ev.room, 'neos.neop.task', { ...ev.content }, `nc-task-again-${r.body.task_id}`);
    expect(second).not.toBe(ev.event_id);
    const outcome = await P.waitFor(async () => {
      const row = (await db().query<{ outcome: string; job_id: string | null }>('select outcome, job_id from ledger.inbound_events where event_id = $1', [second])).rows[0];
      return row?.job_id ? row : null;
    }, 'second event bound to a job');
    expect(outcome.job_id).toBe(jobs[0].id);
    await new Promise((res) => setTimeout(res, 400));
    expect(await jobsOf(r.body.task_id)).toHaveLength(1);
    expect((await db().query('select count(*)::int n from ledger.inbound_events where event_id = $1', [ev.event_id])).rows[0].n).toBe(1);
  });

  it('the app asks; the person answers in Conversations → a typed answer in the thread → the wait through answer_wait() → done', async () => {
    const woke: string[] = [];
    P.setBrain((v: BrainView) => (v.job.includes('You asked:') ? (woke.push(v.job), finish('Recorded the deposit to the account you named.')) : v.calls === 0 ? call('job.ask', ASK) : { text: 'waiting' }));
    const r = await P.api('POST', '/api/ask', { text: 'Record the ₹12,000 deposit from 3 September', app: 'ledger' });
    const ev = await taskEvent(r.body.task_id);
    const ask = await P.waitFor(async () => typed().find((e) => e.type === 'neos.neop.ask' && inThread(e, ev.event_id)), 'typed ask');
    await P.waitFor(async () => (await task(r.body.task_id)).status === 'NEEDS_INPUT', 'NEEDS_INPUT');
    expect((await conv(r.body.conversation_id)).find((x) => x.kind === 'card')!.body).toMatch(/^Question: Ledger needs an answer — Which bank account/);
    // The person's reply in the same conversation is the answer (WP §8 thread correlation) — sent in the thread.
    const a = await P.api('POST', '/api/ask', { text: '1010', conversation_id: r.body.conversation_id });
    expect(a.body).toMatchObject({ answered: true, status: 'ANSWERED', handed_to: 'ledger' });
    const answer = await P.waitFor(async () => typed().find((e) => e.type === 'neos.neop.answer' && inThread(e, ev.event_id)), 'typed answer');
    expect(answer.sender).toBe(P.neuralchatUser);
    expect(answer.content).toMatchObject({ wait_id: ask.content.wait_id, answers: { account_code: '1010' } });
    await P.waitFor(async () => (await task(r.body.task_id)).status === 'COMPLETED', 'completed', 30_000);
    // The wait holds the answer, through answer_wait(), relayed by NeuralChat for the person (data, not an instruction).
    const w = (await db().query('select outcome, answered_by, answer from ledger.waits where id = $1', [ask.content.wait_id])).rows[0];
    expect(w).toMatchObject({ outcome: 'ANSWERED', answered_by: `bridge:${P.neuralchatUser}` });
    expect(w.answer).toMatchObject({ answers: { account_code: '1010' }, via: 'bridge', trusted: false });
    expect(woke[0]).toContain('account_code');
    const kinds = (await conv(r.body.conversation_id)).map((x) => x.kind).filter((k) => k !== 'step');
    expect(kinds).toEqual(['message', 'handoff', 'ack', 'card', 'message', 'notice', 'result']);
  });

  it('a proposal is approved only on the desk (answer_proposal); NeuralChat never posts approve; carried out once', async () => {
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
    const mails = (await readdir(P.mailDir)).length;
    const r = await P.api('POST', '/api/ask', { text: 'Email the August close pack to cfo@acme.example', app: 'ledger' });
    const ev = await taskEvent(r.body.task_id);
    const propose = await P.waitFor(async () => typed().find((e) => e.type === 'neos.neop.propose' && inThread(e, ev.event_id)), 'typed propose');
    await P.waitFor(async () => (await task(r.body.task_id)).status === 'WAITING', 'WAITING');
    expect((await conv(r.body.conversation_id)).find((x) => x.kind === 'waiting')!.body).toBe('Waiting for a yes on your desk: Email the August close pack to the CFO');
    await new Promise((res) => setTimeout(res, 300));
    expect((await readdir(P.mailDir)).length).toBe(mails); // nothing is carried out before a person's yes
    // The person answers on the desk, on the row.
    const yes = await desk.answerProposal('ledger', P.company.id, { proposal_id: propose.content.proposal_id, fingerprint: propose.content.fingerprint, decision: 'yes', by: `user:${P.admin.id}`, roles: ['admin'] });
    expect(yes.status).toBe('APPROVED');
    await P.waitFor(async () => (await task(r.body.task_id)).status === 'COMPLETED', 'completed', 30_000);
    expect((await readdir(P.mailDir)).length).toBe(mails + 1);
    expect((await db().query('select status, decided_by from ledger.proposals where id = $1', [propose.content.proposal_id])).rows[0]).toEqual({ status: 'DONE', decided_by: `user:${P.admin.id}` });
    // NeuralChat never approves: not one approve event on the road, from anyone, in this whole file.
    expect(typed().filter((e) => e.type === 'neos.neop.approve')).toEqual([]);
    expect(typed().filter((e) => e.sender === P.neuralchatUser).map((e) => e.type).every((t) => t === 'neos.neop.task' || t === 'neos.neop.answer')).toBe(true);
  });

  it('files travel by reference: sha256 and a signed platform link in the task’s fields, no bytes in any event; the app keeps the file; the platform keeps no bytes', async () => {
    let seen = '';
    P.setBrain((v) => {
      seen = v.system + '\n' + v.job;
      return finish('read the statement');
    });
    const r = await P.api('POST', '/api/ask', { text: 'Book these two bills from the attached sheet', app: 'ledger', attachments: [{ filename: 'bills.csv', content_type: 'text/csv', content_base64: Buffer.from(csv).toString('base64') }] });
    expect(r.status).toBe(200);
    const ev = await taskEvent(r.body.task_id);
    const ref = JSON.parse(ev.content.fields.neos_file_1);
    expect(ref).toMatchObject({ filename: 'bills.csv', content_type: 'text/csv', bytes: Buffer.byteLength(csv), link: expect.stringMatching(/^mxc:\/\//) });
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    // No bytes in any event on the road.
    const b64 = Buffer.from(csv).toString('base64');
    expect(typed().some((e) => JSON.stringify(e.content).includes(b64) || JSON.stringify(e.content).includes('Kapoor'))).toBe(false);
    const t = await P.waitFor(async () => {
      const x = await task(r.body.task_id);
      return x.status === 'COMPLETED' && x;
    }, 'done', 30_000);
    const facts = (await db().query('select subject, value, source from ledger.facts where job_id = $1', [t.job_id])).rows;
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ subject: 'document:bills.csv', source: `upload:sha256:${ref.sha256}` });
    expect(JSON.stringify(facts[0].value)).toContain('Kapoor, Traders');
    expect(seen).toContain('CloudSoft India');
    expect(seen).toMatch(/trust="untrusted"/);
    expect(t.attachments).toBeNull(); // dropped once the app had it
    // Matrix is the file transport; the platform exposes no signed-file download route.
    expect(ref.link).not.toContain('/neuralchat/files/');
  });

  it('one trace: the task carries the ask’s trace context and the app’s job continues it', async () => {
    P.setBrain(() => finish('ok'));
    const r = await P.api('POST', '/api/ask', { text: 'trial balance please', app: 'ledger' });
    const ev = await taskEvent(r.body.task_id);
    const t = await task(r.body.task_id);
    expect(ev.content.trace).toBe(t.trace_parent);
    const traceId = String(t.trace_parent).split('-')[1];
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    const job = await P.waitFor(async () => (await jobsOf(r.body.task_id))[0], 'job');
    expect(job.trace_id).toContain(traceId);
  });
});
