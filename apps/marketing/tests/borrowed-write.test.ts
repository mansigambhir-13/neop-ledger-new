// borrowed-write.test · v3 §10 "one step in another app's subject". Marketing's manifest `uses` Ledger's WRITE
// ledger.expense.record. With the ACL row a person granted for exactly that ability (and no tasks.open grant),
// it is a borrowed line on Marketing's board; calling it never runs it in Marketing: it opens an a2a task at
// Ledger — Ledger's gate proposes it, a person says yes on the desk, Ledger carries it out once — and Marketing's
// job waits on that task (waits.kind a2a_task) and is woken with the result.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, toolName, type BrainView, type Pilot } from '@neop/testkit';
import { ledgerApp, seedLedger } from '@neop/ledger';
import { marketingApp, seedMarketing } from '../src/index.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot({ apps: [{ def: await marketingApp(), seed: seedMarketing }, { def: await ledgerApp(), seed: seedLedger }] });
});
afterAll(async () => P?.close());

const t = (key: string, args: unknown = {}) => ({ tool: toolName(key), args });
const finish = (summary: string, outcome = 'done') => t('job.finish', { outcome, summary });
const isMarketing = (v: BrainView) => v.tools.includes(toolName('marketing.campaigns.list'));
const EXPENSE = { date: '2026-09-21', currency: 'INR', description: 'Diwali flyers printing', amount_minor: 120_000, gst_rate_bps: 0, account_code: '6400' };
const expenseOps = async () => (await P.backends.ledger!.core.runnerPool.query("select count(*)::int as n from ledger.operations where ability_key = 'ledger.expense.record' and outcome = 'DONE'")).rows[0].n as number;

