import { createHash } from 'node:crypto';
import type { PoolClient } from '@neop/pgkit';
import { calculatePayroll, PayrollError, type Deduction, type Employee, type Timesheet } from '../domain/payroll.ts';

export function digest(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export async function lock(db: PoolClient, company: string) {
  // Serialize source edits with preparing/releasing payroll; no stale snapshot can win a race.
  await db.query("select pg_advisory_xact_lock(hashtext('wage.payroll'), hashtext($1))", [company]);
}
export async function prepared(db: PoolClient, company: string, p: string) {
  const cfg = (await db.query('select currency, deductions from wage.settings where company_id=$1', [company])).rows[0];
  if (!cfg) throw new PayrollError('configure payroll currency and reviewed deduction rules first');
  const emps = (await db.query('select id, source_id, comp_type, rate_minor, currency, status from wage.employees where company_id=$1 order by id', [company])).rows.map(e => ({ ...e, rate_minor: Number(e.rate_minor) })) as Employee[];
  const sheets = (await db.query('select employee_id, minutes from wage.timesheets where company_id=$1 and period=$2 order by employee_id', [company, p])).rows as Timesheet[];
  const inputs = { period: p, currency: cfg.currency as string, deductions: cfg.deductions as Deduction[], employees: emps, timesheets: sheets };
  return { payroll: calculatePayroll(inputs), input_hash: digest(inputs), inputs };
}
export async function getRun(db: PoolClient, company: string, id: string) {
  return (await db.query('select * from wage.pay_runs where company_id=$1 and id=$2', [company, id])).rows[0] ?? null;
}
export async function readDeclared(db: PoolClient, fn: 'employees' | 'settings' | 'timesheets' | 'runs' | 'payslips', args: unknown) {
  return (await db.query(`select wage.read_${fn}($1::jsonb) as result`, [JSON.stringify(args)])).rows[0]!.result;
}
export async function receipt(db: PoolClient, company: string, key: string) {
  return (await db.query('select * from wage.write_receipts where company_id=$1 and reference=$2', [company, key])).rows[0] ?? null;
}
export async function saveReceipt(db: PoolClient, company: string, key: string, args: unknown, result: unknown) {
  await db.query('insert into wage.write_receipts(company_id,reference,request_hash,result) values($1,$2,$3,$4)', [company, key, digest(args), JSON.stringify(result)]);
}
export async function configure(db: PoolClient, company: string, a: { currency: string; deductions: Deduction[] }) {
  await db.query('insert into wage.settings(company_id,currency,deductions) values($1,$2,$3) on conflict(company_id) do update set currency=excluded.currency,deductions=excluded.deductions', [company, a.currency, JSON.stringify(a.deductions)]);
  return { configured: true };
}
export async function importEmployees(db: PoolClient, company: string, rows: any[]) {
  for (const e of rows) await db.query(`insert into wage.employees(company_id,source_id,name,comp_type,rate_minor,currency,status)
    values($1,$2,$3,$4,$5,$6,$7) on conflict(company_id,source_id) do update set name=excluded.name,comp_type=excluded.comp_type,rate_minor=excluded.rate_minor,currency=excluded.currency,status=excluded.status`, [company,e.source_id,e.name,e.comp_type,e.rate_minor,e.currency,e.status]);
  return { imported: rows.length };
}
export async function importTimesheets(db: PoolClient, company: string, p: string, rows: { source_id: string; minutes: number }[]) {
  const run = (await db.query("select id from wage.pay_runs where company_id=$1 and period=$2 and status <> 'superseded'", [company, p])).rows[0];
  if (run) throw new PayrollError('period already prepared; reopen an unreleased run before changing timesheets');
  for (const t of rows) {
    const e = (await db.query('select id from wage.employees where company_id=$1 and source_id=$2', [company, t.source_id])).rows[0];
    if (!e) throw new PayrollError(`unknown employee ${t.source_id}`);
    await db.query('insert into wage.timesheets(company_id,period,employee_id,minutes) values($1,$2,$3,$4) on conflict(company_id,period,employee_id) do update set minutes=excluded.minutes', [company,p,e.id,t.minutes]);
  }
  return { imported: rows.length };
}
export async function prepareRun(db: PoolClient, company: string, p: string, reference: string) {
  if ((await db.query("select id from wage.pay_runs where company_id=$1 and period=$2 and status <> 'superseded'", [company, p])).rowCount) throw new PayrollError('period already prepared or released; do not duplicate payroll');
  const { payroll: r, input_hash, inputs } = await prepared(db, company, p);
  const id = (await db.query(`insert into wage.pay_runs(company_id,period,currency,headcount,gross_minor,deductions_minor,net_minor,input_hash,input_snapshot,reference)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`, [company,p,r.currency,r.headcount,r.gross_minor,r.deductions_minor,r.net_minor,input_hash,JSON.stringify(inputs),reference])).rows[0]!.id;
  for (const s of r.slips) await db.query(`insert into wage.payslips(company_id,run_id,employee_id,currency,gross_minor,deductions_minor,net_minor,minutes,deduction_capped)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [company,id,s.employee_id,r.currency,s.gross_minor,s.deductions_minor,s.net_minor,s.minutes,s.deduction_capped]);
  return { run_id: id, input_hash, headcount: r.headcount, net_minor: r.net_minor, currency: r.currency, status: 'prepared', paid: false };
}
export async function transition(db: PoolClient, company: string, args: any, reference: string, action: 'release' | 'reopen') {
  const r = await getRun(db, company, args.run_id);
  if (!r || r.status !== 'prepared') throw new PayrollError('only an unreleased prepared run can be released or reopened');
  if (r.input_hash !== args.input_hash || Number(r.net_minor) !== args.amount_minor || r.currency !== args.currency) throw new PayrollError('payroll differs from the approved snapshot');
  if (action === 'release') {
    const current = await prepared(db, company, r.period);
    if (current.input_hash !== r.input_hash) throw new PayrollError('payroll inputs changed; reopen, recalculate and obtain a fresh approval');
  }
  const status = action === 'release' ? 'released' : 'superseded';
  await db.query('update wage.pay_runs set status=$3, transition_ref=$4, transitioned_at=now() where company_id=$1 and id=$2', [company,r.id,status,reference]);
  return { run_id: r.id, status, amount_minor: Number(r.net_minor), currency: r.currency, input_hash: r.input_hash, paid: false };
}
