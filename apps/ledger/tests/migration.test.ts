// migration.test · forward-only, immutable once run, proven on populated data,
// and no migration may leave a table without company_id + RLS.
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFamily, createTestDatabase, migrate, roleUrl, createPool, templateFiles } from '@neop/pgkit';
import { migrateApp, TEMPLATE_INFRA_TABLES, TEMPLATE_MIGRATIONS } from '@neop/template';
import { ledgerApp, LEDGER_ROOT, seedLedger } from '../src/index.ts';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
const CO = '11111111-2222-3333-4444-555555555555';
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => db?.drop());

describe('migrations', () => {
  it('apply once, then re-running is a no-op', async () => {
    const app = await ledgerApp();
    const first = await migrateApp(db.adminUrl, app);
    expect(first.map((m) => m.name)).toEqual(['001_standard.sql', 't002_trace_and_acks.sql', 't003_door_journal.sql', 't004_timers_and_summary.sql', '002_ledger.sql', '003_budgets.sql', '004_bookkeeping.sql', '005_inherited.sql']);
    expect(await migrateApp(db.adminUrl, app)).toEqual([]);
  });

  it('a new migration is proven on a populated copy', async () => {
    const pool = createPool(roleUrl(db.adminUrl, 'ledger_app'));
    await seedLedger(pool, CO);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neop-mig-'));
    await cp(path.join(LEDGER_ROOT, 'migrations'), dir, { recursive: true });
    await writeFile(
      path.join(dir, '099_party_region.sql'),
      `alter table {{schema}}.parties add column region text;`,
    );
    // Not in migrate.json yet: refused before anything runs.
    const prepend = await templateFiles(TEMPLATE_MIGRATIONS);
    const run = () => migrate({ adminUrl: db.adminUrl, schema: 'ledger', sources: { dir, prepend }, lintExempt: TEMPLATE_INFRA_TABLES });
    await expect(run()).rejects.toThrow(/does not list 099_party_region\.sql/);
    const led = JSON.parse(await readFile(path.join(dir, 'migrate.json'), 'utf8'));
    led.migrations.push({ file: '099_party_region.sql', tables: ['parties'] });
    await writeFile(path.join(dir, 'migrate.json'), JSON.stringify(led));
    // In production an unproven migration is refused too; this test is the proof, so we mark it after.
    process.env.NEOS_ENV = 'production';
    try {
      await expect(run()).rejects.toThrow(/not proven on populated data: 099_party_region\.sql/);
    } finally {
      delete process.env.NEOS_ENV;
    }
    const applied = await migrate({
      adminUrl: db.adminUrl,
      schema: 'ledger',
      sources: { dir, prepend: await templateFiles(TEMPLATE_MIGRATIONS) },
      lintExempt: TEMPLATE_INFRA_TABLES,
    });
    expect(applied.map((m) => m.name)).toEqual(['099_party_region.sql']);
    const c = await pool.connect();
    await c.query('begin');
    await c.query("select set_config('neos.company_id', $1, true)", [CO]);
    expect((await c.query('select count(*)::int as n from ledger.journal_entries')).rows[0].n).toBeGreaterThan(20);
    await c.query('rollback');
    c.release();
    await pool.end();

    // Editing a migration that already ran is refused.
    await writeFile(path.join(dir, '099_party_region.sql'), 'alter table {{schema}}.parties add column region2 text;');
    await expect(
      migrate({ adminUrl: db.adminUrl, schema: 'ledger', sources: { dir, prepend: await templateFiles(TEMPLATE_MIGRATIONS) }, lintExempt: TEMPLATE_INFRA_TABLES }),
    ).rejects.toThrow(/changed after it ran/);
  });

  it('every shipped migration is listed, in order, and marked proven (migrate.json)', async () => {
    for (const dir of [path.join(LEDGER_ROOT, 'migrations'), path.join(LEDGER_ROOT, '../../packages/neop-template/migrations'), path.join(LEDGER_ROOT, '../../packages/platform/migrations')]) {
      const led = JSON.parse(await readFile(path.join(dir, 'migrate.json'), 'utf8'));
      expect(led.migrations.every((m: any) => m.proven_on_populated_data), dir).toBe(true);
    }
  });

  it('the template upgrades through its own stream without taking an app number (R2)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neop-clash-'));
    await writeFile(path.join(dir, '001_standard.sql'), 'select 1;');
    await expect(
      migrate({ adminUrl: db.adminUrl, schema: 'ledger', sources: { dir, prepend: await templateFiles(TEMPLATE_MIGRATIONS) }, lintExempt: TEMPLATE_INFRA_TABLES }),
    ).rejects.toThrow(/both the template and the app/);
  });

  it('refuses a table without company_id and row-level security', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neop-bad-'));
    await writeFile(path.join(dir, '002_bad.sql'), 'create table {{schema}}.notes (id serial primary key, body text);');
    await bootstrapFamily(db.adminUrl, 'badapp');
    await expect(
      migrate({ adminUrl: db.adminUrl, schema: 'badapp', sources: { dir, prepend: await templateFiles(TEMPLATE_MIGRATIONS) }, lintExempt: TEMPLATE_INFRA_TABLES }),
    ).rejects.toThrow(/tenant lint failed[\s\S]*badapp\.notes/);
  });

  it('floats for money are refused by the schema, and entries must balance', async () => {
    const pool = createPool(roleUrl(db.adminUrl, 'ledger_app'));
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('neos.company_id', $1, true)", [CO]);
      const e = await c.query<{ id: string }>("insert into ledger.journal_entries (company_id, entry_date, memo, reference, currency, source) values ($1, '2026-09-30', 'bad', 'bad-1', 'INR', 'manual') returning id", [CO]);
      const acct = await c.query<{ id: string }>("select id from ledger.accounts where code = '1000'");
      await c.query('insert into ledger.journal_lines (company_id, entry_id, account_id, debit_minor) values ($1, $2, $3, 100)', [CO, e.rows[0]!.id, acct.rows[0]!.id]);
      await expect(c.query('commit')).rejects.toThrow(/does not balance/);
    } finally {
      c.release();
      await pool.end();
    }
  });
});
