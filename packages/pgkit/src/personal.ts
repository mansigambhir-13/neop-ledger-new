import {sqlIdent} from './roles.ts';
// Personal data (WP §11: "personal-data columns are tagged in the manifest so deletion can find
// them"). The DBA's tools for one data subject in one company of one app: find them, export what
// is held about them (subject access), erase it. Only the tagged columns are ever read or
// written. Erasing pseudonymises in place — rows stay, so a journal entry, an invoice or a
// payment that refers to the person keeps its integrity and its money; only the person's
// identifying values go. Each export and erase writes an audit row (neos.audit) in the same
// transaction as the work, so there is no erase without its record.

import { createHash } from 'node:crypto';
import pg from 'pg';
import { assertIdent, familyRoles } from './roles.ts';

export interface PersonalDataTag {
  table: string;
  columns: string[];
  subject_key: string;
}

export interface SubjectExport {
  schema: string;
  company_id: string;
  subject: string;
  exported_at: string;
  /** Per tagged table: the rows about this subject, with the subject key and the tagged columns only. */
  tables: Record<string, Record<string, unknown>[]>;
}

export interface EraseResult {
  schema: string;
  company_id: string;
  subject: string;
  dry_run: boolean;
  /** Per tagged table: rows touched and what each column became (NULL or a pseudonym). */
  tables: Record<string, { rows: number; columns: Record<string, 'null' | 'pseudonym'> }>;
  pseudonym: string;
}

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function columnsOf(c: pg.Client, schema: string, tags: PersonalDataTag[]): Promise<Map<string, Map<string, ColumnInfo>>> {
  const out = new Map<string, Map<string, ColumnInfo>>();
  for (const t of tags) {
    for (const n of [t.table, t.subject_key, ...t.columns]) assertIdent(n);
    const cols = (
      await c.query<ColumnInfo>('select column_name, data_type, is_nullable from information_schema.columns where table_schema = $1 and table_name = $2', [schema, t.table])
    ).rows;
    if (!cols.length) throw new Error(`personal_data: ${sqlIdent(schema)}.${t.table} does not exist`);
    const byName = new Map(cols.map((x) => [x.column_name, x]));
    for (const n of ['company_id', t.subject_key, ...t.columns]) if (!byName.has(n)) throw new Error(`personal_data: ${sqlIdent(schema)}.${t.table} has no column ${n}`);
    out.set(t.table, byName);
  }
  return out;
}

/** Under the family's migrator (owner of every table in the schema), scoped to one company by RLS and by the WHERE. */
async function scoped(c: pg.Client, schema: string, companyId: string): Promise<void> {
  await c.query(`set local role ${familyRoles(schema).migrator}`);
  await c.query("select set_config('neos.company_id', $1, true)", [companyId]);
}

async function audit(c: pg.Client, e: { company_id: string; actor: string; app: string; action: string; outcome: string; detail: unknown }): Promise<void> {
  const has = (await c.query("select to_regclass('neos.audit') is not null as ok")).rows[0].ok;
  if (!has) throw new Error('neos.audit is not in this database; personal-data work is refused without its audit row');
  await c.query('insert into neos.audit (company_id, actor, app_key, action, outcome, detail) values ($1, $2, $3, $4, $5, $6)', [
    e.company_id,
    e.actor,
    e.app,
    e.action,
    e.outcome,
    JSON.stringify(e.detail),
  ]);
}

function check(schema: string, companyId: string, subject: string): void {
  assertIdent(schema);
  if (!UUID.test(companyId)) throw new Error('company_id must be a uuid');
  if (!subject || subject.length > 200) throw new Error('subject (the subject_key value) required');
}

/** Subjects whose tagged columns contain `text` (case-insensitive), to find who to export or erase. */
export async function findSubjects(adminUrl: string, schema: string, companyId: string, tags: PersonalDataTag[], text: string): Promise<{ table: string; subject: string; match: Record<string, unknown> }[]> {
  check(schema, companyId, text);
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query('begin read only');
    await columnsOf(c, schema, tags);
    await scoped(c, schema, companyId);
    const out: { table: string; subject: string; match: Record<string, unknown> }[] = [];
    for (const t of tags) {
      const where = t.columns.map((col) => `${col}::text ilike '%' || $2 || '%'`).join(' or ');
      const r = await c.query(`select ${t.subject_key}::text as subject, ${t.columns.join(', ')} from ${sqlIdent(schema)}.${t.table} where company_id = $1 and (${where}) limit 50`, [companyId, text]);
      for (const row of r.rows) {
        const { subject, ...match } = row;
        out.push({ table: t.table, subject, match });
      }
    }
    await c.query('commit');
    return out;
  } finally {
    await c.end();
  }
}

