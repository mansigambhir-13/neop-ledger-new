// new-company.test · a real company starts with EMPTY books (found preparing go-live: the demo data had hidden
// it). The starter chart (seed.ts --starter-chart, applied by scripts/deploy.sh on a first install) gives it the
// accounts Ledger's bookkeeping relies on, idempotently; with nothing else, a gated change works end to end.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyStarterChart, STARTER_CHART_IN_SME } from '../src/index.ts';
import { bootPilot, call, finish, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot({ seed: false });
});
afterAll(async () => P?.close());

const read = async (key: string, args: unknown = {}) => (await P.api('POST', `/api/apps/ledger/read/${key}`, args)).body.result;

it('a new company has no accounts until the starter chart is applied; applying it again adds nothing', async () => {
  expect((await read('ledger.accounts.list', {})).accounts).toEqual([]);
  expect(await applyStarterChart(P.backend.core.appPool, P.company.id)).toEqual({ added: STARTER_CHART_IN_SME.length, total: STARTER_CHART_IN_SME.length });
  expect(await applyStarterChart(P.backend.core.appPool, P.company.id)).toEqual({ added: 0, total: STARTER_CHART_IN_SME.length });
  const codes = (await read('ledger.accounts.list', {})).accounts.map((a: any) => a.code);
  // Every code the bookkeeping itself relies on (domain/bookkeeping.ts ACCT) is there.
  for (const c of ['1010', '1100', '1300', '2000', '2100', '4000']) expect(codes).toContain(c);
});

it('with only the starter chart, a gated posting goes card → yes → executed once, and the books balance', async () => {
  const args = { date: '2026-09-27', memo: 'Office supplies bought', currency: 'INR', lines: [{ account_code: '6500', debit_minor: 50000, credit_minor: 0 }, { account_code: '1010', debit_minor: 0, credit_minor: 50000 }] };
  P.setBrain((v) =>
    v.job.includes('WOKEN') ? finish('Posted the office supplies.') : v.calls === 0 ? call('ledger.journal.post', { ...args, card: { what: 'Post ₹500 office supplies', why: 'asked', changes: 'one journal entry', if_no_answer: 'nothing' } }) : { text: 'waiting' },
  );
  const t = await P.ask('Record ₹500 of office supplies paid from the bank today');
  const card = await P.waitFor(async () => (await P.desk()).find((c) => c.task_id === t.task_id && c.status === 'PENDING'), 'the card');
  expect((await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint })).status).toBe(200);
  await P.waitFor(async () => (await P.desk()).find((c) => c.id === card.id && c.status === 'EXECUTED'), 'executed');
  const tb = await read('ledger.report.trial_balance', { as_of: '2026-09-30' });
  expect(tb.balanced).toBe(true);
  expect(tb.total_debit_minor).toBe(50000);
});
