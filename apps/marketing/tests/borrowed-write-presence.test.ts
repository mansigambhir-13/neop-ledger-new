// borrowed-write-presence.test · borrowed-write.test with NEOP_PRESENCE on (V3 migration S6, v3 §10 "one step in
// another app's subject"). Marketing's manifest `uses` Ledger's WRITE ledger.expense.record. With Marketing's own
// line for it switched on (no ACL row: the platform is not asked), it is a borrowed line on Marketing's board;
// calling it never runs it in Marketing: one typed neos.neop.ask carrying {ability, args} goes to Ledger in the bus
// room. Ledger checks its own line and the sender, writes the proposal in its own schema (its runner, no model), a
// person says yes on the desk, Ledger carries it out once, and only then answers — Marketing's job wakes with the proof.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, MATRIX, toolName, type BrainView, type Pilot } from '@neop/testkit';
import { ledgerApp, seedLedger } from '@neop/ledger';
import { roomsSetup } from '../../../scripts/rooms-setup.ts';
import { marketingApp, seedMarketing } from '../src/index.ts';

let P: Pilot;
let BUS = '';
beforeAll(async () => {
  P = await bootPilot({ apps: [{ def: await marketingApp(), seed: seedMarketing }, { def: await ledgerApp(), seed: seedLedger }], presence: 'appservice', presenceAll: true });
  expect((await P.api('PUT', `/api/users/${P.admin.id}/chat`, { matrix_user_id: '@priya:acme.example' })).status).toBe(200);
  BUS = (await roomsSetup({ neosUrl: P.platformUrl, adminToken: P.admin.token, homeserverUrl: P.hs!.url, company: 'acmetraders', apps: ['marketing', 'ledger'].map((app) => ({ app, asToken: MATRIX.asToken })) })).bus_room_id;
  await P.waitFor(async () => ['marketing', 'ledger'].every((a) => P.hs!.joined.some((j) => j.room === BUS && j.user === P.neopUsers[a])), 'both apps in the bus room');
}, 60_000);
afterAll(async () => P?.close());

const t = (key: string, args: unknown = {}) => ({ tool: toolName(key), args });
const finish = (summary: string, outcome = 'done') => t('job.finish', { outcome, summary });
const isMarketing = (v: BrainView) => v.tools.includes(toolName('marketing.campaigns.list'));
const EXPENSE = { date: '2026-09-21', currency: 'INR', description: 'Diwali flyers printing', amount_minor: 120_000, gst_rate_bps: 0, account_code: '6400' };
const expenseOps = async () => (await P.backends.ledger!.core.runnerPool.query("select count(*)::int as n from ledger.operations where ability_key = 'ledger.expense.record' and outcome = 'DONE'")).rows[0].n as number;
const onBus = (type: string) => P.hs!.typed.filter((e) => e.room === BUS && e.type === type);

