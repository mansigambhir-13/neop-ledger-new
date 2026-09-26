// gst.test · the nep-gst package end to end, against a faithful fake GST
// Suvidha Provider: the figures come from the books (not the assistant), the
// return is the GSTN GSTR-3B document, save → status → file (ask-first, EVC OTP
// entered by a person) → read-back by RETTRACK; auth expiry re-authenticates;
// a validation error fails cleanly; a lost or timed-out filing is confirmed by
// status and never sent twice.
process.env.NEOP_SANDBOX_TIMEOUT_MS = '8000';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeGstSuvidhaProvider, installAndMigrate, publishPackage, toolName, type FakeGsp } from '@neop/testkit';
import { resetGspSessions } from '@neop/template';
import { withCompany } from '@neop/pgkit';
import { bootPilot, type Pilot } from './harness.ts';
import { LEDGER_ROOT } from '../src/index.ts';

const GSTIN = '27AAPFU0939F1ZV';
let P: Pilot;
let GSP: FakeGsp;
/** Everything the assistant ever saw: tool results and prompts. */
let seen = '';

beforeAll(async () => {
  resetGspSessions();
  GSP = await fakeGstSuvidhaProvider({ gstin: GSTIN, username: 'acme.traders', signatory_pan: 'AAPFU0939F' });
  P = await bootPilot();
  // An admin connects the GSP on the platform (write-only vault).
  const r = await P.api('PUT', '/api/vault/gst_portal', {
    provider: 'gsp',
    base_url: GSP.url,
    client_id: GSP.client_id,
    client_secret: GSP.client_secret,
    username: 'acme.traders',
    gstin: GSTIN,
    signatory_pan: 'AAPFU0939F',
    assume_supply: 'intra_state',
    timeout_ms: 1500,
  });
  expect(r.status).toBe(200);
  await publishPackage(P, path.resolve(LEDGER_ROOT, '../../registry/nep-gst'));
  await installAndMigrate(P, 'ledger', 'nep-gst');
});
afterAll(async () => {
  await P?.close();
  await GSP?.close();
});

type Step = { tool: string; args: Record<string, unknown> };
const t = (key: string, args: Record<string, unknown> = {}): Step => ({ tool: toolName(key), args });
const CARD = { what: 'File the GSTR-3B', why: 'monthly return', changes: 'a binding filing on the GST portal', if_no_answer: 'nothing is filed' };

/** A scripted assistant: the steps in order, then waits; when woken, finishes. */
async function job(ask: string, steps: Step[]) {
  const results: { text: string; isError: boolean }[][] = [];
  P.setBrain((v) => {
    seen += v.system + '\n' + v.results.map((x) => x.text).join('\n');
    results.push(v.results);
    if (v.job.includes('WOKEN')) return t('job.finish', { outcome: 'done', summary: 'checked the proof' });
    if (v.calls < steps.length) return steps[v.calls]!;
    // A proposal is out: wait for the yes. Otherwise report.
    return /Proposal [0-9a-f-]{36}/.test(v.results.at(-1)?.text ?? '') ? { text: 'waiting' } : t('job.finish', { outcome: 'done', summary: 'done' });
  });
  const task = await P.ask(ask);
  return { task, texts: () => results.at(-1)?.map((x) => x.text) ?? [] };
}

const done = (taskId: string) => P.waitFor(async () => (await P.task(taskId)).task.status === 'COMPLETED', 'completed', 30_000);
const read = async (key: string, args: unknown) => (await P.api('POST', `/api/apps/ledger/read/${key}`, args)).body.result;
const rows = (period: string) =>
  withCompany(P.backend.core.appPool, P.company.id, async (c) => (await c.query("select * from ledger.nep_gst_returns where period = $1 and status <> 'superseded' order by created_at", [period])).rows);
/** The person reads the SMS and enters it on the OTP door (write-only vault). The assistant never sees it. */
const enterOtp = (fields: Record<string, string>) => P.api('PUT', '/api/vault/gst_portal_otp', { provider: 'person', ...fields });

