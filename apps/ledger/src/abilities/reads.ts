// Read abilities: one handler per manifest line. Every result carries
// generatedAt, its currency, whether it is empty, and the entries it came from.

import type { ReadAbility, ReadCtx } from '@neop/template';
import * as repo from '../data/ledger.repo.ts';
import * as R from '../domain/reports.ts';

export const DEFAULT_CURRENCY = 'INR';

function head(currency: string, sources: R.Sources) {
  return { generatedAt: new Date().toISOString(), currency, sources, empty: sources.entries === 0 };
}

export const pnl: ReadAbility = {
  kind: 'read',
  async run(a: { from: string; to: string; currency?: string }, ctx: ReadCtx) {
    const cur = a.currency ?? DEFAULT_CURRENCY;
    const q = { from: a.from, to: a.to, currency: cur };
    const accts = await repo.accountTotals(ctx.db, q);
    const src = await repo.entrySources(ctx.db, q, `journal entries dated ${a.from}..${a.to}`);
    return { ...head(cur, src), period: { from: a.from, to: a.to }, ...R.profitAndLoss(accts) };
  },
};

export const balanceSheet: ReadAbility = {
  kind: 'read',
  async run(a: { as_of: string; currency?: string }, ctx: ReadCtx) {
    const cur = a.currency ?? DEFAULT_CURRENCY;
    const q = { from: null, to: a.as_of, currency: cur };
    const accts = await repo.accountTotals(ctx.db, q);
    const src = await repo.entrySources(ctx.db, q, `all journal entries up to ${a.as_of}`);
    return { ...head(cur, src), as_of: a.as_of, ...R.balanceSheet(accts) };
  },
};

export const trialBalance: ReadAbility = {
  kind: 'read',
  async run(a: { as_of: string; currency?: string }, ctx: ReadCtx) {
    const cur = a.currency ?? DEFAULT_CURRENCY;
    const q = { from: null, to: a.as_of, currency: cur };
    const accts = await repo.accountTotals(ctx.db, q);
    const src = await repo.entrySources(ctx.db, q, `all journal entries up to ${a.as_of}`);
    return { ...head(cur, src), as_of: a.as_of, ...R.trialBalance(accts) };
  },
};

export const cashFlow: ReadAbility = {
  kind: 'read',
  async run(a: { from: string; to: string; currency?: string }, ctx: ReadCtx) {
    const cur = a.currency ?? DEFAULT_CURRENCY;
    const lines = await repo.cashLines(ctx.db, { from: a.from, to: a.to, currency: cur });
    const opening = await repo.cashBalanceBefore(ctx.db, { before: a.from, currency: cur });
    const src = await repo.entrySources(ctx.db, { from: a.from, to: a.to, currency: cur }, `journal entries touching cash or bank, ${a.from}..${a.to}`);
    return { ...head(cur, src), period: { from: a.from, to: a.to }, ...R.cashFlow(lines, opening) };
  },
};

export const aging: ReadAbility = {
  kind: 'read',
  async run(a: { kind: 'receivable' | 'payable'; as_of: string; currency?: string }, ctx: ReadCtx) {
    const cur = a.currency ?? DEFAULT_CURRENCY;
    const docs = await repo.openDocuments(ctx.db, { kind: a.kind === 'receivable' ? 'invoice' : 'bill', as_of: a.as_of, currency: cur });
    const sources: R.Sources = {
      entries: docs.length,
      entry_ids: docs.slice(0, 50).map((d) => d.id),
      basis: `open ${a.kind === 'receivable' ? 'customer invoices' : 'supplier bills'} issued on or before ${a.as_of}`,
    };
    return {
      ...head(cur, sources),
      kind: a.kind,
      as_of: a.as_of,
      ...R.aging(
        docs.map(({ id: _id, ...d }) => d),
        a.as_of,
      ),
    };
  },
};

export const budgetRemaining: ReadAbility = {
  kind: 'read',
  async run(a: { account_code: string; month: string; currency?: string }, ctx: ReadCtx) {
    const cur = a.currency ?? DEFAULT_CURRENCY;
    const r = await repo.budgetRemaining(ctx.db, { account_code: a.account_code, month: a.month, currency: cur });
    const sources: R.Sources = { entries: r?.entries ?? 0, entry_ids: r?.ids ?? [], basis: `entries on account ${a.account_code} in ${a.month}; budget table` };
    return {
      ...head(cur, sources),
      account_code: a.account_code,
      month: a.month,
      // No budget set is null, not zero: "unknown" is never presented as "nothing left".
      budget_minor: r?.budget ?? null,
      actual_minor: r?.actual ?? 0,
      remaining_minor: r?.budget == null ? null : r.budget - r.actual,
    };
  },
};

export const vatSummary: ReadAbility = {
  kind: 'read',
  async run(a: { from: string; to: string; currency?: string }, ctx: ReadCtx) {
    const cur = a.currency ?? DEFAULT_CURRENCY;
    const q = { from: a.from, to: a.to, currency: cur };
    const accts = await repo.accountTotals(ctx.db, q);
    const src = await repo.entrySources(ctx.db, q, `journal entries dated ${a.from}..${a.to}`);
    return { ...head(cur, src), period: { from: a.from, to: a.to }, ...R.taxSummary(accts) };
  },
};