describe('a borrowed write', () => {
  it('is declared in the manifest and accepted at registration (a `uses` line may name an owner’s write)', async () => {
    const m = (await P.platform.db.query("select manifest from neos.apps where key = 'marketing'")).rows[0].manifest;
    expect(m.uses).toContainEqual({ app: 'ledger', ability: 'ledger.expense.record', range: '^1.0.0' });
  });

  it('without an ACL row it is not offered', async () => {
    let tools: string[] = [];
    P.setBrain((v) => {
      tools = v.tools;
      return finish('ok');
    });
    const r = await P.ask('Book the flyer printing', undefined, 'marketing');
    await P.waitFor(async () => (await P.task(r.task_id)).task.status === 'COMPLETED', 'done');
    expect(tools).not.toContain(toolName('ledger.expense.record'));
  });

  it('with the ACL: Marketing’s call opens a task at Ledger; Ledger proposes; a person says yes; executed once; Marketing is woken with the result', async () => {
    expect((await P.api('POST', '/api/acl', { caller_app: 'marketing', target_app: 'ledger', ability_key: 'ledger.expense.record' })).status).toBe(200);
    P.backend.core.borrowed.invalidate(P.company.id);
    const before = await expenseOps();
    let marketingTools: string[] = [];
    let handedOff = '';
    let ledgerAsk = '';
    P.setBrain((v) => {
      if (isMarketing(v)) {
        if (v.job.includes('WOKEN')) return finish('Flyer printing booked in Ledger.');
        if (v.calls === 0) {
          marketingTools = v.tools;
          // Only the inputs: the card is written by Ledger's assistant, where the yes is asked for.
          return t('ledger.expense.record', EXPENSE);
        }
        handedOff = v.results[0]!.text;
        return { text: 'waiting' };
      }
      // Ledger's assistant: the step arrives as a task; it proposes it through its own gate.
      if (v.job.includes('WOKEN')) return finish('Recorded the ₹1,200.00 flyer printing expense.');
      if (v.calls === 0) {
        ledgerAsk = v.job;
        return t('ledger.expense.record', { ...EXPENSE, card: { what: 'Record ₹1,200 flyer printing', why: 'borrowed by Marketing', changes: 'one expense entry', if_no_answer: 'nothing is recorded' } });
      }
      return { text: 'waiting' };
    });
    const r = await P.ask('Book the ₹1,200 Diwali flyer printing as an expense', undefined, 'marketing');

    const card = await P.waitFor(async () => (await P.desk()).find((c) => c.app_key === 'ledger' && c.ability_key === 'ledger.expense.record' && c.status === 'PENDING'), 'ledger card');
    expect(marketingTools).toContain(toolName('ledger.expense.record'));
    const step = (await P.backends.marketing!.core.runnerPool.query("select summary, ability_key from marketing.steps where job_id = $1 and kind = 'system' and summary like 'Handed one step%'", [r.job_id])).rows;
    expect(step).toEqual([{ summary: expect.stringMatching(/^Handed one step to ledger \(task [0-9a-f]{8}\): /), ability_key: 'ledger.expense.record' }]);
    void handedOff;
    expect(ledgerAsk).toContain('borrows one step in your subject');
    expect(ledgerAsk).toContain('"amount_minor":120000');
    expect(ledgerAsk).not.toContain('"card"');
    const task = (await P.platform.db.query('select * from neos.tasks where id = $1', [card.task_id])).rows[0];
    expect(task).toMatchObject({ app_key: 'ledger', requester: 'app:marketing', parent_task_id: r.task_id, lineage: ['marketing'], borrowed_ability: 'ledger.expense.record' });
    // Marketing's job waits on that task; Marketing ran nothing itself.
    const wait = (await P.backends.marketing!.core.runnerPool.query("select kind, ref_id, status from marketing.waits where job_id = $1 and kind = 'a2a_task'", [r.job_id])).rows;
    expect(wait).toEqual([{ kind: 'a2a_task', ref_id: card.task_id, status: 'pending' }]);
    expect((await P.backends.marketing!.core.runnerPool.query("select count(*)::int as n from marketing.operations where ability_key like '%expense%'")).rows[0].n).toBe(0);
    expect(await expenseOps()).toBe(before); // nothing done before a person says yes

    await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    const done = await P.waitFor(async () => {
      const x = await P.task(r.task_id);
      return x.task.status === 'COMPLETED' && x;
    }, 'marketing task completed', 20_000);
    expect(done.task.result.summary).toBe('Flyer printing booked in Ledger.');
    expect(await expenseOps()).toBe(before + 1);
  });

  it('the owner’s switch still decides, and the platform refuses what the manifest does not declare or what is a read', async () => {
    await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.expense.record': 'off' } });
    P.backend.core.borrowed.invalidate(P.company.id);
    let tools: string[] = [];
    P.setBrain((v) => {
      tools = v.tools;
      return finish('ok');
    });
    const r = await P.ask('Book it again', undefined, 'marketing');
    await P.waitFor(async () => (await P.task(r.task_id)).task.status === 'COMPLETED', 'done');
    expect(tools).not.toContain(toolName('ledger.expense.record'));
    const parent = r.task_id;
    await expect(P.platform.openA2ATask('marketing', { company_id: P.company.id, target: 'ledger', ask: 'x', parent_task_id: parent, host_job_id: r.job_id, ability: 'ledger.expense.record', args: EXPENSE })).rejects.toMatchObject({
      code: 'switched_off',
    });
    await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.expense.record': 'ask_first' } });
    await expect(P.platform.openA2ATask('marketing', { company_id: P.company.id, target: 'ledger', ask: 'x', parent_task_id: parent, host_job_id: r.job_id, ability: 'ledger.journal.post', args: {} })).rejects.toMatchObject({
      code: 'not_declared',
    });
    expect((await P.api('POST', '/api/acl', { caller_app: 'marketing', target_app: 'ledger', ability_key: 'ledger.budget.remaining' })).status).toBe(200);
    await expect(P.platform.openA2ATask('marketing', { company_id: P.company.id, target: 'ledger', ask: 'x', parent_task_id: parent, host_job_id: r.job_id, ability: 'ledger.budget.remaining', args: {} })).rejects.toMatchObject({
      code: 'not_a_write',
    });
  });
});