/** Subject access: everything the tags say is this person's, in this company. Audited. */
export async function exportSubject(adminUrl: string, schema: string, companyId: string, tags: PersonalDataTag[], subject: string, by: string): Promise<SubjectExport> {
  check(schema, companyId, subject);
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query('begin isolation level repeatable read');
    await columnsOf(c, schema, tags);
    await scoped(c, schema, companyId);
    const tables: SubjectExport['tables'] = {};
    for (const t of tags) {
      tables[t.table] = (await c.query(`select ${t.subject_key}, ${t.columns.join(', ')} from ${sqlIdent(schema)}.${t.table} where company_id = $1 and ${t.subject_key}::text = $2`, [companyId, subject])).rows;
    }
    await c.query('reset role');
    const rows = Object.values(tables).reduce((n, x) => n + x.length, 0);
    await audit(c, { company_id: companyId, actor: by, app: schema, action: 'personal_data.export', outcome: String(rows), detail: { subject, tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])) } });
    await c.query('commit');
    return { schema, company_id: companyId, subject, exported_at: new Date().toISOString(), tables };
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

/**
 * Erase one subject's personal data in one company: every tagged column of their rows becomes NULL
 * (nullable columns) or a stable pseudonym (required text columns — e.g. a party's name, which
 * invoices and journal memos refer to). Rows are never deleted. Dry run by default: the counts,
 * nothing written, nothing audited. Refuses a tagged column it cannot blank safely.
 */
export async function eraseSubject(
  adminUrl: string,
  schema: string,
  companyId: string,
  tags: PersonalDataTag[],
  subject: string,
  opts: { by: string; dryRun?: boolean },
): Promise<EraseResult> {
  check(schema, companyId, subject);
  const dryRun = opts.dryRun !== false;
  const pseudonym = `erased-${createHash('sha256').update(`${companyId}:${subject}`).digest('hex').slice(0, 12)}`;
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query('begin');
    const info = await columnsOf(c, schema, tags);
    const plan: EraseResult['tables'] = {};
    for (const t of tags) {
      const cols: Record<string, 'null' | 'pseudonym'> = {};
      for (const col of t.columns) {
        const ci = info.get(t.table)!.get(col)!;
        if (ci.is_nullable === 'YES') cols[col] = 'null';
        else if (['text', 'character varying', 'character'].includes(ci.data_type)) cols[col] = 'pseudonym';
        else throw new Error(`personal_data: ${sqlIdent(schema)}.${t.table}.${col} is NOT NULL ${ci.data_type}; it cannot be blanked or pseudonymised safely`);
      }
      plan[t.table] = { rows: 0, columns: cols };
    }
    await scoped(c, schema, companyId);
    for (const t of tags) {
      const where = `company_id = $1 and ${t.subject_key}::text = $2`;
      if (dryRun) {
        plan[t.table]!.rows = (await c.query(`select count(*)::int as n from ${sqlIdent(schema)}.${t.table} where ${where}`, [companyId, subject])).rows[0].n;
        continue;
      }
      const sets = Object.entries(plan[t.table]!.columns).map(([col, how]) => `${col} = ${how === 'null' ? 'null' : '$3'}`);
      const r = await c.query(`update ${sqlIdent(schema)}.${t.table} set ${sets.join(', ')} where ${where}`, [companyId, subject, pseudonym]);
      plan[t.table]!.rows = r.rowCount ?? 0;
    }
    await c.query('reset role');
    if (dryRun) {
      await c.query('rollback');
    } else {
      const rows = Object.values(plan).reduce((n, x) => n + x.rows, 0);
      await audit(c, { company_id: companyId, actor: opts.by, app: schema, action: 'personal_data.erase', outcome: String(rows), detail: { subject, pseudonym, tables: plan } });
      await c.query('commit');
    }
    return { schema, company_id: companyId, subject, dry_run: dryRun, tables: plan, pseudonym };
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}
