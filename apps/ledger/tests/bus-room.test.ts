// bus-room.test · v3 §9 "Talking to other NEOPs" + §10 "Borrowing one ability from another app" · V3 migration S6.
// Marketing and Ledger each run their own presence (NEOP_PRESENCE=appservice); scripts/rooms-setup.ts makes
// #marketing-<co>, #ledger-<co> and the company's bus room #neop-bus-<co> and writes them into both schemas. All
// NEOP-to-NEOP work goes over typed events in the bus room, between the apps' own names — never the platform's a2a
// routing (neos.tasks, the gateway, neos.acl stay untouched):
//   · a task Marketing hands Ledger is a job in Ledger's schema (requester = Marketing's Matrix id, on behalf of the
//     person); Ledger's question comes back into the thread as a typed ask; Marketing answers (a2a.answer, relayed
//     data at Ledger); Ledger's typed done wakes Marketing's job with the result, as untrusted data;
//   · a borrowed READ is answered by Ledger's runner with no model; a borrowed WRITE becomes Ledger's own proposal, a
//     person approves it, it is carried out once, and Marketing's job wakes with the proof; both operations tables
//     have a row;
//   · Marketing can never approve; a chain deeper than 3, or a loop, is refused by the callee; a redelivered event
//     never opens a second job;
//   · t015 applies forward on a populated book (its proof in migrate.json).
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { marketingApp, seedMarketing } from '@neop/marketing';
import { bootstrapFamily, createPool, createTestDatabase, migrate, roleUrl, templateFiles, withCompany } from '@neop/pgkit';
import { migratePlatform } from '@neop/platform';
import { TEMPLATE_INFRA_TABLES, TEMPLATE_MIGRATIONS } from '@neop/template';
import { roomsSetup } from '../../../scripts/rooms-setup.ts';
import { LEDGER_ROOT, seedLedger } from '../src/index.ts';
import { bootPilot, ledgerUnderTest, MATRIX, toolName, type BrainView, type Pilot } from './harness.ts';

let P: Pilot;
let BUS = '';
let MKT = '';
let LED = '';
const PRIYA = '@priya:acme.example';
const SLUG = 'acmetraders';
const t = (key: string, args: unknown = {}) => ({ tool: toolName(key), args });
const finish = (summary: string, outcome = 'done') => t('job.finish', { outcome, summary });
const isMarketing = (v: BrainView) => v.tools.includes(toolName('marketing.campaigns.list'));
const mk = () => P.backends.marketing!.core.runnerPool;
const led = () => P.backends.ledger!.core.runnerPool;
const onBus = (type: string, user?: string) => P.hs!.typed.filter((e) => e.room === BUS && e.type === type && (!user || e.user === user));
const done = (taskId: string) => P.waitFor(async () => ['COMPLETED', 'FAILED'].includes((await P.task(taskId)).task.status) && (await P.task(taskId)), 'task terminal', 25_000);
const ledgerJobs = async () => (await led().query('select count(*)::int as n from ledger.jobs')).rows[0].n as number;
const EXPENSE = { date: '2026-09-21', currency: 'INR', description: 'Diwali flyers printing', amount_minor: 120_000, gst_rate_bps: 0, account_code: '6400' };

beforeAll(async () => {
  P = await bootPilot({ apps: [{ def: await marketingApp(), seed: seedMarketing }, await ledgerUnderTest()], presence: 'appservice', presenceAll: true });
  MKT = P.neopUsers.marketing!;
  LED = P.neopUsers.ledger!;
  expect((await P.api('PUT', `/api/users/${P.admin.id}/chat`, { matrix_user_id: PRIYA })).status).toBe(200);
  const r = await roomsSetup({
    neosUrl: P.platformUrl,
    adminToken: P.admin.token,
    homeserverUrl: P.hs!.url,
    company: SLUG,
    apps: [
      { app: 'marketing', asToken: MATRIX.asToken },
      { app: 'ledger', asToken: MATRIX.asToken },
    ],
    people: [PRIYA],
  });
  BUS = r.bus_room_id;
  // Each app's own backend joins the bus room once its schema names it (presence refreshes its rooms).
  await P.waitFor(async () => P.hs!.joined.some((j) => j.room === BUS && j.user === LED) && P.hs!.joined.some((j) => j.room === BUS && j.user === MKT), 'both apps in the bus room');
}, 60_000);
afterAll(async () => P?.close());

