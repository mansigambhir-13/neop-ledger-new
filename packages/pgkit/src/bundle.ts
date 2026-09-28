// The DBA path (WP v3 §11): "the NEOP ships a migration file; the DBA reviews it, applies it to the
// main database, creates a role that can see only that schema". This renders that one file: the
// family's roles and grants (what bootstrapFamily does), the schema and its schema_migrations ledger,
// then every shipped migration — template stream, then the app's — with {{schema}} substituted, each
// in its own transaction as the migrator, recording its name and sha256 exactly as `migrate` does.
// It only renders text; nothing here connects to a database.

import { readFile } from 'node:fs/promises';
import { deskGrantsSql, familyBootstrapSql, familyRoles, assertIdent } from './roles.ts';
import { checkMigrateLedger, render, shippedMigrationFiles, type MigrationSource } from './migrate.ts';
import path from 'node:path';

export interface DbaBundle {
  schema: string;
  sql: string;
  migrations: { name: string; checksum: string }[];
}

export async function renderDbaBundle(opts: { schema: string; sources: MigrationSource; title?: string; extra?: { title: string; sql: string }[] }): Promise<DbaBundle> {
  const { schema } = opts;
  assertIdent(schema);
  const roles = familyRoles(schema);
  const files = await shippedMigrationFiles(opts.sources);
  const ts = files.filter((f) => !f.name.endsWith('.sql'));
  if (ts.length) throw new Error(`${ts.map((f) => f.name).join(', ')}: a data migration (.ts) cannot be rendered to SQL; run it with scripts/migrate.ts in the same window`);
  // What migrate.json says about each file (baseline, proof), shown to the reviewer beside it.
  const ledgers = new Map<string, { baseline?: boolean; proven_on_populated_data?: string; tables?: string[] }>();
  for (const dir of new Set(files.map((f) => path.dirname(f.file)))) {
    const names = files.filter((f) => path.dirname(f.file) === dir).map((f) => path.basename(f.file));
    for (const e of (await checkMigrateLedger(dir, names)) ?? []) ledgers.set(path.join(dir, e.file), e);
  }
  const out: string[] = [];
  out.push(`-- ═══ DBA bundle · ${opts.title ?? schema} · schema ${schema} ═══`);
  out.push('-- Rendered by scripts/dba-bundle.ts. Review, then apply with an admin connection (e.g. psql -v ON_ERROR_STOP=1 -f).');
  out.push('-- Nothing here was applied by the tool that wrote it. Forward-only: a file that already ran is never edited.');
  out.push('--');
  out.push('-- Migrations and their sha256 (what <schema>.schema_migrations records and the backend checks at boot):');
  for (const f of files) out.push(`--   ${f.name.padEnd(32)} sha256 ${f.checksum}`);
  out.push('');
  out.push('-- ── 1 · roles and grants ──────────────────────────────────────────────');
  out.push(familyBootstrapSql(schema));
  out.push('');
  out.push('-- ── 2 · the schema and its migration ledger ───────────────────────────');
  out.push(`create schema if not exists ${schema} authorization ${roles.migrator};`);
  out.push(`set role ${roles.migrator};`);
  out.push(`create table if not exists ${schema}.schema_migrations (\n  name text primary key, checksum text not null, applied_at timestamptz not null default now());`);
  out.push('reset role;');
  out.push('');
  out.push('-- ── 3 · the migrations, in order ──────────────────────────────────────');
  const migrations: DbaBundle['migrations'] = [];
  for (const f of files) {
    const raw = await readFile(f.file, 'utf8');
    const led = ledgers.get(f.file);
    out.push(`-- ─── ${f.name} · sha256 ${f.checksum}`);
    if (led) out.push(`-- ─── tables: ${(led.tables ?? []).join(', ') || '—'} · ${led.baseline ? 'baseline (first release)' : `proven on populated data: ${led.proven_on_populated_data ?? 'NOT YET'}`}`);
    out.push('begin;');
    out.push(`set local role ${roles.migrator};`);
    out.push(`set local search_path to ${schema};`);
    const body = render(raw, schema).trimEnd();
    // A file whose last statement has no ";" would run into the ledger insert below.
    out.push(/;\s*(--[^\n]*)?$/.test(body) ? body : `${body}\n;`);
    out.push(`insert into ${schema}.schema_migrations (name, checksum) values ('${f.name}', '${f.checksum}');`);
    out.push('commit;');
    out.push('');
    migrations.push({ name: f.name, checksum: f.checksum });
  }
  out.push('-- ── 4 · the backend reads the ledger at boot ──────────────────────────');
  out.push(`grant select on ${schema}.schema_migrations to ${roles.app}, ${roles.runner};`);
  out.push('');
  out.push('-- ── 5 · the desk (v3 §11): DML on switchboard + installs, EXECUTE on the desk functions ──');
  out.push('-- Only when the platform has made neos_desk (NOLOGIN); safe to re-run after it does.');
  out.push(`set role ${roles.migrator};`);
  out.push(deskGrantsSql(schema));
  out.push('reset role;');
  out.push('');
  (opts.extra ?? []).forEach((x, i) => {
    out.push(`-- ── ${6 + i} · ${x.title} ──`);
    out.push(x.sql);
    out.push('');
  });
  return { schema, sql: out.join('\n'), migrations };
}
