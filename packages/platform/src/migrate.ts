import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyDeskGrants, bootstrapFamily, migrate } from '@neop/pgkit';

export const PLATFORM_MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

/** Functions that must read every app's schema (018): owned by the admin role, not the platform's migrator. */
const DESK_FUNCTIONS = [
  'neos.desk_pending(text)',
  'neos.desk_activity(text)',
  'neos.refresh_desk_views()',
  'neos.desk_cards(text)',
  'neos.refresh_desk_cards()',
  'neos.desk_questions(text)',
  'neos.refresh_desk_questions()',
  'neos.desk_operations(text)',
  'neos.refresh_desk_operations()',
];

/**
 * Apply the platform's migrations. `through` (tests: the populated-data proof of a past migration) stops after the file
 * whose number is that prefix — the migration under proof, and nothing newer that would later contract what it made.
 */
export async function migratePlatform(adminUrl: string, log?: (m: string) => void, opts: { through?: string } = {}) {
  // The platform never needs a BYPASSRLS runner role (it reads no tenant rows as a runner).
  await bootstrapFamily(adminUrl, 'neos', { runner: false });
  await ensureDeskRole(adminUrl);
  let dir = PLATFORM_MIGRATIONS;
  let cleanup: (() => Promise<void>) | null = null;
  if (opts.through) {
    dir = await mkdtemp(path.join(os.tmpdir(), `neos-through-${opts.through}-`));
    cleanup = () => rm(dir, { recursive: true, force: true });
    await cp(PLATFORM_MIGRATIONS, dir, { recursive: true });
    const led = JSON.parse(await readFile(path.join(dir, 'migrate.json'), 'utf8')) as { migrations: { file: string }[] };
    const cut = (f: string) => f.slice(0, 3) > opts.through!.slice(0, 3);
    for (const m of led.migrations.filter((x) => cut(x.file))) await rm(path.join(dir, m.file));
    led.migrations = led.migrations.filter((m) => !cut(m.file));
    await writeFile(path.join(dir, 'migrate.json'), JSON.stringify(led));
  }
  try {
    const applied = await migrate({ adminUrl, schema: 'neos', sources: { dir }, tenantLint: false, log });
    await afterMigrate(adminUrl, log);
    return applied;
  } finally {
    await cleanup?.();
  }
}

/** v3 §11: the desk's read-only role (NOLOGIN; the migrator cannot create roles). Cluster-wide, so created once. */
async function ensureDeskRole(adminUrl: string): Promise<void> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query("select pg_advisory_lock(hashtext('neos.roles'))");
    try {
      if (!(await c.query("select 1 from pg_roles where rolname = 'neos_desk'")).rowCount) {
        await c.query('create role neos_desk nologin nobypassrls nosuperuser nocreaterole').catch((e) => {
          if (!/already exists/.test((e as Error).message)) throw e;
        });
      }
      // A role of that name made some other way is brought back to what the desk may be: no login, no bypass.
      const r = (await c.query<{ ok: boolean }>("select not rolcanlogin and not rolbypassrls and not rolsuper and not rolcreaterole as ok from pg_roles where rolname = 'neos_desk'")).rows[0];
      if (!r?.ok) {
        for (let i = 0; ; i++) {
          try {
            await c.query('alter role neos_desk nologin nobypassrls nosuperuser nocreaterole');
            break;
          } catch (e) {
            if (i >= 10 || !/concurrently updated/.test((e as Error).message)) throw e;
            await new Promise((res) => setTimeout(res, 20 + Math.random() * 80));
          }
        }
      }
      // v3 S1: the platform writes each app's switchboard, installs and grants as the desk. Its pool role holds
      // the membership WITHOUT inheriting it: none of the desk's rights apply until a transaction runs
      // `SET LOCAL ROLE neos_desk` (transaction-scoped, so safe through PgBouncer's transaction pooling).
      const member = (
        await c.query<{ inherit: boolean; set: boolean }>(
          `select m.inherit_option as inherit, m.set_option as set from pg_auth_members m
             join pg_roles r on r.oid = m.roleid and r.rolname = 'neos_desk'
             join pg_roles u on u.oid = m.member and u.rolname = 'neos_app'`,
        )
      ).rows[0];
      if (!member || member.inherit || !member.set) {
        for (let i = 0; ; i++) {
          try {
            await c.query('grant neos_desk to neos_app with inherit false, set true');
            break;
          } catch (e) {
            if (i >= 10 || !/concurrently updated|tuple concurrently/.test((e as Error).message)) throw e;
            await new Promise((res) => setTimeout(res, 20 + Math.random() * 80));
          }
        }
      }
    } finally {
      await c.query("select pg_advisory_unlock(hashtext('neos.roles'))");
    }
  } finally {
    await c.end();
  }
}

/**
 * After the platform's migrations: the desk functions (018) run as the admin role, which can read every app schema
 * (and so sees every company's rows; the views carry company_id), then the desk views are rebuilt and every
 * registered app's roles may read neos_registry (019). Both are idempotent.
 */
async function afterMigrate(adminUrl: string, log?: (m: string) => void): Promise<void> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    const has = async (fn: string) => (await c.query('select to_regprocedure($1) is not null as ok', [fn])).rows[0].ok as boolean;
    if (await has('neos.refresh_desk_views()')) {
      for (const fn of DESK_FUNCTIONS) {
        if (!(await has(fn))) continue;
        await c.query(`alter function ${fn} owner to current_user`).catch((e) => log?.(`[neos] ${fn} stays with the migrator: ${(e as Error).message}`));
      }
      await c.query('select neos.refresh_desk_views()');
    }
    // v3 S2 (020): the desk's cards, straight from every app's proposals.
    if (await has('neos.refresh_desk_cards()')) await c.query('select neos.refresh_desk_cards()');
    // v3 S3 (021): the desk's questions, straight from every app's input waits.
    if (await has('neos.refresh_desk_questions()')) await c.query('select neos.refresh_desk_questions()');
    // v3 S9 (025): one audit trail — every app's own operations.
    if (await has('neos.refresh_desk_operations()')) await c.query('select neos.refresh_desk_operations()');
    if (await has('neos.grant_registry_read(text)')) {
      await c.query("select neos.grant_registry_read(key) from neos.apps where status <> 'platform' and key ~ '^[a-z][a-z0-9_]{0,40}$'");
    }
    // v3 §11 / S1: the desk's grants on every registered app's schema (t010), for schemas migrated before
    // neos_desk existed. Idempotent; a schema not at t010 (or not on this database) is left alone.
    const apps = (await c.query<{ key: string }>("select key from neos.apps where status <> 'platform' and key ~ '^[a-z][a-z0-9_]{0,40}$'")).rows;
    for (const a of apps) await applyDeskGrants(c, a.key).catch((e) => log?.(`[neos] desk grants on ${a.key} not applied: ${(e as Error).message}`));
  } finally {
    await c.end();
  }
}
