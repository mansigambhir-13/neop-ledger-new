// Hardening: approver policy, reads cannot be ask-first, and the answer is pushed over SSE.
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
    card: { what: 'Send the pack', why: 'close', changes: 'one email', if_no_answer: 'nothing' },
  });

describe('policy', () => {
  it('reads cannot be ask-first', async () => {
    const r = await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.report.pnl': 'ask_first' } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('read_cannot_ask_first');
  });

  it('approver roles and four-eyes: the asker cannot approve, a member cannot where only admins may', async () => {
    const pol = await P.api('PUT', '/api/switchboards/ledger', { approvals: { 'ledger.close_pack.email': { roles: ['admin'], four_eyes: true } } });
    expect(pol.status).toBe(200);
    const second = await P.platform.createUser(P.company.id, { name: 'Anil', email: 'anil@acme.example', role: 'admin' });
    P.setBrain((v) => (v.job.includes('WOKEN') ? finish('sent') : v.calls === 0 ? email() : { text: 'waiting' }));
    const r = await P.api('POST', '/api/ask', { text: 'Send the August close pack to our CFO' }); // asked by Priya (admin)
    const card = await P.waitFor(async () => (await P.desk()).find((c) => c.task_id === r.body.task_id && c.status === 'PENDING'), 'card');
    const own = await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    expect(own.body.error.code).toBe('four_eyes');
    const member = await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint }, P.member.token);
    expect(member.body.error.code).toBe('not_an_approver');
    const ok = await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint }, second.token);
    expect(ok.status).toBe(200);
    await P.waitFor(async () => (await P.task(r.body.task_id)).task.status === 'COMPLETED', 'done');
    await P.api('PUT', '/api/switchboards/ledger', { approvals: { 'ledger.close_pack.email': {} } });
  });
});

describe('push', () => {
  it('(9) the answer arrives over server-sent events', async () => {
    P.setBrain((v) => (v.calls === 0 ? call('ledger.report.pnl', { from: '2026-08-01', to: '2026-08-31' }) : finish('August net profit is in.')));
    const r = await P.api('POST', '/api/ask', { text: 'P&L for August 2026' });
    // The long-lived token in a URL is refused; a short-lived stream token is used instead.
    expect((await fetch(`${P.platformUrl}/api/conversations/${r.body.conversation_id}/events?token=${P.admin.token}`)).status).toBe(401);
    const st = (await P.api('POST', `/api/conversations/${r.body.conversation_id}/stream-token`)).body.token;
    const res = await fetch(`${P.platformUrl}/api/conversations/${r.body.conversation_id}/events?st=${st}`);
    const reader = res.body!.getReader();
    let buf = '';
    const until = Date.now() + 15_000;
    while (!buf.includes('event: result') && Date.now() < until) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
    }
    await reader.cancel();
    expect(buf).toContain('event: message');
    expect(buf).toContain('event: result');
    expect(buf).toContain('August net profit is in.');
  });
});
