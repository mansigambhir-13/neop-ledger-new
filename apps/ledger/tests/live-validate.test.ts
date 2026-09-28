// live-validate.test · scripts/live-validate.ts run against the in-process pilot. The pilot's scripted
// brain obeys the validator's machine lines (TOOL / ARGS / CARD / QUESTION), so every section except
// schedules (minute-resolution timers) runs end to end with no model: reads, blocks, governance,
// writes, questions and documents must all PASS on the demo books.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  blockSources,
  datesFor,
  honestyProblem,
  LiveValidator,
  readCases,
  renderMarkdown,
  resolveBlockArgs,
  subsetMismatch,
  writeInstruction,
  type Report,
} from '../../../scripts/live-validate.ts';
import { LEDGER_ROOT, manifest } from '../src/index.ts';
import { bootPilot, call, finish, type BrainView, type Pilot } from './harness.ts';

/** The instruction format the validator writes, obeyed literally. */
function scriptedBrain(v: BrainView) {
  // A person's own answer reads `amount_rupees: 41`; one relayed by NeuralChat (v3 S5) is untrusted JSON data.
  const answered = /amount_rupees: (\S+)/.exec(v.job) ?? /"amount_rupees": "?([0-9.]+)/.exec(v.job);
  if (v.job.includes('You asked:')) return finish(`amount_rupees=${answered?.[1] ?? '?'}`);
  if (v.job.includes('WOKEN')) return finish('Woken with the answer; done.');
  if (v.calls === 0) {
    const q = /^QUESTION: (.+)$/m.exec(v.job);
    if (q) return call('job.ask', JSON.parse(q[1]!));
    const tool = /^TOOL: (\S+)$/m.exec(v.job);
    const args = /^ARGS: (.+)$/m.exec(v.job);
    if (tool && args) {
      const card = /^CARD: required$/m.test(v.job) ? { card: { what: `live-validate ${tool[1]}`, why: 'acceptance check', changes: args[1]!.slice(0, 200), if_no_answer: 'nothing changes' } } : {};
      return call(tool[1]!, { ...JSON.parse(args[1]!), ...card });
    }
    return finish('Nothing to do.');
  }
  const last = v.results.at(-1)!;
  return last.text.includes('Proposal ') ? { text: 'waiting' } : finish(`Result: ${last.text.slice(0, 300)}`);
}

describe('pure helpers', () => {
  const d = datesFor('2026-09-27');
  const chart = { bank: '1010', cash: '1000', expense: '6300', income: '4000', budget: '6400' };
  it('derives month, previous month and quarter from today', () => {
    expect(d).toMatchObject({ month: '2026-09', monthTo: '2026-09-30', prevFrom: '2026-08-01', prevTo: '2026-08-31', quarterFrom: '2026-07-01', quarterTo: '2026-09-30', todayPlus30: '2026-10-27' });
    expect(datesFor('2026-01-15')).toMatchObject({ prevMonth: '2025-12', prevTo: '2025-12-31', quarterTo: '2026-03-31' });
  });
  it('covers every read of the manifest', () => {
    const cases = readCases(d, chart);
    for (const a of manifest.abilities.filter((x) => x.kind === 'read')) expect(cases[a.key]?.length, a.key).toBeGreaterThan(0);
  });
  it('resolves block placeholders and names the ones it cannot', () => {
    expect(resolveBlockArgs({ from: '{{month_from}}', code: '{{row.code}}' }, d, chart)).toEqual({ args: { from: '2026-09-01', code: '1010' }, unresolved: [] });
    expect(resolveBlockArgs({ x: '{{nope}}' }, d, chart).unresolved).toEqual(['nope']);
    expect(blockSources({ a: [{ ability: 'x.y', args: { k: 1 } }, { ability: 'x.y', args: { k: 1 } }] })).toHaveLength(1);
  });
  it('checks honesty: empty must agree with the sources cited', () => {
    const now = new Date();
    const base = { generatedAt: now.toISOString(), currency: 'INR' };
    expect(honestyProblem({ ...base, empty: false, sources: { entries: 2, entry_ids: ['a', 'b'] }, rows: [1] }, now)).toBeNull();
    expect(honestyProblem({ ...base, empty: true, sources: { entries: 3, entry_ids: [] }, rows: [] }, now)).toMatch(/says empty/);
    expect(honestyProblem({ ...base, empty: false, sources: { entries: 0, entry_ids: [] }, rows: [] }, now)).toMatch(/cites no sources/);
    expect(honestyProblem({ currency: 'INR', sources: {} }, now)).toBe('no generatedAt');
    expect(honestyProblem({ ...base, sources: null }, now)).toBe('no sources');
  });
  it('compares a card’s args to what was asked', () => {
    expect(subsetMismatch({ a: 1, l: [{ x: 2 }] }, { a: 1, b: 9, l: [{ x: 2, y: 3 }] })).toBeNull();
    expect(subsetMismatch({ a: 1 }, { a: 2 })).toMatch(/args\.a/);
    expect(writeInstruction('T', 'i', 'ledger.x', { a: 1 }, true, 'w')).toMatch(/^TOOL: ledger\.x\nARGS: \{"a":1\}\nCARD: required$/m);
  });
});

