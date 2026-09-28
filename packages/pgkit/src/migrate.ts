import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { applyDeskGrants, assertIdent, familyRoles } from './roles.ts';

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
  /** First-release file (migrate.json `baseline: true`): applied to empty schemas, exempt from expand/contract. */
  baseline?: boolean;
  /** Names before this one in its own stream (what a contract marker may point back to). */
  earlier?: string[];
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

/**
 * `migrate.json` (WP §11): every migration in a directory, in order, with the tables it touches.
 *   {file, tables, baseline?, proven_on_populated_data?}
 * `baseline: true` marks the first release's files. They are applied to empty schemas — there is
 * no customer data yet to prove them on — and must come first. Every later file changes live
 * books: in production it is refused without `proven_on_populated_data` (where and when it was run
 * on a populated copy). A file missing from the ledger is refused everywhere.
 */
export interface MigrateLedgerEntry {
  file: string;
  tables?: string[];
  baseline?: boolean;
  proven_on_populated_data?: string;
}
export interface MigrateLedger {
  migrations: MigrateLedgerEntry[];
}
export async function checkMigrateLedger(dir: string, files: string[]): Promise<MigrateLedgerEntry[] | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, 'migrate.json'), 'utf8');
  } catch {
    if (process.env.NEOS_ENV === 'production') throw new Error(`${dir}: migrate.json is required in production`);
    return null;
  }
  const led = JSON.parse(raw) as MigrateLedger;
  const listed = led.migrations.map((m) => m.file);
  const missing = files.filter((f) => !listed.includes(f));
  if (missing.length) throw new Error(`${dir}/migrate.json does not list ${missing.join(', ')}`);
  const gone = listed.filter((f) => !files.includes(f));
  if (gone.length) throw new Error(`${dir}/migrate.json lists missing files ${gone.join(', ')}`);
  if (listed.join() !== [...listed].sort().join()) throw new Error(`${dir}/migrate.json is not in migration order`);
  // Baseline is the first release only: a baseline after a real change would dodge the proof rule.
  const firstChange = led.migrations.findIndex((m) => !m.baseline);
  const late = firstChange < 0 ? [] : led.migrations.slice(firstChange).filter((m) => m.baseline).map((m) => m.file);
  if (late.length) throw new Error(`${dir}/migrate.json marks ${late.join(', ')} baseline after a non-baseline migration; only the first release is baseline`);
  const claims = led.migrations.filter((m) => m.baseline && m.proven_on_populated_data).map((m) => m.file);
  if (claims.length) throw new Error(`${dir}/migrate.json: ${claims.join(', ')} is baseline (applied to empty schemas) and cannot claim proven_on_populated_data`);
  if (process.env.NEOS_ENV === 'production') {
    const unproven = led.migrations.filter((m) => !m.baseline && !m.proven_on_populated_data).map((m) => m.file);
    if (unproven.length) throw new Error(`not proven on populated data: ${unproven.join(', ')} — prove on a populated copy, then mark it in migrate.json`);
  }
  return led.migrations;
}

/**
 * Expand-then-contract (plan §Data model). A change to live books first adds the new shape
 * (expand), the code moves over, and only a later migration takes the old shape away (contract).
 * A non-baseline migration that destroys or reshapes existing data is refused unless it declares
 * itself the contract step and names the earlier expand migration it completes:
 *   -- contract: drop parties.region_old now that nothing reads it; expanded by 005_party_region.sql
 */
const DESTRUCTIVE: { what: string; re: RegExp }[] = [
  { what: 'DROP TABLE', re: /\bdrop\s+table\b/ },
  { what: 'DROP SCHEMA', re: /\bdrop\s+schema\b/ },
  { what: 'TRUNCATE', re: /\btruncate\b/ },
  { what: 'DROP COLUMN', re: /\bdrop\s+(?:column\s+)?(?:if\s+exists\s+)?(?!constraint\b|default\b|not\b|identity\b|expression\b|policy\b|trigger\b|index\b|view\b|function\b|type\b|role\b|owned\b|table\b|schema\b|sequence\b|materialized\b|extension\b|rule\b)[a-z_"][\w"]*\s*(?:cascade\b|restrict\b)?\s*[,;]/ },
  { what: 'RENAME', re: /\balter\s+(?:table|view|materialized\s+view|type|index|sequence)\b[^;]*?\brename\b/ },
  { what: 'ALTER COLUMN … TYPE', re: /\balter\s+(?:column\s+)?[a-z_"][\w"]*\s+(?:set\s+data\s+)?type\b/ },
  { what: 'SET NOT NULL', re: /\bset\s+not\s+null\b/ },
];

