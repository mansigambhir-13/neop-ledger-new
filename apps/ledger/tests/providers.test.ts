// providers.test · Ledger's real provider doors (ship readiness): Resend for
// email and a GST Suvidha Provider for GSTR-3B filing. Each call is journaled
// before it goes out; read-back is exact even when the provider's answer is
// lost; a definite refusal fails cleanly; an outage ends UNKNOWN and is
// reconciled. Nothing is ever sent twice.
process.env.NEOP_SANDBOX_TIMEOUT_MS = '5000';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeGsp, fakeResend, installAndMigrate, publishPackage, toolName, type FakeProvider } from '@neop/testkit';
import { withCompany } from '@neop/pgkit';
import { bootPilot, type Pilot } from './harness.ts';
import { LEDGER_ROOT } from '../src/index.ts';

let P: Pilot;
let RS: FakeProvider;
let GSP: FakeProvider;
beforeAll(async () => {
  RS = await fakeResend();
  GSP = await fakeGsp();
  P = await bootPilot();
  await P.platform.setVaultSecret(P.company.id, 'email', { provider: 'resend', api_key: RS.token, from: 'Acme Books <books@acme.example>', base_url: RS.url });
  await P.platform.setVaultSecret(P.company.id, 'gst_portal', {
    provider: 'http',
    base_url: GSP.url,
    token: GSP.token,
    send_path: '/v1/gstr3b/file',
    lookup_path: '/v1/gstr3b/filings/{key}',
  });
});
afterAll(async () => {
  await P?.close();
  await RS?.close();
  await GSP?.close();
});

const CARD = { what: 'send', why: 'asked', changes: 'one message leaves the company', if_no_answer: 'nothing' };

async function approveOne(key: string, args: Record<string, unknown>) {
  P.setBrain((v) => {
    if (v.job.includes('WOKEN')) return { tool: toolName('job.finish'), args: { outcome: 'done', summary: 'checked' } };
    return v.calls === 0 ? { tool: toolName(key), args: { ...args, card: CARD } } : { text: 'waiting' };
  });
  const t = await P.ask(`provider: ${key}`);
  const card = await P.waitFor(async () => (await P.desk()).find((c) => c.task_id === t.task_id && c.status === 'PENDING'), 'card');
  await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
  const done = await P.waitFor(async () => {
    const r = await P.platform.db.query("select status, proof from neos.approvals where id = $1 and status in ('EXECUTED','REFUSED')", [card.id]);
    return r.rows[0];
  }, 'executed', 20_000);
  return { card, proof: done.proof };
}

const closePack = { period: { from: '2026-08-01', to: '2026-08-31' }, to: ['cfo@acme.example'] };