describe('rooms-setup', () => {
  it('makes each app’s room and the bus room — invite-only, not encrypted, v3 power levels — and writes them into both schemas; run again, it makes nothing new', async () => {
    const bus = P.hs!.created.find((c) => c.room_id === BUS)!;
    expect(bus.user).toBe(MKT);
    expect(bus.body).toMatchObject({ preset: 'private_chat', visibility: 'private', room_alias_name: `neop-bus-${SLUG}` });
    expect(JSON.stringify(bus.body.initial_state)).not.toContain('m.room.encryption');
    const pl = bus.body.power_level_content_override;
    expect(pl.users).toEqual({ [MKT]: 20, [LED]: 20 });
    expect(pl.events).toMatchObject({ 'neos.neop.approve': 50, 'neos.neop.task': 10, 'neos.neop.answer': 10, 'neos.neop.ask': 20, 'neos.neop.propose': 20, 'neos.neop.done': 20, 'neos.neop.note': 20 });
    expect(P.hs!.invites).toContainEqual({ room: BUS, by: MKT, user: LED });
    const own = P.hs!.created.find((c) => c.body.room_alias_name === `ledger-${SLUG}`)!;
    expect(own.user).toBe(LED);
    expect(own.body.power_level_content_override.users).toEqual({ [PRIYA]: 50, [LED]: 20 });
    expect((await led().query('select room_ids, bus_room_id, bus_peers from ledger.installs')).rows[0]).toEqual({ room_ids: [own.room_id], bus_room_id: BUS, bus_peers: { [MKT]: 'marketing' } });
    expect((await mk().query('select bus_room_id, bus_peers from marketing.installs')).rows[0]).toEqual({ bus_room_id: BUS, bus_peers: { [LED]: 'ledger' } });
    const n = P.hs!.created.length;
    const again = await roomsSetup({ neosUrl: P.platformUrl, adminToken: P.admin.token, homeserverUrl: P.hs!.url, company: SLUG, apps: [{ app: 'marketing', asToken: MATRIX.asToken }, { app: 'ledger', asToken: MATRIX.asToken }], people: [PRIYA] });
    expect(again.bus_room_id).toBe(BUS);
    expect(again.created).toEqual([]);
    expect(P.hs!.created.length).toBe(n);
    // The admin API shows the bus to an admin.
    expect((await P.api('GET', '/api/chat/presence?app=ledger')).body).toMatchObject({ bus_room_id: BUS, bus_peers: { [MKT]: 'marketing' } });
  });
});

