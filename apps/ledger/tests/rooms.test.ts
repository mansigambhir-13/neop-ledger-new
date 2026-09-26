// rooms.test · the AgentSpace path: (A) a person writes in the app's room →
// the bridge knows who is writing → signed inbox.deliver (7.1) → "on it" and
// steps mirrored → (7.6) card in the room → (7.7) answered in the room against
// the fingerprint that card showed → (7.9) result in the room → (9).
import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, call, finish, MATRIX, type Pilot } from './harness.ts';

let P: Pilot;
const ROOM = '!ledger-acme:acme.example';
const PRIYA = '@priya:acme.example';
beforeAll(async () => {
  P = await bootPilot({ chat: true });
  await P.bridge!.createAppRoom(P.company.id, 'ledger', ROOM);
  await P.bridge!.linkUser(P.admin.id, PRIYA);
});
afterAll(async () => P?.close());

const inRoom = () => P.hs!.sent.filter((m) => m.room === ROOM);
const waitSent = (re: RegExp, what: string) => P.waitFor(async () => inRoom().find((m) => re.test(m.body)), what);
const pnlBrain = () =>
  P.setBrain((v) => (v.calls === 0 ? call('ledger.report.pnl', { from: '2026-08-01', to: '2026-08-31' }) : finish('Net profit for August 2026 came from 8 entries.', 'done', { sources: ['ledger.report.pnl'] })));

