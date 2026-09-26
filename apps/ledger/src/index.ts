import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest } from '@neop/contracts';
import { loadAgentDir, type AppDefinition } from '@neop/template';
import * as reads from './abilities/reads.ts';
import { closePackEmail, journalPost } from './abilities/writes.ts';
import * as books from './abilities/books.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const LEDGER_ROOT = path.resolve(here, '..');
export const manifest = JSON.parse(readFileSync(path.join(LEDGER_ROOT, 'manifest.json'), 'utf8')) as Manifest;

export async function ledgerApp(): Promise<AppDefinition> {
  const { prompt, skills } = await loadAgentDir(path.join(here, 'agent'));
  return {
    manifest,
    migrationsDir: path.join(LEDGER_ROOT, 'migrations'),
    prompt,
    skills,
    abilities: {
      'ledger.report.pnl': reads.pnl,
      'ledger.report.balance_sheet': reads.balanceSheet,
      'ledger.report.cash_flow': reads.cashFlow,
      'ledger.report.trial_balance': reads.trialBalance,
      'ledger.report.aging': reads.aging,
      'ledger.report.vat_summary': reads.vatSummary,
      'ledger.budget.remaining': reads.budgetRemaining,
      'ledger.journal.post': journalPost,
      'ledger.close_pack.email': closePackEmail,
      'ledger.accounts.list': books.accountsList,
      'ledger.account.ledger': books.accountLedger,
      'ledger.journal.list': books.journalList,
      'ledger.documents.list': books.documentsList,
      'ledger.parties.list': books.partiesList,
      'ledger.bank.unreconciled': books.bankUnreconciled,
      'ledger.periods.status': books.periodsStatus,
      'ledger.coding_rules.list': books.codingRulesList,
      'ledger.invoice.create': books.invoiceCreate,
      'ledger.bill.record': books.billRecord,
      'ledger.payment.record': books.paymentRecord,
      'ledger.invoice.send': books.invoiceSend,
      'ledger.reminder.send': books.reminderSend,
      'ledger.bank.import': books.bankImport,
      'ledger.bank.categorize': books.bankCategorize,
      'ledger.coding_rule.add': books.codingRuleAdd,
      'ledger.entry.reverse': books.entryReverse,
      'ledger.period.close': books.periodClose,
      'ledger.period.reopen': books.periodReopen,
      'ledger.account.create': books.accountCreate,
      'ledger.party.create': books.partyCreate,
    },
  };
}

export { seedLedger } from './seed.ts';
