// THE WORK · bookkeeping rules, pure: invoices and bills with GST, receipts and
// payments, reversals, and bank-line suggestions. Amounts in minor units.

export interface EntryLine {
  account_code: string;
  debit_minor: number;
  credit_minor: number;
}

export interface ItemLine {
  description: string;
  amount_minor: number;
  account_code?: string;
}

export const ACCT = { bank: '1010', receivable: '1100', gstInput: '1300', payable: '2000', gstOutput: '2100', sales: '4000' } as const;

/** GST on a net amount at a rate in basis points (1800 = 18%), rounded half up to the paisa. */
export function gst(netMinor: number, rateBps: number): number {
  return Math.floor((netMinor * rateBps + 5_000) / 10_000);
}

function merge(lines: EntryLine[]): EntryLine[] {
  const by = new Map<string, EntryLine>();
  for (const l of lines) {
    const k = `${l.account_code}:${l.debit_minor > 0 ? 'd' : 'c'}`;
    const cur = by.get(k);
    if (cur) {
      cur.debit_minor += l.debit_minor;
      cur.credit_minor += l.credit_minor;
    } else by.set(k, { ...l });
  }
  return [...by.values()].filter((l) => l.debit_minor > 0 || l.credit_minor > 0);
}

/** Customer invoice: Dr receivable (total) / Cr revenue (net, per line account) / Cr GST output (tax). */
export function invoiceEntry(items: ItemLine[], rateBps: number) {
  const net = items.reduce((s, i) => s + i.amount_minor, 0);
  const tax = gst(net, rateBps);
  const lines = merge([
    { account_code: ACCT.receivable, debit_minor: net + tax, credit_minor: 0 },
    ...items.map((i) => ({ account_code: i.account_code ?? ACCT.sales, debit_minor: 0, credit_minor: i.amount_minor })),
    ...(tax ? [{ account_code: ACCT.gstOutput, debit_minor: 0, credit_minor: tax }] : []),
  ]);
  return { net, tax, total: net + tax, lines };
}

/** Supplier bill: Dr expense/asset (net, per line) / Dr GST input (tax) / Cr payable (total). */
export function billEntry(items: Required<ItemLine>[], rateBps: number) {
  const net = items.reduce((s, i) => s + i.amount_minor, 0);
  const tax = gst(net, rateBps);
  const lines = merge([
    ...items.map((i) => ({ account_code: i.account_code, debit_minor: i.amount_minor, credit_minor: 0 })),
    ...(tax ? [{ account_code: ACCT.gstInput, debit_minor: tax, credit_minor: 0 }] : []),
    { account_code: ACCT.payable, debit_minor: 0, credit_minor: net + tax },
  ]);
  return { net, tax, total: net + tax, lines };
}

/** Receipt against an invoice, or payment of a bill, through a bank account. */
export function settlementEntry(kind: 'invoice' | 'bill', amount: number, bank: string): EntryLine[] {
  return kind === 'invoice'
    ? [
        { account_code: bank, debit_minor: amount, credit_minor: 0 },
        { account_code: ACCT.receivable, debit_minor: 0, credit_minor: amount },
      ]
    : [
        { account_code: ACCT.payable, debit_minor: amount, credit_minor: 0 },
        { account_code: bank, debit_minor: 0, credit_minor: amount },
      ];
}

/** A bank line coded straight to an account (fees, subscriptions, interest). */
export function bankLineEntry(amountSigned: number, bank: string, account: string): EntryLine[] {
  const a = Math.abs(amountSigned);
  return amountSigned > 0
    ? [
        { account_code: bank, debit_minor: a, credit_minor: 0 },
        { account_code: account, debit_minor: 0, credit_minor: a },
      ]
    : [
        { account_code: account, debit_minor: a, credit_minor: 0 },
        { account_code: bank, debit_minor: 0, credit_minor: a },
      ];
}

export function reverse(lines: EntryLine[]): EntryLine[] {
  return lines.map((l) => ({ account_code: l.account_code, debit_minor: l.credit_minor, credit_minor: l.debit_minor }));
}

export interface Rule {
  pattern: string;
  account_code: string;
  direction: 'in' | 'out' | 'any';
  priority: number;
}

export interface OpenDocument {
  number: string;
  kind: 'invoice' | 'bill';
  party: string;
  outstanding_minor: number;
}

/** What a bank line probably is: a coding rule's account, and open documents it could settle. */
export function suggest(txn: { description: string; amount_minor: number }, rules: Rule[], docs: OpenDocument[]) {
  const text = txn.description.toLowerCase();
  const dir = txn.amount_minor > 0 ? 'in' : 'out';
  const rule = [...rules]
    .sort((a, b) => a.priority - b.priority)
    .find((r) => (r.direction === 'any' || r.direction === dir) && text.includes(r.pattern.toLowerCase()));
  const kind = dir === 'in' ? 'invoice' : 'bill';
  const amount = Math.abs(txn.amount_minor);
  const documents = docs
    .filter((d) => d.kind === kind)
    .map((d) => {
      let score = 0;
      if (text.includes(d.number.toLowerCase())) score += 2;
      if (d.outstanding_minor === amount) score += 2;
      if (d.party.split(/\s+/).some((w) => w.length > 3 && text.includes(w.toLowerCase()))) score += 1;
      return { ...d, score };
    })
    .filter((d) => d.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return { rule: rule ? { pattern: rule.pattern, account_code: rule.account_code } : null, documents };
}

export function monthStart(month: string): string {
  return `${month}-01`;
}
