// migration.test · forward-only, immutable once run, proven on populated data,
// and no migration may leave a table without company_id + RLS.
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFamily, checkMigrateLedger, createTestDatabase, destructiveStatements, migrate, policyKeyedOnCompany, roleUrl, createPool, templateFiles } from '@neop/pgkit';
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
    expect(first.map((m) => m.name)).toEqual(['001_standard.sql', 't002_trace_and_acks.sql', 't003_door_journal.sql', 't004_timers_and_summary.sql', 't005_input_waits.sql', 't006_documents_files.sql', 't007_standard_columns.sql', 't008_transitions.sql', 't009_notify.sql', 't010_board_truth.sql', 't011_approved_path.sql', 't012_presence.sql', '002_ledger.sql', '003_budgets.sql', '004_bookkeeping.sql', '005_inherited.sql', '006_source_documents.sql', '007_views.sql']);
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

  it('every shipped migration is listed, in order, and is either baseline or proven (migrate.json)', async () => {
    for (const dir of [path.join(LEDGER_ROOT, 'migrations'), path.join(LEDGER_ROOT, '../../packages/neop-template/migrations'), path.join(LEDGER_ROOT, '../../packages/platform/migrations')]) {
      const led = JSON.parse(await readFile(path.join(dir, 'migrate.json'), 'utf8'));
      for (const m of led.migrations) {
        expect(Object.keys(m).every((k) => ['file', 'tables', 'baseline', 'proven_on_populated_data'].includes(k)), `${dir} ${m.file}`).toBe(true);
        // Baseline files were applied to empty schemas: no self-attested "proven" string on them.
        if (m.baseline) expect(m.proven_on_populated_data, `${dir} ${m.file}`).toBeUndefined();
      }
      // Production accepts the ledger as it ships.
      process.env.NEOS_ENV = 'production';
      try {
        await checkMigrateLedger(dir, led.migrations.map((m: any) => m.file));
      } finally {
        delete process.env.NEOS_ENV;
      }
    }
  });

  it('migrate.json: baseline only for the first release, never claiming proof; production needs proof on every later file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neop-led-'));
    const files = ['002_a.sql', '003_b.sql', '004_c.sql'];
    const write = (m: unknown[]) => writeFile(path.join(dir, 'migrate.json'), JSON.stringify({ migrations: m }));
    await write([{ file: '002_a.sql', baseline: true }, { file: '003_b.sql', baseline: false }, { file: '004_c.sql', baseline: true }]);
    await expect(checkMigrateLedger(dir, files)).rejects.toThrow(/marks 004_c\.sql baseline after a non-baseline/);
    await write([{ file: '002_a.sql', baseline: true, proven_on_populated_data: 'trust me' }, { file: '003_b.sql' }, { file: '004_c.sql' }]);
    await expect(checkMigrateLedger(dir, files)).rejects.toThrow(/002_a\.sql is baseline .* cannot claim/);
    await write([{ file: '002_a.sql', baseline: true }, { file: '003_b.sql', baseline: false, proven_on_populated_data: '2026-09-26 · copy of acme' }, { file: '004_c.sql', baseline: false }]);
    expect((await checkMigrateLedger(dir, files))!.map((m) => m.file)).toEqual(files);
    process.env.NEOS_ENV = 'production';
    try {
      await expect(checkMigrateLedger(dir, files)).rejects.toThrow(/not proven on populated data: 004_c\.sql$|not proven on populated data: 004_c\.sql —/);
    } finally {
      delete process.env.NEOS_ENV;
    }
  });

  it('expand-then-contract: destructive DDL in a new migration is refused unless it is a marked contract step naming its expand', async () => {
    expect(destructiveStatements('alter table {{schema}}.parties add column region text;')).toEqual([]);
    expect(destructiveStatements("alter table x add column y int not null default 0; alter table x drop constraint x_ck; alter table x alter column y drop not null;")).toEqual([]);
    expect(destructiveStatements('-- we never drop table here\nselect 1;')).toEqual([]);
    expect(destructiveStatements('drop table {{schema}}.budgets;')).toEqual(['DROP TABLE']);
    expect(destructiveStatements('alter table {{schema}}.parties drop column region;')).toEqual(['DROP COLUMN']);
    expect(destructiveStatements('alter table {{schema}}.parties drop region;')).toEqual(['DROP COLUMN']);
    expect(destructiveStatements('alter table {{schema}}.parties rename column name to legal_name;')).toEqual(['RENAME']);
    expect(destructiveStatements('alter table {{schema}}.parties rename to counterparties;')).toEqual(['RENAME']);
    expect(destructiveStatements('alter table {{schema}}.budgets alter column amount_minor type numeric(20,2);')).toEqual(['ALTER COLUMN … TYPE']);
    expect(destructiveStatements('alter table {{schema}}.parties alter column gstin set not null;')).toEqual(['SET NOT NULL']);
    expect(destructiveStatements('alter table {{schema}}.parties add column tier numeric(4,2) not null;')).toEqual(['ADD COLUMN … NOT NULL without DEFAULT']);
    expect(destructiveStatements('truncate {{schema}}.parties;')).toEqual(['TRUNCATE']);

    // Through the runner, on the populated ledger family from the tests above.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neop-contract-'));
    await cp(path.join(LEDGER_ROOT, 'migrations'), dir, { recursive: true });
    const led = JSON.parse(await readFile(path.join(dir, 'migrate.json'), 'utf8'));
    const add = async (file: string, sql: string) => {
      await writeFile(path.join(dir, file), sql);
      led.migrations.push({ file, tables: ['parties'], baseline: false });
      await writeFile(path.join(dir, 'migrate.json'), JSON.stringify(led));
    };
    const run = async () => migrate({ adminUrl: db.adminUrl, schema: 'ledger', sources: { dir, prepend: await templateFiles(TEMPLATE_MIGRATIONS) }, lintExempt: TEMPLATE_INFRA_TABLES });
    await add('099_party_region.sql', 'alter table {{schema}}.parties add column region text;');
    // (005 already ran in the test above; the same file is a no-op here.)
    await add('100_region_code.sql', 'alter table {{schema}}.parties add column region_code text;\nalter table {{schema}}.parties drop column region;');
    await expect(run()).rejects.toThrow(/100_region_code\.sql is destructive \(DROP COLUMN\)/);
    // Refused before anything ran: the safe half of 006 did not apply either.
    const c = createPool(roleUrl(db.adminUrl, 'ledger_app'));
    const cols = async () => (await c.query("select column_name from information_schema.columns where table_schema='ledger' and table_name='parties' and column_name like 'region%' order by 1")).rows.map((r) => r.column_name);
    expect(await cols()).toEqual(['region']);
    // A marker that names no earlier migration (or a later one) is not enough.
    await writeFile(path.join(dir, '100_region_code.sql'), '-- contract: region is replaced\nalter table {{schema}}.parties drop column region;');
    await expect(run()).rejects.toThrow(/must name the earlier expand migration/);
    await writeFile(path.join(dir, '100_region_code.sql'), '-- contract: region is replaced; expanded by 007_later.sql\nalter table {{schema}}.parties drop column region;');
    await expect(run()).rejects.toThrow(/names 007_later\.sql, which is not an earlier migration/);
    // Split properly: expand in 006, contract in 007 pointing back at it.
    await writeFile(path.join(dir, '100_region_code.sql'), 'alter table {{schema}}.parties add column region_code text;');
    await add('101_drop_region.sql', '-- contract: nothing reads region since 1.4; expanded by 100_region_code.sql\nalter table {{schema}}.parties drop column region;');
    expect((await run()).map((m) => m.name)).toEqual(['100_region_code.sql', '101_drop_region.sql']);
    expect(await cols()).toEqual(['region_code']);
    await c.end();
  });

  it('tenant lint checks what each policy says, not just that one exists', async () => {
    expect(policyKeyedOnCompany("(company_id = (NULLIF(current_setting('neos.company_id'::text, true), ''::text))::uuid)")).toBe(true);
    expect(policyKeyedOnCompany("((company_id = (current_setting('neos.company_id'::text))::uuid) AND (status <> 'x'::text))")).toBe(true);
    expect(policyKeyedOnCompany('true')).toBe(false);
    expect(policyKeyedOnCompany("((company_id = (current_setting('neos.company_id'::text))::uuid) OR true)")).toBe(false);
    expect(policyKeyedOnCompany("(owner_id = (current_setting('neos.company_id'::text))::uuid)")).toBe(false);
    expect(policyKeyedOnCompany(null)).toBe(false);

    const rls = (t: string) => `alter table {{schema}}.${t} enable row level security; alter table {{schema}}.${t} force row level security;`;
    const table = (t: string) => `create table {{schema}}.${t} (id serial primary key, company_id uuid not null, owner uuid);`;
    const good = `create policy company_isolation on {{schema}}.%t using (company_id = nullif(current_setting('neos.company_id', true), '')::uuid) with check (company_id = nullif(current_setting('neos.company_id', true), '')::uuid);`;
    const cases: [string, string, RegExp | null][] = [
      ['open', `create policy anyone on {{schema}}.%t using (true);`, /policy anyone keyed on company_id/],
      ['wrongcol', `create policy owner on {{schema}}.%t using (owner = current_setting('neos.company_id')::uuid);`, /policy owner keyed on company_id/],
      ['loosecheck', `create policy p on {{schema}}.%t using (company_id = current_setting('neos.company_id')::uuid) with check (true);`, /policy p WITH CHECK keyed on company_id/],
      ['extra', `${good} create policy also_open on {{schema}}.%t for select using (true);`, /policy also_open keyed/],
      ['fine', `${good} create policy narrow on {{schema}}.%t as restrictive using (owner is not null);`, null],
    ];
    for (const [name, pol, want] of cases) {
      const fam = `lint_${name}`;
      await bootstrapFamily(db.adminUrl, fam);
      const dir = await mkdtemp(path.join(os.tmpdir(), 'neop-pol-'));
      await writeFile(path.join(dir, '002_t.sql'), `${table('notes')} ${rls('notes')} ${pol.replaceAll('%t', 'notes')}`);
      const p = migrate({ adminUrl: db.adminUrl, schema: fam, sources: { dir, prepend: await templateFiles(TEMPLATE_MIGRATIONS) }, lintExempt: TEMPLATE_INFRA_TABLES });
      if (want) await expect(p, name).rejects.toThrow(want);
      else expect((await p).map((m) => m.name), name).toContain('002_t.sql');
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
