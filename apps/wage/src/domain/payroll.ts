// Pure payroll arithmetic. No statutory rates are invented: approved inputs supply deductions.
export const MAX_MINOR = 1_000_000_000_000;
export type Deduction = { id: string; kind: 'percent' | 'fixed'; rate_bps: number; amount_minor: number };
export type Employee = { id: string; source_id: string; comp_type: 'salary' | 'hourly'; rate_minor: number; currency: string; status: 'active' | 'terminated' };
export type Timesheet = { employee_id: string; minutes: number };
export type Slip = { employee_id: string; gross_minor: number; deductions_minor: number; net_minor: number; minutes: number | null; deduction_capped: boolean };
export class PayrollError extends Error {}

export function integer(n: number, name: string, max = MAX_MINOR): number {
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new PayrollError(`${name} must be an integer between 0 and ${max}`);
  return n;
}
export function period(value: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new PayrollError('period must be YYYY-MM');
  return value;
}
export function distinct(ids: string[], what: string): void {
  if (new Set(ids).size !== ids.length) throw new PayrollError(`duplicate ${what}`);
}
function roundRatio(n: bigint, d: bigint): number {
  return integer(Number((n + d / 2n) / d), 'computed amount');
}

export function calculatePayroll(input: { period: string; currency: string; employees: Employee[]; timesheets: Timesheet[]; deductions: Deduction[] }) {
  period(input.period);
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new PayrollError('currency must be a three-letter code');
  distinct(input.employees.map(e => e.id), 'employee');
  distinct(input.timesheets.map(t => t.employee_id), 'timesheet');
  distinct(input.deductions.map(d => d.id), 'deduction rule');
  const minutes = new Map(input.timesheets.map(t => [t.employee_id, integer(t.minutes, 'minutes', 60_000)]));
  for (const d of input.deductions) {
    if (!['percent', 'fixed'].includes(d.kind)) throw new PayrollError('unknown deduction kind');
    integer(d.rate_bps, 'deduction rate', 10_000);
    integer(d.amount_minor, 'fixed deduction');
    if ((d.kind === 'percent' && d.amount_minor !== 0) || (d.kind === 'fixed' && d.rate_bps !== 0)) throw new PayrollError('a deduction has either a percentage or a fixed amount, not both');
  }
  const active = input.employees.filter(e => e.status === 'active');
  if (!active.length) throw new PayrollError('no active employees to pay');
  const slips: Slip[] = active.map(e => {
    if (!['salary', 'hourly'].includes(e.comp_type)) throw new PayrollError(`unknown compensation type: ${e.source_id}`);
    if (e.currency !== input.currency) throw new PayrollError(`mixed currencies: ${e.source_id} is not paid in ${input.currency}`);
    integer(e.rate_minor, 'employee rate');
    const worked = e.comp_type === 'hourly' ? minutes.get(e.id) : null;
    if (worked === undefined) throw new PayrollError(`missing timesheet for hourly employee ${e.source_id}; do not assume zero hours`);
    const gross = e.comp_type === 'salary' ? e.rate_minor : roundRatio(BigInt(e.rate_minor) * BigInt(worked!), 60n);
    // Match the source's round-once, cap-at-gross rule, without binary floating-point money.
    const numerator = input.deductions.reduce((sum, d) => sum + (d.kind === 'percent' ? BigInt(gross) * BigInt(d.rate_bps) : BigInt(d.amount_minor) * 10_000n), 0n);
    const rounded = (numerator + 5_000n) / 10_000n;
    const deduction = Number(rounded > BigInt(gross) ? BigInt(gross) : rounded);
    return { employee_id: e.id, gross_minor: gross, deductions_minor: deduction, net_minor: gross - deduction, minutes: worked, deduction_capped: rounded > BigInt(gross) };
  });
  slips.sort((a, b) => a.employee_id.localeCompare(b.employee_id));
  const total = (key: 'gross_minor' | 'deductions_minor' | 'net_minor') => integer(slips.reduce((n, s) => n + s[key], 0), `total ${key}`);
  return { period: input.period, currency: input.currency, headcount: slips.length, gross_minor: total('gross_minor'), deductions_minor: total('deductions_minor'), net_minor: total('net_minor'), slips };
}