describe('a task from another app is still a job (v3 §9)', () => {
  it('Marketing → Ledger over the bus room: Ledger’s question comes back as a typed ask, Marketing answers, Ledger’s done wakes Marketing with the result', async () => {
    const ledgerSaw: string[] = [];
    let marketingWoke = '';
    let asked = '';
    P.setBrain((v) => {
      if (isMarketing(v)) {
        if (v.job.includes('asks a question')) {
          asked = v.job;
          const id = /a2a_answer \(task_id ([0-9a-f-]{36})/.exec(v.job)![1]!;
          return v.calls === 0 ? t('a2a.answer', { task_id: id, answers: { cost_centre: 'digital' } }) : { text: 'waiting' };
        }
        if (v.job.includes('answered the task you handed it')) return (marketingWoke = v.job), finish('Ledger says ₹12,40,000 of the Q4 ad budget is left.');
        return v.calls === 0 ? t('a2a.request', { app: 'ledger', ask: 'Diwali budget check: how much of the Q4 ad budget is left?' }) : { text: 'waiting' };
      }
      ledgerSaw.push(v.job);
      if (v.job.includes('You asked:')) return finish('₹12,40,000 of the digital Q4 budget is left.');
      return v.calls === 0 ? t('job.ask', { text: 'Which cost centre?', why: 'The Q4 ad budget is split between two cost centres.', fields: [{ key: 'cost_centre', label: 'Cost centre' }] }) : { text: 'waiting' };
    });
    const r = await P.ask('Diwali budget check: how much of Q4 ad budget is left?', undefined, 'marketing');
    const res = await done(r.task_id);
    expect(res.task.status).toBe('COMPLETED');
    expect(res.task.result.summary).toBe('Ledger says ₹12,40,000 of the Q4 ad budget is left.');

    // The task: typed, from Marketing's own name, addressed to Ledger, with the chain and the person.
    const task = onBus('neos.neop.task', MKT).at(-1)!;
    expect(task.content).toMatchObject({ company: SLUG, on_behalf_of: PRIYA, text: 'Diwali budget check: how much of the Q4 ad budget is left?', lineage: ['marketing'], depth: 1, 'm.mentions': { user_ids: [LED] } });
    const out = (await mk().query("select * from marketing.bus_threads where direction = 'out' and kind = 'task' and job_id = $1", [r.job_id])).rows[0];
    expect(out).toMatchObject({ root_event_id: task.event_id, peer: LED, peer_app: 'ledger', task_id: task.content.task_id, status: 'done', lineage: ['marketing'], depth: 1 });
    // A job in Ledger's own schema: the asking app is the requester, the person is on_behalf_of.
    const job = (await led().query('select * from ledger.jobs where origin = $1', [task.event_id])).rows[0];
    expect(job).toMatchObject({ source: 'a2a', requester: `app:${MKT}`, on_behalf_of: `user:${P.admin.id}`, status: 'DONE' });
    expect(ledgerSaw[0]).toContain(`Asked by app:${MKT} (a2a) on behalf of user:${P.admin.id}`);
    expect((await led().query("select peer_app, job_id, lineage, depth from ledger.bus_threads where direction = 'in' and root_event_id = $1", [task.event_id])).rows[0]).toEqual({ peer_app: 'marketing', job_id: job.id, lineage: ['marketing'], depth: 1 });

    // Ledger's question went back into the thread as a typed ask; Marketing's job woke with it as data.
    const ask = onBus('neos.neop.ask', LED).find((e) => e.content['m.relates_to']?.event_id === task.event_id)!;
    expect(ask.content).toMatchObject({ job_id: job.id, question: { text: 'Which cost centre?' } });
    expect(asked).toMatch(/<data source="ledger\.ask" trust="untrusted">[\s\S]*Which cost centre\?/);
    // Marketing answered in the same thread with a typed answer to Ledger's wait; Ledger took it as relayed data.
    const answer = onBus('neos.neop.answer', MKT).find((e) => e.content.wait_id === ask.content.wait_id)!;
    expect(answer.content).toMatchObject({ answers: { cost_centre: 'digital' }, 'm.relates_to': { rel_type: 'm.thread', event_id: task.event_id } });
    const woke = ledgerSaw.find((j) => j.includes('You asked:'))!;
    expect(woke).toContain(`An answer was relayed by app:${MKT} (bridge), not given by a person directly`);
    expect(woke).toContain('"cost_centre": "digital"');
    expect(woke).not.toContain('in their own words');
    expect((await led().query('select answered_by, status from ledger.waits where id = $1', [ask.content.wait_id])).rows[0]).toEqual({ answered_by: `app:${MKT}`, status: 'consumed' });

    // Ledger's typed done (with Marketing's task id) woke Marketing's job with the result — as untrusted data.
    const dn = onBus('neos.neop.done', LED).find((e) => e.content.task_id === task.content.task_id)!;
    expect(dn.content).toMatchObject({ job_id: job.id, result: { outcome: 'done', summary: '₹12,40,000 of the digital Q4 budget is left.' }, 'm.relates_to': { event_id: task.event_id } });
    expect(marketingWoke).toMatch(/The ledger app answered the task you handed it \([0-9a-f-]{36}\): COMPLETED\.\nIts result: <data source="ledger" trust="untrusted">[\s\S]*₹12,40,000 of the digital Q4 budget is left\./);
    // Marketing's book: the task handed over, recorded with what came back.
    expect((await mk().query("select outcome, reason from marketing.operations where job_id = $1 and ability_key = 'task:ledger'", [r.job_id])).rows).toEqual([{ outcome: 'COMPLETED', reason: 'a task handed to ledger over the bus room' }]);
    // Nothing went through the platform's a2a routing.
    expect((await P.platform.db.query("select count(*)::int as n from neos.tasks where requester like 'app:%'")).rows[0].n).toBe(0);
  });
});

describe('borrowing one ability (v3 §10: three checks, one ask)', () => {
  it('Marketing’s own line decides whether it is offered: off until the company sets it', async () => {
    let tools: string[] = [];
    P.setBrain((v) => ((tools = v.tools), finish('ok')));
    const r = await P.ask('What budget is left?', undefined, 'marketing');
    await done(r.task_id);
    expect(tools).not.toContain(toolName('ledger.budget.remaining'));
    expect((await P.api('PUT', '/api/switchboards/marketing', { settings: { 'ledger.budget.remaining': 'on', 'ledger.expense.record': 'on' } })).status).toBe(200);
    await P.waitFor(async () => (await P.backends.marketing!.core.board.get(P.company.id)).companySetting('ledger.budget.remaining') === 'on', 'the line on Marketing’s board');
    const r2 = await P.ask('What budget is left?', undefined, 'marketing');
    await done(r2.task_id);
    expect(tools).toContain(toolName('ledger.budget.remaining'));
    expect(tools).toContain(toolName('ledger.expense.record'));
    expect((await P.api('PUT', '/api/switchboards/marketing', { settings: { 'ledger.budget.remaining': 'ask_first' } })).status).toBe(422);
  });

  it('a borrowed READ: a typed ask carrying {ability, args}; Ledger’s runner answers with no model; both operations tables have a row', async () => {
    let ledgerCalls = 0;
    let woke = '';
    P.setBrain((v) => {
      if (!isMarketing(v)) return ledgerCalls++, finish('should not run');
      if (v.job.includes('answered the task you handed it')) return (woke = v.job), finish('₹ left, per Ledger.');
      return v.calls === 0 ? t('ledger.budget.remaining', { account_code: '6400', month: '2026-09' }) : { text: 'waiting' };
    });
    const jobsBefore = await ledgerJobs();
    const r = await P.ask('How much is left in the ads budget for September?', undefined, 'marketing');
    expect((await done(r.task_id)).task.status).toBe('COMPLETED');
    const ask = onBus('neos.neop.ask', MKT).at(-1)!;
    expect(ask.content).toMatchObject({ call: { ability: 'ledger.budget.remaining', args: { account_code: '6400', month: '2026-09' }, on_behalf_of: PRIYA }, 'm.mentions': { user_ids: [LED] } });
    const ans = onBus('neos.neop.answer', LED).find((e) => e.content.wait_id === ask.content.wait_id)!;
    expect(ans.content.result).toMatchObject({ ability: 'ledger.budget.remaining', status: 'DONE', output: { generatedAt: expect.any(String) } });
    expect(ans.content['m.relates_to']).toMatchObject({ rel_type: 'm.thread', event_id: ask.event_id });
    expect(ledgerCalls).toBe(0); // no model at the owner
    expect(await ledgerJobs()).toBe(jobsBefore); // and no job: a read is served
    expect(woke).toMatch(/The ledger app answered the task you handed it \([0-9a-f-]{36}\): COMPLETED\.\nIts result: <data source="ledger" trust="untrusted">/);
    // Both operations tables.
    expect((await led().query("select caller, outcome, job_id, reason from ledger.operations where ability_key = 'ledger.budget.remaining' and idempotency_key = $1", [`bus:${ask.event_id}`])).rows).toEqual([
      { caller: `app:${MKT}`, outcome: 'served', job_id: null, reason: 'a read served to marketing over the bus room (no model)' },
    ]);
    expect((await mk().query("select outcome, reason from marketing.operations where job_id = $1 and ability_key = 'borrow:ledger:ledger.budget.remaining'", [r.job_id])).rows).toEqual([{ outcome: 'answered', reason: 'borrowed from ledger over the bus room' }]);
  });

  it('the owner’s own line still decides: switched off at Ledger, the ask is refused there, and Marketing is told as data', async () => {
    await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.budget.remaining': 'off' } });
    let woke = '';
    P.setBrain((v) => {
      if (!isMarketing(v)) return finish('should not run');
      if (v.job.includes('answered the task you handed it')) return (woke = v.job), finish('Ledger refused.', 'blocked');
      return v.calls === 0 ? t('ledger.budget.remaining', { account_code: '6400', month: '2026-09' }) : { text: 'waiting' };
    });
    const r = await P.ask('Budget left?', undefined, 'marketing');
    await done(r.task_id);
    expect(woke).toMatch(/answered the task you handed it \([0-9a-f-]{36}\): REFUSED\.\nIts result: <data source="ledger" trust="untrusted">[\s\S]*"code": "switched_off"/);
    expect((await mk().query("select outcome from marketing.operations where job_id = $1 and ability_key = 'borrow:ledger:ledger.budget.remaining'", [r.job_id])).rows).toEqual([{ outcome: 'refused' }]);
    await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.budget.remaining': 'on' } });
  });

  it('a borrowed WRITE becomes Ledger’s own proposal (no model); Marketing cannot approve it; a person says yes; carried out once; Marketing wakes with the proof', async () => {
    let ledgerCalls = 0;
    let woke = '';
    P.setBrain((v) => {
      if (!isMarketing(v)) return ledgerCalls++, finish('should not run');
      if (v.job.includes('answered the task you handed it')) return (woke = v.job), finish('Flyer printing booked in Ledger.');
      return v.calls === 0 ? t('ledger.expense.record', EXPENSE) : { text: 'waiting' };
    });
    const expenseOps = async () => (await led().query("select count(*)::int as n from ledger.operations where ability_key = 'ledger.expense.record' and outcome = 'DONE'")).rows[0].n as number;
    const before = await expenseOps();
    const r = await P.ask('Book the ₹1,200 Diwali flyer printing as an expense', undefined, 'marketing');
    const card = await P.waitFor(async () => (await P.desk()).find((c) => c.app_key === 'ledger' && c.ability_key === 'ledger.expense.record' && c.status === 'PENDING'), 'Ledger’s card on the desk');
    const ask = onBus('neos.neop.ask', MKT).at(-1)!;
    expect(ask.content.call).toEqual({ ability: 'ledger.expense.record', args: EXPENSE, on_behalf_of: PRIYA });
    const p = (await led().query("select p.*, j.requester, j.on_behalf_of, j.source, j.origin from ledger.proposals p join ledger.jobs j on j.id = p.job_id where p.id = $1", [card.id])).rows[0];
    expect(p).toMatchObject({ status: 'PROPOSED', args: EXPENSE, requester: `app:${MKT}`, on_behalf_of: `user:${P.admin.id}`, source: 'a2a', origin: ask.event_id });
    expect(p.card.what).toMatch(/borrowed by marketing/);
    expect(p.card.changes).toContain('"amount_minor":120000');
    expect(ledgerCalls).toBe(0); // written by Ledger's runner, as asked
    expect(await expenseOps()).toBe(before); // nothing done before a person's yes
    expect((await mk().query("select status from marketing.waits where job_id = $1 and kind = 'a2a_task'", [r.job_id])).rows).toEqual([{ status: 'pending' }]);

    // The asking app can never approve: its typed approve (in the bus room) is refused by the sender-class rule.
    const nope = await P.hs!.pushTyped({ to: 'ledger', room_id: BUS, sender: MKT, type: 'neos.neop.approve', content: { proposal_id: card.id, fingerprint: p.fingerprint, decision: 'yes' } });
    expect(nope.status).toBe(200);
    expect((await led().query('select outcome from ledger.inbound_events where event_id = $1', [nope.event_id])).rows[0].outcome).toBe('typed:refused:approve');
    expect((await led().query('select status from ledger.proposals where id = $1', [card.id])).rows[0].status).toBe('PROPOSED');

    // A person says yes on the desk.
    expect((await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint })).status).toBe(200);
    expect((await done(r.task_id)).task.result.summary).toBe('Flyer printing booked in Ledger.');
    expect(await expenseOps()).toBe(before + 1);
    expect(ledgerCalls).toBe(0);
    const ans = onBus('neos.neop.answer', LED).find((e) => e.content.wait_id === ask.content.wait_id)!;
    expect(ans.content.result).toMatchObject({ ability: 'ledger.expense.record', status: 'DONE', proposal_id: card.id, decided_by: `user:${P.admin.id}`, proof: { outcome: 'DONE' } });
    expect(woke).toMatch(/answered the task you handed it \([0-9a-f-]{36}\): COMPLETED\.\nIts result: <data source="ledger" trust="untrusted">[\s\S]*"proof"/);
    expect((await led().query('select status from ledger.jobs where origin = $1', [ask.event_id])).rows[0].status).toBe('DONE');
    // Both operations tables.
    expect((await mk().query("select outcome from marketing.operations where job_id = $1 and ability_key = 'borrow:ledger:ledger.expense.record'", [r.job_id])).rows).toEqual([{ outcome: 'answered' }]);
    expect((await led().query("select count(*)::int as n from ledger.operations where ability_key = 'ledger.expense.record' and job_id = $1", [p.job_id])).rows[0].n).toBe(1);
    expect((await P.platform.db.query("select count(*)::int as n from neos.tasks where requester like 'app:%'")).rows[0].n).toBe(0);
  });
});

