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

const ROLE_DEFAULTS = ['statement_timeout=30s', 'lock_timeout=10s', 'idle_in_transaction_session_timeout=30s'];

/** Role-level defaults (cluster-wide rows): set only what is missing, retrying concurrent bootstraps. */
async function roleDefaults(client: pg.Client, role: string, extra: string[] = []): Promise<void> {
  const cur = (await client.query<{ c: string[] | null }>('select rolconfig as c from pg_roles where rolname = $1', [role])).rows[0]?.c ?? [];
  for (const d of [...ROLE_DEFAULTS, ...extra].filter((x) => !cur.includes(x))) {
    const [k, v] = d.split('=') as [string, string];
    for (let i = 0; ; i++) {
      try {
        await client.query(`alter role ${role} set ${k} = '${v}'`);
        break;
      } catch (e) {
        if (i >= 10 || !/concurrently updated/.test((e as Error).message)) throw e;
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 80));
      }
    }
  }
}

/** Create the family roles (cluster-wide) and let the migrator create a schema in this database. */
export async function bootstrapFamily(adminUrl: string, schema: string, opts: { runner?: boolean } = {}): Promise<FamilyRoles> {
  const roles = familyRoles(schema);
  // A family that never uses a BYPASSRLS runner (the platform's `neos`) does not get one.
  const withRunner = opts.runner !== false;
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('neos.roles'))");
    await ensureRole(client, roles.migrator, 'nobypassrls nosuperuser nocreaterole');
    await ensureRole(client, roles.app, 'nobypassrls nosuperuser nocreaterole');
    if (withRunner) await ensureRole(client, roles.runner, 'bypassrls nosuperuser nocreaterole');
    // Timeouts as role defaults: they hold however the role connects, including through
    // PgBouncer, which drops per-connection startup settings (S8).
    // WP v3 §11 step 9: an app's roles resolve names in their own schema only (search_path = <schema>).
    // Every query the template writes is schema-qualified; this makes an unqualified name mean the app's own table.
    const home = withRunner ? [`search_path=${schema}`] : [];
    for (const r of withRunner ? [roles.app, roles.runner] : [roles.app]) await roleDefaults(client, r, home);
    const db = (await client.query<{ db: string }>('select current_database() as db')).rows[0]!.db;
    await client.query(`grant create, connect on database "${db}" to ${roles.migrator}`);
    await client.query(`grant connect on database "${db}" to ${withRunner ? `${roles.app}, ${roles.runner}` : roles.app}`);
    if (!withRunner) {
      // A runner left over from an earlier bootstrap: no way in here, and disarmed cluster-wide
      // (no login, no BYPASSRLS). Dropping it needs every database's grant revoked first (ops).
      const old = await client.query('select 1 from pg_roles where rolname = $1', [roles.runner]);
      if (old.rowCount) {
        await client.query(`revoke all on database "${db}" from ${roles.runner}`);
        await client.query(`alter role ${roles.runner} nologin nobypassrls`).catch(() => {});
      }
    }
    await client.query("select pg_advisory_unlock(hashtext('neos.roles'))");
  } finally {
    await client.end();
  }
  return roles;
}

/**
 * What bootstrapFamily does, as reviewable SQL for a DBA (scripts/dba-bundle.ts): the family's roles
 * (created without a password — the DBA sets each from the secret store), their options and role-level
 * defaults, and the database grants. Idempotent: every statement checks before it changes anything,
 * so it can be applied to a cluster where the roles already exist.
 */
