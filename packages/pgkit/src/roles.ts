import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

/**
 * The three roles every family gets (D1). Run once per cluster by the platform's
 * migration runner with an admin connection; idempotent.
 *
 *   <schema>_migrator  owns the schema and runs DDL; used only by the migrator
 *   <schema>_app       DML on the family, row-level security enforced
 *   <schema>_runner    BYPASSRLS, but granted only the standard tables
 */
export interface FamilyRoles {
  migrator: string;
  app: string;
  runner: string;
}

export function familyRoles(schema: string): FamilyRoles {
  assertIdent(schema);
  return { migrator: `${schema}_migrator`, app: `${schema}_app`, runner: `${schema}_runner` };
}

export function assertIdent(name: string): void {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(name)) throw new Error(`invalid identifier: ${name}`);
}

export function rolePassword(role: string): string {
  const name = `NEOS_PW_${role.toUpperCase()}`;
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  const v = process.env[name];
  if (v) return v;
  // Package roles (<host>_nep_<pkg>) appear when a company installs a package, so they
  // cannot each have a pre-made secret: derive them from the host's package key, which
  // only the migrator and that host's backend hold.
  const pkg = /^([a-z][a-z0-9]*)_nep_/.exec(role);
  if (pkg) {
    const kname = `NEOS_PKG_PW_KEY_${pkg[1]!.toUpperCase()}`;
    const kfile = process.env[`${kname}_FILE`];
    const key = kfile ? readFileSync(kfile, 'utf8').trim() : process.env[kname];
    if (key) return createHmac('sha256', key).update(role).digest('base64url');
  }
  // The dev/test default is a known string: never let it reach a production cluster.
  if (process.env.NEOS_ENV === 'production') throw new Error(`${name} (or ${name}_FILE) is required when NEOS_ENV=production`);
  return `${role}_dev_pw`;
}

async function ensureRole(client: pg.Client, role: string, opts: string): Promise<void> {
  assertIdent(role);
  const pw = rolePassword(role).replace(/'/g, "''");
  const { rowCount } = await client.query('select 1 from pg_roles where rolname = $1', [role]);
  if (!rowCount) {
    try {
      await client.query(`create role ${role} login password '${pw}' ${opts}`);
    } catch (e) {
      // Another process created it concurrently.
      if ((e as { code?: string }).code !== '42710' && (e as { code?: string }).code !== '23505') throw e;
    }
  }
  // Roles are cluster-wide; parallel bootstraps on other databases can race here.
  for (let i = 0; ; i++) {
    try {
      await client.query(`alter role ${role} login password '${pw}' ${opts}`);
      return;
    } catch (e) {
      if (i >= 10 || !/concurrently updated/.test((e as Error).message)) throw e;
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 80));
    }
  }
}

/** Create the family roles (cluster-wide) and let the migrator create a schema in this database. */
export async function bootstrapFamily(adminUrl: string, schema: string): Promise<FamilyRoles> {
  const roles = familyRoles(schema);
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('neos.roles'))");
    await ensureRole(client, roles.migrator, 'nobypassrls nosuperuser nocreaterole');
    await ensureRole(client, roles.app, 'nobypassrls nosuperuser nocreaterole');
    await ensureRole(client, roles.runner, 'bypassrls nosuperuser nocreaterole');
    const db = (await client.query<{ db: string }>('select current_database() as db')).rows[0]!.db;
    await client.query(`grant create, connect on database "${db}" to ${roles.migrator}`);
    await client.query(`grant connect on database "${db}" to ${roles.app}, ${roles.runner}`);
    await client.query("select pg_advisory_unlock(hashtext('neos.roles'))");
  } finally {
    await client.end();
  }
  return roles;
}

/** Build a connection string for one role against the same host/database as the admin URL. */
export function roleUrl(adminUrl: string, role: string): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = rolePassword(role);
  return u.toString();
}
