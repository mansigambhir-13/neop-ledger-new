// Pure domain: runs with nothing else alive.
import { describe, expect, it } from 'vitest';
import { aging, cashFlow, checkEntry, profitAndLoss, trialBalance, type AccountTotal } from '../src/domain/reports.ts';

const A = (code: string, type: AccountTotal['type'], subtype: string, d: number, c: number): AccountTotal => ({ code, name: code, type, subtype, debit_minor: d, credit_minor: c });

describe('reports domain', () => {
  it('profit and loss', () => {
    const r = profitAndLoss([A('4000', 'income', 'revenue', 0, 1000), A('5000', 'expense', 'cogs', 600, 0), A('6000', 'expense', 'opex', 100, 0)]);
    expect(r.totals).toMatchObject({ revenue_minor: 1000, cogs_minor: 600, gross_profit_minor: 400, net_profit_minor: 300 });
  });
  it('trial balance flags disagreement', () => {
    expect(trialBalance([A('1', 'asset', 'cash', 10, 0), A('2', 'income', 'revenue', 0, 9)]).balanced).toBe(false);
  });
  it('cash flow classes movements by counterpart', () => {
    const r = cashFlow(
      [
        { entry_id: 'e1', subtype: 'bank', type: 'asset', debit_minor: 500, credit_minor: 0 },
        { entry_id: 'e1', subtype: 'loan', type: 'liability', debit_minor: 0, credit_minor: 500 },
        { entry_id: 'e2', subtype: 'bank', type: 'asset', debit_minor: 0, credit_minor: 200 },
        { entry_id: 'e2', subtype: 'fixed_asset', type: 'asset', debit_minor: 200, credit_minor: 0 },
      ],
      100,
    );
    expect(r).toMatchObject({ financing_minor: 500, investing_minor: -200, operating_minor: 0, closing_cash_minor: 400 });
  });
  it('aging buckets by days past due', () => {
    const r = aging(
      [
        { number: 'a', party: 'p', due_date: '2026-10-01', outstanding_minor: 1 },
        { number: 'b', party: 'p', due_date: '2026-09-01', outstanding_minor: 2 },
        { number: 'c', party: 'p', due_date: '2026-05-01', outstanding_minor: 4 },
      ],
      '2026-09-30',
    );
    expect(r.buckets).toEqual({ current: 1, d1_30: 2, d31_60: 0, d61_90: 0, d90_plus: 4 });
  });
  it('entries must balance', () => {
    expect(checkEntry([{ account_code: 'a', debit_minor: 5, credit_minor: 0 }, { account_code: 'b', debit_minor: 0, credit_minor: 5 }])).toBeNull();
    expect(checkEntry([{ account_code: 'a', debit_minor: 5, credit_minor: 0 }, { account_code: 'b', debit_minor: 0, credit_minor: 4 }])).toMatch(/do not balance/);
    expect(checkEntry([{ account_code: 'a', debit_minor: 5, credit_minor: 5 }, { account_code: 'b', debit_minor: 0, credit_minor: 0 }])).toMatch(/exactly one/);
  });
});
