// THE WORK · bookkeeping inherited from the earlier Ledger (Shiv's
// src/domain/ledger/{receivables,cashflow,tax,books,profile}.mjs), translated to
// integer minor units and our chart (account type + subtype). Pure: no SQL, no
// HTTP, no model. See docs/INHERITED-FROM-SHIV.md for what came from where.

import { daysBetween } from './reports.ts';
import type { AccountTotal, AccountType } from './reports.ts';

// ── company profile ─────────────────────────────────────────────────────────

export type TaxRegime = 'IN_GST' | 'UK_VAT' | 'EU_VAT' | 'US_SALES_TAX' | 'none';

export interface Settings {
  tax_regime: TaxRegime;
  return_frequency: 'monthly' | 'quarterly';
  fiscal_year_start_month: number;
  aging_buckets: number[];
  forecast_weeks: number;
  min_cash_buffer_minor: number;
  chase_after_days: number;
}

export const DEFAULT_SETTINGS: Settings = {
  tax_regime: 'IN_GST',
  return_frequency: 'monthly',
  fiscal_year_start_month: 4,
  aging_buckets: [30, 60, 90],
  forecast_weeks: 13,
  min_cash_buffer_minor: 0,
  chase_after_days: 7,
};

/** Bucket labels and a classifier from the company's bucket bounds (days past due). */
export function bucketing(bounds: number[]) {
  const b = [...new Set(bounds.filter((x) => Number.isInteger(x) && x > 0))].sort((x, y) => x - y);
  const ub = b.length ? b : DEFAULT_SETTINGS.aging_buckets;
  const labels = ['Current'];
  for (let i = 0; i < ub.length; i++) labels.push(`${i === 0 ? 1 : ub[i - 1]! + 1}–${ub[i]}`);
  labels.push(`${ub[ub.length - 1]}+`);
  const of = (daysPastDue: number) => {
    if (daysPastDue <= 0) return labels[0]!;
    for (let i = 0; i < ub.length; i++) if (daysPastDue <= ub[i]!) return labels[i + 1]!;
    return labels[labels.length - 1]!;
  };
  return { labels, of };
}

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);

// ── aging analysis (receivables.mjs arAging / apAging) ──────────────────────

export interface AgingDoc {
  number: string;
  party: string;
  issue_date: string;
  due_date: string;
  total_minor: number;
  outstanding_minor: number;
  reminded_at: string | null;
}

