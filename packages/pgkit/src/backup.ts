// Per-company logical backup and restore (plan §Backups). Point-in-time
// recovery restores every app at once; this restores one company in one app's
// family without rewinding anyone else. Tables are discovered from the catalog
// (every table with company_id), walked in foreign-key order, and restored in
// one transaction with identity values preserved.

import pg from 'pg';
import { assertIdent } from './roles.ts';

export interface CompanyDump {
  schema: string;
  company_id: string;
  exported_at: string;
  order: string[];
  tables: Record<string, unknown[]>;
}

async function tablesInOrder(c: pg.Client, schema: string): Promise<string[]> {
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
