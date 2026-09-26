// The books, day to day: customers and invoices, sending and chasing, receipts,
// bills and payments, bank import and reconciliation, reversals, month close
// and reopen — each through the gate, each write proven by read-back.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toolName } from '@neop/testkit';
import { bootPilot, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => P?.close());

// Relative to the real clock so "not yet overdue" stays true whenever this runs.
const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const CARD = { what: 'bookkeeping step', why: 'asked', changes: 'the books', if_no_answer: 'nothing changes' };
const read = async (key: string, args: unknown = {}) => {
  const r = await P.api('POST', `/api/apps/ledger/read/${key}`, args);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.result;
};

/** One ability call in a job. Ask-first calls are approved on the desk. Returns the tool's first result and the task. */
async function run(key: string, args: Record<string, unknown>, opts: { approve?: boolean } = {}) {
  let first = '';
  const ask = key.match(/\.(create|record|send|categorize|reverse|close|reopen|post|email|import)$/) && !['ledger.party.create'].includes(key);
  P.setBrain((v) => {
    if (v.job.includes('WOKEN')) return { tool: toolName('job.finish'), args: { outcome: 'done', summary: `${key} verified` } };
    if (v.calls === 0) return { tool: toolName(key), args: ask ? { ...args, card: CARD } : args };
    if (!first) first = v.results[0]!.text;
    return v.results.some((r) => r.text.includes('Proposal ')) ? { text: 'waiting' } : { tool: toolName('job.finish'), args: { outcome: 'done', summary: `${key} ok` } };
  });
  const t = await P.ask(`book: ${key}`);
  const outcome = await P.waitFor(async () => {
    const x = await P.task(t.task_id);
    if (['COMPLETED', 'FAILED'].includes(x.task.status)) return { task: x, card: null as any };
    const card = (await P.desk()).find((c) => c.task_id === t.task_id && c.status === 'PENDING');
    if (card && opts.approve !== false) {
      await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint });
      const done = await P.waitFor(async () => {
        const y = await P.task(t.task_id);
        return ['COMPLETED', 'FAILED'].includes(y.task.status) && y;
      }, `${key} done`);
      return { task: done, card };
    }
    return null;
  }, `${key}`);
  return { ...outcome, first, job: t.job_id };
}

describe('customers and invoices', () => {
  it('adds a customer (on), raises an invoice with GST (ask first), numbered after the history', async () => {
    const c = await run('ledger.party.create', { kind: 'customer', name: 'Diya Stores', email: 'accounts@diya.example', gstin: '27ABCDE1234F1Z5' });
    expect(c.card).toBeNull();
    const inv = await run('ledger.invoice.create', {
      customer: 'Diya Stores',
      issue_date: '2026-09-20',
      due_date: FUTURE,
      currency: 'INR',
      gst_rate_bps: 1800,
      lines: [
        { description: 'Festive hampers x 40', amount_minor: 16_000_000 },
        { description: 'Delivery', amount_minor: 400_000 },
      ],
    });
    expect(inv.card.args.lines).toHaveLength(2);
    expect(inv.task.task.status).toBe('COMPLETED');
    const docs = await read('ledger.documents.list', { kind: 'invoice', status: 'open', party: 'Diya' });
    expect(docs.documents).toEqual([expect.objectContaining({ number: 'INV-0005', total_minor: 19_352_000, paid_minor: 0 })]);
    const tb = await read('ledger.report.trial_balance', { as_of: '2026-09-30' });
    expect(tb.balanced).toBe(true);
  });

  it('refuses an invoice for an unknown customer before anyone is asked', async () => {
    const r = await run('ledger.invoice.create', { customer: 'Nobody Ltd', issue_date: '2026-09-20', due_date: '2026-10-05', currency: 'INR', gst_rate_bps: 1800, lines: [{ description: 'x', amount_minor: 100 }] });
    expect(r.card).toBeNull();
    expect(r.first).toMatch(/not_possible.*no customer called "Nobody Ltd"/);
  });

  it('emails the invoice and, once overdue, a reminder', async () => {
    const before = (await readdir(P.mailDir)).length;
    await run('ledger.invoice.send', { document_number: 'INV-0005' });
    const files = await readdir(P.mailDir);
    expect(files.length).toBe(before + 1);
    const mails = await Promise.all(files.map((f) => readFile(path.join(P.mailDir, f), 'utf8')));
    expect(mails.some((m) => m.includes('Invoice INV-0005') && m.includes('accounts@diya.example'))).toBe(true);
    const notOverdue = await run('ledger.reminder.send', { document_number: 'INV-0005' });
    expect(notOverdue.card).toBeNull();
    expect(notOverdue.first).toMatch(/INV-0005 is not overdue/);
    const overdue = await run('ledger.reminder.send', { document_number: 'INV-0003' }); // due 2026-09-17, part paid
    expect(overdue.card.ability_key).toBe('ledger.reminder.send');
    const all = await Promise.all((await readdir(P.mailDir)).map((f) => readFile(path.join(P.mailDir, f), 'utf8')));
    expect(all.some((m) => m.includes('Reminder: invoice INV-0003') && m.includes('accounts@sharmaretail.example'))).toBe(true);
  });

  it('records a part receipt; refuses more than is outstanding', async () => {
    const part = await run('ledger.payment.record', { kind: 'invoice', document_number: 'INV-0005', date: '2026-09-28', amount_minor: 10_000_000 });
    expect(part.task.task.status).toBe('COMPLETED');
    const d = (await read('ledger.documents.list', { kind: 'invoice', status: 'open', party: 'Diya' })).documents[0];
    expect(d).toMatchObject({ paid_minor: 10_000_000, outstanding_minor: 9_352_000, status: 'open' });
    const over = await run('ledger.payment.record', { kind: 'invoice', document_number: 'INV-0005', date: '2026-09-29', amount_minor: 10_000_000 });
    expect(over.card).toBeNull();
    expect(over.first).toMatch(/more than the ₹93,520.00 outstanding/);
  });
});