export function agingAnalysis(
  kind: 'receivable' | 'payable',
  open: AgingDoc[],
  /** Everything issued in the trailing 90 days, paid or not (for days outstanding). */
  issued90Minor: number,
  asOf: string,
  s: Pick<Settings, 'aging_buckets' | 'chase_after_days'>,
  control: { account_code: string | null; balance_minor: number },
) {
  const { labels, of } = bucketing(s.aging_buckets);
  const bucketTotals = new Map(labels.map((l) => [l, 0]));
  const byParty = new Map<string, { party: string; total_minor: number; overdue_minor: number; buckets: Map<string, number> }>();
  let total = 0;
  let overdue = 0;
  let dueIn7 = 0;
  let dueIn14 = 0;
  const items = open
    .filter((d) => d.outstanding_minor > 0)
    .map((d) => {
      const days = daysBetween(d.due_date, asOf);
      const label = of(days);
      total += d.outstanding_minor;
      bucketTotals.set(label, bucketTotals.get(label)! + d.outstanding_minor);
      if (days > 0) overdue += d.outstanding_minor;
      else {
        if (-days <= 7) dueIn7 += d.outstanding_minor;
        if (-days <= 14) dueIn14 += d.outstanding_minor;
      }
      const p = byParty.get(d.party) ?? { party: d.party, total_minor: 0, overdue_minor: 0, buckets: new Map(labels.map((l) => [l, 0])) };
      p.total_minor += d.outstanding_minor;
      if (days > 0) p.overdue_minor += d.outstanding_minor;
      p.buckets.set(label, p.buckets.get(label)! + d.outstanding_minor);
      byParty.set(d.party, p);
      // Chase cadence (receivables): first reminder chase_after_days after the due date, then every chase_after_days.
      const nextChase =
        kind === 'receivable'
          ? d.reminded_at
            ? addDays(d.reminded_at.slice(0, 10), Math.max(1, s.chase_after_days))
            : addDays(d.due_date, s.chase_after_days)
          : null;
      return {
        number: d.number,
        party: d.party,
        issue_date: d.issue_date,
        due_date: d.due_date,
        outstanding_minor: d.outstanding_minor,
        days_past_due: Math.max(0, days),
        bucket: label,
        reminded_at: d.reminded_at,
        next_chase_due: nextChase,
      };
    });
  // Likely duplicates (payables): same supplier, same amount, issued within 3 days of each other.
  const possible_duplicates: { number: string; party: string; amount_minor: number; reason: string }[] = [];
  if (kind === 'payable') {
    const seen: AgingDoc[] = [];
    for (const d of [...open].sort((a, b) => a.issue_date.localeCompare(b.issue_date))) {
      const twin = seen.find((p) => p.party === d.party && p.total_minor === d.total_minor && Math.abs(daysBetween(p.issue_date, d.issue_date)) <= 3);
      if (twin) possible_duplicates.push({ number: d.number, party: d.party, amount_minor: d.total_minor, reason: `possible duplicate of ${twin.number}` });
      seen.push(d);
    }
  }
  return {
    labels,
    buckets: labels.map((l) => ({ label: l, amount_minor: bucketTotals.get(l)!, pct: total > 0 ? Math.round((bucketTotals.get(l)! * 100) / total) : 0 })),
    parties: [...byParty.values()]
      .sort((a, b) => b.total_minor - a.total_minor)
      .map((p) => ({ party: p.party, total_minor: p.total_minor, overdue_minor: p.overdue_minor, buckets: labels.map((l) => ({ label: l, amount_minor: p.buckets.get(l)! })) })),
    items,
    total_outstanding_minor: total,
    overdue_minor: overdue,
    due_in_7_minor: dueIn7,
    due_in_14_minor: dueIn14,
    // DSO / DPO = outstanding ÷ what was issued in the trailing 90 days × 90.
    days_outstanding: issued90Minor > 0 ? Math.round((total / issued90Minor) * 90) : null,
    possible_duplicates,
    control: { account_code: control.account_code, balance_minor: control.balance_minor, ties: control.balance_minor === total },
  };
}

// ── cash forecast (cashflow.mjs forecast) ───────────────────────────────────

export interface Expected {
  due_date: string;
  outstanding_minor: number;
}

export function cashForecast(openingCash: number, ar: Expected[], ap: Expected[], asOf: string, weeks: number, minBuffer: number) {
  let balance = openingCash;
  let runway: number | null = null;
  let lowest = openingCash;
  const rows = [];
  for (let w = 1; w <= weeks; w++) {
    const from = addDays(asOf, 7 * (w - 1));
    const to = addDays(asOf, 7 * w);
    // Week 1 also carries everything already overdue: it is still expected, just late.
    const inWeek = (x: Expected) => x.due_date <= to && (w === 1 || x.due_date > from);
    const inflow = ar.filter(inWeek).reduce((t, x) => t + x.outstanding_minor, 0);
    const outflow = ap.filter(inWeek).reduce((t, x) => t + x.outstanding_minor, 0);
    balance += inflow - outflow;
    lowest = Math.min(lowest, balance);
    if (runway === null && balance < minBuffer) runway = w;
    rows.push({ week: w, week_ending: to, inflow_minor: inflow, outflow_minor: outflow, net_minor: inflow - outflow, balance_minor: balance });
  }
  return { weeks: rows, closing_minor: balance, lowest_balance_minor: lowest, runway_week: runway, week_ending_below_buffer: runway === null ? null : rows[runway - 1]!.week_ending };
}

