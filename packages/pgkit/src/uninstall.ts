// Company-scoped uninstall (WP §11: "uninstalling is a company-scoped delete the DBA runs from
// one script"). Every table in the app's schema that carries company_id — the template's standard
// tables, the app's own, and installed packages' nep_* tables — loses that company's rows, children
// before parents, in one transaction under the family's migrator (the owner; row-level security
// still scopes it to the company). Other companies are untouched. Dry run by default.

import pg from 'pg';
import { tablesInOrder } from './backup.ts';
import { assertIdent, familyRoles } from './roles.ts';

export interface PurgeResult {
  schema: string;
  company_id: string;
  dry_run: boolean;
  /** Deletion order (children first). */
  order: string[];
  /** Rows of this company per table (dry run: that would go; otherwise: that went). */
  counts: Record<string, number>;
  total: number;
}

export async function purgeCompany(adminUrl: string, schema: string, companyId: string, opts: { dryRun?: boolean } = {}): Promise<PurgeResult> {
  assertIdent(schema);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) throw new Error('company_id must be a uuid');
  const dryRun = opts.dryRun !== false;
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query('begin');
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [`migrate:${schema}`]); // not while its migrations run
    const order = [...(await tablesInOrder(c, schema))].reverse();
    await c.query(`set local role ${familyRoles(schema).migrator}`);
    await c.query("select set_config('neos.company_id', $1, true)", [companyId]);
    const counts: Record<string, number> = {};
    for (const t of order) {
      const before = (await c.query<{ n: number }>(`select count(*)::int as n from ${schema}.${t} where company_id = $1`, [companyId])).rows[0]!.n;
      if (!dryRun && before) {
        const r = await c.query(`delete from ${schema}.${t} where company_id = $1`, [companyId]);
        if (r.rowCount !== before) throw new Error(`${schema}.${t}: counted ${before} rows, deleted ${r.rowCount}; nothing was removed`);
      }
      counts[t] = before;
    }
    await c.query(dryRun ? 'rollback' : 'commit'); // deferred constraints run at commit
    return { schema, company_id: companyId, dry_run: dryRun, order, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}
