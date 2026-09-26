// proposal.test · execute once, fingerprint-bound, stale yes refused; change,
// no, grants and money caps.
import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, call, finish, type BrainView, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => P?.close());

const CARD = { what: 'Email the August close pack', why: 'Month-end', changes: 'One email leaves the company', if_no_answer: 'Nothing is sent' };
const email = (to: string[]) => call('ledger.close_pack.email', { period: { from: '2026-08-01', to: '2026-08-31' }, to, card: CARD });
const post = (amount: number, memo = 'Accrue August audit fee') =>
  call('ledger.journal.post', {
    date: '2026-08-31',
    memo,
    currency: 'INR',
    lines: [
      { account_code: '6300', debit_minor: amount, credit_minor: 0 },
      { account_code: '2000', debit_minor: 0, credit_minor: amount },
    ],
    card: { what: `Post ${amount} paise audit accrual`, why: 'Month-end accrual', changes: 'One journal entry', if_no_answer: 'Nothing is posted' },
  });

async function pendingCard(jobId: string) {
  return P.waitFor(async () => (await P.desk()).find((c) => c.job_id === jobId && c.status === 'PENDING'), 'pending card');
}
async function taskDone(taskId: string) {
  return P.waitFor(async () => {
    const t = await P.task(taskId);
    return ['COMPLETED', 'FAILED'].includes(t.task.status) && t;
  }, 'task terminal');
}
const mails = async () => (await readdir(P.mailDir)).length;