describe('a borrowed write over the bus room', () => {
  it('is declared in the manifest and published to the registry (neos_registry.uses): Ledger reads it there', async () => {
    const m = (await P.platform.db.query("select manifest from neos.apps where key = 'marketing'")).rows[0].manifest;
    expect(m.uses).toContainEqual({ app: 'ledger', ability: 'ledger.expense.record', range: '^1.0.0' });
    expect((await P.backends.ledger!.core.runnerPool.query("select 1 from neos_registry.uses where app = 'marketing' and owner_app = 'ledger' and ability = 'ledger.expense.record'")).rowCount).toBe(1);
  });

  it('without Marketing’s own line switched on it is not offered', async () => {
    let tools: string[] = [];
    P.setBrain((v) => {
      tools = v.tools;
      return finish('ok');
    });
    const r = await P.ask('Book the flyer printing', undefined, 'marketing');
    await P.waitFor(async () => (await P.task(r.task_id)).task.status === 'COMPLETED', 'done');
    expect(tools).not.toContain(toolName('ledger.expense.record'));
  });

  it('with the line: Marketing’s call is one typed ask at Ledger; Ledger proposes (no model); a person says yes; executed once; Marketing is woken with the proof', async () => {
    expect((await P.api('PUT', '/api/switchboards/marketing', { settings: { 'ledger.expense.record': 'on' } })).status).toBe(200);
    // The board's NOTIFY reaches Marketing's runner (drops its cached board and borrow list) before the next job.
    await P.waitFor(async () => (await P.backends.marketing!.core.board.get(P.company.id)).companySetting('ledger.expense.record') === 'on', 'the line on Marketing’s board');
    const before = await expenseOps();
    let marketingTools: string[] = [];
    let ledgerSessions = 0;
    let woke = '';
    P.setBrain((v) => {
      if (isMarketing(v)) {
        if (v.job.includes('WOKEN')) return (woke = v.job), finish('Flyer printing booked in Ledger.');
        if (v.calls === 0) {
          marketingTools = v.tools;
          // Only the inputs: the card is written by Ledger, where the yes is asked for.
          return t('ledger.expense.record', EXPENSE);
        }
        return { text: 'waiting' };
      }
      ledgerSessions++;
      return finish('should not run');
    });
    const r = await P.ask('Book the ₹1,200 Diwali flyer printing as an expense', undefined, 'marketing');

    const card = await P.waitFor(async () => (await P.desk()).find((c) => c.app_key === 'ledger' && c.ability_key === 'ledger.expense.record' && c.status === 'PENDING'), 'ledger card');
    expect(marketingTools).toContain(toolName('ledger.expense.record'));
    const step = (await P.backends.marketing!.core.runnerPool.query("select summary, ability_key from marketing.steps where job_id = $1 and kind = 'system' and summary like 'Handed one step%'", [r.job_id])).rows;
    expect(step).toEqual([{ summary: expect.stringMatching(/^Handed one step to ledger \(task [0-9a-f]{8}, over the bus room\): /), ability_key: 'ledger.expense.record' }]);
    const ask = onBus('neos.neop.ask').at(-1)!;
    expect(ask.user).toBe(P.neopUsers.marketing);
    expect(ask.content.call).toMatchObject({ ability: 'ledger.expense.record', args: EXPENSE });
    expect(ask.content.call.args).not.toHaveProperty('card');
    // Ledger's job for it: asked by Marketing's Matrix id, on behalf of the person, run by no model.
    const lj = (await P.backends.ledger!.core.runnerPool.query('select * from ledger.jobs where origin = $1', [ask.event_id])).rows[0];
    expect(lj).toMatchObject({ source: 'a2a', requester: `app:${P.neopUsers.marketing}`, on_behalf_of: `user:${P.admin.id}`, status: 'WAITING' });
    expect(lj.ask).toContain('borrows one step in your subject over the bus room');
    expect(lj.ask).toContain('"amount_minor":120000');
    expect(ledgerSessions).toBe(0);
    // Marketing's job waits on that thread; Marketing ran nothing itself.
    const wait = (await P.backends.marketing!.core.runnerPool.query("select w.kind, w.ref_id, w.status, b.root_event_id from marketing.waits w join marketing.bus_threads b on b.id = w.ref_id where w.job_id = $1 and w.kind = 'a2a_task'", [r.job_id])).rows;
    expect(wait).toEqual([{ kind: 'a2a_task', ref_id: expect.any(String), status: 'pending', root_event_id: ask.event_id }]);
    expect((await P.backends.marketing!.core.runnerPool.query("select count(*)::int as n from marketing.operations where ability_key like '%expense%'")).rows[0].n).toBe(0);
    expect(await expenseOps()).toBe(before); // nothing done before a person says yes

    await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    const done = await P.waitFor(async () => {
      const x = await P.task(r.task_id);
      return x.task.status === 'COMPLETED' && x;
    }, 'marketing task completed', 25_000);
    expect(done.task.result.summary).toBe('Flyer printing booked in Ledger.');
    expect(await expenseOps()).toBe(before + 1);
    expect(ledgerSessions).toBe(0);
    expect(woke).toMatch(/The ledger app answered the task you handed it \([0-9a-f-]{36}\): COMPLETED\.\nIts result: <data source="ledger" trust="untrusted">[\s\S]*"proof"/);
    // Both operations tables have a row; nothing went through the platform's a2a routing or its ACL.
    expect((await P.backends.marketing!.core.runnerPool.query("select outcome from marketing.operations where job_id = $1 and ability_key = 'borrow:ledger:ledger.expense.record'", [r.job_id])).rows).toEqual([{ outcome: 'answered' }]);
    expect((await P.platform.db.query("select count(*)::int as n from neos.tasks where requester like 'app:%'")).rows[0].n).toBe(0);
    expect((await P.platform.db.query('select count(*)::int as n from neos.acl')).rows[0].n).toBe(0);
  });

  it('the owner’s switch still decides, and the owner refuses what the asker does not declare', async () => {
    const LED = P.neopUsers.ledger!;
    const MKT = P.neopUsers.marketing!;
    await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.expense.record': 'off' } });
    const call = async (ability: string, args: Record<string, unknown>) => {
      const content = {
        job_id: randomUUID(),
        wait_id: randomUUID(),
        question: { text: `Borrowed: ${ability}`, why: 'test', fields: [] },
        due: new Date(Date.now() + 3_600_000).toISOString(),
        call: { ability, args },
        'm.mentions': { user_ids: [LED] },
      };
      const ev = await P.hs!.pushTyped({ to: 'ledger', room_id: BUS, sender: MKT, type: 'neos.neop.ask', content });
      const ans = onBus('neos.neop.answer').find((e) => e.user === LED && e.content.wait_id === content.wait_id)!;
      const outcome = (await P.backends.ledger!.core.runnerPool.query('select outcome from ledger.inbound_events where event_id = $1', [ev.event_id])).rows[0].outcome;
      return { outcome, refused: ans?.content.result.refused };
    };
    expect(await call('ledger.expense.record', EXPENSE)).toEqual({ outcome: 'typed:call_refused:switched_off', refused: { code: 'switched_off', message: 'ledger.expense.record is switched off' } });
    await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.expense.record': 'ask_first' } });
    expect((await call('ledger.journal.post', {})).refused).toMatchObject({ code: 'not_declared' });
    // Marketing's own line off: its gate never sends the ask.
    await P.api('PUT', '/api/switchboards/marketing', { settings: { 'ledger.expense.record': 'off' } });
    let tools: string[] = [];
    P.setBrain((v) => {
      tools = v.tools;
      return finish('ok');
    });
    // The board's NOTIFY drops the cached line at once; the next job is not offered it.
    await P.waitFor(async () => {
      const r = await P.ask('Book it again', undefined, 'marketing');
      await P.waitFor(async () => (await P.task(r.task_id)).task.status === 'COMPLETED', 'done');
      return !tools.includes(toolName('ledger.expense.record'));
    }, 'not offered once Marketing’s line is off');
  });
});