describe('email via Resend', () => {
  it('sends once with the proposal’s idempotency key, attachments and sender; proof carries the delivery state', async () => {
    const { card, proof } = await approveOne('ledger.close_pack.email', closePack);
    expect(proof.outcome).toBe('DONE');
    expect(proof.read_back.id).toBe(RS.performed[0]!.id);
    expect(RS.performed).toHaveLength(1);
    const sent = RS.performed[0]!;
    expect(sent.body.from).toBe('Acme Books <books@acme.example>');
    expect(sent.body.to).toEqual(['cfo@acme.example']);
    expect(sent.body.attachments.map((a: any) => a.filename)).toEqual(['close-pack.json', 'trial-balance.csv']);
    expect(Buffer.from(sent.body.attachments[1].content, 'base64').toString()).toContain('code,name,debit,credit');
    expect(RS.requests.find((r) => r.method === 'POST')!.key).toContain(card.proposal_id);
    const j = await withCompany(P.backend.core.appPool, P.company.id, (c) =>
      c.query("select status, provider_ref from ledger.door_journal where door = 'email' and idempotency_key like $1", [`%${card.proposal_id}`]),
    );
    expect(j.rows).toEqual([{ status: 'accepted', provider_ref: sent.id }]);
  });

  it('when the provider’s answer is lost, read-back recovers the id from the journal — and nothing is sent twice', async () => {
    const before = RS.performed.length;
    RS.fault = 'drop_after_accept';
    const { proof } = await approveOne('ledger.close_pack.email', closePack);
    expect(proof.outcome).toBe('DONE');
    expect(RS.performed.length).toBe(before + 1);
    const posts = RS.requests.filter((r) => r.method === 'POST').slice(-2);
    expect(posts[0]!.key).toBe(posts[1]!.key); // the retry reused the key and the journaled payload
  });

  it('a definite refusal fails cleanly and is never retried', async () => {
    RS.fault = 'refuse';
    const before = RS.requests.filter((r) => r.method === 'POST').length;
    const { proof } = await approveOne('ledger.close_pack.email', closePack);
    RS.fault = null;
    expect(proof.outcome).toBe('FAILED');
    expect(proof.error).toMatch(/422/);
    expect(RS.requests.filter((r) => r.method === 'POST').length).toBe(before + 1);
  });

  const settle = (proposalId: string) =>
    P.waitFor(async () => {
      const r = await P.backend.core.runnerPool.query('select status from ledger.proposals where id = $1', [proposalId]);
      return ['DONE', 'FAILED'].includes(r.rows[0].status) && r.rows[0].status;
    }, 'reconciled', 30_000);

  it('an outage ends UNKNOWN; if the provider is back within the recovery window, it goes out exactly once', async () => {
    RS.fault = 'outage';
    const before = RS.performed.length;
    const { card, proof } = await approveOne('ledger.close_pack.email', closePack);
    expect(proof.outcome).toBe('UNKNOWN');
    RS.fault = null;
    expect(await settle(card.proposal_id)).toBe('DONE');
    expect(RS.performed.length).toBe(before + 1);
  });

  it('past the recovery window it is closed as not sent — never sent late', async () => {
    RS.fault = 'outage';
    const before = RS.performed.length;
    const { card, proof } = await approveOne('ledger.close_pack.email', closePack);
    expect(proof.outcome).toBe('UNKNOWN');
    process.env.NEOP_DOOR_RECOVERY_MS = '0'; // the window has passed
    RS.fault = null;
    expect(await settle(card.proposal_id)).toBe('FAILED');
    expect(RS.performed.length).toBe(before);
    delete process.env.NEOP_DOOR_RECOVERY_MS;
  });
});

describe('GSTR-3B filing via a GST Suvidha Provider', () => {
  it('prepares in the sandbox, files once through the GSP with the proposal’s key, reads back the ARN', async () => {
    await publishPackage(P, path.resolve(LEDGER_ROOT, '../../registry/nep-gst'));
    await installAndMigrate(P, 'ledger', 'nep-gst');
    P.setBrain((v) => {
      if (v.job.includes('WOKEN')) return { tool: toolName('job.finish'), args: { outcome: 'done', summary: 'filed' } };
      if (v.calls === 0) return { tool: toolName('gst.gstr3b.prepare'), args: { period: '2026-09', output_tax_minor: 12_000_000, input_tax_minor: 4_000_000, currency: 'INR' } };
      if (v.calls === 1) return { tool: toolName('gst.gstr3b.file'), args: { period: '2026-09', card: CARD } };
      return { text: 'waiting' };
    });
    const t = await P.ask('File September GSTR-3B');
    const card = await P.waitFor(async () => (await P.desk()).find((c) => c.task_id === t.task_id && c.status === 'PENDING'), 'card', 30_000);
    await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
    const a = await P.waitFor(async () => (await P.platform.db.query("select proof from neos.approvals where id = $1 and status = 'EXECUTED'", [card.id])).rows[0], 'filed', 30_000);
    expect(a.proof.outcome).toBe('DONE');
    expect(GSP.performed).toHaveLength(1);
    expect(GSP.performed[0]!.body).toMatchObject({ form: 'GSTR-3B', period: '2026-09', net_payable_minor: 8_000_000 });
    expect(a.proof.read_back.status).toBe('FILED');
    const ret = (await P.api('POST', '/api/apps/ledger/read/gst.returns.list', { period: '2026-09' })).body.result.returns[0];
    expect(ret).toMatchObject({ status: 'filed', ack_ref: GSP.performed[0]!.id });
  });
});