describe('proposal', () => {
  it('refuses a stale yes: an answer against a different fingerprint does nothing', async () => {
    P.setBrain((v: BrainView) => (v.job.includes('WOKEN') ? finish('stopped') : v.calls === 0 ? email(['cfo@acme.example']) : { text: 'waiting' }));
    const { job_id } = await P.ask('Email the August pack to the CFO');
    const card = await pendingCard(job_id);
    const before = await mails();
    await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: 'sha256:' + '0'.repeat(64) });
    const refused = await P.waitFor(async () => (await P.desk()).find((c) => c.id === card.id && c.status === 'REFUSED'), 'refused');
    expect(refused.last_error).toContain('fingerprint_mismatch');
    const p = await P.backend.core.runnerPool.query('select status from ledger.proposals where id = $1', [card.proposal_id]);
    expect(p.rows[0].status).toBe('PROPOSED');
    expect(await mails()).toBe(before);
    const ev = await P.backend.core.runnerPool.query("select event from ledger.proposal_events where proposal_id = $1 and event like 'answer_refused%'", [card.proposal_id]);
    expect(ev.rowCount).toBe(1);
  });

  it('carries out a yes exactly once; a retried execute returns the stored proof', async () => {
    P.setBrain((v) => (v.job.includes('WOKEN') ? finish('sent') : v.calls === 0 ? email(['cfo@acme.example']) : { text: 'waiting' }));
    const { task_id, job_id } = await P.ask('Email the August pack to the CFO');
    const card = await pendingCard(job_id);
    const before = await mails();
    await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    await taskDone(task_id);
    expect(await mails()).toBe(before + 1);
    // A second execute (new token, new idempotency key) must do nothing new.
    const again = await P.platform.gateway.call({
      caller: 'platform',
      app: 'ledger',
      endpoint: 'proposals.execute',
      company_id: P.company.id,
      body: { proposal_id: card.proposal_id },
      idem_key: `retry:${card.id}`,
      exec: { proposal_id: card.proposal_id, fingerprint: card.fingerprint },
    });
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe('DONE');
    expect(await mails()).toBe(before + 1);
    const ops = await P.backend.core.runnerPool.query('select count(*)::int as n from ledger.operations where ability_key = $1 and detail->>\'proposal_id\' = $2', ['ledger.close_pack.email', card.proposal_id]);
    expect(ops.rows[0].n).toBe(1);
  });

  it('two executes racing for the same yes carry it out once and write one outcome', async () => {
    P.setBrain((v) => (v.job.includes('WOKEN') ? finish('sent') : v.calls === 0 ? email(['cfo@acme.example']) : { text: 'waiting' }));
    const { job_id } = await P.ask('Email the pack');
    const card = await pendingCard(job_id);
    // Record the yes in the app without the platform worker executing it.
    await P.platform.db.query("update neos.approvals set status = 'RESOLVED', decision = 'yes', fingerprint_seen = fingerprint, decided_by = $2, next_attempt_at = now() + interval '1 hour' where id = $1", [card.id, P.admin.id]);
    const r = await P.platform.gateway.call({ caller: 'platform', app: 'ledger', endpoint: 'proposals.resolve', company_id: P.company.id, idem_key: `race-r:${card.id}`,
      body: { proposal_id: card.proposal_id, decision: 'yes', fingerprint_seen: card.fingerprint, decided_by: `user:${P.admin.id}` } });
    expect(r.status).toBe(200);
    const before = await mails();
    const exec = (k: string) => P.platform.gateway.call({ caller: 'platform', app: 'ledger', endpoint: 'proposals.execute', company_id: P.company.id, body: { proposal_id: card.proposal_id }, idem_key: k, exec: { proposal_id: card.proposal_id, fingerprint: card.fingerprint } });
    const [a, b] = await Promise.all([exec(`race-a:${card.id}`), exec(`race-b:${card.id}`)]);
    expect([a.status, b.status].sort()).toEqual([200, 409].sort()); // one carries it out, the other is told it is in progress
    expect(await mails()).toBe(before + 1);
    const ev = await P.backend.core.runnerPool.query("select count(*)::int as n from ledger.proposal_events where proposal_id = $1 and event like 'executed:%'", [card.proposal_id]);
    expect(ev.rows[0].n).toBe(1);
  });

  it('an execution token bound to another fingerprint is refused', async () => {
    P.setBrain((v) => (v.job.includes('WOKEN') ? finish('x') : v.calls === 0 ? email(['cfo@acme.example']) : { text: 'waiting' }));
    const { job_id } = await P.ask('Email the pack');
    const card = await pendingCard(job_id);
    const r = await P.platform.gateway.call({
      caller: 'platform',
      app: 'ledger',
      endpoint: 'proposals.execute',
      company_id: P.company.id,
      body: { proposal_id: card.proposal_id },
      idem_key: `forged:${card.id}`,
      exec: { proposal_id: card.proposal_id, fingerprint: 'sha256:' + 'f'.repeat(64) },
    });
    expect(r.status).toBe(409);
    // …and a correctly bound token still cannot execute something nobody approved.
    const r2 = await P.platform.gateway.call({
      caller: 'platform',
      app: 'ledger',
      endpoint: 'proposals.execute',
      company_id: P.company.id,
      body: { proposal_id: card.proposal_id },
      idem_key: `unapproved:${card.id}`,
      exec: { proposal_id: card.proposal_id, fingerprint: card.fingerprint },
    });
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('not_approved');
  });

  it('"change this first" supersedes the proposal and the assistant proposes again with a new fingerprint', async () => {
    let second = false;
    P.setBrain((v) => {
      if (v.job.includes('SUPERSEDED') && v.calls === 0) {
        second = true;
        return email(['cfo@acme.example', 'ca@acme.example']);
      }
      if (v.job.includes('WOKEN') && !v.job.includes('SUPERSEDED')) return finish('done');
      return v.calls === 0 ? email(['cfo@acme.example']) : { text: 'waiting' };
    });
    const { job_id } = await P.ask('Email the pack');
    const card = await pendingCard(job_id);
    await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'change', fingerprint_seen: card.fingerprint, feedback: 'Copy the CA too' });
    const next = await P.waitFor(async () => (await P.desk()).find((c) => c.job_id === job_id && c.status === 'PENDING' && c.id !== card.id), 'new card');
    expect(second).toBe(true);
    expect(next.fingerprint).not.toBe(card.fingerprint);
    expect(next.args.to).toEqual(['cfo@acme.example', 'ca@acme.example']);
    const old = await P.backend.core.runnerPool.query('select status, feedback from ledger.proposals where id = $1', [card.proposal_id]);
    expect(old.rows[0]).toMatchObject({ status: 'SUPERSEDED', feedback: 'Copy the CA too' });
    expect((await P.desk()).find((c) => c.id === card.id).status).toBe('CLOSED');
  });

  it('a no stops the job and nothing is done', async () => {
    P.setBrain((v) => (v.job.includes('REJECTED') ? finish('The person said no; nothing was posted.', 'blocked') : v.calls === 0 ? post(500_000) : { text: 'waiting' }));
    const { task_id, job_id } = await P.ask('Accrue the audit fee');
    const card = await pendingCard(job_id);
    await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'no', fingerprint_seen: card.fingerprint }, P.member.token);
    const t = await taskDone(task_id);
    expect(t.task.result.outcome).toBe('blocked');
    const e = await P.backend.core.runnerPool.query('select count(*)::int as n from ledger.operations where ability_key = $1', ['ledger.journal.post']);
    expect(e.rows[0].n).toBe(0);
  });

  it('a standing yes (grant) carries out a covered write without a card; over its limit it asks', async () => {
    const g = await P.api('POST', '/api/grants', {
      app_key: 'ledger',
      ability_key: 'ledger.journal.post',
      limits: { per_call_minor: 1_000_000, currency: 'INR' },
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(g.status).toBe(200);
    let res = '';
    P.setBrain((v) => {
      if (v.calls === 0) return post(400_000, 'Small accrual under the grant');
      res = v.results[0]!.text;
      return finish('posted');
    });
    const a = await P.ask('Accrue small fee');
    await taskDone(a.task_id);
    expect(res).toContain('standing yes');
    const posted = await P.backend.core.runnerPool.query("select status, approved_via from ledger.proposals where job_id = $1", [a.job_id]);
    expect(posted.rows[0]).toMatchObject({ status: 'DONE', approved_via: 'grant' });

    P.setBrain((v) => (v.calls === 0 ? post(5_000_000, 'Large accrual over the grant') : { text: 'waiting' }));
    const b = await P.ask('Accrue large fee');
    const card = await pendingCard(b.job_id);
    expect(card.ability_key).toBe('ledger.journal.post');
  });

  it('a company amount cap refuses before anything is proposed', async () => {
    const r = await P.api('PUT', '/api/switchboards/ledger', {
      rules: [{ id: 'journal-cap', type: 'amount_cap', currency: 'INR', per_call_minor: 10_000_000, applies_to: ['ledger.journal.post'] }],
    });
    expect(r.status).toBe(200);
    let seen = '';
    P.setBrain((v) => {
      if (v.calls === 0) return post(20_000_000, 'Huge accrual');
      seen = v.results[0]!.text;
      return finish('refused by rule', 'blocked');
    });
    const a = await P.ask('Accrue huge fee');
    await taskDone(a.task_id);
    expect(seen).toContain('rule:journal-cap');
    const n = await P.backend.core.runnerPool.query('select count(*)::int as n from ledger.proposals where job_id = $1', [a.job_id]);
    expect(n.rows[0].n).toBe(0);
    await P.api('PUT', '/api/switchboards/ledger', { rules: [] });
  });
});