export function familyBootstrapSql(schema: string, opts: { runner?: boolean } = {}): string {
  const roles = familyRoles(schema);
  const withRunner = opts.runner !== false;
  const make: [string, string, boolean][] = [
    [roles.migrator, 'nobypassrls nosuperuser nocreaterole', false],
    [roles.app, 'nobypassrls nosuperuser nocreaterole', false],
    ...(withRunner ? ([[roles.runner, 'bypassrls nosuperuser nocreaterole', true]] as [string, string, boolean][]) : []),
  ];
  const home = withRunner ? [`search_path=${schema}`] : [];
  const out: string[] = [`-- roles for family ${schema} (pgkit bootstrapFamily). Passwords are the DBA's, from the secret store: ALTER ROLE ${roles.app} PASSWORD '…';`];
  for (const [r, o, bypass] of make) {
    out.push(
      `do $$ begin\n` +
        `  if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} login ${o}; end if;\n` +
        `  if exists (select 1 from pg_roles where rolname = '${r}' and (not rolcanlogin or rolsuper or rolcreaterole or rolbypassrls <> ${bypass})) then alter role ${r} login ${o}; end if;\n` +
        `end $$;`,
    );
  }
  for (const r of withRunner ? [roles.app, roles.runner] : [roles.app]) {
    for (const d of [...ROLE_DEFAULTS, ...home]) {
      const [k, v] = d.split('=') as [string, string];
      out.push(`do $$ begin\n  if not ('${d}' = any(coalesce((select rolconfig from pg_roles where rolname = '${r}'), '{}'))) then alter role ${r} set ${k} = '${v}'; end if;\nend $$;`);
    }
  }
  out.push(
    `do $$ begin\n` +
      `  execute format('grant create, connect on database %I to ${roles.migrator}', current_database());\n` +
      `  execute format('grant connect on database %I to ${withRunner ? `${roles.app}, ${roles.runner}` : roles.app}', current_database());\n` +
      `end $$;`,
  );
  return out.join('\n');
}

/** The platform desk's role (v3 §11): NOLOGIN, created by the platform's migrations; reached with SET ROLE. */
export const DESK_ROLE = 'neos_desk';

/**
 * What the desk may do in one NEOP schema (v3 §11, template t010): DML on <schema>.switchboard and
 * <schema>.installs, SELECT on the board history and the grants, EXECUTE on answer_proposal / create_grant /
 * revoke_grant / set_schedule — and nothing on the app's own tables. Idempotent, and a no-op unless the
 * role exists and the schema is at t010 or later. Run as the schema's migrator (the objects' owner).
 */
export function deskGrantsSql(schema: string): string {
  assertIdent(schema);
  const s = schema;
  return (
    `do $$ begin\n` +
    `  if exists (select 1 from pg_roles where rolname = '${DESK_ROLE}') and to_regclass('${s}.switchboard_history') is not null\n` +
    `     and to_regprocedure('${s}.create_grant(text, jsonb, timestamptz, text, uuid)') is not null then\n` +
    `    grant usage on schema ${s} to ${DESK_ROLE};\n` +
    `    grant select, insert, update, delete on ${s}.switchboard, ${s}.installs to ${DESK_ROLE};\n` +
    `    grant select on ${s}.switchboard_history, ${s}.grants, ${s}.grant_uses to ${DESK_ROLE};\n` +
    `    grant execute on function ${s}.answer_proposal(uuid, text, text, text, text), ${s}.create_grant(text, jsonb, timestamptz, text, uuid),\n` +
    `      ${s}.revoke_grant(uuid, text), ${s}.set_schedule(uuid, text, text, jsonb, boolean), ${s}.board_version_for(uuid, integer),\n` +
    `      ${s}.import_grant(jsonb, jsonb) to ${DESK_ROLE};\n` +
    `  end if;\n` +
    `end $$;`
  );
}

/** Apply deskGrantsSql as the schema's migrator over an admin connection (idempotent; see deskGrantsSql). */
export async function applyDeskGrants(adminUrlOrClient: string | pg.Client, schema: string): Promise<boolean> {
  assertIdent(schema);
  const own = typeof adminUrlOrClient === 'string';
  const c = own ? new pg.Client({ connectionString: adminUrlOrClient }) : adminUrlOrClient;
  if (own) await c.connect();
  try {
    const ready = (
      await c.query<{ ok: boolean }>(
        `select exists (select 1 from pg_roles where rolname = $1) and exists (select 1 from pg_roles where rolname = $2)
                and to_regclass($3) is not null as ok`,
        [DESK_ROLE, familyRoles(schema).migrator, `${schema}.switchboard_history`],
      )
    ).rows[0]?.ok;
    if (!ready) return false;
    await c.query('begin');
    try {
      await c.query(`set local role ${familyRoles(schema).migrator}`);
      await c.query(deskGrantsSql(schema));
      await c.query('commit');
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    }
    return true;
  } finally {
    if (own) await c.end();
  }
}

/** Build a connection string for one role against the same host/database as the admin URL. */
export function roleUrl(adminUrl: string, role: string): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = rolePassword(role);
  return u.toString();
}