describe('bills', () => {
  it('records a supplier bill with GST input and pays it in full', async () => {
    await run('ledger.party.create', { kind: 'vendor', name: 'Swift Couriers', email: 'billing@swift.example' });
    await run('ledger.bill.record', {
      vendor: 'Swift Couriers',
      number: 'SC-7781',
      issue_date: '2026-09-18',
      due_date: '2026-10-18',
      currency: 'INR',
      gst_rate_bps: 1800,
      lines: [{ description: 'Courier September', amount_minor: 2_500_000, account_code: '6100' }],
    });
    const dup = await run('ledger.bill.record', { vendor: 'Swift Couriers', number: 'SC-7781', issue_date: '2026-09-18', due_date: '2026-10-18', currency: 'INR', gst_rate_bps: 1800, lines: [{ description: 'again', amount_minor: 1, account_code: '6100' }] });
    expect(dup.first).toMatch(/already recorded/);
    await run('ledger.payment.record', { kind: 'bill', document_number: 'SC-7781', date: '2026-09-25', amount_minor: 2_950_000 });
    const paid = (await read('ledger.documents.list', { kind: 'bill', status: 'paid', party: 'Swift' })).documents;
    expect(paid).toEqual([expect.objectContaining({ number: 'SC-7781', total_minor: 2_950_000, status: 'paid' })]);
  });
});

