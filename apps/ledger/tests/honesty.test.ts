// honesty.test · nulls are null, empty is empty, generatedAt present, and the
// books are internally consistent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPilot, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => P?.close());

const read = async (key: string, args: unknown) => (await P.api('POST', `/api/apps/ledger/read/${key}`, args)).body.result;

describe('honesty', () => {
  it('a period with no entries says empty, with zero entries as its source', async () => {
    const r = await read('ledger.report.pnl', { from: '2025-01-01', to: '2025-01-31' });
    expect(r.empty).toBe(true);
    expect(r.sources.entries).toBe(0);
    expect(r.income).toEqual([]);
    expect(Date.parse(r.generatedAt)).not.toBeNaN();
  });

  it('every report names what it was built from', async () => {
    const r = await read('ledger.report.pnl', { from: '2026-08-01', to: '2026-08-31' });
    expect(r.empty).toBe(false);
    expect(r.sources.entries).toBeGreaterThan(0);
    expect(r.sources.entry_ids.length).toBe(Math.min(50, r.sources.entries));
    expect(r.sources.basis).toContain('2026-08-01');
  });

  it('the trial balance agrees and the balance sheet balances on the seeded books', async () => {
    const tb = await read('ledger.report.trial_balance', { as_of: '2026-09-30' });
    expect(tb.balanced).toBe(true);
    expect(tb.total_debit_minor).toBe(tb.total_credit_minor);
    const bs = await read('ledger.report.balance_sheet', { as_of: '2026-09-30' });
    expect(bs.balanced).toBe(true);
  });

  it('cash flow reconciles opening to closing, and closing matches the balance sheet', async () => {
    const cf = await read('ledger.report.cash_flow', { from: '2026-07-01', to: '2026-09-30' });
    expect(cf.closing_cash_minor).toBe(cf.opening_cash_minor + cf.operating_minor + cf.investing_minor + cf.financing_minor);
    const bs = await read('ledger.report.balance_sheet', { as_of: '2026-09-30' });
    const cash = bs.assets.filter((a: any) => ['cash', 'bank'].includes(a.subtype)).reduce((s: number, a: any) => s + a.amount_minor, 0);
    expect(cf.closing_cash_minor).toBe(cash);
    expect(cf.investing_minor).toBe(-24_000_000);
  });

  it('money is integers in minor units, never floats', async () => {
    const r = await read('ledger.report.vat_summary', { from: '2026-07-01', to: '2026-09-30' });
    for (const k of ['output_tax_minor', 'input_tax_minor', 'net_payable_minor']) expect(Number.isInteger(r[k])).toBe(true);
    expect(r.output_tax_minor).toBe(Math.round((320_000 + 150_000 + 410_000 + 275_000) * 100 * 0.18));
  });

  it('aging lists every open item with its bucket', async () => {
    const r = await read('ledger.report.aging', { kind: 'receivable', as_of: '2026-09-30' });
    expect(r.items.map((i: any) => i.number).sort()).toEqual(['INV-0002', 'INV-0003', 'INV-0004']);
    const sum = Object.values(r.buckets as Record<string, number>).reduce((s, x) => s + x, 0);
    expect(sum).toBe(r.total_outstanding_minor);
  });
});
