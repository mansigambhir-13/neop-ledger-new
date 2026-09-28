// Package roles and grants (v3 §10, S7). A package's migrations are files in the host's own numbered set
// (written by `neos install`) and run with the host's migrations — never at request time. What the migrator
// role cannot do is make roles: this runs with the admin connection after the host's migrations (migrateApp),
// and the DBA bundle carries the same statements (packageGrantsSql). Idempotent.
//
//   <host>_nep_<name>   LOGIN, no bypass: SELECT/INSERT/UPDATE on exactly its manifest's tables, nothing else
//   <host>_app          SELECT only on those tables (the host reads them; only the package writes them)

import pg from 'pg';
import { assertIdent, familyRoles, rolePassword } from '@neop/pgkit';
import { packageSlug, type PackagesLock } from './lock.ts';

const IDENT = /^[a-z_][a-z0-9_]*$/;

export function packageRole(host: string, packageKey: string): string {
  const role = `${host}_nep_${packageSlug(packageKey)}`;
  assertIdent(role);
  return role;
}

/** The grants for one package, as SQL a DBA can read (no passwords; the role is created by the migrator run or the DBA). */
export function packageGrantsSql(host: string, p: { key: string; tables: string[] }): string {
  assertIdent(host);
  const role = packageRole(host, p.key);
  const app = familyRoles(host).app;
  const lines = [`grant usage on schema ${host} to ${role};`];
  for (const t of p.tables) {
    if (!IDENT.test(t)) throw new Error(`bad table name ${t}`);
    lines.push(
      `do $g$ begin if to_regclass('${host}.${t}') is not null then`,
      `  grant select, insert, update on ${host}.${t} to ${role};`,
      `  revoke insert, update, delete, truncate on ${host}.${t} from ${app};`,
      `  grant select on ${host}.${t} to ${app};`,
      `end if; end $g$;`,
    );
  }
  lines.push(`grant usage, select on all sequences in schema ${host} to ${role};`);
  return lines.join('\n');
}

/**
 * The DBA bundle's section for installed packages: each package's role (LOGIN, no bypass; the DBA sets its password,
 * or NEOS_PKG_PW_KEY_<HOST> derives it as the migrator does) and its grants. Idempotent; run after the migrations.
 */
export function packageBootstrapSql(host: string, lock: PackagesLock): string {
  const out: string[] = [];
  for (const p of lock.packages) {
    const role = packageRole(host, p.key);
    out.push(`-- ${p.key}@${p.version} (artifact ${p.artifact_hash})`);
    out.push(`do $r$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} login nobypassrls nosuperuser nocreaterole; end if; end $r$;`);
    out.push(`alter role ${role} set search_path = ${host};`);
    out.push(`do $c$ begin execute format('grant connect on database %I to ${role}', current_database()); end $c$;`);
    out.push(packageGrantsSql(host, p));
  }
  return out.length ? out.join('\n') : '-- (no packages installed)';
}

/** Create each locked package's role (cluster-wide) and give it exactly its tables. Returns the roles. */
export async function applyPackageGrants(adminUrl: string, host: string, lock: PackagesLock): Promise<string[]> {
  if (!lock.packages.length) return [];
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const roles: string[] = [];
  try {
    await client.query("select pg_advisory_lock(hashtext('neos.roles'))");
    const db = (await client.query<{ d: string }>('select current_database() as d')).rows[0]!.d;
    for (const p of lock.packages) {
      const role = packageRole(host, p.key);
      const pw = rolePassword(role).replace(/'/g, "''");
      const exists = await client.query<{ c: string[] | null }>('select rolconfig as c from pg_roles where rolname = $1', [role]);
      if (!exists.rowCount) {
        await client.query(`create role ${role} login password '${pw}' nobypassrls nosuperuser nocreaterole`).catch((e) => {
          // Roles are cluster-wide: another database's migrator may have made it a moment ago.
          if (!['42710', '23505'].includes((e as { code?: string }).code ?? '')) throw e;
        });
      }
      await retryConcurrent(() => client.query(`alter role ${role} login password '${pw}' nobypassrls nosuperuser nocreaterole`));
      if (!(exists.rows[0]?.c ?? []).includes(`search_path=${host}`)) await retryConcurrent(() => client.query(`alter role ${role} set search_path = ${host}`));
      await client.query(`grant connect on database "${db}" to ${role}`);
      await client.query(packageGrantsSql(host, p));
      roles.push(role);
    }
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('neos.roles'))").catch(() => {});
    await client.end();
  }
  return roles;
}

/** Role rows are cluster-wide: parallel migrations of other databases can race an ALTER ROLE ("tuple concurrently updated"). */
async function retryConcurrent<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 10 || !/concurrently updated/.test((e as Error).message)) throw e;
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 80));
    }
  }
}
