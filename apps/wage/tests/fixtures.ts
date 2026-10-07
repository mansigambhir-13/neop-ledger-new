import type { Pool } from '@neop/pgkit';
import { withCompany } from '@neop/pgkit';
import { configure, importEmployees, prepareRun, prepared } from '../src/data/payroll.repo.ts';
export const RUN = 'ca270982-5990-4777-911b-7782f8db9156';
export const employees = [
  { source_id: 'E-1', name: 'Ann', comp_type: 'salary', rate_minor: 500000, currency: 'INR', status: 'active' },
  { source_id: 'E-2', name: 'Bob', comp_type: 'salary', rate_minor: 400000, currency: 'INR', status: 'active' },
];
export const settings = { currency: 'INR', deductions: [{ id: 'reviewed-withholding', kind: 'percent' as const, rate_bps: 2000, amount_minor: 0 }] };
export async function seed(pool: Pool, company: string) {
  await withCompany(pool, company, async db => {
    await configure(db, company, settings);
    await importEmployees(db, company, employees);
    // Seed a deterministic UUID without disabling the immutable-run trigger.
    const snapshot = await prepared(db, company, '2026-08');
    const p = snapshot.payroll;
    await db.query(`insert into wage.pay_runs(id,company_id,period,currency,headcount,gross_minor,deductions_minor,net_minor,input_hash,input_snapshot,reference)
      values($1,$2,'2026-08','INR',$3,$4,$5,$6,$7,$8,'seed')`, [RUN,company,p.headcount,p.gross_minor,p.deductions_minor,p.net_minor,snapshot.input_hash,JSON.stringify(snapshot.inputs)]);
    await prepareRun(db, company, '2026-09', 'seed-current');
  });
}