describe('bank reconciliation and month close', () => {
  it('a month with unreconciled bank lines cannot be closed', async () => {
    const r = await run('ledger.period.close', { month: '2026-09' });
    expect(r.card).toBeNull();
    expect(r.first).toMatch(/3 bank line\(s\) in 2026-09 are not reconciled/);
  });

  it('imports statement lines once (staging, on), with suggestions', async () => {
    const lines = [{ external_id: 'HDFC-0930-04', date: '2026-09-30', description: 'INTEREST CREDIT', amount_minor: 42_000 }];
    await run('ledger.bank.import', { bank_account_code: '1010', currency: 'INR', lines });
    await run('ledger.bank.import', { bank_account_code: '1010', currency: 'INR', lines }); // idempotent by the bank's id
    const u = await read('ledger.bank.unreconciled');
    expect(u.transactions).toHaveLength(4);
    const kapoor = u.transactions.find((t: any) => t.description.includes('KAPOOR'));
    expect(kapoor.suggestions.documents[0].number).toBe('INV-0002');
    expect(u.transactions.find((t: any) => t.description.includes('AWS')).suggestions.rule.account_code).toBe('6200');
  });

  it('matches a receipt to its invoice and codes the rest; teaches a rule', async () => {
    const u = (await read('ledger.bank.unreconciled')).transactions;
    const id = (s: string) => u.find((t: any) => t.description.includes(s)).id;
    await run('ledger.payment.record', { kind: 'invoice', document_number: 'INV-0002', date: '2026-09-26', amount_minor: 17_700_000, bank_transaction_id: id('KAPOOR') });
    await run('ledger.bank.categorize', { bank_transaction_id: id('AWS'), account_code: '6200' });
    await run('ledger.bank.categorize', { bank_transaction_id: id('SMS'), account_code: '6300' });
    await run('ledger.coding_rule.add', { pattern: 'INTEREST', account_code: '4100', direction: 'in' });
    const rest = (await read('ledger.bank.unreconciled')).transactions;
    expect(rest).toHaveLength(1);
    expect(rest[0].suggestions.rule.account_code).toBe('4100');
    await run('ledger.bank.categorize', { bank_transaction_id: rest[0].id, account_code: '4100' });
    expect((await read('ledger.bank.unreconciled')).transactions).toEqual([]);
    const inv2 = (await read('ledger.documents.list', { kind: 'invoice', status: 'paid' })).documents.map((d: any) => d.number);
    expect(inv2).toContain('INV-0002');
  });

  it('closes September; nothing more can be posted into it until it is reopened with a reason', async () => {
    const c = await run('ledger.period.close', { month: '2026-09', reason: 'September close' });
    expect(c.task.task.status).toBe('COMPLETED');
    expect((await read('ledger.periods.status')).closed.map((x: any) => x.month)).toEqual(['2026-09']);
    const blocked = await run('ledger.journal.post', {
      date: '2026-09-30',
      memo: 'late accrual',
      currency: 'INR',
      lines: [
        { account_code: '6300', debit_minor: 100, credit_minor: 0 },
        { account_code: '2000', debit_minor: 0, credit_minor: 100 },
      ],
    });
    expect(blocked.card).toBeNull();
    expect(blocked.first).toMatch(/2026-09 is closed/);
    const noReason = await run('ledger.period.reopen', { month: '2026-09', reason: '' });
    expect(noReason.card).toBeNull();
    await run('ledger.period.reopen', { month: '2026-09', reason: 'auditor adjustment' });
    expect((await read('ledger.periods.status')).closed).toEqual([]);
  });
});

describe('corrections and the chart', () => {
  it('reverses an entry once, linked to the original; the books still balance', async () => {
    const e = (await read('ledger.journal.list', { from: '2026-09-30', to: '2026-09-30', search: 'Interest on sweep' })).entries[0];
    await run('ledger.entry.reverse', { entry: e.id, date: '2026-09-30', memo: 'Interest booked twice' });
    const after = (await read('ledger.journal.list', { from: '2026-09-30', to: '2026-09-30', search: 'Interest booked twice' })).entries[0];
    expect(after.reverses).toBe(e.id);
    const again = await run('ledger.entry.reverse', { entry: e.id, date: '2026-09-30' });
    expect(again.first).toMatch(/already reversed/);
    expect((await read('ledger.report.trial_balance', { as_of: '2026-09-30' })).balanced).toBe(true);
  });

  it('adds an account; its ledger reads back with a running balance', async () => {
    const bad = await run('ledger.account.create', { code: '6500', name: 'Travel', type: 'expense', subtype: 'bank' });
    expect(bad.first).toMatch(/subtype is one of/);
    await run('ledger.account.create', { code: '6500', name: 'Travel', type: 'expense', subtype: 'opex' });
    expect((await read('ledger.accounts.list', { type: 'expense' })).accounts.map((a: any) => a.code)).toContain('6500');
    const bank = await read('ledger.account.ledger', { account_code: '1010', from: '2026-09-01', to: '2026-09-30' });
    const last = bank.rows.at(-1);
    expect(last.balance_minor).toBe(bank.closing_minor);
    expect(bank.opening_minor + bank.rows.reduce((s: number, r: any) => s + r.debit_minor - r.credit_minor, 0)).toBe(bank.closing_minor);
  });
});
