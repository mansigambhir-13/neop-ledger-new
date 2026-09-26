// Write abilities. Both floors are ask-first: the gate turns a call into a
// proposal; these handlers run only on the approved path, with a stable
// idempotency key, and prove themselves by reading back.

import { DoorError, type ExecCtx, type WriteAbility } from '@neop/template';
import * as repo from '../data/ledger.repo.ts';
import { isLocked } from '../data/books.repo.ts';
import { checkEntry } from '../domain/reports.ts';
import { aging, balanceSheet, cashFlow, pnl, trialBalance, vatSummary } from './reads.ts';

type JournalArgs = { date: string; memo: string; currency: string; lines: { account_code: string; debit_minor: number; credit_minor: number }[] };

export const journalPost: WriteAbility = {
  kind: 'write',
  measure: (a: JournalArgs) => ({ amount_minor: a.lines.reduce((s, l) => s + l.debit_minor, 0), currency: a.currency }),
  check: (a: JournalArgs) => checkEntry(a.lines),
  async validate(a: JournalArgs, ctx) {
    const codes = [...new Set(a.lines.map((l) => l.account_code))];
    const found = await repo.accountIdsByCode(ctx.db, codes);
    const missing = codes.filter((c) => !found.has(c));
    if (missing.length) return `unknown account codes: ${missing.join(', ')}`;
    return (await isLocked(ctx.db, a.date)) ? `${a.date.slice(0, 7)} is closed; post into an open month or reopen it first` : null;
  },
  async execute(a: JournalArgs, ctx: ExecCtx) {
    return ctx.withDb(async (db) => {
      const ids = await repo.accountIdsByCode(db, a.lines.map((l) => l.account_code));
      const missing = a.lines.filter((l) => !ids.has(l.account_code)).map((l) => l.account_code);
      if (missing.length) throw new DoorError(`unknown account codes: ${[...new Set(missing)].join(', ')}`, { definite: true });
      const r = await repo.insertEntry(db, {
        company_id: ctx.company_id,
        date: a.date,
        memo: a.memo,
        reference: ctx.idempotencyKey,
        currency: a.currency,
        source: 'assistant',
        job_id: ctx.job_id,
        lines: a.lines.map((l) => ({ account_id: ids.get(l.account_code)!, debit_minor: l.debit_minor, credit_minor: l.credit_minor })),
      });
      return { external_ref: r.id, detail: { created: r.created } };
    });
  },
  async readBack(_a: JournalArgs, ctx: ExecCtx) {
    const e = await ctx.withDb((db) => repo.entryByReference(db, ctx.idempotencyKey));
    return { found: !!e, data: e };
  },
};

type PackArgs = { period: { from: string; to: string }; to: string[]; note?: string };

function fmt(minor: number): string {
  return (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const closePackEmail: WriteAbility = {
  kind: 'write',
  measure: (a: PackArgs) => ({ recipients: a.to }),
  check: (a: PackArgs) => (a.period.from > a.period.to ? 'period.from is after period.to' : null),
  async execute(a: PackArgs, ctx: ExecCtx) {
    const { from, to } = a.period;
    const pack = await ctx.withDb(async (db) => {
      const rc = { company_id: ctx.company_id, caller: ctx.caller, job_id: ctx.job_id, now: ctx.now, db };
      return {
        pnl: (await pnl.run({ from, to }, rc)) as any,
        balance_sheet: (await balanceSheet.run({ as_of: to }, rc)) as any,
        cash_flow: (await cashFlow.run({ from, to }, rc)) as any,
        trial_balance: (await trialBalance.run({ as_of: to }, rc)) as any,
        receivables: (await aging.run({ kind: 'receivable', as_of: to }, rc)) as any,
        payables: (await aging.run({ kind: 'payable', as_of: to }, rc)) as any,
        tax: (await vatSummary.run({ from, to }, rc)) as any,
      };
    });
    const tbCsv = ['code,name,debit,credit', ...pack.trial_balance.rows.map((r: any) => `${r.code},"${r.name}",${fmt(r.debit_minor)},${fmt(r.credit_minor)}`)].join('\n');
    const text = [
      `Close pack for ${from} to ${to} (${pack.pnl.currency})`,
      a.note ? `\n${a.note}\n` : '',
      `Net profit: ${fmt(pack.pnl.totals.net_profit_minor)}`,
      `Revenue: ${fmt(pack.pnl.totals.revenue_minor)} · Gross profit: ${fmt(pack.pnl.totals.gross_profit_minor)}`,
      `Closing cash: ${fmt(pack.cash_flow.closing_cash_minor)}`,
      `Receivables outstanding: ${fmt(pack.receivables.total_outstanding_minor)} · Payables outstanding: ${fmt(pack.payables.total_outstanding_minor)}`,
      `Tax payable (net): ${fmt(pack.tax.net_payable_minor)}`,
      `Trial balance ${pack.trial_balance.balanced ? 'agrees' : 'DOES NOT agree'}; balance sheet ${pack.balance_sheet.balanced ? 'balances' : 'DOES NOT balance'}.`,
      `\nBuilt from ${pack.trial_balance.sources.entries} journal entries. Generated ${new Date().toISOString()}.`,
    ].join('\n');
    const sent = await ctx.doors.email.send(
      {
        to: a.to,
        subject: `Close pack ${from} – ${to}`,
        text,
        attachments: [
          { filename: 'close-pack.json', content: JSON.stringify(pack, null, 2), contentType: 'application/json' },
          { filename: 'trial-balance.csv', content: tbCsv, contentType: 'text/csv' },
        ],
      },
      ctx.idempotencyKey,
    );
    return { external_ref: sent.id };
  },
  async readBack(a: PackArgs, ctx: ExecCtx) {
    const m = await ctx.doors.email.lookup(ctx.idempotencyKey);
    const ok = !!m && m.to.length === a.to.length && m.to.every((x, i) => x === a.to[i]);
    return { found: ok, data: m ? { id: m.id, to: m.to, subject: m.subject, sent_at: m.sent_at } : null };
  },
};
