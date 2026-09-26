// backup.test · restore one company in one app's family without touching
// another company (plan §Backups).
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import pg from 'pg';
import { backupSchemas, backupStamp, exportCompany, importCompany, nightlyBackup, restoreSchema, runsToPrune } from '@neop/pgkit';
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

// Nightly per-schema exports. The dump needs a pg_dump matching the server (17): CI installs
// postgresql-client-17; locally set NEOS_PG_DUMP/NEOS_PG_RESTORE (the compose backup service is proven live).
const hasPgDump = (() => {
  try {
    return /\b1[7-9]\./.test(execFileSync(process.env.NEOS_PG_DUMP ?? 'pg_dump', ['--version'], { encoding: 'utf8' }));
  } catch {
    return false;
  }
})();

it('retention keeps the newest N runs and never touches anything that is not a run', () => {
  const names = ['20260920T020000Z', '20260921T020000Z', 'notes.txt', '20260922T020000Z', 'lost+found', '20260923T020000Z'];
  expect(runsToPrune(names, 2)).toEqual(['20260920T020000Z', '20260921T020000Z']);
  expect(runsToPrune(names, 10)).toEqual([]);
  expect(runsToPrune(names, 0)).toEqual(['20260920T020000Z', '20260921T020000Z', '20260922T020000Z']); // always keeps one
  expect(backupStamp(new Date('2026-09-26T02:00:03.456Z'))).toBe('20260926T020003Z');
});

it('discovers every migrated family to dump (neos + each app)', async () => {
  expect(await backupSchemas(P.adminUrl)).toEqual(expect.arrayContaining(['neos', 'ledger']));
});

it.skipIf(!hasPgDump)('nightly: per-schema pg_dump + per-company exports with retention; one schema restores alone', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'neop-nightly-'));
  for (const old of ['20200101T020000Z', '20200102T020000Z']) await mkdir(path.join(dir, old));
  const m = await nightlyBackup({ adminUrl: P.adminUrl, dir, keep: 2, companies: true, schemas: ['neos', 'ledger'] });
  expect(m.schemas.map((s) => s.schema)).toEqual(['neos', 'ledger']);
  expect(m.schemas.every((s) => s.bytes > 1000)).toBe(true);
  expect(m.companies.some((c) => c.schema === 'ledger' && c.company_id === P.company.id)).toBe(true);
  expect(m.removed).toEqual(['20200101T020000Z']);
  expect((await readdir(dir)).sort()).toEqual(['20200102T020000Z', m.stamp]);
  const before = strip(await tb());
  const c = new pg.Client({ connectionString: P.adminUrl });
  await c.connect();
  await c.query('begin');
  await c.query("select set_config('neos.company_id', $1, true)", [P.company.id]);
  await c.query("delete from ledger.journal_lines where company_id = $1 and entry_id in (select id from ledger.journal_entries where company_id = $1 and reference = 'seed:capital')", [P.company.id]);
  await c.query("delete from ledger.journal_entries where company_id = $1 and reference = 'seed:capital'", [P.company.id]);
  await c.query('commit');
  await c.end();
  expect(strip(await tb())).not.toEqual(before);
  await restoreSchema(P.adminUrl, path.join(dir, m.stamp, 'ledger.dump'), 'ledger');
  // A restore rewrites the heap, so row order (e.g. of cited source ids) may differ; the figures may not.
  const canon = (v: any): any => (Array.isArray(v) ? v.map(canon).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, canon(x)])) : v);
  expect(canon(strip(await tb()))).toEqual(canon(before));
});