// ── tax return per regime (tax.mjs vatReturn) ───────────────────────────────

const TAX_NAME: Record<TaxRegime, string> = { IN_GST: 'GST', UK_VAT: 'VAT', EU_VAT: 'VAT', US_SALES_TAX: 'Sales tax', none: 'Tax' };

export function taxReturn(regime: TaxRegime, accts: AccountTotal[], to: string, frequency: 'monthly' | 'quarterly') {
  const sum = (f: (a: AccountTotal) => boolean, v: (a: AccountTotal) => number) => accts.filter(f).reduce((t, a) => t + v(a), 0);
  const output = sum((a) => a.subtype === 'tax_output', (a) => a.credit_minor - a.debit_minor);
  const inputBooked = sum((a) => a.subtype === 'tax_input', (a) => a.debit_minor - a.credit_minor);
  const sales = sum((a) => a.type === 'income', (a) => a.credit_minor - a.debit_minor);
  const purchases = sum((a) => a.type === 'expense', (a) => a.debit_minor - a.credit_minor);
  // US sales tax is charged on sales but is not reclaimable on purchases.
  const reclaim = regime === 'US_SALES_TAX' ? 0 : inputBooked;
  const net = output - reclaim;
  const name = TAX_NAME[regime];
  const boxes =
    regime === 'UK_VAT' || regime === 'EU_VAT'
      ? [
          { box: '1', label: 'VAT due on sales and other outputs', amount_minor: output },
          { box: '2', label: 'VAT due on acquisitions (NI)', amount_minor: 0 },
          { box: '3', label: 'Total VAT due', amount_minor: output },
          { box: '4', label: 'VAT reclaimed on purchases and other inputs', amount_minor: reclaim },
          { box: '5', label: 'Net VAT to pay (or reclaim)', amount_minor: net },
          { box: '6', label: 'Total value of sales excluding VAT', amount_minor: sales },
          { box: '7', label: 'Total value of purchases excluding VAT', amount_minor: purchases },
          { box: '8', label: 'Goods supplied to the EU (NI)', amount_minor: 0 },
          { box: '9', label: 'Goods acquired from the EU (NI)', amount_minor: 0 },
        ]
      : [
          { box: 'output', label: `Output ${name} on sales`, amount_minor: output },
          { box: 'input', label: reclaim || regime !== 'US_SALES_TAX' ? `Input ${name} credit on purchases` : `Input credit (not reclaimable under ${name})`, amount_minor: reclaim },
          { box: 'net', label: `Net ${name} payable`, amount_minor: net },
          { box: 'sales', label: 'Total sales (excl. tax)', amount_minor: sales },
          { box: 'purchases', label: 'Total purchases (excl. tax)', amount_minor: purchases },
        ];
  // Due dates: GSTR-3B the 20th of the next month; UK VAT one month and seven days after the period; others are not assumed.
  const [y, m] = to.split('-').map(Number) as [number, number];
  const nextMonth20 = new Date(Date.UTC(y, m, 20)).toISOString().slice(0, 10);
  const plus1m7 = new Date(Date.UTC(y, m + 1, 0) + 7 * 86_400_000).toISOString().slice(0, 10);
  const due = regime === 'IN_GST' ? nextMonth20 : regime === 'UK_VAT' ? plus1m7 : null;
  const blockers: string[] = [];
  if (regime === 'none') blockers.push('No tax regime is set; set it in the company settings (ledger.settings.update).');
  if (regime === 'UK_VAT' && frequency !== 'quarterly') blockers.push('UK VAT returns are normally quarterly; check the return frequency in the settings.');
  return { tax_name: name, boxes, output_tax_minor: output, input_tax_minor: reclaim, input_tax_booked_minor: inputBooked, net_payable_minor: net, sales_ex_tax_minor: sales, purchases_ex_tax_minor: purchases, due_date: due, blockers };
}

// ── chart authoring (books.mjs nextCatCode) ─────────────────────────────────