describe('live validation against the pilot', () => {
  let P: Pilot;
  let filesDir: string;
  let report: Report;
  beforeAll(async () => {
    filesDir = await mkdtemp(path.join(os.tmpdir(), 'neop-lv-files-'));
    P = await bootPilot({ backendConfig: () => ({ documents: { backend: 'local', dir: filesDir } }) });
    P.setBrain(scriptedBrain);
    // v3 S7: nep-gst is built into Ledger, so the validator exercises its writes. Preparing a return reads the books and
    // the GSTIN profile only (no GSP call): a profile-only credential, as ops would connect it. Portal writes stay off (gst: false).
    await P.setDoorSecret('gst_portal', { provider: 'gsp', base_url: 'http://127.0.0.1:9', client_id: 'c', client_secret: 's', username: 'acme', gstin: '27AAPFU0939F1ZV', assume_supply: 'intra_state' });
    const v = new LiveValidator({
      baseUrl: P.platformUrl,
      adminToken: P.admin.token,
      memberToken: P.member.token,
      app: 'ledger',
      only: ['reads', 'blocks', 'governance', 'writes', 'questions', 'documents'],
      budgetUsd: 1,
      expectRoad: 'gateway',
      emailTo: 'lv-check@acme.example',
      // v3 (S8): the pilot's email door is in its secret store, which a remote check cannot list: named here.
      doors: ['email'],
      gst: false,
      jobTimeoutMs: 30_000,
      pollMs: 100,
      scheduleLeadMin: 1,
      repoRoot: path.resolve(LEDGER_ROOT, '../..'),
    });
    report = await v.run();
  }, 300_000);
  afterAll(async () => {
    await P?.close();
    await rm(filesDir, { recursive: true, force: true });
  });

  it('every check passes; nothing is skipped', () => {
    const bad = report.rows.filter((r) => r.result !== 'PASS');
    // v3 S7: the only rows that are not PASS are nep-gst's three GST-portal effects, which the validator never runs
    // without --gst (a real sandbox portal and a person entering the OTP) — exactly these, with exactly that reason.
    const portal = 'a GST portal effect (save / OTP / file) — run with --gst only against a sandbox portal';
    expect(bad.map((r) => `${r.result} ${r.section} · ${r.item}: ${r.evidence}`).sort()).toEqual(
      ['gst.gstr3b.file', 'gst.gstr3b.save', 'gst.otp.request'].map((k) => `SKIPPED writes · ${k}: ${portal}`),
    );
  });

  it('exercises every read and every write of the manifest, and every block with reads', () => {
    const passed = (s: string) => report.rows.filter((r) => r.section === s && r.result === 'PASS').map((r) => r.item);
    for (const a of manifest.abilities) {
      const s = a.kind === 'read' ? 'reads' : 'writes';
      expect(passed(s).some((i) => i === a.key || i.startsWith(`${a.key} `)), a.key).toBe(true);
    }
    expect(passed('blocks').length).toBeGreaterThan(20);
    expect(report.rows.find((r) => r.item === 'ledger.journal.post')!.evidence).toContain('wrong fingerprint refused');
    expect(passed('governance')).toEqual(expect.arrayContaining(['standing yes within its cap (₹1.00 ≤ ₹10.00)', 'member changes the switchboard']));
    expect(passed('questions')).toEqual(['question answered via desk', 'question answered via conversation']);
    expect(passed('documents')).toContain('download is identical (sha256)');
  });

  it('every task took the gateway road (presence off)', () => {
    expect(report.rows.filter((r) => /WRONG_ROAD/.test(r.evidence))).toEqual([]);
  });

  it('renders a markdown report with a summary table', () => {
    const md = renderMarkdown(report);
    expect(md).toContain('**All checks pass**');
    expect(md).toMatch(/\| writes \| \d+ \| 0 \| 3 \|/); // v3 S7: nep-gst's three portal effects, skipped without --gst
  });
});

