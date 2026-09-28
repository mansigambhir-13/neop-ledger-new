// Per-company logical backup and restore (plan §Backups). Point-in-time
// recovery restores every app at once; this restores one company in one app's
// family without rewinding anyone else. Tables are discovered from the catalog
// (every table with company_id), walked in foreign-key order, and restored in
// one transaction with identity values preserved.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { assertIdent } from './roles.ts';

export interface CompanyDump {
  schema: string;
  company_id: string;
  exported_at: string;
  order: string[];
  tables: Record<string, unknown[]>;
}

/** Every table in a schema with a company_id column, parents before children (foreign-key order). */
export async function tablesInOrder(c: pg.Client, schema: string): Promise<string[]> {
  const tables = (
    await c.query<{ t: string }>(
      `select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind = 'r'
          and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped)`,
      [schema],
    )
  ).rows.map((r) => r.t);
  const deps = (
    await c.query<{ child: string; parent: string }>(
      `select cc.relname as child, pc.relname as parent from pg_constraint k
         join pg_class cc on cc.oid = k.conrelid join pg_class pc on pc.oid = k.confrelid
         join pg_namespace n on n.oid = cc.relnamespace
        where k.contype = 'f' and n.nspname = $1 and cc.relname <> pc.relname`,
      [schema],
    )
  ).rows;
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string, path: Set<string>) => {
    if (seen.has(t)) return;
    if (path.has(t)) throw new Error(`foreign-key cycle at ${t}`);
    path.add(t);
    for (const d of deps.filter((x) => x.child === t && tables.includes(x.parent))) visit(d.parent, path);
    path.delete(t);
    seen.add(t);
    out.push(t);
  };
  for (const t of tables.sort()) visit(t, new Set());
  return out;
}

export async function exportCompany(adminUrl: string, schema: string, companyId: string): Promise<CompanyDump> {
  assertIdent(schema);
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query('begin isolation level repeatable read read only');
    const order = await tablesInOrder(c, schema);
    const tables: Record<string, unknown[]> = {};
    for (const t of order) {
      tables[t] = (await c.query(`select to_jsonb(x) as r from ${schema}.${t} x where company_id = $1`, [companyId])).rows.map((r) => r.r);
    }
    await c.query('commit');
    return { schema, company_id: companyId, exported_at: new Date().toISOString(), order, tables };
  } finally {
    await c.end();
  }
}

/** Replace one company's rows with the dump, atomically. Other companies are untouched. */
export async function importCompany(adminUrl: string, dump: CompanyDump): Promise<Record<string, number>> {
  assertIdent(dump.schema);
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  const counts: Record<string, number> = {};
  try {
    await c.query('begin');
    // Row-level security is forced; restore under this company's own setting.
    await c.query("select set_config('neos.company_id', $1, true)", [dump.company_id]);
    // An exact restore: the board triggers (t010) keep each row as it was dumped (version, history) and log nothing.
    await c.query("select set_config('neos.restore', 'on', true)");
    const order = await tablesInOrder(c, dump.schema);
    for (const t of [...order].reverse()) await c.query(`delete from ${dump.schema}.${t} where company_id = $1`, [dump.company_id]);
    for (const t of order) {
      const rows = dump.tables[t] ?? [];
      for (const r of rows) {
        if ((r as { company_id?: string }).company_id !== dump.company_id) throw new Error(`${t}: a row in the dump belongs to another company`);
      }
      if (!rows.length) continue;
      await c.query(`insert into ${dump.schema}.${t} overriding system value select * from jsonb_populate_recordset(null::${dump.schema}.${t}, $1)`, [JSON.stringify(rows)]);
      counts[t] = rows.length;
    }
    await c.query('commit'); // deferred checks (e.g. balanced journal entries) run here
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
  return counts;
}

// ── Nightly per-schema logical exports (plan §Backups) ─────────────────────
// Point-in-time recovery rewinds the whole cluster. These let one app (its whole
// schema) or one company in one app be restored without rewinding anyone else.

export interface NightlyOptions {
  adminUrl: string;
  /** Root directory; each run writes <dir>/<UTC stamp>/ with a manifest.json. */
  dir: string;
  /** Keep this many runs (the oldest are removed after a successful run). */
  keep: number;
  /** Also write one JSON export per company per app schema (restorable with importCompany). */
  companies?: boolean;
  /** Restrict to these schemas (default: every migrated family: neos + each app). */
  schemas?: string[];
  /** pg_dump binary (default: NEOS_PG_DUMP, else pg_dump on PATH). */
  pgDump?: string;
  now?: Date;
  log?: (m: string) => void;
}

export interface NightlyManifest {
  stamp: string;
  started_at: string;
  finished_at: string;
  database: string;
  schemas: { schema: string; file: string; bytes: number; sha256: string }[];
  companies: { schema: string; company_id: string; file: string; rows: number }[];
  removed: string[];
}

/** Every schema the migration runner owns: those with a schema_migrations table. */
export async function backupSchemas(adminUrl: string): Promise<string[]> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    const r = await c.query<{ s: string }>("select table_schema as s from information_schema.tables where table_name = 'schema_migrations' order by 1");
    return r.rows.map((x) => x.s);
  } finally {
    await c.end();
  }
}

