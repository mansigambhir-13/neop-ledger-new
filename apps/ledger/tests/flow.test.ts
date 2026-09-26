// flow.test · the platform user flow from the NEOS app, step by step:
// (1) ask → (2) Conversations first → (3)+(5a) NeuralChat with registry context
// → (4) task → (6) acknowledged at once → 7.x in the app → (8) result onto the
// conversation → (9) the person reads it. Plus the REPORTED trail and cancel.
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
    card: { what: 'Email the August close pack to the CFO', why: 'close', changes: 'one email leaves the company', if_no_answer: 'nothing is sent' },
  });

describe('platform user flow', () => {
  it('(2) stores the ask before routing, even when no app fits', async () => {
    const r = await P.api('POST', '/api/ask', { text: 'Book me a flight to Goa' });
    expect(r.body.handed_to).toBeNull();
    const conv = await P.api('GET', `/api/conversations/${r.body.conversation_id}`);
    expect(conv.body.messages.map((m: any) => m.kind)).toEqual(['message', 'notice']);
    expect(conv.body.messages[0].body).toBe('Book me a flight to Goa');
  });

  it('(5a) NeuralChat sees installed apps, what each can do, and which need a yes', async () => {
    const r = await P.api('GET', '/api/registry');
    const ledger = r.body.apps.find((a: any) => a.key === 'ledger');
    const byKey = Object.fromEntries(ledger.abilities.map((a: any) => [a.key, a]));
    expect(byKey['ledger.close_pack.email'].needs_yes).toBe(true);
    expect(byKey['ledger.report.pnl'].needs_yes).toBe(false);
  });

  it('(1)→(9) a gated ask: the conversation shows what was said and everything that came back', async () => {
    P.setBrain((v) => (v.job.includes('WOKEN') ? finish('Close pack sent to cfo@acme.example.', 'done', { changed: ['one email sent'] }) : v.calls === 0 ? email() : { text: 'waiting' }));
    const t0 = Date.now();
    const r = await P.api('POST', '/api/ask', { text: 'Send the August close pack to our CFO' });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.body.handed_to).toBe('ledger'); // picked by NeuralChat, not named by the person
    expect(r.body.status).toBe('ACKNOWLEDGED');
    const card = await P.waitFor(async () => (await P.desk()).find((c) => c.task_id === r.body.task_id && c.status === 'PENDING'), 'card');
    expect((await P.task(r.body.task_id)).task.status).toBe('WAITING');
    await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    await P.waitFor(async () => (await P.task(r.body.task_id)).task.status === 'COMPLETED', 'completed');
    const conv = await P.api('GET', `/api/conversations/${r.body.conversation_id}`);
    expect(conv.body.messages.map((m: any) => m.kind)).toEqual(['message', 'handoff', 'ack', 'waiting', 'result']);
    expect(conv.body.messages.at(-1).body).toBe('Close pack sent to cfo@acme.example.');

    // (7.8) the approval's trail reads ASKED → ANSWERED → DONE → RESUMED → REPORTED.
    const ev = await P.backend.core.runnerPool.query('select event from ledger.proposal_events where proposal_id = $1 order by id', [card.proposal_id]);
    expect(ev.rows.map((e: any) => e.event)).toEqual(['proposed', 'answered:yes', 'executing', 'executed:DONE', 'resumed', 'reported']);
  });

  it('after a yes the task is working again, and a person can stop it', async () => {
    let woke = false;
    P.setBrain((v) => {
      if (v.job.includes('WOKEN')) {
        woke = true;
        return { hang: true };
      }
      return v.calls === 0 ? email() : { text: 'waiting' };
    });
    const r = await P.api('POST', '/api/ask', { text: 'Send the August close pack to our CFO' });
    const card = await P.waitFor(async () => (await P.desk()).find((c) => c.task_id === r.body.task_id && c.status === 'PENDING'), 'card');
    await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    await P.waitFor(async () => woke && (await P.task(r.body.task_id)).task.status === 'ACKNOWLEDGED', 'working again');
    const c = await P.api('POST', `/api/tasks/${r.body.task_id}/cancel`, { reason: 'changed my mind' });
    expect(c.body.status).toBe('CANCELLED');
    const job = await P.jobRow(r.body.job_id);
    expect(job.status).toBe('CANCELLED');
    // The hung session is refused on its next call: it no longer holds a RUNNING job.
    const tok = await P.backend.core.jobTokens.mint({ sub: job.id, sid: 'any', company_id: P.company.id, abilities: [] }, 60_000);
    const g = await fetch(`http://127.0.0.1:${P.backend.ports.gate}/gate/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'book.note', args: { text: 'still here' } }),
    });
    expect(g.status).toBe(409);
    P.worker.kill(r.body.job_id);
  });

  it('cancelling a job with a card nobody answered withdraws it and closes the card', async () => {
    P.setBrain((v) => (v.calls === 0 ? email() : { text: 'waiting' }));
    const r = await P.api('POST', '/api/ask', { text: 'Send the August close pack to our CFO' });
    const card = await P.waitFor(async () => (await P.desk()).find((c) => c.task_id === r.body.task_id && c.status === 'PENDING'), 'card');
    await P.api('POST', `/api/tasks/${r.body.task_id}/cancel`, {});
    await P.waitFor(async () => (await P.desk()).find((c) => c.id === card.id && c.status === 'CLOSED'), 'card closed');
    const p = await P.backend.core.runnerPool.query('select status from ledger.proposals where id = $1', [card.proposal_id]);
    expect(p.rows[0].status).toBe('WITHDRAWN');
    const late = await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    expect(late.status).toBe(409);
    await P.waitFor(async () => (await P.api('GET', `/api/conversations/${r.body.conversation_id}`)).body.messages.some((m: any) => m.kind === 'result'), 'result');
  });

  it('a platform bug on one outbox event parks it and the rest keep flowing', async () => {
    const dl = await P.platform.db.query('select count(*)::int as n from neos.outbox_dead_letters');
    expect(dl.rows[0].n).toBe(0); // nothing so far in this file failed to apply
    // Inject an event the platform cannot apply (task id that does not parse as a uuid).
    await P.backend.core.runnerPool.query(`insert into ledger.outbox (company_id, event_type, payload) values ($1, 'job.acknowledged', '{"task_id":"not-a-uuid","job_id":"x"}')`, [P.company.id]);
    P.setBrain((v) => (v.calls === 0 ? call('ledger.report.pnl', { from: '2026-08-01', to: '2026-08-31' }) : finish('ok')));
    const r = await P.api('POST', '/api/ask', { text: 'P&L for August 2026' });
    await P.waitFor(async () => (await P.task(r.body.task_id)).task.status === 'COMPLETED', 'later events still applied');
    const parked = await P.platform.db.query('select event_type, error from neos.outbox_dead_letters');
    expect(parked.rows).toHaveLength(1);
    expect(parked.rows[0].event_type).toBe('job.acknowledged');
  });
});
