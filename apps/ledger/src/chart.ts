// A starter chart of accounts for a new company (a small Indian business, GST): what a company that has
// just installed Ledger needs before it can record anything. No transactions, no parties — its own books start
// empty. The codes Ledger's bookkeeping relies on (domain/bookkeeping.ts ACCT) are kept; everything else is a
// usual Indian SME account an admin can rename or extend. Idempotent: existing codes are never changed.
import { withCompany, type Pool } from '@neop/pgkit';

export const STARTER_CHART_IN_SME: readonly [code: string, name: string, type: string, subtype: string][] = [
  ['1000', 'Cash in hand', 'asset', 'cash'],
  ['1010', 'Bank current account', 'asset', 'bank'],
  ['1100', 'Accounts receivable', 'asset', 'receivable'],
  ['1200', 'Inventory', 'asset', 'inventory'],
  ['1300', 'GST input credit', 'asset', 'tax_input'],
  ['1400', 'TDS receivable', 'asset', 'other_asset'],
  ['1500', 'Office equipment', 'asset', 'fixed_asset'],
  ['1510', 'Furniture and fixtures', 'asset', 'fixed_asset'],
  ['1520', 'Computers', 'asset', 'fixed_asset'],
  ['1600', 'Security deposits', 'asset', 'other_asset'],
  ['2000', 'Accounts payable', 'liability', 'payable'],
  ['2100', 'GST output payable', 'liability', 'tax_output'],
  ['2200', 'TDS payable', 'liability', 'other_liability'],
  ['2300', 'Salaries payable', 'liability', 'other_liability'],
  ['2500', 'Bank term loan', 'liability', 'loan'],
  ['3000', "Owners' capital", 'equity', 'equity'],
  ['3100', 'Retained earnings', 'equity', 'retained_earnings'],
  ['4000', 'Sales', 'income', 'revenue'],
  ['4010', 'Service income', 'income', 'revenue'],
  ['4100', 'Interest income', 'income', 'other_income'],
  ['4200', 'Other income', 'income', 'other_income'],
  ['5000', 'Cost of goods sold', 'expense', 'cogs'],
  ['5100', 'Freight inward', 'expense', 'cogs'],
  ['6000', 'Salaries and wages', 'expense', 'opex'],
  ['6100', 'Rent', 'expense', 'opex'],
  ['6200', 'Software subscriptions', 'expense', 'opex'],
  ['6300', 'Bank charges', 'expense', 'other_expense'],
  ['6400', 'Marketing and advertising', 'expense', 'opex'],
  ['6500', 'Office supplies', 'expense', 'opex'],
  ['6600', 'Travel and conveyance', 'expense', 'opex'],
  ['6700', 'Electricity and utilities', 'expense', 'opex'],
  ['6800', 'Professional fees', 'expense', 'opex'],
  ['6900', 'Repairs and maintenance', 'expense', 'opex'],
  ['7000', 'Telephone and internet', 'expense', 'opex'],
  ['7100', 'Insurance', 'expense', 'opex'],
  ['7200', 'Printing and stationery', 'expense', 'opex'],
  ['7300', 'Depreciation', 'expense', 'other_expense'],
  ['7400', 'Interest expense', 'expense', 'other_expense'],
];

/** Adds every starter account the company does not have yet; returns how many were added. */
export async function applyStarterChart(pool: Pool, companyId: string): Promise<{ added: number; total: number }> {
  return withCompany(pool, companyId, async (c) => {
    let added = 0;
    for (const [code, name, type, subtype] of STARTER_CHART_IN_SME) {
      const r = await c.query(
        'insert into ledger.accounts (company_id, code, name, type, subtype) values ($1,$2,$3,$4,$5) on conflict (company_id, code) do nothing',
        [companyId, code, name, type, subtype],
      );
      added += r.rowCount ?? 0;
    }
    return { added, total: STARTER_CHART_IN_SME.length };
  });
}
