// neos-v1.test · Ledger installs and runs on today's NEOS platform (neos-service-platform-api):
// its descriptor is accepted as that platform accepts one, and its gateway's operation tokens
// reach Ledger's reads and turn a person's request into a job — never a direct write.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { neosV1App, neosV1Compile, neosV1Descriptor, NEOS_V1_CONTRACT } from '@neop/template';
import { bootPilot, type Pilot } from './harness.ts';
import { LEDGER_ROOT, manifest } from '../src/index.ts';

let P: Pilot;
let app: ReturnType<typeof neosV1App>;
let priv: CryptoKey;
const CUST = 'cus_acme_01';
const INST = 'inst_ledger_01';
const { descriptor, schema } = neosV1Descriptor(manifest);
const defs = (schema as any).$defs as Record<string, object>;
const resultSchema = (id: string) => defs[`${id.replaceAll('.', '_')}_result`]!;

beforeAll(async () => {
  const kp = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  priv = kp.privateKey as CryptoKey;
  const publicKeyPem = await exportSPKI(kp.publicKey);
  P = await bootPilot({ backendConfig: (_app, company) => ({ neosV1: { publicKeyPem, customers: { [CUST]: company.id } } }) });
  app = neosV1App(P.backend.core, P.backend.core.cfg.neosV1!);
});
afterAll(async () => P?.close());