const RUN = /^\d{8}T\d{6}Z$/;
export const backupStamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Runs to delete so that `keep` remain (oldest first). Only directories named like a run are touched. */
export function runsToPrune(names: string[], keep: number): string[] {
  const runs = names.filter((n) => RUN.test(n)).sort();
  return runs.slice(0, Math.max(0, runs.length - Math.max(1, keep)));
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.trim()}`))));
  });
}

/** libpq reads the password from the environment, never argv (which `ps` shows). */
function libpqEnv(adminUrl: string): { env: NodeJS.ProcessEnv; dbname: string } {
  const u = new URL(adminUrl);
  const dbname = decodeURIComponent(u.pathname.slice(1)) || 'postgres';
  return {
    dbname,
    env: {
      ...process.env,
      PGHOST: u.hostname,
      PGPORT: u.port || '5432',
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
      PGDATABASE: dbname,
      PGSSLMODE: u.searchParams.get('sslmode') ?? process.env.PGSSLMODE ?? 'prefer',
    },
  };
}

export async function nightlyBackup(o: NightlyOptions): Promise<NightlyManifest> {
  const log = o.log ?? (() => {});
  const started = o.now ?? new Date();
  const stamp = backupStamp(started);
  const out = path.join(o.dir, stamp);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const schemas = o.schemas ?? (await backupSchemas(o.adminUrl));
  for (const s of schemas) assertIdent(s);
  const { env, dbname } = libpqEnv(o.adminUrl);
  const manifest: NightlyManifest = { stamp, started_at: started.toISOString(), finished_at: '', database: dbname, schemas: [], companies: [], removed: [] };
  for (const s of schemas) {
    const file = `${s}.dump`;
    // Custom format: compressed, and pg_restore can take the whole schema (or one table) back out.
    await run(o.pgDump ?? process.env.NEOS_PG_DUMP ?? 'pg_dump', ['--format=custom', `--schema=${s}`, `--file=${path.join(out, file)}`, dbname], env);
    const buf = await readFile(path.join(out, file));
    manifest.schemas.push({ schema: s, file, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
    log(`dumped ${s} (${buf.length} bytes)`);
  }
  if (o.companies) {
    const c = new pg.Client({ connectionString: o.adminUrl });
    await c.connect();
    const ids = (await c.query<{ id: string }>('select id from neos.companies order by id').catch(() => ({ rows: [] as { id: string }[] }))).rows.map((r) => r.id);
    await c.end();
    for (const s of schemas.filter((x) => x !== 'neos')) {
      for (const id of ids) {
        const dump = await exportCompany(o.adminUrl, s, id);
        const rows = Object.values(dump.tables).reduce((n, t) => n + t.length, 0);
        if (!rows) continue;
        const file = path.join('companies', s, `${id}.json`);
        await mkdir(path.join(out, 'companies', s), { recursive: true, mode: 0o700 });
        await writeFile(path.join(out, file), JSON.stringify(dump), { mode: 0o600 });
        manifest.companies.push({ schema: s, company_id: id, file, rows });
      }
    }
    log(`exported ${manifest.companies.length} company files`);
  }
  manifest.finished_at = new Date().toISOString();
  // Retention only after this run is complete, so a failing night never eats the good ones.
  manifest.removed = runsToPrune(await readdir(o.dir), o.keep).filter((r) => r !== stamp);
  for (const r of manifest.removed) await rm(path.join(o.dir, r), { recursive: true, force: true });
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}

/**
 * Restore one schema from a nightly dump in one transaction: its objects are dropped and
 * recreated from the file. Stop that app's backend first; no other schema is touched.
 */
export async function restoreSchema(adminUrl: string, file: string, schema: string, pgRestore = process.env.NEOS_PG_RESTORE ?? 'pg_restore'): Promise<void> {
  assertIdent(schema);
  const { env, dbname } = libpqEnv(adminUrl);
  await run(pgRestore, ['--clean', '--if-exists', '--single-transaction', '--exit-on-error', `--schema=${schema}`, `--dbname=${dbname}`, file], env);
}
