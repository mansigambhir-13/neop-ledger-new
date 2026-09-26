// runtime-a2a.test · Ledger as the owner, Marketing (the Phase-4 fixture) as the
// host: a hand-off's result can never be lost to a race (the wait is written
// before the platform is asked), switchboard.changed drops the borrow cache, and
// what another party says in a refusal reaches the model only as data.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { marketingApp, seedMarketing } from '@neop/marketing';
import { bootPilot, ledgerUnderTest, toolName, type BrainView, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot({ apps: [{ def: await marketingApp(), seed: seedMarketing }, await ledgerUnderTest()] });
});
afterAll(async () => P?.close());

const t = (key: string, args: unknown = {}) => ({ tool: toolName(key), args });
const finish = (summary: string, outcome = 'done') => t('job.finish', { outcome, summary });
const isMarketing = (v: BrainView) => v.tools.includes(toolName('marketing.campaigns.list'));
const acl = (ability_key: string) => P.api('POST', '/api/acl', { caller_app: 'marketing', target_app: 'ledger', ability_key });
const done = (taskId: string) => P.waitFor(async () => ['COMPLETED', 'FAILED'].includes((await P.task(taskId)).task.status), 'task terminal');
const BUDGET = toolName('ledger.budget.remaining');

describe('refusals from other parties are data', () => {
  it('the platform refusing a hand-off: its message is wrapped as untrusted', async () => {
    let seen = '';
    P.setBrain((v) => {
      if (v.calls === 0) return t('a2a.request', { app: 'ledger', ask: 'Post the ad spend' });
      seen = v.results[0]!.text;
      return finish('refused', 'blocked');
    });
    const r = await P.ask('Hand the bookkeeping to Ledger', undefined, 'marketing');
    await done(r.task_id);
    expect(seen).toMatch(/Refused by the gate \([a-z_]+\): the platform answered 403\n<data source="platform" trust="untrusted">/);
    // The wait written before asking is closed, not left pending.
    const w = await P.backends.marketing!.core.runnerPool.query("select status, outcome from marketing.waits where job_id = $1 and kind = 'a2a_task'", [r.job_id]);
    expect(w.rows).toEqual([{ status: 'consumed', outcome: 'NOT_OPENED' }]);
  });
});

describe('borrowing', () => {
  it('switchboard.changed drops the borrow cache: a new ACL is offered at once, not in 30 s', async () => {
    let tools: string[] = [];
    P.setBrain((v) => {
      tools = v.tools;
      return finish('ok');
    });
    const ask = async () => {
      const r = await P.ask('What budget is left?', undefined, 'marketing');
      await done(r.task_id);
      return tools;
    };
    expect(await ask()).not.toContain(BUDGET); // no ACL; the list is now cached
    expect((await acl('ledger.budget.remaining')).status).toBe(200);
    expect(await ask()).not.toContain(BUDGET); // cached for 30 s …
    await P.platform.notifyApp('marketing', P.company.id); // … unless the platform says the board changed
    expect(await ask()).toContain(BUDGET);
  });

  it('the owner refusing a borrowed read: its message is wrapped as untrusted', async () => {
    // Off at Ledger; Marketing's cached list still offers it, so the owner itself refuses.
    await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.budget.remaining': 'off' } });
    let seen = '';
    P.setBrain((v) => {
      if (v.calls === 0) return t('ledger.budget.remaining', { account_code: '6400', month: '2026-09' });
      seen = v.results[0]!.text;
      return finish('blocked', 'blocked');
    });
    const r = await P.ask('Budget left?', undefined, 'marketing');
    await done(r.task_id);
    expect(seen).toMatch(/Refused by the gate \(owner_refused\): ledger answered 403\n<data source="ledger" trust="untrusted">\n"ledger\.budget\.remaining is switched off"\n<\/data>/);
    await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.budget.remaining': 'on' } });
  });
});

describe('a2a hand-off', () => {
  it('a result that arrives before the hand-off call returns is not lost: the platform is told to redeliver', async () => {
    await acl('tasks.open');
    let woke = '';
    P.setBrain((v) => {
      if (!isMarketing(v)) return { hang: true }; // Ledger's own job is not what this test is about
      if (v.job.includes('WOKEN')) {
        woke = v.job;
        return finish('Ledger posted it.');
      }
      return v.calls === 0 ? t('a2a.request', { app: 'ledger', ask: 'Post a journal entry for the ad spend' }) : { text: 'waiting' };
    });
    const mk = P.backends.marketing!.core.platform;
    const real = mk.openA2A.bind(mk);
    let early: { delivered: boolean; wait: any } | null = null;
    const spy = vi.spyOn(mk, 'openA2A').mockImplementation(async (req) => {
      const r = await real(req);
      // The target finishes instantly and the platform delivers the result before this call returns.
      await P.platform.db.query(`update neos.tasks set status = 'COMPLETED', result = $2 where id = $1`, [
        r.body.task_id,
        JSON.stringify({ outcome: 'done', summary: 'Posted the ad spend (fast)', changed: ['JE-FAST'], could_not: [], sources: [] }),
      ]);
      await P.platform.a2aResultsTick();
      const d = await P.platform.db.query('select result_delivered_at from neos.tasks where id = $1', [r.body.task_id]);
      const w = await P.backends.marketing!.core.runnerPool.query("select status, ref_id from marketing.waits where job_id = $1 and kind = 'a2a_task'", [req.host_job_id]);
      early = { delivered: d.rows[0].result_delivered_at !== null, wait: w.rows[0] };
      return r;
    });
    try {
      const r = await P.ask('Hand the ad-spend bookkeeping to Ledger', undefined, 'marketing');
      await P.waitFor(async () => (await P.task(r.task_id)).task.status === 'COMPLETED', 'woken by the redelivered result', 20_000);
      expect(early).not.toBeNull();
      expect(early!.wait).toEqual({ status: 'pending', ref_id: null }); // the wait existed before the result arrived
      expect(early!.delivered).toBe(false); // answered "try again" (503, retried, never stored as final), so the platform kept it
      expect(woke).toContain('Posted the ad spend (fast)');
      const w = await P.backends.marketing!.core.runnerPool.query("select status, outcome from marketing.waits where job_id = $1 and kind = 'a2a_task'", [r.job_id]);
      expect(w.rows).toEqual([{ status: 'consumed', outcome: 'COMPLETED' }]);
    } finally {
      spy.mockRestore();
    }
  });
});