function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(?:--|\/\/)[^\n]*/g, ' ').toLowerCase();
}

/** The destructive statements in a migration's source (comments ignored). */
export function destructiveStatements(src: string): string[] {
  let code = withoutComments(src);
  const found = DESTRUCTIVE.filter((d) => d.re.test(code)).map((d) => d.what);
  // ADD COLUMN … NOT NULL with no DEFAULT fails on a populated table (and is a backfill in disguise).
  while (/\([^()]*\)/.test(code)) code = code.replace(/\([^()]*\)/g, ' ');
  for (const m of code.matchAll(/\badd\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?([a-z_"][\w"]*)\s+([^,;]*)/g)) {
    if (/^(constraint|primary|unique|foreign|check|value|exclude)$/.test(m[1]!)) continue;
    if (/\bnot\s+null\b/.test(m[2]!) && !/\bdefault\b|\bgenerated\b/.test(m[2]!)) {
      found.push('ADD COLUMN … NOT NULL without DEFAULT');
      break;
    }
  }
  return found;
}

/** Refuse destructive DDL in a non-baseline migration unless it is a marked contract step. */
export function expandContractLint(name: string, src: string, earlier: string[]): void {
  const found = destructiveStatements(src);
  if (!found.length) return;
  const marker = /(?:--|\/\/)\s*contract:\s*(.+)/i.exec(src);
  if (!marker) {
    throw new Error(
      `migration ${name} is destructive (${found.join(', ')}). Expand then contract: add the new shape first, move the code over, ` +
        `then contract in a later file carrying "-- contract: <reason>; expanded by <earlier migration>"`,
    );
  }
  const refs = [...marker[1]!.matchAll(/\b(t?\d{3}_[\w.-]+?\.(?:sql|ts))\b/g)].map((m) => m[1]!);
  if (!refs.length) throw new Error(`migration ${name}: its contract marker must name the earlier expand migration it completes`);
  const bad = refs.filter((r) => r === name || !earlier.includes(r));
  if (bad.length) throw new Error(`migration ${name}: its contract marker names ${bad.join(', ')}, which is not an earlier migration in this stream`);
}

async function listFiles(src: MigrationSource): Promise<MigrationFile[]> {
  const names = (await readdir(src.dir)).filter((n) => /^\d{3}_.+\.(sql|ts)$/.test(n)).sort();
  const appLedger = await checkMigrateLedger(src.dir, names);
  const baseline = new Set<string>();
  for (const e of appLedger ?? []) if (e.baseline) baseline.add(path.join(src.dir, e.file));
  const tdirs = [...new Set((src.prepend ?? []).map((f) => path.dirname(f)))];
  for (const d of tdirs) {
    const led = await checkMigrateLedger(d, (src.prepend ?? []).filter((f) => path.dirname(f) === d).map((f) => path.basename(f)));
    for (const e of led ?? []) if (e.baseline) baseline.add(path.join(d, e.file));
  }
  const template: MigrationFile[] = (src.prepend ?? []).map((f) => ({ name: path.basename(f), file: f, baseline: baseline.has(f) })).sort((a, b) => a.name.localeCompare(b.name));
  const app: MigrationFile[] = names.map((n) => ({ name: n, file: path.join(src.dir, n), baseline: baseline.has(path.join(src.dir, n)) }));
  checkStream(template, 'template');
  checkStream(app, 'app');
  const clash = template.find((t) => app.some((a) => a.name === t.name));
  if (clash) throw new Error(`migration ${clash.name} exists in both the template and the app`);
  for (const stream of [template, app]) stream.forEach((f, i) => (f.earlier = stream.slice(0, i).map((x) => x.name)));
  return [...template, ...app];
}