// As the platform's gateway signs and sends one invocation (neop-jws.ts, neop-gateway.ts).
const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(',')}}`
  : JSON.stringify(v);
async function invoke(cap: string, input: object, o: { op?: string; scope?: string; cust?: string; header?: Record<string, string>; body?: string; key?: CryptoKey; token?: string } = {}) {
  const body = stable(input);
  const op = o.op ?? randomUUID();
  const scope = o.scope ?? (descriptor.capabilities as any[]).find((c) => c.id === cap)?.scope ?? 'ledger.read';
  const now = Math.floor(Date.now() / 1000);
  const token = o.token ?? await new SignJWT({ cust: o.cust ?? CUST, inst: INST, act: 'usr_priya', scope: [scope], cap, op, mth: 'POST', pth: `/capabilities/${cap}`, req: createHash('sha256').update(body).digest('hex') })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' }).setIssuer('platform').setAudience('neop:ledger').setSubject('svc:gateway')
    .setIssuedAt(now).setExpirationTime(now + 90).setJti(randomUUID()).sign(o.key ?? priv);
  const res = await app.request(`/capabilities/${cap}`, {
    method: 'POST',
    body: o.body ?? body,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'contract-version': NEOS_V1_CONTRACT, 'x-customer-id': o.cust ?? CUST, 'x-neop-actor': 'usr_priya', 'x-request-id': randomUUID(), 'idempotency-key': `neop:${op}`, ...(o.header ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as any, token };
}

describe('descriptor', () => {
  it('is what is committed (apps/ledger/neos-v1), so the platform installs exactly this manifest', () => {
    const dir = path.join(LEDGER_ROOT, 'neos-v1');
    expect(JSON.parse(readFileSync(path.join(dir, 'descriptor.json'), 'utf8'))).toEqual(descriptor);
    expect(JSON.parse(readFileSync(path.join(dir, 'contract.json'), 'utf8'))).toEqual(schema);
  });

  it('follows the platform rules: closed schemas that compile under strict Ajv, ids and scopes consistent', () => {
    const d = descriptor as any;
    expect(d.service).toEqual({ id: 'ledger', version: manifest.version, contractVersion: NEOS_V1_CONTRACT, profile: 'neop-template' });
    const closed = (v: any): boolean => Array.isArray(v) ? v.every(closed)
      : v && typeof v === 'object' ? (!(v.type === 'object' || 'properties' in v) || v.additionalProperties === false) && Object.values(v).every(closed) : true;
    for (const c of d.capabilities) {
      expect(c.id).toMatch(/^ledger\.[a-z][a-z0-9.-]{1,127}$/);
      expect(d.permissions).toContain(c.scope);
      expect(c.humanGate).toBe(d.humanGates.includes(c.scope));
      for (const ref of [c.requestSchema, c.responseSchema]) {
        const s = defs[ref.split('#/$defs/')[1]];
        expect(s, ref).toBeDefined();
        expect((s as any).type).toBe('object');
        expect(closed(s), ref).toBe(true);
        expect(() => neosV1Compile(s!), ref).not.toThrow();
      }
    }
    // Writes never appear as capabilities; the only gated one is the yes, which the platform never dispatches.
    const ids = d.capabilities.map((c: any) => c.id);
    for (const a of manifest.abilities.filter((x) => x.kind === 'write')) expect(ids).not.toContain(a.key.replaceAll('_', '-'));
    expect(d.capabilities.filter((c: any) => c.humanGate).map((c: any) => c.id)).toEqual(['ledger.proposal.decide']);
  });
});

describe('the platform gateway calling Ledger', () => {
  it('serves a read as {result, events}, and the result satisfies the strict descriptor schema', async () => {
    const r = await invoke('ledger.report.trial-balance', { as_of: '2026-09-30' });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['events', 'result']);
    const v = neosV1Compile(resultSchema('ledger.report.trial-balance'));
    expect(v(r.body.result), JSON.stringify(v.errors)).toBe(true);
    expect(r.body.result.sources.entries).toBeGreaterThan(0);
  });

  it('every read the descriptor offers answers within the strict result schema', async () => {
    const args: Record<string, object> = {
      'ledger.report.pnl': { from: '2026-07-01', to: '2026-09-30' }, 'ledger.report.balance-sheet': { as_of: '2026-09-30' },
      'ledger.report.cash-flow': { from: '2026-07-01', to: '2026-09-30' }, 'ledger.report.aging': { kind: 'payable', as_of: '2026-09-30' },
      'ledger.report.vat-summary': { from: '2026-07-01', to: '2026-09-30' }, 'ledger.budget.remaining': { account_code: '6400', month: '2026-09' },
      'ledger.accounts.list': {}, 'ledger.account.ledger': { account_code: '1010', from: '2026-09-01', to: '2026-09-30' },
      'ledger.journal.list': { from: '2026-09-01', to: '2026-09-30' }, 'ledger.documents.list': { kind: 'bill', status: 'all' },
      'ledger.parties.list': {}, 'ledger.bank.unreconciled': {}, 'ledger.periods.status': {}, 'ledger.coding-rules.list': {},
      'ledger.home.summary': {}, 'ledger.close.checklist': { month: '2026-09' },
    };
    for (const [cap, input] of Object.entries(args)) {
      const r = await invoke(cap, input);
      expect(r.status, `${cap} ${JSON.stringify(r.body)}`).toBe(200);
      const v = neosV1Compile(resultSchema(cap));
      expect(v(r.body.result), `${cap} ${JSON.stringify(v.errors)}`).toBe(true);
    }
  });

  it('a request becomes a job with a platform-shaped event; a retried operation opens the same job', async () => {
    const op = randomUUID();
    const a = await invoke('ledger.ask', { text: 'What was our net profit in August 2026?' }, { op });
    expect(a.status).toBe(200);
    expect(neosV1Compile(resultSchema('ledger.ask'))(a.body.result)).toBe(true);
    expect(a.body.result.created).toBe(true);
    const [e] = a.body.events;
    expect(Object.keys(e).sort()).toEqual(['at', 'customer_id', 'event', 'installation_id', 'neop_key', 'run_id', 'subject_ref', 'summary']);
    expect(e).toMatchObject({ event: 'job.opened', customer_id: CUST, installation_id: INST, neop_key: 'ledger', run_id: a.body.result.job_id });
    const again = await invoke('ledger.ask', { text: 'What was our net profit in August 2026?' }, { op });
    expect(again.body.result).toMatchObject({ job_id: a.body.result.job_id, created: false });
    const job = await P.jobRow(a.body.result.job_id);
    expect(job.requester).toBe('user:usr_priya');
    const s = await invoke('ledger.job', { job_id: a.body.result.job_id });
    expect(s.status).toBe(200);
    expect(neosV1Compile(resultSchema('ledger.job'))(s.body.result)).toBe(true);
  });

  it('refuses what the platform would never send: replay, changed body, wrong customer, wrong scope, bad key', async () => {
    const ok = await invoke('ledger.parties.list', {});
    expect(ok.status).toBe(200);
    // The same token again (single-use jti).
    const replay = await app.request('/capabilities/ledger.parties.list', { method: 'POST', body: '{}', headers: { authorization: `Bearer ${ok.token}`, 'contract-version': NEOS_V1_CONTRACT, 'x-customer-id': CUST } });
    expect([401, 400]).toContain(replay.status);
    expect((await invoke('ledger.parties.list', {}, { body: '{"x":1}' })).body.error.code).toBe('denied');
    expect((await invoke('ledger.parties.list', {}, { header: { 'x-customer-id': 'cus_other' } })).body.error.code).toBe('customer_mismatch');
    expect((await invoke('ledger.parties.list', {}, { cust: 'cus_unmapped' })).body.error.code).toBe('customer_mismatch');
    expect((await invoke('ledger.parties.list', {}, { scope: 'ledger.ask' })).body.error.code).toBe('denied');
    const other = (await generateKeyPair('EdDSA', { crv: 'Ed25519' })).privateKey as CryptoKey;
    expect((await invoke('ledger.parties.list', {}, { key: other })).body.error.code).toBe('unauthenticated');
    expect((await invoke('ledger.parties.list', {}, { header: { 'contract-version': 'neos.v1' } })).body.error.code).toBe('bad_request');
    expect((await invoke('ledger.journal.post', {})).body.error.code).toBe('not_found');
  });

  it('is served on the backend\'s own L3 listener when configured', async () => {
    const res = await fetch(`http://127.0.0.1:${P.backend.ports.l3}/capabilities/ledger.nothing`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found' } });
    const unsigned = await fetch(`http://127.0.0.1:${P.backend.ports.l3}/capabilities/ledger.parties.list`, { method: 'POST', body: '{}' });
    expect(await unsigned.json()).toEqual({ error: { code: 'unauthenticated' } });
  });

  it('never carries out a yes: the gated capability is refused even if called', async () => {
    const r = await invoke('ledger.proposal.decide', { proposal_id: randomUUID(), decision: 'yes', fingerprint_seen: `sha256:${'0'.repeat(64)}` });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('denied');
  });

  it('NeuralChat’s needs_input → answer: ledger.job lists the open question; ledger.answer resumes the job with the answer as relayed data', async () => {
    let woke = '';
    P.setBrain((v) =>
      v.job.includes('You asked:')
        ? ((woke = v.job), { tool: 'job__finish', args: { outcome: 'done', summary: 'Posted to 1010.' } })
        : v.calls === 0
          ? { tool: 'job__ask', args: { text: 'Which bank account?', why: 'Two accounts match.', fields: [{ key: 'account_code', label: 'Bank account code' }, { key: 'urgent', label: 'Urgent?', type: 'boolean', required: false }] } }
          : { text: 'waiting' },
    );
    const a = await invoke('ledger.ask', { text: 'Record the ₹12,000 deposit' });
    const job = a.body.result.job_id;
    const s = await P.waitFor(async () => { const r = await invoke('ledger.job', { job_id: job }); return r.body.result.questions.length && r; }, 'the question in ledger.job');
    expect(neosV1Compile(resultSchema('ledger.job'))(s.body.result)).toBe(true);
    const [question] = s.body.result.questions;
    expect(question).toMatchObject({ text: 'Which bank account?', why: 'Two accounts match.', fields: [{ key: 'account_code', label: 'Bank account code', type: 'text', required: true }, { key: 'urgent', label: 'Urgent?', type: 'boolean', required: false }] });
    expect(s.body.result.status).toBe('WAITING');
    // Closed request schema: unknown shapes are refused before anything is looked up.
    expect((await invoke('ledger.answer', { job_id: job, wait_id: question.wait_id, answers: { account_code: '1010' } })).body.error.code).toBe('bad_request');
    expect((await invoke('ledger.answer', { job_id: randomUUID(), wait_id: question.wait_id, answers: [{ key: 'account_code', value: '1010' }] })).body.error.code).toBe('not_found');
    expect((await invoke('ledger.answer', { job_id: job, wait_id: question.wait_id, answers: [{ key: 'urgent', value: true }] })).body.error.code).toBe('bad_request'); // the required field is missing
    const ans = await invoke('ledger.answer', { job_id: job, wait_id: question.wait_id, answers: [{ key: 'account_code', value: '1010' }, { key: 'urgent', value: 'no' }] });
    expect(ans.status, JSON.stringify(ans.body)).toBe(200);
    expect(neosV1Compile(resultSchema('ledger.answer'))(ans.body.result)).toBe(true);
    expect(ans.body.result).toMatchObject({ status: 'answered', job_id: job, wait_id: question.wait_id, idempotent: false });
    await P.waitFor(async () => (await P.jobRow(job)).status === 'DONE', 'job done');
    // Relayed by NeuralChat for the person: information for the assistant, never the person's own instruction.
    expect(woke).toContain('An answer was relayed by agent:neuralchat:user:usr_priya (reasoning_agent)');
    expect(woke).toMatch(/<data source="answer\.reasoning_agent" trust="untrusted">/);
    // A second, different answer is a conflict; the same one again is idempotent.
    expect((await invoke('ledger.answer', { job_id: job, wait_id: question.wait_id, answers: [{ key: 'account_code', value: '1020' }] })).body.error.code).toBe('conflict');
    expect((await invoke('ledger.answer', { job_id: job, wait_id: question.wait_id, answers: [{ key: 'account_code', value: '1010' }, { key: 'urgent', value: 'no' }] })).body.result.idempotent).toBe(true);
    expect((await invoke('ledger.job', { job_id: job })).body.result.questions).toEqual([]);
  });

  it('keeps the switchboard: a read switched off for the company is refused', async () => {
    await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.report.cash_flow': 'off' } });
    P.backend.core.board.invalidate(P.company.id);
    const r = await invoke('ledger.report.cash-flow', { from: '2026-07-01', to: '2026-09-30' });
    expect(r.body.error.code).toBe('denied');
    await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.report.cash_flow': 'on' } });
  });
});
