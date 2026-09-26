import { conformance } from '@neop/testkit';
import { ledgerUnderTest } from './harness.ts';

conformance({
  app: ledgerUnderTest,
  reads: {
    'ledger.report.pnl': { from: '2026-07-01', to: '2026-09-30' },
    'ledger.report.balance_sheet': { as_of: '2026-09-30' },
    'ledger.report.cash_flow': { from: '2026-07-01', to: '2026-09-30' },
    'ledger.report.trial_balance': { as_of: '2026-09-30' },
    'ledger.report.aging': { kind: 'receivable', as_of: '2026-09-30' },
    'ledger.report.vat_summary': { from: '2026-07-01', to: '2026-09-30' },
    'ledger.budget.remaining': { account_code: '6400', month: '2026-09' },
    'ledger.accounts.list': { as_of: '2026-09-30' },
    'ledger.account.ledger': { account_code: '1010', from: '2026-09-01', to: '2026-09-30' },
    'ledger.journal.list': { from: '2026-09-01', to: '2026-09-30' },
    'ledger.documents.list': { kind: 'invoice', status: 'all' },
    'ledger.parties.list': {},
    'ledger.bank.unreconciled': {},
    'ledger.periods.status': {},
    'ledger.coding_rules.list': {},
  },
  gatedWrite: {
    key: 'ledger.journal.post',
    args: { date: '2026-09-30', memo: 'Conformance accrual', currency: 'INR', lines: [{ account_code: '6300', debit_minor: 1000, credit_minor: 0 }, { account_code: '2000', debit_minor: 0, credit_minor: 1000 }] },
  },
});
