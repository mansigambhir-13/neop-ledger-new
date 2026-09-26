import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { assertIdent, familyRoles } from './roles.ts';

export interface MigrationSource {
  /** Directory of numbered files: 001_x.sql, 002_y.sql, 003_z.ts */
  dir: string;
  /**
   * A second, independent stream applied first — the template's migrations
   * (001_standard.sql, then t002_*.sql …) — so the template can upgrade the
   * standard tables without taking a number from the app's own stream (R2).
   */
  prepend?: string[];
}

export interface MigrateOptions {
  adminUrl: string;
  schema: string;
  sources: MigrationSource;
  /** Tables exempt from the tenant lint (infrastructure, not business rows). */
  lintExempt?: string[];
  /** Skip the tenant lint (platform schema, which is not tenant-partitioned the same way). */
  tenantLint?: boolean;
  log?: (msg: string) => void;
}

export interface AppliedMigration {
  name: string;
  checksum: string;
}

interface MigrationFile {
  name: string;
  file: string;
}

function checkStream(files: MigrationFile[], label: string): void {
  const seen = new Set<string>();
  for (const f of files) {
    const num = /^(t?\d{3})_/.exec(f.name)?.[1];
    if (!num) throw new Error(`${label} migration ${f.name} must be named NNN_<what>.sql (or tNNN_ for the template)`);
    if (seen.has(num)) throw new Error(`duplicate migration number ${num} (${f.name})`);
    seen.add(num);
  }
}

async function listFiles(src: MigrationSource): Promise<MigrationFile[]> {
  const template = (src.prepend ?? []).map((f) => ({ name: path.basename(f), file: f })).sort((a, b) => a.name.localeCompare(b.name));
  const names = (await readdir(src.dir)).filter((n) => /^\d{3}_.+\.(sql|ts)$/.test(n)).sort();
  const app = names.map((n) => ({ name: n, file: path.join(src.dir, n) }));
  checkStream(template, 'template');
  checkStream(app, 'app');
  const clash = template.find((t) => app.some((a) => a.name === t.name));
  if (clash) throw new Error(`migration ${clash.name} exists in both the template and the app`);
  return [...template, ...app];
}

/** Every template migration file in a directory (001_standard.sql, t002_…, t003_…). */
export async function templateFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((n) => /^(001_standard|t\d{3}_.+)\.sql$/.test(n)).sort().map((n) => path.join(dir, n));
}

/**
 * Forward-only, immutable migrations. A file that already ran must not change
 * (its checksum is recorded); a bad migration is fixed by a new one. Each file
 * runs in its own transaction as the family's migrator role.
 */
export async function migrate(opts: MigrateOptions): Promise<AppliedMigration[]> {
  const { schema } = opts;
  assertIdent(schema);
  const roles = familyRoles(schema);
  const log = opts.log ?? (() => {});
  const files = await listFiles(opts.sources);
  const client = new pg.Client({ connectionString: opts.adminUrl });
  await client.connect();
  const applied: AppliedMigration[] = [];
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', [`migrate:${schema}`]);
    await client.query(`create schema if not exists ${schema} authorization ${roles.migrator}`);
    await client.query(`set role ${roles.migrator}`);
    await client.query(`create table if not exists ${schema}.schema_migrations (
      name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
    await client.query('reset role');
    const done = new Map(
      (await client.query<{ name: string; checksum: string }>(`select name, checksum from ${schema}.schema_migrations`)).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    for (const f of files) {
      const raw = await readFile(f.file, 'utf8');
      const checksum = createHash('sha256').update(raw).digest('hex');
      const prior = done.get(f.name);
      if (prior) {
        if (prior !== checksum) {
          throw new Error(`migration ${f.name} changed after it ran (checksum mismatch); fix forward with a new file`);
        }
        continue;
      }
      log(`[${schema}] applying ${f.name}`);
      await client.query('begin');
      try {
        await client.query(`set local role ${roles.migrator}`);
        await client.query(`set local search_path to ${schema}`);
        if (f.name.endsWith('.sql')) {
          await client.query(render(raw, schema));
        } else {
          const mod = (await import(pathToFileURL(f.file).href)) as { default: (c: pg.Client, schema: string) => Promise<void> };
          await mod.default(client, schema);
        }
        if (opts.tenantLint !== false) await tenantLint(client, schema, ['schema_migrations', ...(opts.lintExempt ?? [])]);
        await client.query(`insert into ${schema}.schema_migrations (name, checksum) values ($1, $2)`, [f.name, checksum]);
        await client.query('commit');
        applied.push({ name: f.name, checksum });
      } catch (e) {
        await client.query('rollback');
        throw new Error(`migration ${f.name} failed: ${(e as Error).message}`, { cause: e });
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(hashtext($1))', [`migrate:${schema}`]).catch(() => {});
    await client.end();
  }
  return applied;
}

export function render(sql: string, schema: string): string {
  return sql.replaceAll('{{schema}}', schema);
}

/**
 * B1: every business table in a family carries company_id NOT NULL and forced
 * row-level security. A migration that breaks this does not commit.
 */
export async function tenantLint(client: pg.Client | pg.PoolClient, schema: string, exempt: string[]): Promise<void> {
  const { rows } = await client.query<{
    table_name: string;
    has_company: boolean;
    company_not_null: boolean;
    rls: boolean;
    forced: boolean;
    policies: number;
  }>(
    `select c.relname as table_name,
            exists(select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped) as has_company,
            exists(select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'company_id' and a.attnotnull) as company_not_null,
            c.relrowsecurity as rls, c.relforcerowsecurity as forced,
            (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r','p')`,
    [schema],
  );
  const bad: string[] = [];
  for (const r of rows) {
    if (exempt.includes(r.table_name)) continue;
    const problems: string[] = [];
    if (!r.has_company || !r.company_not_null) problems.push('company_id uuid NOT NULL');
    if (!r.rls || !r.forced) problems.push('ENABLE + FORCE ROW LEVEL SECURITY');
    if (r.policies === 0) problems.push('a company_id policy');
    if (problems.length) bad.push(`${schema}.${r.table_name} is missing ${problems.join(', ')}`);
  }
  if (bad.length) throw new Error(`tenant lint failed:\n  ${bad.join('\n  ')}`);
}
