// hardening.test · rotation (R10), vault at rest (R9), approver policy (R8),
// reads cannot be ask-first (R7), outbox ack + prune (R11), dead-letter replay
// (R12), and the answer pushed over SSE (R15).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { JobTokens } from '../../../packages/neop-template/src/gate/jobtoken.ts';
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

describe('rotation', () => {
  it('a rotated gateway key keeps in-flight tokens valid until the previous key is retired', async () => {
    const l3 = `http://127.0.0.1:${P.backend.ports.l3}/l3/tasks.open`;
    const post = (t: string) =>
      fetch(l3, {
        method: 'POST',
        headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', 'contract-version': '1' },
        body: JSON.stringify({ task_id: randomUUID(), ask: 'x', requester: `user:${P.admin.id}` }),
      });
    const old = await P.platform.gateway.mint({ aud: 'ledger', sub: 'platform', company_id: P.company.id, ability: 'tasks.open', idem_key: 'k' });
    await P.platform.gateway.keys.rotate(); // published, not signing
    expect(P.platform.gateway.jwks().keys).toHaveLength(2);
    expect((await post(await P.platform.gateway.mint({ aud: 'ledger', sub: 'platform', company_id: P.company.id, ability: 'tasks.open', idem_key: 'k' }))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1_300)); // verifiers' JWKS cache (1 s in tests) refreshes
    await P.platform.gateway.keys.activate();
    const fresh = await P.platform.gateway.mint({ aud: 'ledger', sub: 'platform', company_id: P.company.id, ability: 'tasks.open', idem_key: 'k' });
    expect((await post(fresh)).status).toBe(200); // app fetches the new key on an unknown kid
    expect((await post(old)).status).toBe(200); // previous key still published
    const old2 = await (async () => {
      const k = P.platform.gateway.keys.keys.find((x) => x.state === 'previous')!;
      const { SignJWT } = await import('jose');
      return new SignJWT({ company_id: P.company.id, ability: 'tasks.open', idem_key: 'k' })
        .setProtectedHeader({ alg: 'EdDSA', kid: k.kid })
        .setIssuer('neos-gateway').setAudience('ledger').setSubject('platform').setJti(randomUUID()).setIssuedAt().setExpirationTime('60s')
        .sign(k.privateKey);
    })();
    await P.platform.gateway.keys.retirePrevious();
    // The app trusts a fetched JWKS for jwksCacheMs (1 s in tests, 60 s by default).
    await new Promise((r) => setTimeout(r, 1_300));
    expect(P.platform.gateway.jwks().keys).toHaveLength(1);
    const res = await post(old2);
    expect([401]).toContain(res.status);
  });

  it('job-token secrets rotate: the first signs, every listed one verifies', async () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const before = new JobTokens(a, 'ledger');
    const tok = await before.mint({ sub: randomUUID(), sid: 's', company_id: P.company.id, abilities: [] }, 60_000);
    const during = new JobTokens([b, a], 'ledger');
    expect((await during.verify(tok)).sid).toBe('s');
    const after = new JobTokens([b], 'ledger');
    await expect(after.verify(tok)).rejects.toThrow();
  });

  it('a service secret rotates with an overlap window', async () => {
    const r = await P.platform.db.query("select service_secret_hash from neos.apps where key = 'ledger'");
    expect(r.rows[0].service_secret_hash).toMatch(/^[0-9a-f]{64}$/);
    await P.platform.rotateServiceSecret('ledger', 'n'.repeat(48));
    // The backend still holds the old secret: it keeps working inside the window.
    const sb = await P.backend.core.platform.switchboard(P.company.id);
    expect(sb.company.id).toBe(P.company.id);
    expect(await P.platform.authService(`Service ledger:${'n'.repeat(48)}`)).toBe('ledger');
    expect(await P.platform.authService(`Service ledger:${'z'.repeat(48)}`)).toBeNull();
  });
});

describe('vault', () => {
  it('stores door credentials sealed and bound to their company and door', async () => {
    const row = (await P.platform.db.query("select secret from neos.vault_secrets where company_id = $1 and door = 'email'", [P.company.id])).rows[0];
    expect(row.secret.v).toBe(1);
    expect(JSON.stringify(row.secret)).not.toContain(P.mailDir);
    expect(await P.platform.lend('ledger', P.company.id, 'email')).toMatchObject({ provider: 'dev-mailbox' });
    // Copied to another company, the sealed secret will not open.
    const B = await P.platform.createCompany('Other Co');
    await P.platform.db.query("insert into neos.vault_secrets (company_id, door, secret) values ($1, 'email', $2)", [B.id, JSON.stringify(row.secret)]);
    await expect(P.platform.lend('ledger', B.id, 'email')).rejects.toThrow();
  });
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

describe('outbox and dead letters', () => {
  it('acked events past retention are pruned; unacked ones never are', async () => {
    await P.platform.pullOutbox('ledger');
    const cur = Number((await P.platform.db.query("select cursor from neos.outbox_cursors where app_key = 'ledger'")).rows[0].cursor);
    const before = (await P.backend.core.runnerPool.query('select count(*)::int as n from ledger.outbox where id <= $1', [cur])).rows[0].n;
    expect(before).toBeGreaterThan(0);
    // Age everything, then add one event the platform has not pulled yet.
    await P.backend.core.runnerPool.query("update ledger.outbox set created_at = now() - interval '30 days'");
    await P.backend.core.runnerPool.query(`insert into ledger.outbox (company_id, event_type, payload, created_at) values ($1, 'card.raised', '{"job_id":null,"kind":"heads_up","text":"late"}', now() - interval '30 days')`, [P.company.id]);
    await P.platform.ackOutboxes();
    const left = (await P.backend.core.runnerPool.query('select id from ledger.outbox')).rows;
    expect(left).toHaveLength(1);
    expect(Number(left[0].id)).toBeGreaterThan(cur);
  });

  it('a parked event can be replayed once the cause is fixed', async () => {
    await P.backend.core.runnerPool.query(`insert into ledger.outbox (company_id, event_type, payload) values ($1, 'job.acknowledged', '{"task_id":"not-a-uuid","job_id":"x"}')`, [P.company.id]);
    // The background consumer or this explicit pull parks it, whichever holds the cursor first.
    const dl = await P.waitFor(async () => {
      await P.platform.pullOutbox('ledger');
      return (await P.api('GET', '/api/dead-letters')).body.dead_letters.find((d: any) => d.event_type === 'job.acknowledged' && !d.replayed_at);
    }, 'parked event');
    // "Fix" the cause: make the payload valid (a real fix would be a platform release).
    await P.platform.db.query(`update neos.outbox_dead_letters set payload = jsonb_set(jsonb_set(payload, '{task_id}', to_jsonb($3::text)), '{job_id}', to_jsonb($3::text)) where app_key = $1 and event_id = $2`, [dl.app_key, dl.event_id, randomUUID()]);
    const rep = await P.api('POST', `/api/dead-letters/${dl.app_key}/${dl.event_id}/replay`);
    expect(rep.status).toBe(200);
    expect((await P.api('POST', `/api/dead-letters/${dl.app_key}/${dl.event_id}/replay`)).status).toBe(409);
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
