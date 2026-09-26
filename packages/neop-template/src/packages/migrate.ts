// Package migrations: run by the platform's migration runner (admin), never at
// request time. Tables land in the host's schema, named nep_<name>_*, owned by
// the host migrator; the package's own role gets DML on exactly those tables;
// the host app role may only read them. The tenant lint applies (B1).

import { createHash } from 'node:crypto';
import pg from 'pg';
import { assertIdent, familyRoles, rolePassword, render, tenantLint } from '@neop/pgkit';
import type { PackageBundle } from './types.ts';

export function packageRole(host: string, packageKey: string): string {
  const name = packageKey.replace(/^nep-/, '').replace(/[^a-z0-9]/g, '_');
  const role = `${host}_nep_${name}`;
  assertIdent(role);
  return role;
}

export async function migratePackage(adminUrl: string, host: string, bundle: PackageBundle): Promise<string[]> {
  const m = bundle.manifest;
  const prefix = `nep_${m.key.replace(/^nep-/, '').replace(/[^a-z0-9]/g, '_')}_`;
  const roles = familyRoles(host);
  const role = packageRole(host, m.key);
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', [`migrate:${host}`]);
    const exists = await client.query('select 1 from pg_roles where rolname = $1', [role]);
    const pw = rolePassword(role).replace(/'/g, "''");
    if (!exists.rowCount) await client.query(`create role ${role} login password '${pw}' nobypassrls nosuperuser nocreaterole`).catch(() => {});
    else await client.query(`alter role ${role} login password '${pw}'`);
    await client.query(`grant connect on database "${(await client.query('select current_database() as d')).rows[0].d}" to ${role}`);
    const done = new Set((await client.query<{ name: string }>(`select name from ${host}.schema_migrations`)).rows.map((r) => r.name));
    for (const file of Object.keys(m.migrations).sort()) {
      const name = `${m.key}@${m.version}/${file}`;
      const legacy = [...done].find((d) => d.startsWith(`${m.key}@`) && d.endsWith(`/${file}`));
      if (done.has(name) || legacy) continue;
      const sql = m.migrations[file]!;
      await client.query('begin');
      try {
        const before = new Set((await client.query<{ t: string }>(`select tablename as t from pg_tables where schemaname = $1`, [host])).rows.map((r) => r.t));
        await client.query(`set local role ${roles.migrator}`);
        await client.query(`set local search_path to ${host}`);
        await client.query(render(sql, host));
        const after = (await client.query<{ t: string }>(`select tablename as t from pg_tables where schemaname = $1`, [host])).rows.map((r) => r.t);
        const created = after.filter((t) => !before.has(t));
        const stray = created.filter((t) => !t.startsWith(prefix));
        if (stray.length) throw new Error(`a package may only create ${prefix}* tables (created ${stray.join(', ')})`);
        await tenantLint(client, host, ['schema_migrations', 'seen_tokens', 'outbox_acked']);
        await client.query(`grant usage on schema ${host} to ${role}`);
        for (const t of after.filter((x) => x.startsWith(prefix))) {
          await client.query(`grant select, insert, update on ${host}.${t} to ${role}`);
          await client.query(`revoke insert, update, delete on ${host}.${t} from ${roles.app}`);
          await client.query(`grant select on ${host}.${t} to ${roles.app}`);
        }
        await client.query(`grant usage, select on all sequences in schema ${host} to ${role}`);
        await client.query(`insert into ${host}.schema_migrations (name, checksum) values ($1, $2)`, [name, createHash('sha256').update(sql).digest('hex')]);
        await client.query('commit');
        applied.push(name);
      } catch (e) {
        await client.query('rollback');
        throw new Error(`package migration ${name} failed: ${(e as Error).message}`, { cause: e });
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(hashtext($1))', [`migrate:${host}`]).catch(() => {});
    await client.end();
  }
  return applied;
}