async function approve(taskId: string, before?: () => Promise<void>) {
  const card = await P.waitFor(async () => (await P.desk()).find((c) => c.task_id === taskId && c.status === 'PENDING'), 'filing card', 30_000);
  await before?.();
  await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
  const a = await P.waitFor(async () => (await P.platform.db.query("select proof from neos.approvals where id = $1 and status in ('EXECUTED','REFUSED')", [card.id])).rows[0], 'executed', 30_000);
  return { card, proof: a.proof };
}

const halves = (m: number) => [Math.ceil(m / 2) / 100, (m - Math.ceil(m / 2)) / 100];

describe('GSTR-3B from the books through a GSP', () => {
  it('the assistant cannot type the figures: prepare takes only the month', async () => {
    const j = await job('Prepare September GST with my numbers', [t('gst.gstr3b.prepare', { period: '2026-09', output_tax_minor: 1, input_tax_minor: 0, currency: 'INR' })]);
    await done(j.task.task_id);
    expect(j.texts()[0]).toMatch(/additional|must NOT have/i);
    expect(await rows('2026-09')).toHaveLength(0);
  });

  it('a host read the company switched off cannot be used by the package', async () => {
    expect((await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.report.pnl': 'off' } })).status).toBe(200);
    for (const b of Object.values(P.backends)) b.core.board.invalidate(P.company.id);
    const j = await job('Prepare September GST', [t('gst.gstr3b.prepare', { period: '2026-09' })]);
    await done(j.task.task_id);
    expect(j.texts()[0]).toMatch(/FAILED/);
    expect(j.texts()[0]).toMatch(/switched off/);
    await P.api('PUT', '/api/switchboards/ledger', { settings: { 'ledger.report.pnl': 'on' } });
    for (const b of Object.values(P.backends)) b.core.board.invalidate(P.company.id);
  });

  it('prepare → save (OTP login by a person) → EVC OTP → a yes → filed once, read back by RETTRACK, ARN reported', async () => {
    // Job 1: prepare from the books; save finds no portal session, so an OTP is sent and nothing is saved.
    const j1 = await job('Prepare and save the September GSTR-3B', [t('gst.gstr3b.prepare', { period: '2026-09' }), t('gst.gstr3b.save', { period: '2026-09' })]);
    await done(j1.task.task_id);
    const [prep, save1] = j1.texts();
    expect(prep).toMatch(/"outcome": "DONE"/);
    expect(save1).toMatch(/FAILED/);
    expect(save1).toMatch(/no GST portal session/);
    expect(GSP.otpsSent.filter((o) => o.purpose === 'auth')).toHaveLength(1);
    expect(GSP.saved.size).toBe(0);

    // The figures are the ledger's, split by the configured (and stated) assumption.
    const vat = await read('ledger.report.vat_summary', { from: '2026-09-01', to: '2026-09-30' });
    const pnl = await read('ledger.report.pnl', { from: '2026-09-01', to: '2026-09-30' });
    expect(vat.output_tax_minor).toBeGreaterThan(0);
    const [draft] = await rows('2026-09');
    expect(draft).toMatchObject({ status: 'draft', gstin: GSTIN, ret_period: '092026' });
    expect(Number(draft.output_tax_minor)).toBe(vat.output_tax_minor);
    expect(Number(draft.input_tax_minor)).toBe(vat.input_tax_minor);
    expect(Number(draft.net_payable_minor)).toBe(Math.max(vat.net_payable_minor, 0));
    expect(draft.split_basis).toMatch(/ASSUMED intra_state/);
    const d = draft.payload;
    expect(d.sup_details.osup_det).toEqual({ txval: pnl.totals.revenue_minor / 100, iamt: 0, camt: halves(vat.output_tax_minor)[0], samt: halves(vat.output_tax_minor)[1], csamt: 0 });
    expect(d.itc_elg.itc_net).toEqual({ iamt: 0, camt: halves(vat.input_tax_minor)[0], samt: halves(vat.input_tax_minor)[1], csamt: 0 });
    expect(d.itc_elg.itc_avl.find((x: any) => x.ty === 'OTH')).toMatchObject(d.itc_elg.itc_net);
    // Sources are on the record: the host reads are steps with their basis, the figures facts.
    const steps = await withCompany(P.backend.core.appPool, P.company.id, async (c) =>
      (await c.query('select summary, ability_key, output_ref from ledger.steps where job_id = $1 order by seq', [j1.task.job_id])).rows,
    );
    expect(steps.find((s) => s.ability_key === 'ledger.report.vat_summary' && s.summary.startsWith('[nep-gst]'))?.output_ref.basis).toMatch(/2026-09-01\.\.2026-09-30/);
    expect(steps.some((s) => /GSTR-3B draft 092026/.test(s.summary))).toBe(true);
    const facts = await withCompany(P.backend.core.appPool, P.company.id, async (c) => (await c.query("select subject, value, source from ledger.facts where job_id = $1", [j1.task.job_id])).rows);
    expect(facts.find((f) => /output tax/.test(f.subject))).toMatchObject({ value: vat.output_tax_minor });
    expect(facts.find((f) => /output tax/.test(f.subject))!.source).toMatch(/ledger\.report\.vat_summary/);

    // The person reads the SMS and enters the OTP on the door; the assistant never sees it.
    expect((await enterOtp({ auth_otp: GSP.lastOtp('auth')! })).status).toBe(200);

    // Job 2: save (logs in, RETSAVE, RETSTATUS), ask for the EVC OTP, propose the filing.
    const j2 = await job('Save and file the September GSTR-3B', [
      t('gst.gstr3b.save', { period: '2026-09' }),
      t('gst.otp.request', { purpose: 'evc' }),
      t('gst.gstr3b.file', { period: '2026-09', card: CARD }),
    ]);
    const { card, proof } = await approve(j2.task.task_id, async () => {
      expect(GSP.saved.get('092026')?.data).toEqual(d); // exactly the document built from the books
      expect(GSP.actions('RETSTATUS')).toBeGreaterThanOrEqual(1);
      expect(GSP.actions('RETFILE')).toBe(0); // nothing binding before the yes
      await enterOtp({ evc_otp: GSP.lastOtp('evc')! });
    });
    // The proposal is bound to the saved return's figures and hash, not to what the assistant typed.
    expect(card.args).toMatchObject({ period: '2026-09', gstin: GSTIN, ret_period: '092026', net_payable_minor: Math.max(vat.net_payable_minor, 0), payload_sha256: draft.payload_sha256 });
    expect(proof.outcome).toBe('DONE');
    expect(GSP.filings).toHaveLength(1);
    expect(GSP.actions('RETFILE')).toBe(1);
    expect(proof.read_back).toMatchObject({ ret_period: '092026', arn: GSP.filings[0]!.arn, status: 'Filed' });
    await done(j2.task.task_id);
    const listed = (await read('gst.returns.list', { period: '2026-09' })).returns;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ status: 'filed', ack_ref: GSP.filings[0]!.arn, gsp_status: 'P' });
    const journal = await withCompany(P.backend.core.appPool, P.company.id, async (c) =>
      (await c.query("select status, provider_ref, payload from ledger.door_journal where door = 'gst_portal' order by created_at")).rows,
    );
    // The first save was refused (no session) and journaled as such; then the save and the filing.
    expect(journal.map((x) => x.status)).toEqual(['rejected', 'accepted', 'accepted']);
    expect(journal[2]!.provider_ref).toBe(GSP.filings[0]!.arn);

    // Secrets stayed out of the model and out of the database.
    for (const o of GSP.otpsSent) expect(seen).not.toContain(o.otp);
    expect(seen).not.toContain(GSP.client_secret);
    const dump = await withCompany(P.backend.core.appPool, P.company.id, async (c) =>
      JSON.stringify((await c.query('select payload from ledger.door_journal')).rows) + JSON.stringify((await c.query('select summary from ledger.steps')).rows),
    );
    expect(dump).not.toMatch(/tok_[0-9a-f]{24}/);
    expect(dump).not.toContain(GSP.client_secret);
  });

  it('a filed month is never proposed again', async () => {
    const j = await job('File September again', [t('gst.gstr3b.file', { period: '2026-09', card: CARD })]);
    await P.waitFor(async () => j.texts().length > 0, 'refusal', 20_000);
    expect(j.texts()[0]).toMatch(/already filed/);
    expect(GSP.actions('RETFILE')).toBe(1);
  });

  it('a GSP validation error (4xx) fails the save cleanly; nothing is saved', async () => {
    GSP.fault = 'save_invalid';
    const j = await job('Prepare and save August', [t('gst.gstr3b.prepare', { period: '2026-08' }), t('gst.gstr3b.save', { period: '2026-08' })]);
    await done(j.task.task_id);
    GSP.fault = null;
    expect(j.texts()[1]).toMatch(/FAILED/);
    expect(j.texts()[1]).toMatch(/422 RET191106/);
    expect(GSP.saved.has('082026')).toBe(false);
    expect((await rows('2026-08'))[0]).toMatchObject({ status: 'draft' });
  });

  it('an expired session is refreshed and the call retried; a refused refresh asks a person for a new OTP', async () => {
    GSP.expireTokens();
    const refreshes = GSP.actions('REFRESHTOKEN');
    const j = await job('Save August', [t('gst.gstr3b.save', { period: '2026-08' })]);
    await done(j.task.task_id);
    expect(j.texts()[0]).toMatch(/"outcome": "DONE"/);
    expect(GSP.actions('REFRESHTOKEN')).toBe(refreshes + 1);
    expect(GSP.saved.has('082026')).toBe(true);

    GSP.expireTokens();
    GSP.refuseRefresh = true;
    const otps = GSP.otpsSent.length;
    const j2 = await job('Save August again', [t('gst.otp.request', { purpose: 'evc' })]);
    await done(j2.task.task_id);
    expect(j2.texts()[0]).toMatch(/FAILED/);
    expect(j2.texts()[0]).toMatch(/no GST portal session/);
    expect(GSP.otpsSent.length).toBe(otps + 1);
    expect(GSP.otpsSent.at(-1)!.purpose).toBe('auth');
    GSP.refuseRefresh = false;
    await enterOtp({ auth_otp: GSP.lastOtp('auth')! });
  });

  it('a filing whose answer is lost in an outage ends UNKNOWN, then status reconciles it — sent once', async () => {
    const j = await job('File August', [t('gst.otp.request', { purpose: 'evc' }), t('gst.gstr3b.file', { period: '2026-08', card: CARD })]);
    const { card, proof } = await approve(j.task.task_id, async () => {
      await enterOtp({ evc_otp: GSP.lastOtp('evc')! });
      GSP.fault = 'file_then_outage';
    });
    expect(proof.outcome).toBe('UNKNOWN');
    expect(GSP.filings.filter((f) => f.ret_period === '082026')).toHaveLength(1);
    GSP.fault = null;
    const status = await P.waitFor(async () => {
      const r = await P.backend.core.runnerPool.query('select status, proof from ledger.proposals where id = $1', [card.proposal_id]);
      return r.rows[0].status === 'DONE' && r.rows[0];
    }, 'reconciled', 30_000);
    expect(status.proof.read_back.arn).toBe(GSP.filings.find((f) => f.ret_period === '082026')!.arn);
    expect(GSP.requests.filter((r) => r.action === 'RETFILE')).toHaveLength(2); // September + August, once each
    expect((await rows('2026-08'))[0]).toMatchObject({ status: 'filed', ack_ref: status.proof.read_back.arn });
  });

  it('a filing that times out is confirmed by read-back, not re-sent', async () => {
    const pre = await job('Prepare and save July', [t('gst.gstr3b.prepare', { period: '2026-07' }), t('gst.gstr3b.save', { period: '2026-07' })]);
    await done(pre.task.task_id);
    expect(GSP.saved.has('072026')).toBe(true);
    const j = await job('File July', [t('gst.otp.request', { purpose: 'evc' }), t('gst.gstr3b.file', { period: '2026-07', card: CARD })]);
    GSP.hangMs = 3_000; // longer than the door's 1.5 s timeout
    const { proof } = await approve(j.task.task_id, async () => {
      await enterOtp({ evc_otp: GSP.lastOtp('evc')! });
      GSP.fault = 'file_hang';
    });
    expect(proof.outcome).toBe('DONE');
    expect(proof.read_back.arn).toBe(GSP.filings.find((f) => f.ret_period === '072026')!.arn);
    expect(GSP.requests.filter((r) => r.action === 'RETFILE')).toHaveLength(3);
  });
});
