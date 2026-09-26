// Phase 4 exit: Marketing asks Ledger for budget through the gateway; both
// operations tables match the audit; a2a tasks have their own lifecycle, a
// person approves in the owner app, and loops are refused.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, toolName, type BrainView, type Pilot } from '@neop/testkit';
import { ledgerApp, seedLedger } from '@neop/ledger';
import { DIWALI_CAMPAIGN, marketingApp, seedMarketing } from '../src/index.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot({ apps: [{ def: await marketingApp(), seed: seedMarketing }, { def: await ledgerApp(), seed: seedLedger }] });
});
afterAll(async () => P?.close());

const t = (key: string, args: unknown = {}) => ({ tool: toolName(key), args });
const finish = (summary: string, outcome = 'done') => t('job.finish', { outcome, summary });
const isMarketing = (v: BrainView) => v.tools.includes(toolName('marketing.campaigns.list'));
const acl = (ability_key: string) => P.api('POST', '/api/acl', { caller_app: 'marketing', target_app: 'ledger', ability_key });

describe('borrowing', () => {
  it('without an ACL row the borrowed ability is not offered', async () => {
    let tools: string[] = [];
    P.setBrain((v) => {
      tools = v.tools;
      return finish('ok');
    });
    const r = await P.ask('What budget is left?', undefined, 'marketing');
    await P.waitFor(async () => (await P.task(r.task_id)).task.status === 'COMPLETED', 'done');
    expect(tools).not.toContain(toolName('ledger.budget.remaining'));
    expect(tools).toContain(toolName('a2a.request'));
  });

  it('with the ACL, Marketing reads the budget through the gateway; both books and the audit share one request id', async () => {
    expect((await acl('ledger.budget.remaining')).status).toBe(200);
    P.backend.core.borrowed.invalidate(P.company.id);
    let answer = '';
    P.setBrain((v) => {
      if (v.calls === 0) return t('ledger.budget.remaining', { account_code: '6400', month: '2026-09' });
      answer = v.results[0]!.text;
      return finish('Budget checked.');
    });
    const r = await P.ask('How much of the September marketing budget is left?', undefined, 'marketing');
    await P.waitFor(async () => (await P.task(r.task_id)).task.status === 'COMPLETED', 'done');
    expect(answer).toContain('trust="untrusted"');
    expect(answer).toContain('"remaining_minor": 6500000'); // ₹1,00,000 budget − ₹35,000 spent
    const mine = (await P.backends.marketing!.core.runnerPool.query("select gateway_request_id from marketing.operations where ability_key = 'borrow:ledger:ledger.budget.remaining' and job_id = $1", [r.job_id])).rows;
    expect(mine).toHaveLength(1);
    const rid = mine[0].gateway_request_id;
    const theirs = (await P.backends.ledger!.core.runnerPool.query("select caller, outcome from ledger.operations where gateway_request_id = $1", [rid])).rows;
    expect(theirs).toEqual([{ caller: 'app:marketing', outcome: 'served' }]);
    const audit = (await P.platform.db.query('select actor, app_key, action from neos.audit where request_id = $1', [rid])).rows;
    expect(audit).toEqual([{ actor: 'app:marketing', app_key: 'ledger', action: 'l3.ledger.budget.remaining' }]);
  });

  it('the owner’s switch still decides: off at Ledger refuses the borrowed read', async () => {
    await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.budget.remaining': 'off' } });
    let seen = '';
    P.setBrain((v) => {
      if (v.calls === 0) return t('ledger.budget.remaining', { account_code: '6400', month: '2026-09' });
      seen = v.results[0]!.text;
      return finish('blocked', 'blocked');
    });
    const r = await P.ask('Budget left?', undefined, 'marketing');
    await P.waitFor(async () => (await P.task(r.task_id)).task.status === 'COMPLETED', 'done');
    expect(seen).toMatch(/Refused/);
    await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.budget.remaining': 'on' } });
    P.backend.core.borrowed.invalidate(P.company.id);
  });
});