export const DEFAULT_SUBTYPE: Record<AccountType, string> = { asset: 'other_asset', liability: 'other_liability', equity: 'equity', income: 'revenue', expense: 'opex' };
const RANGE: Record<string, number> = { asset: 1000, liability: 2000, equity: 3000, income: 4000, cogs: 5000, expense: 6000 };

/**
 * The next free code in a type's range, stepping by 10 above the highest used,
 * then the first free slot from the bottom; never a code that is taken.
 */
export function nextAccountCode(used: string[], type: AccountType, subtype?: string): string | null {
  const base = RANGE[subtype === 'cogs' ? 'cogs' : type]!;
  const top = base + (type === 'expense' && subtype !== 'cogs' ? 3990 : 990);
  const taken = new Set(used);
  const inRange = used.map((c) => Number(c)).filter((n) => Number.isInteger(n) && n >= base && n <= top);
  for (let n = (inRange.length ? Math.max(...inRange) : base - 10) + 10; n <= top; n += 10) if (!taken.has(String(n))) return String(n);
  for (let n = base; n <= top; n += 10) if (!taken.has(String(n))) return String(n);
  return null;
}

// ── opening balances (writes/opening-balances.mjs) ──────────────────────────

/**
 * One balanced opening entry: each account on its natural side (a negative
 * amount flips it), and the difference to the equity account.
 */
export function openingEntry(balances: { account_code: string; type: AccountType; amount_minor: number }[], equityCode: string) {
  const lines: { account_code: string; debit_minor: number; credit_minor: number }[] = [];
  let dr = 0;
  let cr = 0;
  for (const b of balances) {
    if (!b.amount_minor) continue;
    const debitNormal = b.type === 'asset' || b.type === 'expense';
    const a = Math.abs(b.amount_minor);
    if (debitNormal === b.amount_minor > 0) {
      lines.push({ account_code: b.account_code, debit_minor: a, credit_minor: 0 });
      dr += a;
    } else {
      lines.push({ account_code: b.account_code, debit_minor: 0, credit_minor: a });
      cr += a;
    }
  }
  const diff = dr - cr;
  if (diff > 0) lines.push({ account_code: equityCode, debit_minor: 0, credit_minor: diff });
  if (diff < 0) lines.push({ account_code: equityCode, debit_minor: -diff, credit_minor: 0 });
  return { lines, opening_equity_minor: diff };
}

// ── exports (books.mjs reportMarkdown, close-pack.mjs CSV) ───────────────────

const money = (m: number) => (m / 100).toFixed(2);
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** Formula-looking cells are prefixed so a spreadsheet never runs text from the books as a formula. */
const safe = (v: unknown) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) && !/^-?\d/.test(v) ? `'${v}` : v);

export interface Table {
  columns: { key: string; label: string; money?: boolean }[];
  rows: Record<string, unknown>[];
}

export function tableToCsv(t: Table): string {
  return [t.columns.map((c) => csvCell(c.label)).join(','), ...t.rows.map((r) => t.columns.map((c) => csvCell(c.money ? money(Number(r[c.key] ?? 0)) : safe(r[c.key]))).join(','))].join('\n') + '\n';
}

export function tableToMarkdown(title: string, summary: [string, string][], t: Table): string {
  const esc = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    `# ${esc(title)}`,
    '',
    ...summary.map(([k, v]) => `- ${esc(k)}: ${esc(v)}`),
    '',
    `| ${t.columns.map((c) => esc(c.label)).join(' | ')} |`,
    `| ${t.columns.map((c) => (c.money ? '---:' : '---')).join(' | ')} |`,
    ...t.rows.map((r) => `| ${t.columns.map((c) => esc(c.money ? money(Number(r[c.key] ?? 0)) : r[c.key])).join(' | ')} |`),
    '',
    'Built from the posted books; every figure traces to journal entries.',
    '',
  ].join('\n');
}

export { money as minorToDecimal };
