import type { ReadAbility, WriteAbility } from '@neop/template';
import type { PoolClient } from '@neop/pgkit';
import { DoorError } from '@neop/template';
import * as repo from '../data/payroll.repo.ts';
import { distinct, PayrollError, period } from '../domain/payroll.ts';

const read = (name: Parameters<typeof repo.readDeclared>[1]): ReadAbility => ({ kind: 'read', run: (a, ctx) => repo.readDeclared(ctx.db, name, a) });
function write(operation: (db: PoolClient, company: string, a: any, ref: string) => Promise<unknown>): WriteAbility {
  return {
    kind: 'write',
    async execute(a, ctx) {
      try {
        const detail = await ctx.withDb(async db => {
          await repo.lock(db, ctx.company_id);
          const previous = await repo.receipt(db, ctx.company_id, ctx.idempotencyKey);
          if (previous) {
            if (previous.request_hash !== repo.digest(a)) throw new PayrollError('idempotency key already belongs to different content');
            return previous.result;
          }
          const result = await operation(db, ctx.company_id, a, ctx.idempotencyKey);
          await repo.saveReceipt(db, ctx.company_id, ctx.idempotencyKey, a, result);
          return result;
        });
        return { external_ref: ctx.idempotencyKey, detail };
      } catch (e) {
        if (e instanceof PayrollError) throw new DoorError(e.message, { definite: true });
        throw e;
      }
    },
    async readBack(a, ctx) {
      const r = await ctx.withDb(db => repo.receipt(db, ctx.company_id, ctx.idempotencyKey));
      return { found: !!r && r.request_hash === repo.digest(a), data: r?.result ?? null };
    },
  };
}
function check(fn: (a: any) => void) {
  return (a: any) => { try { fn(a); return null; } catch (e) { return (e as Error).message; } };
}
const configure = write((db, c, a) => repo.configure(db, c, a));
configure.check = check(a => {
  distinct(a.deductions.map((d: any) => d.id), 'deduction rule');
  for (const d of a.deductions) if ((d.kind === 'percent' && d.amount_minor !== 0) || (d.kind === 'fixed' && d.rate_bps !== 0)) throw new PayrollError('a deduction has either a percentage or a fixed amount, not both');
});
const employees = write((db, c, a) => repo.importEmployees(db, c, a.employees));
employees.check = check(a => distinct(a.employees.map((e: any) => e.source_id), 'employee source_id'));
const timesheets = write((db, c, a) => repo.importTimesheets(db, c, a.period, a.entries));
timesheets.check = check(a => { period(a.period); distinct(a.entries.map((e: any) => e.source_id), 'timesheet source_id'); });
const prepare = write((db, c, a, ref) => repo.prepareRun(db, c, a.period, ref));
prepare.check = check(a => { period(a.period); });
function transition(action: 'release' | 'reopen'): WriteAbility {
  const handler = write((db, c, a, ref) => repo.transition(db, c, a, ref, action));
  handler.normalize = async (a, ctx) => {
    // Normalization precedes manifest validation in the shared gate. Malformed ids must not reach SQL.
    if (!a || typeof a !== 'object' || typeof a.run_id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(a.run_id)) return a;
    const r = await repo.getRun(ctx.db, ctx.company_id, a.run_id);
    // Let validate produce the actionable refusal for an unknown run.
    return r ? { ...a, input_hash: r.input_hash, amount_minor: Number(r.net_minor), currency: r.currency } : a;
  };
  handler.validate = async (a, ctx) => {
    const r = await repo.getRun(ctx.db, ctx.company_id, a.run_id);
    return !r || r.status !== 'prepared' ? 'only an unreleased prepared run can be released or reopened' : null;
  };
  return handler;
}
export const abilities = {
  'wage.settings.get': read('settings'),
  'wage.employees.list': read('employees'),
  'wage.timesheets.list': read('timesheets'),
  'wage.payroll.list': read('runs'),
  'wage.payslips.list': read('payslips'),
  'wage.settings.update': configure,
  'wage.employees.import': employees,
  'wage.timesheets.import': timesheets,
  'wage.payroll.prepare': prepare,
  'wage.payroll.release': transition('release'),
  'wage.payroll.reopen': transition('reopen'),
};
