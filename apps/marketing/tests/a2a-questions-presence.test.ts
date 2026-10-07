// a2a-questions-presence.test · a2a-questions.test with NEOP_PRESENCE on (V3 migration S6, v3 §9): Marketing hands
// work to Ledger in the company's bus room, for a person. Ledger's job knows whom it serves (on_behalf_of, from the
// task body) and who asked (requester = Marketing's Matrix id). Its question goes back into the thread as a typed
// ask — to the asking app, never straight to a person — and Marketing's job wakes with it. Marketing does not know,
// so it asks ITS person (job_ask); Priya answers; Marketing relays her answer with a typed answer. At Ledger that
// answer is relayed data (app:<Marketing>), never a person's word; Ledger carries on; Marketing wakes with the result.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, MATRIX, toolName, type BrainView, type Pilot } from '@neop/testkit';
import { ledgerApp, seedLedger } from '@neop/ledger';
import { roomsSetup } from '../../../scripts/rooms-setup.ts';
import { marketingApp, seedMarketing } from '../src/index.ts';

let P: Pilot;
let BUS = '';
const PRIYA = '@priya:acme.example';
beforeAll(async () => {
  P = await bootPilot({ apps: [{ def: await marketingApp(), seed: seedMarketing }, { def: await ledgerApp(), seed: seedLedger }], presence: 'appservice', presenceAll: true });
  expect((await P.api('PUT', `/api/users/${P.admin.id}/chat`, { matrix_user_id: PRIYA })).status).toBe(200);
  BUS = (await roomsSetup({ neosUrl: P.platformUrl, adminToken: P.admin.token, homeserverUrl: P.hs!.url, company: 'acmetraders', apps: ['marketing', 'ledger'].map((app) => ({ app, asToken: MATRIX.asToken })) })).bus_room_id;
  await P.waitFor(async () => ['marketing', 'ledger'].every((a) => P.hs!.joined.some((j) => j.room === BUS && j.user === P.neopUsers[a])), 'both apps in the bus room');
}, 60_000);
afterAll(async () => P?.close());

const t = (key: string, args: unknown = {}) => ({ tool: toolName(key), args });
const finish = (summary: string, outcome = 'done') => t('job.finish', { outcome, summary });
const isMarketing = (v: BrainView) => v.tools.includes(toolName('marketing.campaigns.list'));

