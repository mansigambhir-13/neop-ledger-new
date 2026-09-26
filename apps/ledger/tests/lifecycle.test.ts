// Expiry and UNKNOWN outcomes (S1, S2): both wake the job so it can tell the
// person; a late yes is refused; UNKNOWN is reconciled by reading back.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, call, finish, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => P?.close());

const email = () =>
  call('ledger.close_pack.email', {
    period: { from: '2026-08-01', to: '2026-08-31' },
    to: ['cfo@acme.example'],
    card: { what: 'Send pack', why: 'close', changes: 'one email', if_no_answer: 'nothing is sent' },
  });

describe('lifecycle', () => {
  it('an unanswered proposal expires, wakes the job, and a late yes is refused', async () => {
    let woken = '';
    P.setBrain((v) => {
      if (v.job.includes('WOKEN')) {
        woken = v.job;
        return finish('Nobody answered in time; nothing was sent.', 'blocked');
      }
      return v.calls === 0 ? email() : { text: 'waiting' };
    });
    const { task_id, job_id } = await P.ask('Send the pack');
    const card = await P.waitFor(async () => (await P.desk()).find((c) => c.job_id === job_id), 'card');
    // Nobody answers: move the deadline into the past (expiry runs on database time).
    await P.backend.core.runnerPool.query("update ledger.proposals set expires_at = now() - interval '1 second' where id = $1", [card.proposal_id]);
    await P.platform.db.query("update neos.approvals set expires_at = now() - interval '1 second' where id = $1", [card.id]);
    const t = await P.waitFor(async () => {
      const t = await P.task(task_id);
      return t.task.status === 'COMPLETED' && t;
    }, 'completed after expiry');
    expect(woken).toContain('is now EXPIRED');
    expect(t.task.result.outcome).toBe('blocked');
    await P.waitFor(async () => (await P.desk()).find((c) => c.id === card.id && c.status === 'EXPIRED'), 'card expired');
    const late = await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    expect(late.status).toBe(409);
  });

  it('an effect that may or may not have happened ends UNKNOWN, wakes the job, and is reconciled', async () => {
    // Break the mailbox so the send fails indeterminately and read-back cannot look.
    const broken = path.join(P.mailDir, 'not-a-dir');
    await writeFile(broken, 'x');
    await P.platform.setVaultSecret(P.company.id, 'email', { provider: 'dev-mailbox', dir: path.join(broken, 'box') });
    await P.backend.core.appPool.query('select 1');
    let woken = '';
    P.setBrain((v) => {
      if (v.job.includes('WOKEN')) {
        woken = v.job;
        return finish('The email may not have gone out; the app is checking.', 'failed');
      }
      return v.calls === 0 ? email() : { text: 'waiting' };
    });
    const { task_id, job_id } = await P.ask('Send the pack');
    const card = await P.waitFor(async () => (await P.desk()).find((c) => c.job_id === job_id && c.status === 'PENDING'), 'card');
    await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    await P.waitFor(async () => (await P.task(task_id)).task.status === 'FAILED', 'task reported');
    expect(woken).toContain('is now UNKNOWN');
    // Reconciliation reads back; the message never appears, so after its retries it is FAILED.
    await P.platform.setVaultSecret(P.company.id, 'email', { provider: 'dev-mailbox', dir: P.mailDir });
    const p = await P.waitFor(async () => {
      const r = await P.backend.core.runnerPool.query('select status, proof from ledger.proposals where id = $1', [card.proposal_id]);
      return r.rows[0].status === 'FAILED' && r.rows[0];
    }, 'reconciled', 20_000);
    expect(p.proof.reconcile_attempts).toBe(10);
  });

  it('a session that ends without reporting fails the job honestly', async () => {
    P.setBrain(() => ({ text: 'I think it is fine.' }));
    const { task_id } = await P.ask('What is our cash position?');
    const t = await P.waitFor(async () => {
      const t = await P.task(task_id);
      return t.task.status === 'FAILED' && t;
    }, 'failed');
    expect(t.task.result.summary).toContain('stopped without reporting');
  });
});
