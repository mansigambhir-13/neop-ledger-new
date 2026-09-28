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

describe('binding rooms and people (admin, audited)', () => {
  it('an admin binds an app room and links a person; members cannot; bad ids are refused', async () => {
    const bind = await P.api('POST', '/api/chat/rooms', { app: 'ledger', room_id: '!books-2:acme.example' });
    expect(bind.status, JSON.stringify(bind.body)).toBe(200);
    expect(bind.body.bot).toMatch(/^@neop_ledger_.+:acme\.example$/);
    // The app's identity was registered in the appservice namespace and joined the room.
    expect(P.hs!.joined).toContainEqual({ room: '!books-2:acme.example', user: bind.body.bot });
    expect((await P.api('POST', '/api/chat/rooms', { app: 'ledger', room_id: '!x:acme.example' }, P.member.token)).status).toBe(403);
    expect((await P.api('POST', '/api/chat/rooms', { app: 'ledger', room_id: 'not-a-room' })).status).toBe(400);
    expect((await P.api('PUT', `/api/users/${P.member.id}/chat`, { matrix_user_id: '@rahul:acme.example' })).status).toBe(200);
    expect((await P.api('PUT', `/api/users/${P.member.id}/chat`, { matrix_user_id: 'rahul' })).status).toBe(400);
    const users = (await P.api('GET', '/api/users')).body.users;
    expect(users.find((u: any) => u.id === P.member.id).matrix_user_id).toBe('@rahul:acme.example');
    const audit = (await P.api('GET', '/api/audit?action=chat.')).body.rows.map((r: any) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['chat.room_bound', 'chat.user_linked']));
    await P.bridge!.createAppRoom(P.company.id, 'ledger', ROOM); // restore the room the other tests use
  });
});

describe('v3 §8 room settings: invite-only, no end-to-end encryption, only people post neos.neop.approve', () => {
  const bot = `@neop_ledger_acmetraders:${MATRIX.serverName}`;
  const bind = (room_id: string) => P.api('POST', '/api/chat/rooms', { app: 'ledger', room_id });
  const bound = async (room: string) => (await P.platform.db.query('select 1 from neos.rooms where room_id = $1', [room])).rowCount;

  it('an encrypted room is refused, and nothing is bound', async () => {
    P.hs!.setState('!e2ee:acme.example', 'm.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' });
    const r = await bind('!e2ee:acme.example');
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'room_unfit' });
    expect(r.body.error.message).toMatch(/end-to-end encrypted/);
    expect(await bound('!e2ee:acme.example')).toBe(0);
  });

  it('a room anyone can join is refused', async () => {
    P.hs!.setState('!public:acme.example', 'm.room.join_rules', { join_rule: 'public' });
    const r = await bind('!public:acme.example');
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/not invite-only \(join rule: public\)/);
    expect(await bound('!public:acme.example')).toBe(0);
  });

  it('power levels that let the app, a bridge or everyone post neos.neop.approve are refused; so is a level the app cannot post its notes at', async () => {
    P.hs!.setState('!flat:acme.example', 'm.room.power_levels', { users: {}, users_default: 0, events: {} });
    expect((await bind('!flat:acme.example')).body.error.message).toMatch(/neos\.neop\.approve needs level 0, which everyone has by default/);
    P.hs!.setState('!botadmin:acme.example', 'm.room.power_levels', { users: { [bot]: 100 }, users_default: 0, events: { 'neos.neop.approve': 50 } });
    expect((await bind('!botadmin:acme.example')).body.error.message).toContain(`${bot} could post neos.neop.approve`);
    P.hs!.setState('!mute:acme.example', 'm.room.power_levels', { users: {}, users_default: 0, events: { 'neos.neop.approve': 50, 'neos.neop.done': 20 } });
    expect((await bind('!mute:acme.example')).body.error.message).toContain(`${bot} cannot post neos.neop.done`);
    // An allowlisted bridge (the reasoning agent) at the approve level is refused too.
    const agent = `@neuralchat_acmetraders:${MATRIX.serverName}`;
    expect((await P.api('PUT', '/api/chat/allowlist', { app: 'ledger', matrix_id: agent, kind: 'bridge' })).status).toBe(200);
    P.hs!.setState('!agentup:acme.example', 'm.room.power_levels', { users: { [agent]: 50 }, users_default: 0, events: { 'neos.neop.approve': 50 } });
    expect((await bind('!agentup:acme.example')).body.error.message).toContain(`${agent} could post neos.neop.approve`);
    expect((await P.api('DELETE', `/api/chat/allowlist/ledger/${encodeURIComponent(agent)}`)).status).toBe(200);
    for (const r of ['!flat:acme.example', '!botadmin:acme.example', '!mute:acme.example', '!agentup:acme.example']) expect(await bound(r)).toBe(0);
    // The room the other tests use is still the active one.
    expect((await P.platform.db.query("select room_id from neos.rooms where company_id = $1 and app_key = 'ledger' and status = 'active'", [P.company.id])).rows[0].room_id).toBe(ROOM);
  });

  it('a room the appservice creates is invite-only, unencrypted, people at the approve level and the app below it — and it binds', async () => {
    const made = await P.bridge!.createRoom(P.company.id, 'ledger', { people: [PRIYA], name: 'Books · Acme' });
    const req = P.hs!.created.find((c) => c.room_id === made.room_id)!;
    expect(req.user).toBe(bot);
    expect(req.body).toMatchObject({ preset: 'private_chat', visibility: 'private', invite: [PRIYA] });
    expect(JSON.stringify(req.body.initial_state)).not.toContain('m.room.encryption');
    expect(req.body.power_level_content_override.events['neos.neop.approve']).toBe(50);
    expect(req.body.power_level_content_override.users).toMatchObject({ [PRIYA]: 50, [bot]: 10 });
    expect(made.bot).toBe(bot);
    expect(await bound(made.room_id)).toBe(1);
    await P.bridge!.createAppRoom(P.company.id, 'ledger', ROOM); // restore the room the other tests use
  });
});