describe('the callee’s runner enforces the chain; Matrix redelivers', () => {
  const task = (lineage: string[], depth: number, extra: Record<string, unknown> = {}) => ({
    task_id: randomUUID(),
    company: SLUG,
    on_behalf_of: PRIYA,
    text: 'Post the ad spend',
    lineage,
    depth,
    'm.mentions': { user_ids: [LED] },
    ...extra,
  });

  it('depth > 3 is refused with a typed done; so is a loop; no job opens', async () => {
    P.setBrain(() => ({ hang: true }));
    const before = await ledgerJobs();
    const deep = await P.hs!.pushTyped({ to: 'ledger', room_id: BUS, sender: MKT, type: 'neos.neop.task', content: task(['cos', 'books', 'hr', 'marketing'], 4) });
    const loop = await P.hs!.pushTyped({ to: 'ledger', room_id: BUS, sender: MKT, type: 'neos.neop.task', content: task(['ledger', 'marketing'], 2) });
    const lying = await P.hs!.pushTyped({ to: 'ledger', room_id: BUS, sender: MKT, type: 'neos.neop.task', content: task(['cos', 'hr'], 2) });
    const outcome = async (id: string) => (await led().query('select outcome from ledger.inbound_events where event_id = $1', [id])).rows[0]?.outcome;
    expect(await outcome(deep.event_id)).toBe('typed:refused:a2a_depth');
    expect(await outcome(loop.event_id)).toBe('typed:refused:a2a_loop');
    expect(await outcome(lying.event_id)).toBe('typed:refused:bad_lineage');
    expect(await ledgerJobs()).toBe(before);
    const refusal = onBus('neos.neop.done', LED).find((e) => e.content['m.relates_to']?.event_id === deep.event_id)!;
    expect(refusal.content).toMatchObject({ job_id: 'none', result: { outcome: 'failed', refused: 'a2a_depth' }, could_not: [expect.stringMatching(/a2a chains stop at depth 3/)] });
    expect(onBus('neos.neop.done', LED).find((e) => e.content['m.relates_to']?.event_id === loop.event_id)!.content.result.refused).toBe('a2a_loop');
  });

  it('a task not addressed to Ledger (no mention) is not Ledger’s; a stranger on the bus is nobody', async () => {
    const before = await ledgerJobs();
    const other = await P.hs!.pushTyped({ to: 'ledger', room_id: BUS, sender: MKT, type: 'neos.neop.task', content: task(['marketing'], 1, { 'm.mentions': { user_ids: ['@neop_cos_acmetraders:acme.example'] } }) });
    const stranger = await P.hs!.pushTyped({ to: 'ledger', room_id: BUS, sender: '@neop_evil_acmetraders:acme.example', type: 'neos.neop.task', content: task(['evil'], 1) });
    const person = await P.hs!.pushTyped({ to: 'ledger', room_id: BUS, sender: PRIYA, type: 'neos.neop.task', content: task(['marketing'], 1) });
    const outcome = async (id: string) => (await led().query('select outcome from ledger.inbound_events where event_id = $1', [id])).rows[0]?.outcome;
    expect(await outcome(other.event_id)).toBe('typed:bus:not_ours');
    expect(await outcome(stranger.event_id)).toBe('typed:unknown_sender');
    expect(await outcome(person.event_id)).toBe('typed:unknown_sender');
    expect(await ledgerJobs()).toBe(before);
  });

  it('a redelivered task never opens a second job; a redelivered borrowed call is never served twice', async () => {
    P.setBrain(() => ({ hang: true }));
    const before = await ledgerJobs();
    const ev = `$redeliver-${randomUUID()}:acme.example`;
    const body = task(['marketing'], 1);
    const first = await P.hs!.pushTyped({ to: 'ledger', room_id: BUS, sender: MKT, type: 'neos.neop.task', content: body, event_id: ev });
    const again = await P.hs!.pushTyped({ to: 'ledger', room_id: BUS, sender: MKT, type: 'neos.neop.task', content: body, event_id: ev });
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(await ledgerJobs()).toBe(before + 1);
    expect((await led().query('select count(*)::int as n from ledger.jobs where origin = $1', [ev])).rows[0].n).toBe(1);
    expect((await led().query("select count(*)::int as n from ledger.bus_threads where root_event_id = $1", [ev])).rows[0].n).toBe(1);
    const call = `$recall-${randomUUID()}:acme.example`;
    const content = {
      job_id: randomUUID(),
      wait_id: randomUUID(),
      question: { text: 'Borrowed: ledger.budget.remaining', why: 'test', fields: [] },
      due: new Date(Date.now() + 3_600_000).toISOString(),
      call: { ability: 'ledger.budget.remaining', args: { account_code: '6400', month: '2026-09' } },
      'm.mentions': { user_ids: [LED] },
    };
    await P.hs!.pushTyped({ to: 'ledger', room_id: BUS, sender: MKT, type: 'neos.neop.ask', content, event_id: call });
    await P.hs!.pushTyped({ to: 'ledger', room_id: BUS, sender: MKT, type: 'neos.neop.ask', content, event_id: call });
    expect((await led().query('select count(*)::int as n from ledger.operations where idempotency_key = $1', [`bus:${call}`])).rows[0].n).toBe(1);
    expect(onBus('neos.neop.answer', LED).filter((e) => e.content.wait_id === content.wait_id)).toHaveLength(1);
  });

  it('with presence on, the asking gate refuses a loop or depth > 3 before anything is sent — and never calls the platform’s a2a route', async () => {
    const core = P.backends.marketing!.core;
    const gate = P.backends.marketing!.gate;
    let platformCalls = 0;
    const real = core.platform.openA2A.bind(core.platform);
    core.platform.openA2A = async (req) => (platformCalls++, real(req));
    // A Marketing job taken from the bus at the end of a chain (as its bus_threads row records it), held by a session.
    const job = async (lineage: string[]) => {
      const id = (
        await core.company(P.company.id, (c) =>
          c.query<{ id: string }>(
            `insert into marketing.jobs (company_id, source, requester, on_behalf_of, task_id, ask, status, claimed_by, claimed_until)
             values ($1, 'a2a', 'app:@neop_x:acme.example', $2, gen_random_uuid(), 'x', 'RUNNING', 'test-sid', now() + interval '1 hour') returning id`,
            [P.company.id, `user:${P.admin.id}`],
          ),
        )
      ).rows[0]!.id;
      await core.company(P.company.id, (c) =>
        c.query(`insert into marketing.bus_threads (company_id, direction, kind, room_id, peer, peer_app, job_id, lineage, depth) values ($1, 'in', 'task', $2, $3, $4, $5, $6, $7)`, [
          P.company.id,
          BUS,
          LED,
          lineage.at(-1),
          id,
          JSON.stringify(lineage),
          lineage.length,
        ]),
      );
      return { sub: id, sid: 'test-sid', company_id: P.company.id, app: 'marketing', abilities: [] };
    };
    const sent = onBus('neos.neop.task', MKT).length;
    try {
      const deep = await gate.call(await job(['cos', 'hr', 'books']), 'a2a.request', { app: 'ledger', ask: 'Post the ad spend' });
      expect(deep).toMatchObject({ status: 'refused', code: 'a2a_depth' });
      const loop = await gate.call(await job(['ledger']), 'a2a.request', { app: 'ledger', ask: 'Post the ad spend' });
      expect(loop).toMatchObject({ status: 'refused', code: 'a2a_loop' });
      expect(onBus('neos.neop.task', MKT)).toHaveLength(sent);
      expect(platformCalls).toBe(0);
      expect((await mk().query("select count(*)::int as n from marketing.waits where kind = 'a2a_task' and job_id in (select job_id from marketing.bus_threads where direction = 'in' and peer = $1)", [LED])).rows[0].n).toBe(0);
    } finally {
      core.platform.openA2A = real;
    }
  });
});

