import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, call, finish, proposalIdFrom, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => {
  await P?.close();
});

describe('pilot end to end', () => {
  it('a report request returns a sourced report', async () => {
    P.setBrain((v) => {
      if (v.calls === 0) return call('book.note', { text: 'Understood: P&L for August 2026.' });
      if (v.calls === 1) return call('ledger.report.pnl', { from: '2026-08-01', to: '2026-08-31' });
      const pnl = v.results[1]!.text;
      const net = /"net_profit_minor": (-?\d+)/.exec(pnl)?.[1];
      return finish(`Net profit for August 2026 was ${net} paise.`, 'done', { sources: ['ledger.report.pnl 2026-08-01..2026-08-31'] });
    });
    const t0 = Date.now();
    const { task_id, job_id } = await P.ask('Show me the P&L for August 2026');
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(job_id).toMatch(/[0-9a-f-]{36}/);
    const t = await P.waitFor(async () => {
      const t = await P.task(task_id);
      return t.task.status === 'COMPLETED' && t;
    }, 'task completed');
    expect(t.task.result.outcome).toBe('done');
    expect(t.task.result.summary).toMatch(/Net profit for August 2026 was -?\d+ paise/);
    expect(t.activity.map((a: any) => a.kind)).toEqual(expect.arrayContaining(['received', 'note', 'ability', 'report']));
  });

  it('a gated email becomes a proposal, a yes carries it out once, the assistant reports proof', async () => {
    let woken = '';
    P.setBrain((v) => {
      if (v.job.includes('YOU ARE BEING WOKEN')) {
        woken = v.job;
        return finish('Close pack sent to cfo@acme.example as approved.', 'done');
      }
      if (v.calls === 0)
        return call('ledger.close_pack.email', {
          period: { from: '2026-08-01', to: '2026-08-31' },
          to: ['cfo@acme.example'],
          card: { what: 'Email the August close pack to cfo@acme.example', why: 'Month-end close', changes: 'One email leaves the company', if_no_answer: 'Nothing is sent' },
        });
      return { text: 'waiting' };
    });
    const { task_id, job_id } = await P.ask('Send the August close pack to cfo@acme.example');
    const card = await P.waitFor(async () => (await P.desk()).find((c) => c.job_id === job_id && c.status === 'PENDING'), 'card on desk');
    expect(card.card.what).toContain('close pack');
    expect((await P.jobRow(job_id)).status).toBe('WAITING');
    expect(await readdir(P.mailDir)).toHaveLength(0);

    const r = await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    expect(r.status).toBe(200);
    const t = await P.waitFor(async () => {
      const t = await P.task(task_id);
      return t.task.status === 'COMPLETED' && t;
    }, 'task completed after yes');
    expect(t.task.result.summary).toContain('sent');
    expect(woken).toContain('is now DONE');
    expect(await readdir(P.mailDir)).toHaveLength(1);
    const desk = (await P.desk()).find((c) => c.id === card.id);
    expect(desk.status).toBe('EXECUTED');
    expect(desk.proof.outcome).toBe('DONE');
    void proposalIdFrom;
  });
});
