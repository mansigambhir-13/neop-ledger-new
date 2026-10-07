// dba-bundle.test · WP v3 §11 "the DBA path": scripts/dba-bundle.ts renders ONE reviewable .sql — the
// family's roles and grants, the schema, every shipped migration (template stream, then Ledger's) with
// {{schema}} substituted and its sha256. The file carries every checksum, and applied to an empty
// database it leaves exactly the schema_migrations — and the same tables and columns — that migrate does.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, renderDbaBundle, shippedMigrations } from '@neop/pgkit';
import { appMigrationSources, LOCK_FILE, migrateApp, packageBootstrapSql, readLock } from '@neop/template';
import { ledgerApp, LEDGER_ROOT } from '../src/index.ts';

const REPO = path.resolve(LEDGER_ROOT, '../..');
let viaMigrate: Awaited<ReturnType<typeof createTestDatabase>>;
let viaBundle: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  [viaMigrate, viaBundle] = await Promise.all([createTestDatabase(), createTestDatabase()]);
});
afterAll(async () => {
  await viaMigrate?.drop();
  await viaBundle?.drop();
});

async function read<T>(url: string, sql: string): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(sql)).rows as T[];
  } finally {
    await c.end();
  }
}

describe('the DBA bundle', () => {
  it('the script prints one .sql carrying every shipped migration’s sha256, {{schema}} substituted, and never connects', async () => {
    const { stdout } = await promisify(execFile)(path.join(REPO, 'node_modules/.bin/tsx'), ['scripts/dba-bundle.ts', 'ledger'], {
      cwd: REPO,
      // No database reachable: a script that tried to connect would fail here.
      env: { ...process.env, NEOS_ADMIN_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' },
      maxBuffer: 16 * 1024 * 1024,
    });
    const shipped = await shippedMigrations(await appMigrationSources(await ledgerApp()));
    expect(shipped.map((m) => m.name)).toContain('t009_notify.sql');
    expect(shipped.map((m) => m.name)).toContain('007_views.sql');
    for (const m of shipped) {
      expect(stdout).toContain(`-- ─── ${m.name} · sha256 ${m.checksum}`);
      expect(stdout).toContain(`values ('${m.name}', '${m.checksum}')`);
    }
    expect(stdout).not.toContain('{{schema}}');
    expect(stdout).toContain('create role ledger_runner login bypassrls');
    expect(stdout).toContain("alter role ledger_app set search_path = 'ledger'");
    expect(stdout).toContain('create function "ledger".answer_proposal(');
    // v3 S7: the packages installed into Ledger's build — their files are in the set above, their roles here.
    expect(stdout).toContain('installed by `neos install` from nep-gst@2.0.0');
    expect(stdout).toContain('create role ledger_nep_gst login nobypassrls');
    expect(stdout).toContain('grant select, insert, update on "ledger".nep_gst_returns to ledger_nep_gst;');
  });

  it('applied to an empty database it yields the same schema_migrations, tables and columns as migrate', async () => {
    const app = await ledgerApp();
    await migrateApp(viaMigrate.adminUrl, app); // (also makes sure the cluster-wide roles exist)
    // v3 S7: with the installed packages' roles and grants, as scripts/dba-bundle.ts renders it.
    const extra = [{ title: 'installed packages', sql: packageBootstrapSql('ledger', await readLock(path.join(LEDGER_ROOT, LOCK_FILE))) }];
    const bundle = await renderDbaBundle({ schema: 'ledger', sources: await appMigrationSources(app), extra });
    const c = new pg.Client({ connectionString: viaBundle.adminUrl });
    await c.connect();
    try {
      await c.query(bundle.sql);
    } finally {
      await c.end();
    }
    const ledger = 'select name, checksum from ledger.schema_migrations order by name';
    const a = await read<{ name: string; checksum: string }>(viaMigrate.adminUrl, ledger);
    const b = await read<{ name: string; checksum: string }>(viaBundle.adminUrl, ledger);
    expect(b).toEqual(a);
    expect(b.length).toBe(bundle.migrations.length);
    const shape = `select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema = 'ledger' order by 1, 2`;
    expect(await read(viaBundle.adminUrl, shape)).toEqual(await read(viaMigrate.adminUrl, shape));
    const security = `select c.relname, c.relrowsecurity, c.relforcerowsecurity, r.rolname as owner from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.oid = c.relowner
                       where n.nspname = 'ledger' and c.relkind in ('r', 'v') order by 1`;
    expect(await read(viaBundle.adminUrl, security)).toEqual(await read(viaMigrate.adminUrl, security));
    const grants = `select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'ledger' order by 1, 2, 3`;
    expect(await read(viaBundle.adminUrl, grants)).toEqual(await read(viaMigrate.adminUrl, grants));
  });
});