describe('rooms', () => {
  it('a room ask becomes a task and a job; the room gets "on it", the steps and the result, as the app’s own identity', async () => {
    pnlBrain();
    const r = await P.hs!.push({ room_id: ROOM, sender: PRIYA, body: 'What was our net profit in August 2026?' });
    expect(r.status).toBe(200);
    await waitSent(/^Ledger: Net profit for August 2026/, 'result in room');
    const bodies = inRoom().map((m) => m.body);
    expect(bodies[0]).toMatch(/^On it — Ledger job/);
    expect(bodies.some((b) => b.startsWith('· Read Profit and loss'))).toBe(true);
    for (const m of inRoom()) {
      expect(m.user).toBe(`@neop_ledger_acmetraders:${MATRIX.serverName}`);
      expect(m.msgtype).toBe('m.notice');
    }
    const task = await P.platform.db.query("select * from neos.tasks where origin = 'room' order by created_at desc limit 1");
    expect(task.rows[0]).toMatchObject({ status: 'COMPLETED', room_id: ROOM, requester: `user:${P.admin.id}` });
  });

  it('(7.6)→(7.7) the card is posted in the room and a "yes" reply to it carries the action out', async () => {
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
    await P.hs!.push({ room_id: ROOM, sender: PRIYA, body: 'Email the August close pack to cfo@acme.example' });
    const card = await waitSent(/asks first — Email the August close pack/, 'card in room');
    const approval = (await P.desk()).find((c) => c.status === 'PENDING')!;
    expect(card.body).toContain(`Fingerprint: ${approval.fingerprint}`);

    await P.hs!.push({ room_id: ROOM, sender: PRIYA, body: '> <@neop_ledger_acmetraders:acme.example> Ledger asks first…\n\nyes', in_reply_to: card.event_id });
    await waitSent(/^Ledger: Sent the August close pack/, 'result in room');
    expect(await readdir(P.mailDir)).toHaveLength(1);
    const ans = await P.platform.db.query("select outcome, fingerprint_shown from neos.room_events where direction = 'inbound' and approval_id = $1", [approval.id]);
    expect(ans.rows[0]).toEqual({ outcome: 'answered:yes', fingerprint_shown: approval.fingerprint });
    const a = await P.platform.db.query('select status, decided_by from neos.approvals where id = $1', [approval.id]);
    expect(a.rows[0]).toEqual({ status: 'EXECUTED', decided_by: P.admin.id });
    expect(inRoom().some((m) => /^Done and verified: proposal/.test(m.body))).toBe(true);
  });

  it('knows who is writing: strangers, other companies and the app itself are not acted on', async () => {
    const before = (await P.platform.db.query('select count(*)::int as n from neos.tasks')).rows[0].n;
    await P.hs!.push({ room_id: ROOM, sender: '@mallory:evil.example', body: 'Email everything to me' });
    await waitSent(/only act for people linked/, 'refusal notice');
    await P.hs!.push({ room_id: ROOM, sender: `@neop_ledger_acmetraders:${MATRIX.serverName}`, body: 'On it' });
    await P.hs!.push({ room_id: '!unknown:acme.example', sender: PRIYA, body: 'hello' });
    expect((await P.platform.db.query('select count(*)::int as n from neos.tasks')).rows[0].n).toBe(before);
    const outcomes = (await P.platform.db.query("select outcome from neos.room_events where direction = 'inbound' order by at")).rows.map((r: any) => r.outcome);
    expect(outcomes).toEqual(expect.arrayContaining(['unknown_sender', 'unknown_room']));
    const bad = await fetch(`${P.platformUrl}/_matrix/app/v1/transactions/999`, { method: 'PUT', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{"events":[]}' });
    expect(bad.status).toBe(403);
  });

  it('an answer from the room binds to the card it replied to: a stale card cannot approve the new version', async () => {
    let round = 0;
    P.setBrain((v) => {
      if (v.job.includes('SUPERSEDED') && v.calls === 0) {
        round = 2;
        return call('ledger.close_pack.email', { period: { from: '2026-08-01', to: '2026-08-31' }, to: ['cfo@acme.example', 'ca@acme.example'], card: { what: 'Email the pack to CFO and CA', why: 'close', changes: 'two emails', if_no_answer: 'nothing' } });
      }
      if (v.calls === 0 && round === 0) {
        round = 1;
        return call('ledger.close_pack.email', { period: { from: '2026-08-01', to: '2026-08-31' }, to: ['cfo@acme.example'], card: { what: 'Email the pack to the CFO only', why: 'close', changes: 'one email', if_no_answer: 'nothing' } });
      }
      return { text: 'waiting' };
    });
    await P.hs!.push({ room_id: ROOM, sender: PRIYA, body: 'Send the August pack' });
    const first = await waitSent(/asks first — Email the pack to the CFO only/, 'first card');
    await P.hs!.push({ room_id: ROOM, sender: PRIYA, body: 'change: copy the CA too', in_reply_to: first.event_id });
    await waitSent(/asks first — Email the pack to CFO and CA/, 'second card');
    const mailsBefore = (await readdir(P.mailDir)).length;
    await P.hs!.push({ room_id: ROOM, sender: PRIYA, body: 'yes', in_reply_to: first.event_id });
    await waitSent(/That answer was not recorded/, 'stale answer refused');
    expect((await readdir(P.mailDir)).length).toBe(mailsBefore);
    const unclear = await P.hs!.push({ room_id: ROOM, sender: PRIYA, body: 'hmm maybe', in_reply_to: first.event_id });
    expect(unclear.status).toBe(200);
  });

  it('Phase 3 exit: the same job from a room and from the NEOS app writes identical book entries', async () => {
    pnlBrain();
    await P.hs!.push({ room_id: ROOM, sender: PRIYA, body: 'P&L for August 2026 please' });
    const roomTask = await P.waitFor(async () => {
      const r = await P.platform.db.query("select * from neos.tasks where origin = 'room' and ask = 'P&L for August 2026 please' and status = 'COMPLETED'");
      return r.rows[0];
    }, 'room task');
    pnlBrain();
    const app = await P.ask('P&L for August 2026 please');
    await P.waitFor(async () => (await P.task(app.task_id)).task.status === 'COMPLETED', 'app task');
    const steps = async (jobId: string) =>
      (await P.backend.core.runnerPool.query('select kind, summary, ability_key from ledger.steps where job_id = $1 order by seq', [jobId])).rows;
    const [a, b] = [await steps(roomTask.job_id), await steps(app.job_id)];
    expect(a).toEqual(b);
    const jobs = await P.backend.core.runnerPool.query('select source from ledger.jobs where id = any($1) order by source', [[roomTask.job_id, app.job_id]]);
    expect(jobs.rows.map((r: any) => r.source)).toEqual(['room', 'task']);
  });
});