describe('template migration t015', () => {
  it('t015 applies forward on a populated book: nothing lost, the bus columns and thread table empty and company-scoped', async () => {
    const db = await createTestDatabase();
    const CO = '11111111-2222-3333-4444-555555555555';
    const tdir = await mkdtemp(path.join(os.tmpdir(), 'neop-t015-'));
    try {
      await migratePlatform(db.adminUrl);
      await cp(TEMPLATE_MIGRATIONS, tdir, { recursive: true });
      const tled = JSON.parse(await readFile(path.join(tdir, 'migrate.json'), 'utf8'));
      for (const m of tled.migrations.filter((x: any) => x.file >= 't015')) await rm(path.join(tdir, m.file));
      tled.migrations = tled.migrations.filter((m: any) => m.file < 't015');
      await writeFile(path.join(tdir, 'migrate.json'), JSON.stringify(tled));
      await bootstrapFamily(db.adminUrl, 'ledger');
      const run = async (dir: string) => migrate({ adminUrl: db.adminUrl, schema: 'ledger', sources: { dir: path.join(LEDGER_ROOT, 'migrations'), prepend: await templateFiles(dir) }, lintExempt: TEMPLATE_INFRA_TABLES });
      await run(tdir);
      const pool = createPool(roleUrl(db.adminUrl, 'ledger_app'));
      const runner = createPool(roleUrl(db.adminUrl, 'ledger_runner'));
      const admin = new pg.Client({ connectionString: db.adminUrl });
      await admin.connect();
      try {
        await seedLedger(pool, CO);
        await admin.query("insert into ledger.installs (company_id, status, company_name, time_zone, matrix_user, room_ids) values ($1, 'active', 'Old Co', 'Asia/Kolkata', '@neop_ledger_old:hs', '{!r:hs}')", [CO]);
        await withCompany(pool, CO, (c) => c.query("insert into ledger.jobs (company_id, source, requester, task_id, ask, status) values ($1, 'a2a', 'app:marketing', gen_random_uuid(), 'old a2a job', 'DONE')", [CO]));
        const count = async () => (await admin.query('select (select count(*) from ledger.jobs) + (select count(*) from ledger.installs) + (select count(*) from ledger.accounts) as n')).rows[0].n;
        const before = await count();
        const applied = await run(TEMPLATE_MIGRATIONS);
        expect(applied.map((m) => m.name)).toContain('t015_bus_room.sql');
        expect(await count()).toBe(before);
        expect((await runner.query('select matrix_user, room_ids, bus_room_id, bus_peers from ledger.installs')).rows).toEqual([{ matrix_user: '@neop_ledger_old:hs', room_ids: ['!r:hs'], bus_room_id: null, bus_peers: {} }]);
        expect((await runner.query('select count(*)::int as n from ledger.bus_threads')).rows[0].n).toBe(0);
        // Company-scoped: the app role sees and writes only its company's threads.
        const row = (co: string) => `insert into ledger.bus_threads (company_id, direction, kind, room_id, peer, peer_app) values ('${co}', 'out', 'task', '!bus:hs', '@neop_marketing_old:hs', 'marketing')`;
        await withCompany(pool, CO, (c) => c.query(row(CO)));
        await expect(withCompany(pool, CO, (c) => c.query(row('99999999-2222-3333-4444-555555555555')))).rejects.toThrow(/row-level security/);
        expect((await withCompany(pool, '99999999-2222-3333-4444-555555555555', (c) => c.query('select 1 from ledger.bus_threads'))).rowCount).toBe(0);
        await expect(admin.query("update ledger.installs set bus_room_id = 'not-a-room'")).rejects.toThrow(/check constraint/);
      } finally {
        await admin.end();
        await pool.end();
        await runner.end();
      }
    } finally {
      await db.drop();
      await rm(tdir, { recursive: true, force: true });
    }
  });
});