describe('a2a tasks', () => {
  it('without an ACL for tasks.open the hand-off is refused', async () => {
    let seen = '';
    P.setBrain((v) => {
      if (v.calls === 0) return t('a2a.request', { app: 'ledger', ask: 'Post the ad spend' });
      seen = v.results[0]!.text;
      return finish('could not hand off', 'blocked');
    });
    const r = await P.ask('Book the ad spend in the ledger', undefined, 'marketing');
    await P.waitFor(async () => (await P.task(r.task_id)).task.status === 'COMPLETED', 'done');
    expect(seen).toMatch(/Refused by the gate \(denied\)/);
  });

  it('spend approved in Marketing, bookkeeping handed to Ledger, approved there by a person, result back to Marketing', async () => {
    await acl('tasks.open');
    await P.api('PUT', '/api/switchboards/ledger', { approvals: { 'ledger.journal.post': { four_eyes: true } } });
    const anil = await P.platform.createUser(P.company.id, { name: 'Anil', email: 'anil@acme.example', role: 'admin' });
    let marketingWoke: string[] = [];
    P.setBrain((v) => {
      if (isMarketing(v)) {
        if (v.job.includes('WOKEN') && v.job.includes('is now DONE')) {
          marketingWoke.push('spend');
          return v.calls === 0 ? t('a2a.request', { app: 'ledger', ask: 'Post a journal entry: debit 6400, credit 2000, 2500000 paise INR, memo Google Ads Diwali' }) : { text: 'waiting' };
        }
        if (v.job.includes('answered the task')) {
          marketingWoke.push('ledger');
          return finish('Spend committed and booked in Ledger.');
        }
        return v.calls === 0
          ? t('marketing.spend.commit', {
              campaign_id: DIWALI_CAMPAIGN,
              vendor: 'Google Ads',
              amount_minor: 2_500_000,
              currency: 'INR',
              card: { what: 'Commit ₹25,000 to Google Ads for Diwali', why: 'campaign launch', changes: 'money committed', if_no_answer: 'nothing is committed' },
            })
          : { text: 'waiting' };
      }
      // Ledger's assistant
      if (v.job.includes('WOKEN')) return finish('Journal entry posted for the Google Ads spend.');
      return v.calls === 0
        ? t('ledger.journal.post', {
            date: '2026-09-30',
            memo: 'Google Ads Diwali',
            currency: 'INR',
            lines: [
              { account_code: '6400', debit_minor: 2_500_000, credit_minor: 0 },
              { account_code: '2000', debit_minor: 0, credit_minor: 2_500_000 },
            ],
            card: { what: 'Post ₹25,000 ad spend', why: 'asked by Marketing', changes: 'one journal entry', if_no_answer: 'nothing is posted' },
          })
        : { text: 'waiting' };
    });
    const r = await P.ask('Launch the Diwali search spend: ₹25,000 with Google Ads', undefined, 'marketing');
    const spendCard = await P.waitFor(async () => (await P.desk()).find((c) => c.task_id === r.task_id && c.status === 'PENDING'), 'spend card');
    await P.api('POST', `/api/desk/${spendCard.id}/answer`, { decision: 'yes', fingerprint_seen: spendCard.fingerprint });

    const ledgerCard = await P.waitFor(async () => (await P.desk()).find((c) => c.app_key === 'ledger' && c.ability_key === 'ledger.journal.post' && c.status === 'PENDING'), 'ledger card');
    const ledgerTask = (await P.platform.db.query('select * from neos.tasks where id = $1', [ledgerCard.task_id])).rows[0];
    expect(ledgerTask).toMatchObject({ requester: 'app:marketing', parent_task_id: r.task_id, lineage: ['marketing'] });
    // Four-eyes follows the chain back to the person who started it: Priya asked Marketing, so she cannot approve Ledger's posting.
    const own = await P.api('POST', `/api/desk/${ledgerCard.id}/answer`, { decision: 'yes', fingerprint_seen: ledgerCard.fingerprint });
    expect(own.body.error.code).toBe('four_eyes');
    await P.api('POST', `/api/desk/${ledgerCard.id}/answer`, { decision: 'yes', fingerprint_seen: ledgerCard.fingerprint }, anil.token);

    const done = await P.waitFor(async () => {
      const x = await P.task(r.task_id);
      return x.task.status === 'COMPLETED' && x;
    }, 'marketing task completed', 20_000);
    expect(done.task.result.summary).toBe('Spend committed and booked in Ledger.');
    expect(marketingWoke).toEqual(['spend', 'ledger']);
    const entry = (await P.backends.ledger!.core.runnerPool.query("select count(*)::int as n from ledger.operations where ability_key = 'ledger.journal.post' and outcome = 'DONE'")).rows[0].n;
    expect(entry).toBe(1);
    const job = await P.jobRow(ledgerTask.job_id, 'ledger');
    expect(job.source).toBe('a2a');
    await P.api('PUT', '/api/switchboards/ledger', { approvals: { 'ledger.journal.post': {} } });
  });

  it('refuses loops and chains deeper than three', async () => {
    const parent = (await P.platform.db.query("select id from neos.tasks where requester = 'app:marketing' order by created_at desc limit 1")).rows[0].id;
    await expect(P.platform.openA2ATask('ledger', { company_id: P.company.id, target: 'marketing', ask: 'loop back', parent_task_id: parent, host_job_id: parent })).rejects.toMatchObject({
      code: 'a2a_loop',
    });
    const deep = (await P.platform.db.query(`insert into neos.tasks (company_id, app_key, requester, ask, lineage) values ($1, 'ledger', 'app:x', 'deep', '["a","b","c"]') returning id`, [P.company.id])).rows[0].id;
    await expect(P.platform.openA2ATask('ledger', { company_id: P.company.id, target: 'marketing', ask: 'too deep', parent_task_id: deep, host_job_id: deep })).rejects.toMatchObject({
      code: 'a2a_depth',
    });
  });
});
