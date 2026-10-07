// Read abilities: one handler per manifest line. Every result carries
// generatedAt, its currency, whether it is empty, and the entries it came from.

import type { ReadAbility, ReadCtx } from '@neop/template';
import * as repo from '../data/ledger.repo.ts';
import * as R from '../domain/reports.ts';
import { agedTo } from '../domain/names.ts';

export const DEFAULT_CURRENCY = 'INR';

/**
 * v3 S9 · a read the NEOS screens use is ONE SQL function the app declared in its migration file (read_<x>, registered
 * in ledger.declared_reads): the desk runs it through ledger.block_read(), and this handler runs the same function —
 * so a screen and the assistant always see one answer.
 */
function declared(fn: string): ReadAbility {
  return {
    kind: 'read',
    async run(a: unknown, ctx: ReadCtx) {
      return (await ctx.db.query<{ r: unknown }>(`select ledger.${fn}($1::jsonb) as r`, [JSON.stringify(a ?? {})])).rows[0]!.r;
    },
  };
}

function head(currency: string, sources: R.Sources) {
  return { generatedAt: new Date().toISOString(), currency, sources, empty: sources.entries === 0 };
}

export const pnl: ReadAbility = declared('read_pnl');

export const balanceSheet: ReadAbility = declared('read_balance_sheet');

export const trialBalance: ReadAbility = declared('read_trial_balance');

export const cashFlow: ReadAbility = declared('read_cash_flow');

export const aging: ReadAbility = declared('read_aging');

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

export const vatSummary: ReadAbility = declared('read_vat_summary');
