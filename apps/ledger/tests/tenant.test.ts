// tenant.test · B1: a token for company A cannot read or write company B's rows.
import { afterAll, beforeAll, expect, it } from 'vitest';
import pg from 'pg';
import { roleUrl, withCompany } from '@neop/pgkit';
import { bootPilot, call, finish, type Pilot } from './harness.ts';

let P: Pilot;
let B: { id: string };
let bUser: { id: string; token: string };
beforeAll(async () => {
  P = await bootPilot();
  B = await P.platform.createCompany('Bharat Exports', 'Asia/Kolkata');
  bUser = await P.platform.createUser(B.id, { name: 'Bina', email: 'bina@bharat.example', role: 'admin' });
  await P.platform.installApp(B.id, 'ledger');
});
afterAll(async () => P?.close());

it('company B sees none of company A’s books through L3', async () => {
  const a = await P.api('POST', '/api/apps/ledger/read/ledger.report.trial_balance', { as_of: '2026-09-30' });
  const b = await P.api('POST', '/api/apps/ledger/read/ledger.report.trial_balance', { as_of: '2026-09-30' }, bUser.token);
  expect(a.body.result.sources.entries).toBeGreaterThan(20);
  expect(b.body.result.sources.entries).toBe(0);
  expect(b.body.result.empty).toBe(true);
});

it('a company that has not installed the app reaches nothing (5a)', async () => {
  const C = await P.platform.createCompany('Chennai Mills');
  const cUser = await P.platform.createUser(C.id, { name: 'Chitra', email: 'c@chennai.example', role: 'admin' });
  const r = await P.api('POST', '/api/apps/ledger/read/ledger.report.trial_balance', { as_of: '2026-09-30' }, cUser.token);
  expect(r.status).toBe(403);
  expect(r.body.error.code).toBe('not_installed');
  const ask = await P.api('POST', '/api/ask', { text: 'Show me the P&L' }, cUser.token);
  expect(ask.body.handed_to).toBeNull();
});

it('the app role sees nothing without a company, and cannot write another company’s rows', async () => {
  const c = new pg.Client(roleUrl(P.adminUrl, 'ledger_app'));
  await c.connect();
  try {
    expect((await c.query('select count(*)::int as n from ledger.journal_entries')).rows[0].n).toBe(0);
    await c.query('begin');
    await c.query("select set_config('neos.company_id', $1, true)", [B.id]);
    expect((await c.query('select count(*)::int as n from ledger.journal_entries')).rows[0].n).toBe(0);
    await expect(
      c.query("insert into ledger.accounts (company_id, code, name, type, subtype) values ($1, '9999', 'x', 'asset', 'cash')", [P.company.id]),
    ).rejects.toThrow(/row-level security/);
    await c.query('rollback');
  } finally {
    await c.end();
  }
});

it('a job token for company B cannot act on company A’s job', async () => {
  P.setBrain((v) => (v.calls === 0 ? call('ledger.report.pnl', { from: '2026-08-01', to: '2026-08-31' }) : finish('ok')));
  const { task_id, job_id } = await P.ask('P&L for August');
  await P.waitFor(async () => (await P.task(task_id)).task.status === 'COMPLETED', 'done');
  const forged = await P.backend.core.jobTokens.mint({ sub: job_id, sid: 'whatever', company_id: B.id, abilities: ['ledger.report.pnl'] }, 60_000);
  const r = await fetch(`http://127.0.0.1:${P.backend.ports.gate}/gate/call`, {
    method: 'POST',
    headers: { authorization: `Bearer ${forged}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'ledger.report.pnl', args: { from: '2026-08-01', to: '2026-08-31' } }),
  });
  expect(r.status).toBe(409);
  // And the runner's cross-company role cannot touch subject tables at all.
  const run = new pg.Client(roleUrl(P.adminUrl, 'ledger_runner'));
  await run.connect();
  await expect(run.query('select * from ledger.journal_entries limit 1')).rejects.toThrow(/permission denied/);
  await run.end();
  void withCompany;
});
