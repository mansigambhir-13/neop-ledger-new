// a2a-questions.test · WP §9 with the WP §8 `ask`: Marketing hands work to Ledger for a person; Ledger's
// job knows whom it serves (on_behalf_of, from the platform's rootRequester) and, when it needs to know
// something, its question goes to that person — never to the calling app. The person answers (here by
// following up in their own conversation with Marketing); Ledger carries on; Marketing wakes with the result.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, toolName, type BrainView, type Pilot } from '@neop/testkit';
import { ledgerApp, seedLedger } from '@neop/ledger';
import { marketingApp, seedMarketing } from '../src/index.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot({ apps: [{ def: await marketingApp(), seed: seedMarketing }, { def: await ledgerApp(), seed: seedLedger }] });
  expect((await P.api('POST', '/api/acl', { caller_app: 'marketing', target_app: 'ledger', ability_key: 'tasks.open' })).status).toBe(200);
});
afterAll(async () => P?.close());

const t = (key: string, args: unknown = {}) => ({ tool: toolName(key), args });
const finish = (summary: string, outcome = 'done') => t('job.finish', { outcome, summary });
const isMarketing = (v: BrainView) => v.tools.includes(toolName('marketing.campaigns.list'));

describe('a question from the callee goes to the person the chain started from', () => {
  it('Ledger’s job is on behalf of Priya; its question is hers to answer; Marketing cannot answer it; her answer lets both jobs finish', async () => {
    const ledgerSaw: string[] = [];
    let marketingResult = '';
    P.setBrain((v) => {
      if (isMarketing(v)) {
        if (v.job.includes('answered the task')) return (marketingResult = v.job), finish('Ledger booked it against the cost centre you named.');
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
    const q = await P.waitFor(async () => (await P.api('GET', '/api/questions')).body.questions.find((x: any) => x.app_key === 'ledger'), 'Ledger’s question');
    const ledgerTask = (await P.platform.db.query('select * from neos.tasks where id = $1', [q.task_id])).rows[0];
    expect(ledgerTask).toMatchObject({ requester: 'app:marketing', parent_task_id: r.body.task_id, status: 'NEEDS_INPUT' });
    // Routed to the root person, shown in her conversation with Marketing.
    expect(q).toMatchObject({ root_task_id: r.body.task_id, asked_of: P.admin.id, asked_of_name: 'Priya', text: 'Which cost centre?' });
    const conv = await P.api('GET', `/api/conversations/${r.body.conversation_id}`);
    expect(conv.body.messages.find((m: any) => m.kind === 'card' && m.author === 'app:ledger').body).toMatch(/^Question: Ledger needs an answer — Which cost centre\?/);
    // Ledger's job knows whom it serves: the calling app is the requester, the person is on_behalf_of.
    const job = await P.jobRow(ledgerTask.job_id, 'ledger');
    expect(job).toMatchObject({ source: 'a2a', requester: 'app:marketing', on_behalf_of: `user:${P.admin.id}` });
    expect(ledgerSaw[0]).toContain(`Asked by app:marketing (a2a) on behalf of user:${P.admin.id}`);

    // The calling app never answers for the person: the gateway door is the platform's alone.
    await expect(P.platform.internalCall('marketing', { company_id: P.company.id, app: 'ledger', endpoint: 'waits.answer', body: { wait_id: q.wait_id, answers: { cost_centre: 'digital' }, answered_by: 'app:marketing' }, idem_key: 'mkt-answer' })).rejects.toMatchObject({ status: 403 });
    await expect(P.platform.gateway.call({ caller: 'app:marketing', app: 'ledger', endpoint: 'waits.answer', company_id: P.company.id, body: {}, idem_key: 'mkt-answer-2' })).rejects.toMatchObject({ status: 403 });
    expect((await P.platform.db.query('select status from neos.questions where id = $1', [q.id])).rows[0].status).toBe('OPEN');

    // Priya answers by replying in her own conversation (the thread correlates to Ledger's waiting job).
    const f = await P.api('POST', '/api/ask', { text: 'digital', conversation_id: r.body.conversation_id });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect(f.body).toMatchObject({ answered: true, question_id: q.id, handed_to: 'ledger' });
    const done = await P.waitFor(async () => { const x = await P.task(r.body.task_id); return x.task.status === 'COMPLETED' && x; }, 'Marketing completed', 20_000);
    expect(done.task.result.summary).toBe('Ledger booked it against the cost centre you named.');
    const woke = ledgerSaw.find((j) => j.includes('You asked:'))!;
    expect(woke).toContain(`user:${P.admin.id} answered (conversation). Their answer, in their own words:`);
    expect(woke).toContain('cost_centre: digital');
    expect(marketingResult).toContain('₹12,40,000 of the digital Q4 budget is left.');
    expect((await P.platform.db.query('select status, answered_by, answered_via from neos.questions where id = $1', [q.id])).rows[0]).toEqual({ status: 'ANSWERED', answered_by: `user:${P.admin.id}`, answered_via: 'conversation' });
  });
});
