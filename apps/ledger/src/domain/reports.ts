// THE WORK · pure report logic: no HTTP, no SQL, no model. Runs in a unit test
// with nothing else alive. Amounts are integers in minor units.

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface AccountTotal {
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  debit_minor: number;
  credit_minor: number;
}

export interface Sources {
  entries: number;
  entry_ids: string[];
  basis: string;
}

export interface ReportLine {
  code: string;
  name: string;
  subtype: string;
  amount_minor: number;
}

/** Natural-side balance: debit-normal for assets and expenses, credit-normal otherwise. */
export function natural(a: AccountTotal): number {
  return a.type === 'asset' || a.type === 'expense' ? a.debit_minor - a.credit_minor : a.credit_minor - a.debit_minor;
}

const line = (a: AccountTotal): ReportLine => ({ code: a.code, name: a.name, subtype: a.subtype, amount_minor: natural(a) });
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const nonZero = (a: AccountTotal) => a.debit_minor !== 0 || a.credit_minor !== 0;

export function profitAndLoss(accts: AccountTotal[]) {
  const income = accts.filter((a) => a.type === 'income' && nonZero(a)).map(line);
  const expenses = accts.filter((a) => a.type === 'expense' && nonZero(a)).map(line);
  const revenue = sum(income.filter((l) => l.subtype === 'revenue').map((l) => l.amount_minor));
  const cogs = sum(expenses.filter((l) => l.subtype === 'cogs').map((l) => l.amount_minor));
  const inc = sum(income.map((l) => l.amount_minor));
  const exp = sum(expenses.map((l) => l.amount_minor));
  return {
    income,
    expenses,
    totals: {
      revenue_minor: revenue,
      cogs_minor: cogs,
      gross_profit_minor: revenue - cogs,
      income_minor: inc,
      expenses_minor: exp,
      net_profit_minor: inc - exp,
    },
  };
}

export function balanceSheet(accts: AccountTotal[]) {
  const assets = accts.filter((a) => a.type === 'asset' && nonZero(a)).map(line);
  const liabilities = accts.filter((a) => a.type === 'liability' && nonZero(a)).map(line);
  const equity = accts.filter((a) => a.type === 'equity' && nonZero(a)).map(line);
  const earnings = sum(accts.filter((a) => a.type === 'income').map(natural)) - sum(accts.filter((a) => a.type === 'expense').map(natural));
  const A = sum(assets.map((l) => l.amount_minor));
  const L = sum(liabilities.map((l) => l.amount_minor));
  const E = sum(equity.map((l) => l.amount_minor));
  return {
    assets,
    liabilities,
    equity,
    totals: { assets_minor: A, liabilities_minor: L, equity_minor: E, earnings_to_date_minor: earnings },
    balanced: A === L + E + earnings,
  };
}

export function trialBalance(accts: AccountTotal[]) {
  const rows = accts
    .filter(nonZero)
    .map((a) => ({ code: a.code, name: a.name, type: a.type, debit_minor: a.debit_minor, credit_minor: a.credit_minor, balance_minor: a.debit_minor - a.credit_minor }));
  const d = sum(rows.map((r) => r.debit_minor));
  const c = sum(rows.map((r) => r.credit_minor));
  return { rows, total_debit_minor: d, total_credit_minor: c, balanced: d === c };
}

export interface CashLine {
  entry_id: string;
  subtype: string;
  type: AccountType;
  debit_minor: number;
  credit_minor: number;
}

const CASH = ['cash', 'bank'];
const INVESTING = ['fixed_asset'];
const FINANCING = ['loan', 'equity', 'retained_earnings'];

/** Direct method: each entry's net cash movement is classed by its largest non-cash counterpart. */
export function cashFlow(lines: CashLine[], openingCash: number) {
  const byEntry = new Map<string, CashLine[]>();
  for (const l of lines) byEntry.set(l.entry_id, [...(byEntry.get(l.entry_id) ?? []), l]);
  let operating = 0;
  let investing = 0;
  let financing = 0;
  for (const ls of byEntry.values()) {
    const cash = ls.filter((l) => CASH.includes(l.subtype));
    if (!cash.length) continue;
    const net = sum(cash.map((l) => l.debit_minor - l.credit_minor));
    const others = ls.filter((l) => !CASH.includes(l.subtype)).sort((a, b) => b.debit_minor + b.credit_minor - (a.debit_minor + a.credit_minor));
    const main = others[0];
    if (!main) continue; // cash-to-cash transfer
    if (INVESTING.includes(main.subtype)) investing += net;
    else if (FINANCING.includes(main.subtype)) financing += net;
    else operating += net;
  }
  return {
    opening_cash_minor: openingCash,
    operating_minor: operating,
    investing_minor: investing,
    financing_minor: financing,
    closing_cash_minor: openingCash + operating + investing + financing,
  };
}

export interface OpenDoc {
  number: string;
  party: string;
  due_date: string;
  outstanding_minor: number;
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso + 'T00:00:00Z') - Date.parse(fromIso + 'T00:00:00Z')) / 86_400_000);
}

export function aging(docs: OpenDoc[], asOf: string) {
  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  const items = docs.map((d) => {
    const days = daysBetween(d.due_date, asOf);
    const bucket = days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90_plus';
    buckets[bucket] += d.outstanding_minor;
    return { ...d, days_past_due: Math.max(days, 0), bucket };
  });
  return { buckets, items, total_outstanding_minor: sum(docs.map((d) => d.outstanding_minor)) };
}

export function taxSummary(accts: AccountTotal[]) {
  const output = sum(accts.filter((a) => a.subtype === 'tax_output').map((a) => a.credit_minor - a.debit_minor));
  const input = sum(accts.filter((a) => a.subtype === 'tax_input').map((a) => a.debit_minor - a.credit_minor));
  return { output_tax_minor: output, input_tax_minor: input, net_payable_minor: output - input };
}

/** A journal entry that can be posted: balanced, at least two lines, one side per line. */
export function checkEntry(lines: { account_code: string; debit_minor: number; credit_minor: number }[]): string | null {
  if (lines.length < 2) return 'an entry needs at least two lines';
  for (const [i, l] of lines.entries()) {
    if ((l.debit_minor === 0) === (l.credit_minor === 0)) return `line ${i + 1}: exactly one of debit or credit must be non-zero`;
  }
  const d = sum(lines.map((l) => l.debit_minor));
  const c = sum(lines.map((l) => l.credit_minor));
  if (d !== c) return `debits (${d}) and credits (${c}) do not balance`;
  return null;
}
