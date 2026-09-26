// backup.test · restore one company in one app's family without touching
// another company (plan §Backups).
import { afterAll, beforeAll, expect, it } from 'vitest';
import pg from 'pg';
import { exportCompany, importCompany } from '@neop/pgkit';
import { bootPilot, type Pilot } from './harness.ts';
import { seedLedger } from '../src/index.ts';

let P: Pilot;
let B: { id: string; token: string };
beforeAll(async () => {
  P = await bootPilot();
  const co = await P.platform.createCompany('Bharat Exports');
  await P.platform.installApp(co.id, 'ledger');
  const u = await P.platform.createUser(co.id, { name: 'Bina', email: 'bina@bharat.example', role: 'admin' });
  B = { id: co.id, token: u.token };
  await seedLedger(P.backend.core.appPool, co.id);
});
afterAll(async () => P?.close());

const tb = async (token?: string) => (await P.api('POST', '/api/apps/ledger/read/ledger.report.trial_balance', { as_of: '2026-09-30' }, token)).body.result;
const strip = (r: any) => ({ ...r, generatedAt: null });

it('exports a company, survives damage, restores exactly, and leaves the other company alone', async () => {
  const beforeA = strip(await tb());
  const beforeB = strip(await tb(B.token));
  const dump = await exportCompany(P.adminUrl, 'ledger', P.company.id);
  expect(dump.order.indexOf('accounts')).toBeLessThan(dump.order.indexOf('journal_lines'));
  expect(dump.tables.journal_entries!.length).toBeGreaterThan(20);

  // Damage company A only (as an operator with direct access would).
  const c = new pg.Client({ connectionString: P.adminUrl });
  await c.connect();
  await c.query('begin');
  await c.query("select set_config('neos.company_id', $1, true)", [P.company.id]);
  await c.query('delete from ledger.documents where company_id = $1', [P.company.id]);
  await c.query("delete from ledger.journal_lines where company_id = $1 and entry_id in (select id from ledger.journal_entries where company_id = $1 and reference = 'seed:capital')", [P.company.id]);
  await c.query("delete from ledger.journal_entries where company_id = $1 and reference = 'seed:capital'", [P.company.id]);
  await c.query('commit');
  await c.end();
  expect(strip(await tb())).not.toEqual(beforeA);

  const counts = await importCompany(P.adminUrl, dump);
  expect(counts.journal_entries).toBe(dump.tables.journal_entries!.length);
  expect(strip(await tb())).toEqual(beforeA);
  expect(strip(await tb(B.token))).toEqual(beforeB);
});

it('refuses a dump that smuggles another company’s rows', async () => {
  const dump = await exportCompany(P.adminUrl, 'ledger', P.company.id);
  (dump.tables.accounts![0] as any).company_id = B.id;
  await expect(importCompany(P.adminUrl, dump)).rejects.toThrow(/another company/);
});
