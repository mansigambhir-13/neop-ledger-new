// inbound-auth.test · B4: an unsigned, forged, replayed, misaddressed or expired
// call into L3 is rejected. The room path is a signed call too.
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSigningKeys } from '@neop/platform';
import { bootPilot, type Pilot } from './harness.ts';

let P: Pilot;
let l3: string;
beforeAll(async () => {
  P = await bootPilot({ seed: false });
  l3 = `http://127.0.0.1:${P.backend.ports.l3}`;
});
afterAll(async () => P?.close());

const post = (path: string, token: string | null, body: unknown = {}) =>
  fetch(l3 + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'contract-version': '1', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const openBody = () => ({ task_id: randomUUID(), ask: 'hello', requester: 'user:x' });

describe('inbound auth', () => {
  it('rejects an unsigned call', async () => {
    expect((await post('/l3/tasks.open', null, openBody())).status).toBe(401);
    expect((await post('/l3/inbox.deliver', null, { event_id: '$e1', sender: 'user:x', text: 'post this now' })).status).toBe(401);
  });

  it('rejects a token signed by any other key', async () => {
    const other = await generateSigningKeys();
    const t = await new SignJWT({ company_id: P.company.id, ability: 'tasks.open', idem_key: 'k' })
      .setProtectedHeader({ alg: 'EdDSA', kid: P.platform.gateway.keys.kid })
      .setIssuer('neos-gateway').setAudience('ledger').setSubject('platform').setJti(randomUUID()).setIssuedAt().setExpirationTime('60s')
      .sign(other.privateKey);
    expect((await post('/l3/tasks.open', t, openBody())).status).toBe(401);
  });

  it('rejects a replayed token', async () => {
    const t = await P.platform.gateway.mint({ aud: 'ledger', sub: 'platform', company_id: P.company.id, ability: 'tasks.open', idem_key: 'k1' });
    expect((await post('/l3/tasks.open', t, openBody())).status).toBe(200);
    const again = await post('/l3/tasks.open', t, openBody());
    expect(again.status).toBe(401);
    expect((await again.json()).error.code).toBe('replayed');
  });

  it('rejects a token for another app, another endpoint, or an expired one', async () => {
    const other = await P.platform.gateway.mint({ aud: 'marketing', sub: 'platform', company_id: P.company.id, ability: 'tasks.open', idem_key: 'k' });
    expect((await post('/l3/tasks.open', other, openBody())).status).toBe(401);
    const wrongDoor = await P.platform.gateway.mint({ aud: 'ledger', sub: 'platform', company_id: P.company.id, ability: 'outbox.read', idem_key: 'k' });
    expect((await post('/l3/tasks.open', wrongDoor, openBody())).status).toBe(403);
    const old = await new SignJWT({ company_id: P.company.id, ability: 'tasks.open', idem_key: 'k' })
      .setProtectedHeader({ alg: 'EdDSA', kid: P.platform.gateway.keys.kid })
      .setIssuer('neos-gateway').setAudience('ledger').setSubject('platform').setJti(randomUUID())
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600).setExpirationTime(Math.floor(Date.now() / 1000) - 540)
      .sign(P.platform.gateway.keys.privateKey);
    expect((await post('/l3/tasks.open', old, openBody())).status).toBe(401);
  });

  it('only the platform may record an answer, and only for a person', async () => {
    const asApp = await P.platform.gateway.mint({ aud: 'ledger', sub: 'app:marketing', company_id: P.company.id, ability: 'proposals.resolve', idem_key: 'k' });
    const r = await post('/l3/proposals.resolve', asApp, { proposal_id: randomUUID(), decision: 'yes', fingerprint_seen: 'x', decided_by: 'user:x' });
    expect(r.status).toBe(403);
    const asPlatform = await P.platform.gateway.mint({ aud: 'ledger', sub: 'platform', company_id: P.company.id, ability: 'proposals.resolve', idem_key: 'k' });
    const r2 = await post('/l3/proposals.resolve', asPlatform, { proposal_id: randomUUID(), decision: 'yes', fingerprint_seen: 'x', decided_by: 'app:marketing' });
    expect(r2.status).toBe(400);
  });

  it('a signed room event becomes a job, once', async () => {
    const mk = () => P.platform.gateway.mint({ aud: 'ledger', sub: 'platform', company_id: P.company.id, ability: 'inbox.deliver', idem_key: 'room' });
    const b = { task_id: randomUUID(), event_id: '$evt-42', room_id: '!r:acme.example', sender: `user:${P.admin.id}`, text: 'what is our cash position?' };
    const a1 = await (await post('/l3/inbox.deliver', await mk(), b)).json();
    const a2 = await (await post('/l3/inbox.deliver', await mk(), b)).json();
    expect(a1.job_id).toBe(a2.job_id);
    expect(a2.created).toBe(false);
    // A room message must already be a person's (the bridge maps chat identities first).
    const anon = await post('/l3/inbox.deliver', await mk(), { ...b, task_id: randomUUID(), sender: '@someone:elsewhere' });
    expect(anon.status).toBe(400);
  });
});