// v3 S5 · the same validator, through the person-facing API only, against an install whose app runs with NEOP presence
// and where NeuralChat speaks Matrix: every task it opens must take the Matrix road (--expect-road matrix); writes are
// approved on the desk, questions answered on the desk and in the conversation (a typed answer in the thread), files
// kept and downloaded — the same PASSes as the platform road.
describe('live validation against the pilot — NeuralChat speaks Matrix', () => {
  let P: Pilot;
  let filesDir: string;
  let report: Report;
  beforeAll(async () => {
    filesDir = await mkdtemp(path.join(os.tmpdir(), 'neop-lv-files-'));
    P = await bootPilot({ presence: 'appservice', neuralchat: true, backendConfig: () => ({ documents: { backend: 'local', dir: filesDir } }) });
    P.setBrain(scriptedBrain);
    await P.setDoorSecret('gst_portal', { provider: 'gsp', base_url: 'http://127.0.0.1:9', client_id: 'c', client_secret: 's', username: 'acme', gstin: '27AAPFU0939F1ZV', assume_supply: 'intra_state' });
    const v = new LiveValidator({
      baseUrl: P.platformUrl,
      adminToken: P.admin.token,
      memberToken: P.member.token,
      app: 'ledger',
      only: ['reads', 'blocks', 'governance', 'writes', 'questions', 'documents'],
      budgetUsd: 1,
      emailTo: 'lv-check@acme.example',
      doors: ['email'],
      gst: false,
      jobTimeoutMs: 30_000,
      pollMs: 100,
      scheduleLeadMin: 1,
      repoRoot: path.resolve(LEDGER_ROOT, '../..'),
      expectRoad: 'matrix',
    });
    report = await v.run();
  }, 300_000);
  afterAll(async () => {
    await P?.close();
    await rm(filesDir, { recursive: true, force: true });
  }, 120_000);

  it('every check passes through Matrix; only the GST portal effects are skipped (as on the platform road)', () => {
    const bad = report.rows.filter((r) => r.result !== 'PASS');
    const portal = 'a GST portal effect (save / OTP / file) — run with --gst only against a sandbox portal';
    expect(bad.map((r) => `${r.result} ${r.section} · ${r.item}: ${r.evidence}`).sort()).toEqual(
      ['gst.gstr3b.file', 'gst.gstr3b.save', 'gst.otp.request'].map((k) => `SKIPPED writes · ${k}: ${portal}`),
    );
    expect(report.rows.filter((r) => r.section === 'writes').length).toBeGreaterThan(5);
    expect(report.rows.filter((r) => r.section === 'questions' && r.result === 'PASS').map((r) => r.item)).toEqual(['question answered via desk', 'question answered via conversation']);
  });
});
