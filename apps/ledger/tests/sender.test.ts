// sender.test · WP v3 §13 standard test: each kind of message is accepted only from its sender class.
// v3 S9: there is no gateway and no L3, so the only places an answer can enter the app are its own presence (Matrix,
// where the sender class is checked — apps/ledger/tests/presence-sender.test.ts proves both roads: a stranger, a person
// of another company and the app itself open nothing, in a room and in a DM; a bridge's go-ahead is never a yes —
// presence-go-ahead.test.ts) and the book's two functions, answer_proposal() and answer_wait(). This file proves the
// book's half, whoever calls it: an app (app:*) can neither resolve a proposal nor answer a person's question, and no
// HTTP route of the backend takes an answer at all.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCompany } from '@neop/pgkit';
import { bootPilot, call, type Pilot } from './harness.ts';

describe('the book takes an answer only from a person', () => {
  let P: Pilot;
  beforeAll(async () => {
    P = await bootPilot();
  });
  afterAll(async () => P?.close());

  it('an app (app:*) can neither resolve a proposal nor answer a wait — the book refuses, and no route of the backend takes an answer', async () => {
    // Proposes; woken by the "no", it asks one question and waits on it.
    P.setBrain((v) =>
      v.job.includes('WOKEN')
        ? v.calls === 0
          ? call('job.ask', { text: 'Anything else?', why: 'test', fields: [{ key: 'note', label: 'Note' }] })
          : { text: 'waiting' }
        : v.calls === 0
          ? call('ledger.close_pack.email', {
              period: { from: '2026-08-01', to: '2026-08-31' },
              to: ['cfo@acme.example'],
              card: { what: 'Email the August close pack', why: 'close', changes: 'one email leaves the company', if_no_answer: 'nothing is sent' },
            })
          : { text: 'waiting' },
    );
    const r = await P.ask('Email the August pack to the CFO');
    const card = await P.waitFor(async () => (await P.desk()).find((c) => c.job_id === r.job_id && c.status === 'PENDING'), 'the card');
    const resolve = { proposal_id: card.proposal_id, decision: 'yes', fingerprint_seen: card.fingerprint, decided_by: `user:${P.admin.id}` };
    // No HTTP route of the backend takes an answer (v3 S9: no L3). Its listeners are the files listener, the gate (a job
    // token) and the appservice push (the homeserver's token): none has an answer or resolve route for anyone.
    for (const p of ['/l3/proposals.resolve', '/l3/proposals.execute', '/l3/waits.answer', '/proposals.resolve', '/waits.answer']) {
      const res = await fetch(`http://127.0.0.1:${P.backend.ports.files}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(resolve) });
      expect(res.status, p).toBe(404);
    }
    // The book: answer_proposal() takes an answer only from a person, whoever calls it.
    await expect(
      withCompany(P.backend.core.appPool, P.company.id, (c) => c.query('select ledger.answer_proposal($1, $2, $3, $4, null)', [card.proposal_id, card.fingerprint, 'yes', 'app:marketing'])),
    ).rejects.toThrow(/decided_by must be a person/);
    expect((await P.backend.core.runnerPool.query('select status, decided_by, answered_at from ledger.proposals where id = $1', [card.proposal_id])).rows[0]).toEqual({ status: 'PROPOSED', decided_by: null, answered_at: null });

    // A wait: the job asks after a "no" wakes it; an app cannot answer that question either.
    const no = await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'no', fingerprint_seen: card.fingerprint });
    expect(no.status, JSON.stringify(no.body)).toBe(200);
    const wait = await P.waitFor(async () => (await P.backend.core.runnerPool.query("select id from ledger.waits where job_id = $1 and kind = 'input' and status = 'pending'", [r.job_id])).rows[0], 'the question');
    // The book's function refuses an app's key on a person's question, whoever calls it.
    await expect(
      withCompany(P.backend.core.appPool, P.company.id, (c) => c.query("select ledger.answer_wait($1, $2::jsonb, 'app:marketing', 'app')", [wait.id, JSON.stringify({ note: 'send it anyway' })])),
    ).rejects.toThrow(/^not_their_wait: /);
    expect((await P.backend.core.runnerPool.query('select status, answered_by from ledger.waits where id = $1', [wait.id])).rows[0]).toEqual({ status: 'pending', answered_by: null });
  });
});
