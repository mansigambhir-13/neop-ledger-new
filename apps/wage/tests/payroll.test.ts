import { describe, expect, it } from 'vitest';
import { calculatePayroll, type Employee } from '../src/domain/payroll.ts';
const employee: Employee = { id: 'a', source_id: 'E-1', comp_type: 'salary', rate_minor: 500000, currency: 'INR', status: 'active' };
const input = { period: '2026-09', currency: 'INR', employees: [employee], timesheets: [], deductions: [{ id: 'reviewed-tax', kind: 'percent' as const, rate_bps: 2000, amount_minor: 0 }, { id: 'fixed', kind: 'fixed' as const, rate_bps: 0, amount_minor: 10000 }] };

describe('Wage exact gross-to-net arithmetic', () => {
  it('preserves the source salary example in minor units', () => {
    expect(calculatePayroll(input)).toMatchObject({ headcount: 1, gross_minor: 500000, deductions_minor: 110000, net_minor: 390000 });
  });
  it('calculates hourly pay from integer minutes with half-up rounding', () => {
    expect(calculatePayroll({ ...input, employees: [{ ...employee, comp_type: 'hourly', rate_minor: 101 }], timesheets: [{ employee_id: 'a', minutes: 30 }], deductions: [] }).net_minor).toBe(51);
  });
  it('rounds percentage rules together once, not once per rule', () => {
    expect(calculatePayroll({ ...input, employees: [{ ...employee, rate_minor: 1 }], deductions: [{ id: '1', kind: 'percent', rate_bps: 2500, amount_minor: 0 }, { id: '2', kind: 'percent', rate_bps: 2500, amount_minor: 0 }] }).deductions_minor).toBe(1);
  });
  it('caps deductions at gross and surfaces the cap for review', () => {
    const r = calculatePayroll({ ...input, deductions: [{ id: 'x', kind: 'fixed', rate_bps: 0, amount_minor: 600000 }] });
    expect(r.net_minor).toBe(0); expect(r.slips[0]!.deduction_capped).toBe(true);
  });
  it('excludes terminated employees without deleting earlier issued payroll', () => {
    expect(calculatePayroll({ ...input, employees: [employee, { ...employee, id: 'b', status: 'terminated' }] }).headcount).toBe(1);
  });
  it('requires an explicit timesheet for an hourly employee', () => {
    expect(() => calculatePayroll({ ...input, employees: [{ ...employee, comp_type: 'hourly' }] })).toThrow('missing timesheet');
    expect(calculatePayroll({ ...input, employees: [{ ...employee, comp_type: 'hourly' }], timesheets: [{ employee_id: 'a', minutes: 0 }], deductions: [] }).net_minor).toBe(0);
  });
  it.each([NaN, Infinity, -1, 0.1, 1_000_000_000_001, Number.MAX_SAFE_INTEGER])('refuses unsafe money %s', rate_minor => {
    expect(() => calculatePayroll({ ...input, employees: [{ ...employee, rate_minor }] })).toThrow('integer');
  });
  it.each(['2026-00','2026-13','September','2026-9',''])('refuses invalid period %s', period => {
    expect(() => calculatePayroll({ ...input, period })).toThrow('YYYY-MM');
  });
  it('refuses duplicate source rows, mixed currencies and missing employees', () => {
    expect(() => calculatePayroll({ ...input, employees: [employee, employee] })).toThrow('duplicate');
    expect(() => calculatePayroll({ ...input, employees: [{ ...employee, currency: 'USD' }] })).toThrow('mixed currencies');
    expect(() => calculatePayroll({ ...input, employees: [] })).toThrow('no active employees');
  });
  it('refuses totals exceeding the declared bounded money range', () => {
    expect(() => calculatePayroll({ ...input, employees: [{ ...employee, rate_minor: 1e12 }, { ...employee, id: 'b', rate_minor: 1e12 }] })).toThrow('total gross_minor');
  });
  it('keeps gross = deductions + net over boundary values', () => {
    for (const rate_minor of [0,1,2,99,100,101,999999999999,1e12]) {
      const r = calculatePayroll({ ...input, employees: [{ ...employee, rate_minor }] });
      expect(r.gross_minor).toBe(r.deductions_minor+r.net_minor);
      expect(Number.isSafeInteger(r.net_minor)).toBe(true);
    }
  });
});