describe('a question from the callee goes back to the app that asked, in the thread', () => {
  it('Ledger’s job is on behalf of Priya; its question wakes Marketing’s job; Marketing asks Priya and relays her answer; both jobs finish', async () => {
    const MKT = P.neopUsers.marketing!;
    const ledgerSaw: string[] = [];
    const marketingSaw: string[] = [];
    P.setBrain((v) => {
      if (isMarketing(v)) {
        marketingSaw.push(v.job);
        if (v.job.includes('answered the task you handed it')) return finish('Ledger booked it against the cost centre you named.');
        if (v.job.includes('You asked:')) {
          const [context] = JSON.parse(/<data source="a2a.pending_questions" trust="untrusted">\n([\s\S]*?)\n<\/data>/.exec(v.job)![1]!);
          return v.calls === 0 ? t('a2a.answer', { task_id: context.task_id, question_wait_id: context.question_wait_id,
            answers: { cost_centre: 'digital' } }) : { text: 'waiting' };
        }
        if (v.job.includes('asks a question')) {
          // Marketing does not know the cost centre: it asks its own person, then relays.
          return v.calls === 0 ? t('job.ask', { text: 'Which cost centre should Ledger use?', why: 'Ledger needs it to check the Q4 budget.', fields: [{ key: 'cost_centre', label: 'Cost centre' }] }) : { text: 'waiting' };
        }
        return v.calls === 0 ? t('a2a.request', { app: 'ledger', ask: 'How much of the Q4 ad budget is left?' }) : { text: 'waiting' };
      }
      ledgerSaw.push(v.job);
      if (v.job.includes('You asked:')) return finish('₹12,40,000 of the digital Q4 budget is left.');
      return v.calls === 0
        ? t('job.ask', { text: 'Which cost centre?', why: 'The Q4 ad budget is split between two cost centres.', fields: [{ key: 'cost_centre', label: 'Cost centre' }] })
        : { text: 'waiting' };
    });
    const r = await P.api('POST', '/api/ask', { text: 'Diwali budget check: how much of Q4 ad budget is left?', app: 'marketing' });
    expect(r.status).toBe(200);

    // Ledger's job: the asking app is the requester, Priya is on_behalf_of — and its question went to the thread.
    const task = await P.waitFor(async () => P.hs!.typed.find((e) => e.room === BUS && e.type === 'neos.neop.task' && e.user === MKT), 'the task on the bus');
    const job = await P.waitFor(async () => (await P.backends.ledger!.core.runnerPool.query('select * from ledger.jobs where origin = $1', [task.event_id])).rows[0], 'Ledger’s job');
    expect(job).toMatchObject({ source: 'a2a', requester: `app:${MKT}`, on_behalf_of: `user:${P.admin.id}` });
    await P.waitFor(async () => ledgerSaw.length > 0, 'Ledger’s first session');
    expect(ledgerSaw[0]).toContain(`Asked by app:${MKT} (a2a) on behalf of user:${P.admin.id}`);
    const ask = await P.waitFor(async () => P.hs!.typed.find((e) => e.room === BUS && e.type === 'neos.neop.ask' && e.content['m.relates_to']?.event_id === task.event_id), 'Ledger’s typed ask');
    expect(ask.content.question.text).toBe('Which cost centre?');

    // Marketing's own question goes to Priya (the platform's question list; she is who Marketing works for).
    const q = await P.waitFor(async () => (await P.api('GET', '/api/questions')).body.questions.find((x: any) => x.app_key === 'marketing'), 'Marketing’s question to Priya');
    expect(q).toMatchObject({ text: 'Which cost centre should Ledger use?', asked_of: P.admin.id });
    expect(marketingSaw.find((j) => j.includes('asks a question'))).toMatch(/<data source="ledger\.ask" trust="untrusted">[\s\S]*Which cost centre\?/);
    // Ledger's wait is still open: nobody has answered it yet.
    expect((await P.backends.ledger!.core.runnerPool.query('select status from ledger.waits where id = $1', [ask.content.wait_id])).rows[0].status).toBe('pending');

    const a = await P.api('POST', `/api/questions/${q.id}/answer`, { answers: { cost_centre: 'digital' } });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const done = await P.waitFor(async () => {
      const x = await P.task(r.body.task_id);
      return x.task.status === 'COMPLETED' && x;
    }, 'Marketing completed', 25_000);
    expect(done.task.result.summary).toBe('Ledger booked it against the cost centre you named.');
    // Marketing woke with Priya's answer in her own words; it relayed it in the thread.
    expect(marketingSaw.find((j) => j.includes('You asked:'))).toContain(`user:${P.admin.id} answered (desk). Their answer, in their own words:`);
    const relayed = P.hs!.typed.find((e) => e.room === BUS && e.type === 'neos.neop.answer' && e.user === MKT && e.content.wait_id === ask.content.wait_id)!;
    expect(relayed.content).toMatchObject({ answers: { cost_centre: 'digital' }, 'm.relates_to': { event_id: task.event_id } });
    // At Ledger the answer is relayed data from the app, never a person's word.
    const woke = ledgerSaw.find((j) => j.includes('You asked:'))!;
    expect(woke).toContain(`An answer was relayed by app:${MKT} (bridge), not given by a person directly`);
    expect(woke).not.toContain('in their own words');
    expect((await P.backends.ledger!.core.runnerPool.query('select answered_by from ledger.waits where id = $1', [ask.content.wait_id])).rows[0].answered_by).toBe(`app:${MKT}`);
    expect(marketingSaw.find((j) => j.includes('answered the task you handed it'))).toContain('₹12,40,000 of the digital Q4 budget is left.');
    // Not through the platform's a2a routing.
    expect((await P.platform.db.query("select count(*)::int as n from neos.tasks where requester like 'app:%'")).rows[0].n).toBe(0);
  });
});