/** sha256 of a migration file's bytes: what schema_migrations records, and what the boot check compares. */
export function migrationChecksum(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** The shipped migration files (template stream, then the app's), in order: name, path and checksum. */
export async function shippedMigrationFiles(sources: MigrationSource): Promise<(AppliedMigration & { file: string })[]> {
  const files = await listFiles(sources);
  return Promise.all(files.map(async (f) => ({ name: f.name, file: f.file, checksum: migrationChecksum(await readFile(f.file, 'utf8')) })));
}

/** The shipped migration set (template stream, then the app's), in order, with each file's checksum. */
export async function shippedMigrations(sources: MigrationSource): Promise<AppliedMigration[]> {
  const files = await listFiles(sources);
  return Promise.all(files.map(async (f) => ({ name: f.name, checksum: migrationChecksum(await readFile(f.file, 'utf8')) })));
}

export interface SchemaDrift {
  /** Shipped, not applied: the DBA has not run them yet. */
  pending: string[];
  /** Applied, not shipped: the database is ahead of this build (or ran a file this build does not know). */
  unknown: string[];
  /** Applied with different bytes than this build ships: a migration was edited after it ran. */
  changed: string[];
}

export class SchemaMismatchError extends Error {
  readonly schema: string;
  readonly drift: SchemaDrift;
  constructor(schema: string, drift: SchemaDrift) {
    const parts = [
      drift.pending.length ? `pending (not applied): ${drift.pending.join(', ')}` : '',
      drift.unknown.length ? `unknown (applied, not in this build): ${drift.unknown.join(', ')}` : '',
      drift.changed.length ? `changed (checksum differs from what ran): ${drift.changed.join(', ')}` : '',
    ].filter(Boolean);
    super(`schema ${schema} is not in step with this build's migrations — refusing to start. ${parts.join('; ')}. Run the migrator (scripts/migrate.ts) or deploy the build that matches the database.`);
    this.name = 'SchemaMismatchError';
    this.schema = schema;
    this.drift = drift;
  }
}

/**
 * Compare what the database says ran (`<schema>.schema_migrations`) with what this build ships.
 * Package migrations (named `<package>@<version>/<file>`) are the registry's, verified at spawn,
 * and are not part of the app's own set.
 */
export function schemaDrift(applied: AppliedMigration[], shipped: AppliedMigration[]): SchemaDrift {
  const own = applied.filter((a) => !a.name.includes('@'));
  const ran = new Map(own.map((a) => [a.name, a.checksum]));
  const ships = new Map(shipped.map((s) => [s.name, s.checksum]));
  return {
    pending: shipped.filter((s) => !ran.has(s.name)).map((s) => s.name),
    unknown: own.filter((a) => !ships.has(a.name)).map((a) => a.name).sort(),
    changed: shipped.filter((s) => ran.has(s.name) && ran.get(s.name) !== s.checksum).map((s) => s.name),
  };
}

/** Boot check: throws SchemaMismatchError when the schema and the shipped set differ. `url` may be any role granted SELECT on schema_migrations. */
export async function assertSchemaInStep(url: string, schema: string, sources: MigrationSource): Promise<AppliedMigration[]> {
  assertIdent(schema);
  const shipped = await shippedMigrations(sources);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let applied: AppliedMigration[];
  try {
    applied = (await client.query<AppliedMigration>(`select name, checksum from ${schema}.schema_migrations order by name`)).rows;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '42P01' || code === '3F000') throw new SchemaMismatchError(schema, { pending: shipped.map((s) => s.name), unknown: [], changed: [] });
    if (code === '42501') throw new Error(`cannot read ${schema}.schema_migrations (permission denied); re-run the migrator, which grants it to the app and runner roles`, { cause: e });
    throw e;
  } finally {
    await client.end().catch(() => {});
  }
  const drift = schemaDrift(applied, shipped);
  if (drift.pending.length || drift.unknown.length || drift.changed.length) throw new SchemaMismatchError(schema, drift);
  return shipped;
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
    // Expand-then-contract, checked for every pending change before any of them runs.
    for (const f of files) {
      if (f.baseline || done.has(f.name)) continue;
      expandContractLint(f.name, await readFile(f.file, 'utf8'), f.earlier ?? []);
    }
    for (const f of files) {
      const raw = await readFile(f.file, 'utf8');
      const checksum = migrationChecksum(raw);
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
    // The backend reads this at boot (WP §11 step 8: a schema out of step with the shipped set refuses
    // to start). Only the family's roles that the migrations let into the schema get it.
    for (const r of [roles.app, roles.runner]) {
      const ok = await client.query<{ ok: boolean }>("select case when exists (select 1 from pg_roles where rolname = $1) then has_schema_privilege($1, $2, 'usage') else false end as ok", [r, schema]);
      if (ok.rows[0]?.ok) await client.query(`grant select on ${schema}.schema_migrations to ${r}`);
    }
    // v3 §11: the desk's grants on a NEOP schema (t010+), repeated idempotently — the platform may have
    // made its role after this schema's migrations first ran.
    await applyDeskGrants(client, schema);
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
 * Is a policy expression (as Postgres prints it back) keyed off the company setting? It must
 * contain `company_id = current_setting('neos.company_id' …)` as a conjunct and no OR, so the
 * policy can only ever narrow to the caller's company. `true`, another column or an OR fails.
 */
export function policyKeyedOnCompany(expr: string | null): boolean {
  if (!expr) return false;
  const e = expr.toLowerCase().replace(/::(text|character varying)\b/g, '').replace(/[()]/g, ' ');
  if (/\bor\b/.test(e)) return false;
  const setting = String.raw`(?:nullif)?current_setting'neos\.company_id'(?:,true)?(?:,'')?(?:::uuid)?`;
  const keyed = new RegExp(`^(?:company_id=${setting}|${setting}=company_id)$`);
  return e.split(/\band\b/).some((c) => keyed.test(c.replace(/\s+/g, '')));
}

/**
 * B1: every business table in a family carries company_id NOT NULL and forced
 * row-level security, and every permissive policy on it is keyed off the
 * company setting (permissive policies OR together, so one loose policy opens
 * the table). A migration that breaks this does not commit.
 */
export async function tenantLint(client: pg.Client | pg.PoolClient, schema: string, exempt: string[]): Promise<void> {
  const { rows } = await client.query<{
    table_name: string;
    has_company: boolean;
    company_not_null: boolean;
    rls: boolean;
    forced: boolean;
    policies: { name: string; permissive: boolean; qual: string | null; check: string | null }[];
  }>(
    `select c.relname as table_name,
            exists(select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped) as has_company,
            exists(select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'company_id' and a.attnotnull) as company_not_null,
            c.relrowsecurity as rls, c.relforcerowsecurity as forced,
            coalesce((select json_agg(json_build_object('name', p.polname, 'permissive', p.polpermissive,
                              'qual', pg_get_expr(p.polqual, p.polrelid), 'check', pg_get_expr(p.polwithcheck, p.polrelid)))
                        from pg_policy p where p.polrelid = c.oid), '[]'::json) as policies
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
    const permissive = r.policies.filter((p) => p.permissive);
    if (permissive.length === 0) problems.push('a company_id policy');
    for (const p of permissive) {
      // USING governs reads/updates/deletes; WITH CHECK (or USING when absent) governs writes.
      if (!policyKeyedOnCompany(p.qual) && !(p.qual === null && policyKeyedOnCompany(p.check))) problems.push(`policy ${p.name} keyed on company_id = current_setting('neos.company_id') (USING is ${p.qual ?? 'absent'})`);
      if (p.check !== null && !policyKeyedOnCompany(p.check)) problems.push(`policy ${p.name} WITH CHECK keyed on company_id (it is ${p.check})`);
    }
    if (problems.length) bad.push(`${schema}.${r.table_name} is missing ${problems.join(', ')}`);
  }
  if (bad.length) throw new Error(`tenant lint failed:\n  ${bad.join('\n  ')}`);
}
