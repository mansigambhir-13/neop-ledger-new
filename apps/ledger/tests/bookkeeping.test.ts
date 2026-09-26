// Pure bookkeeping rules: GST, invoice and bill entries, settlements, reversals, suggestions.
import { describe, expect, it } from 'vitest';
import { bankLineEntry, billEntry, gst, invoiceEntry, reverse, settlementEntry, suggest } from '../src/domain/bookkeeping.ts';
import { checkEntry } from '../src/domain/reports.ts';

describe('bookkeeping domain', () => {
  it('GST rounds half up to the paisa', () => {
    expect(gst(10_000, 1800)).toBe(1_800);
    expect(gst(1, 1800)).toBe(0); // 0.18 paisa
    expect(gst(3, 1800)).toBe(1); // 0.54 → 1
    expect(gst(12_345, 500)).toBe(617); // 617.25
  });
  it('an invoice debits receivable with the total and credits revenue and GST', () => {
    const inv = invoiceEntry([{ description: 'A', amount_minor: 100_000 }, { description: 'B', amount_minor: 50_000, account_code: '4100' }], 1800);
    expect(inv).toMatchObject({ net: 150_000, tax: 27_000, total: 177_000 });
    expect(checkEntry(inv.lines)).toBeNull();
    expect(inv.lines).toContainEqual({ account_code: '1100', debit_minor: 177_000, credit_minor: 0 });
    expect(inv.lines).toContainEqual({ account_code: '2100', debit_minor: 0, credit_minor: 27_000 });
  });
  it('a bill merges lines per account and takes GST input', () => {
    const b = billEntry(
      [
        { description: 'x', amount_minor: 1_000, account_code: '6200' },
        { description: 'y', amount_minor: 2_000, account_code: '6200' },
      ],
      1800,
    );
    expect(b.lines).toEqual([
      { account_code: '6200', debit_minor: 3_000, credit_minor: 0 },
      { account_code: '1300', debit_minor: 540, credit_minor: 0 },
      { account_code: '2000', debit_minor: 0, credit_minor: 3_540 },
    ]);
  });
  it('settlements, bank lines and reversals balance', () => {
    for (const l of [settlementEntry('invoice', 500, '1010'), settlementEntry('bill', 500, '1010'), bankLineEntry(-118, '1010', '6300'), bankLineEntry(900, '1010', '4100')]) {
      expect(checkEntry(l)).toBeNull();
      expect(checkEntry(reverse(l))).toBeNull();
    }
    expect(reverse(settlementEntry('invoice', 500, '1010'))[0]).toEqual({ account_code: '1010', debit_minor: 0, credit_minor: 500 });
  });
  it('suggests a rule account and the documents a bank line could settle', () => {
    const s = suggest(
      { description: 'NEFT CR KAPOOR TRADERS INV-0002', amount_minor: 17_700_000 },
      [{ pattern: 'CHARGES', account_code: '6300', direction: 'out', priority: 100 }],
      [
        { number: 'INV-0002', kind: 'invoice', party: 'Kapoor Traders', outstanding_minor: 17_700_000 },
        { number: 'INV-0004', kind: 'invoice', party: 'Kapoor Traders', outstanding_minor: 32_450_000 },
        { number: 'MW-117', kind: 'bill', party: 'Mehta', outstanding_minor: 17_700_000 },
      ],
    );
    expect(s.rule).toBeNull();
    expect(s.documents.map((d) => d.number)).toEqual(['INV-0002']);
    expect(suggest({ description: 'SMS ALERT CHARGES', amount_minor: -11_800 }, [{ pattern: 'charges', account_code: '6300', direction: 'out', priority: 1 }], []).rule).toEqual({ pattern: 'charges', account_code: '6300' });
  });
});
