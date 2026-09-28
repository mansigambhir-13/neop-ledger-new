// live-fixes.test · what testing Ledger live against the NEOS reasoning agent (NeuralChat, over Matrix) found,
// ported from Shivam's fixes (docs/INHERITED-FROM-SHIV.md, "Live-tested fixes"), each enforced in code:
//   · aging of a running period is measured to the company's today, never past it; a bill due today is due,
//     not overdue (38a5153);
//   · every job states the requester's open proposals — "none" plainly; the same change is never proposed
//     twice while one waits or is approved (7055884, 52c2472);
//   · a name that matches nothing is refused with the closest real names ("Did you mean …?"); a category named in
//     words is the one account whose name matches (4fa4f94, 7055884);
//   · a question for a write lists every required input still missing (0f51089);
//   · a manual posting to an account not in the chart is refused whole (1f1fb4d).
// All through the real pilot (platform + gateway + L3 + gate + runner) with a scripted brain.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRequiredFields } from '../../../packages/neop-template/src/gate/gate.ts';
import { accountByName, agedTo, closest, companyToday, type ChartAccount } from '../src/domain/names.ts';
import { bootPilot, call, finish, type BrainView, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => P?.close());

const TZ = 'Asia/Kolkata';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
const CARD = { what: 'bookkeeping step', why: 'asked', changes: 'the books', if_no_answer: 'nothing changes' };
const read = async (key: string, args: unknown = {}) => {
  const r = await P.api('POST', `/api/apps/ledger/read/${key}`, args);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(P.backend.core.validators.checkOutput(key, r.body.result)).toBeNull();
  return r.body.result;
};
const done = (taskId: string) => P.waitFor(async () => ['COMPLETED', 'FAILED'].includes((await P.task(taskId)).task.status), 'settled');

/**
 * One call in a job; returns what the gate said. A written proposal ends the session (the job waits), so a
 * proposal is seen as the card it raised on the desk.
 */
async function once(key: string, args: unknown): Promise<{ first: string; isError: boolean; task_id: string; job: string }> {
  let first: { text: string; isError: boolean } | null = null;
  let job = '';
  P.setBrain((v: BrainView) => {
    if (v.calls === 0) return ((job = v.job), call(key, args));
    first ??= v.results[0]!;
    return finish('reported what the gate said');
  });
  const t = await P.ask(`do: ${key}`);
  const got = await P.waitFor(async () => {
    if (first) return first;
    const card = (await P.desk()).find((c) => c.task_id === t.task_id && c.status === 'PENDING');
    return card ? { text: `Proposal ${card.id} is written`, isError: false } : null;
  }, `${key} answered`);
  return { first: got.text, isError: got.isError, task_id: t.task_id, job };
}

/** Approve the card a task raised, and wait for it to be carried out. */
async function approve(taskId: string) {
  const card = await P.waitFor(async () => (await P.desk()).find((c) => c.task_id === taskId && c.status === 'PENDING'), 'card');
  P.setBrain((v) => (v.job.includes('WOKEN') ? finish('done') : { text: 'waiting' }));
  expect((await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'yes', fingerprint_seen: card.fingerprint })).status).toBe(200);
  await done(taskId);
}

describe('pure helpers', () => {
  it("the company's today is its own (time zone), and an aging ahead of today is measured to today", () => {
    const now = new Date('2026-09-30T20:00:00Z'); // 1 Oct 01:30 in Kolkata
    expect(companyToday({ now, time_zone: 'Asia/Kolkata' })).toBe('2026-10-01');
    expect(companyToday({ now, time_zone: 'UTC' })).toBe('2026-09-30');
    expect(agedTo('2026-10-31', { now, time_zone: 'Asia/Kolkata' })).toBe('2026-10-01');
    expect(agedTo('2026-09-15', { now, time_zone: 'Asia/Kolkata' })).toBe('2026-09-15');
  });

  it('closest names: a mis-heard one finds the real one; nothing alike finds nothing', () => {
    const parties = ['Kaveri Dairy', 'Mehta Wholesale Supplies', 'CloudSoft India', 'Sharma Retail Pvt Ltd'];
    expect(closest('Caveriteri', parties, (x) => x)[0]).toBe('Kaveri Dairy');
    expect(closest('Kaveri Deri', parties, (x) => x)[0]).toBe('Kaveri Dairy');
    expect(closest('Mehta Wholsale', parties, (x) => x)[0]).toBe('Mehta Wholesale Supplies');
    expect(closest('Nobody Ltd', parties, (x) => x)).toEqual([]);
  });

  it('a category named in words is the ONE account whose name matches; none or several is no match', () => {
    const chart: ChartAccount[] = [
      ['1500', 'Office equipment', 'asset', 'fixed_asset'],
      ['6100', 'Office rent', 'expense', 'opex'],
      ['6200', 'Software subscriptions', 'expense', 'opex'],
      ['6500', 'Office supplies', 'expense', 'opex'],
    ].map(([code, name, type, subtype]) => ({ code: code!, name: name!, type: type!, subtype: subtype!, is_active: true }));
    expect(accountByName(chart, '6200')?.code).toBe('6200');
    expect(accountByName(chart, 'office supplies')?.code).toBe('6500');
    expect(accountByName(chart, 'Software subscription')?.code).toBe('6200');
    expect(accountByName(chart, 'office')).toBeNull(); // three offices: ask
    expect(accountByName(chart, 'travel')).toBeNull(); // none: ask
  });

  it('a question for a write gets every required input still missing, with plain labels, and none it has', () => {
    const input = {
      required: ['date', 'currency', 'description', 'amount_minor', 'gst_rate_bps', 'account_code'],
      properties: { date: { type: 'string', format: 'date' }, amount_minor: { type: 'integer' }, gst_rate_bps: { type: 'integer' }, account_code: { type: 'string' } },
    };
    const f = withRequiredFields([{ key: 'vendor', label: 'Supplier' }, { key: 'amount_minor', label: 'Amount before GST' }], input, { description: 'office supplies', currency: 'INR' }) as any[];
    expect(f.map((x) => x.key)).toEqual(['vendor', 'amount_minor', 'date', 'gst_rate_bps', 'account_code']);
    expect(f.find((x) => x.key === 'date')).toMatchObject({ label: 'Date (YYYY-MM-DD)', type: 'date', required: true });
    expect(f.find((x) => x.key === 'gst_rate_bps')).toMatchObject({ label: 'GST rate (basis points: 1800 is 18%)', type: 'number' });
    expect(f.find((x) => x.key === 'account_code')!.label).toBe('Account code');
  });
});

describe('every job states the requester’s open proposals (honesty)', () => {
  it('with none open, the job says NONE plainly — "drop that proposal" cannot be answered with a made-up decline', async () => {
    let seen = '';
    P.setBrain((v) => ((seen = v.job), finish('No proposal is open, so nothing changed.')));
    const t = await P.ask('Drop that proposal.');
    await done(t.task_id);
    expect(seen).toMatch(/Open proposals asked for by user:[0-9a-f-]+: NONE\. Nothing of theirs is waiting for a yes or no/);
    expect(seen).toContain('say plainly that no proposal is open and nothing changed');
  });

  it('with one open, the next job lists it (as data); the same change proposed again is refused while it waits', async () => {
    const bill = { vendor: 'CloudSoft India', number: 'CS-DUP-1', issue_date: '2026-09-20', due_date: '2026-10-20', currency: 'INR', gst_rate_bps: 1800, lines: [{ description: 'Hosting', amount_minor: 100_000, account_code: '6200' }] };
    const first = await once('ledger.bill.record', { ...bill, card: CARD });
    expect(first.first).toMatch(/Proposal .* is written/);
    const pending = await P.waitFor(async () => (await P.desk()).find((c) => c.task_id === first.task_id && c.status === 'PENDING'), 'card');
    const again = await once('ledger.bill.record', { ...bill, card: { ...CARD, what: 'approve CS-DUP-1' } });
    expect(again.job).toMatch(/Open proposals asked for by user:[0-9a-f-]+ \(waiting for a person's yes/);
    expect(again.job).toMatch(/<data source="open_proposals" trust="untrusted">[\s\S]*"what": "bookkeeping step"/);
    expect(again.isError).toBe(true);
    expect(again.first).toMatch(/Refused by the gate \(already_proposed\): this exact change is already waiting for a person's yes/);
    expect(again.first).toContain('do not prepare, offer or describe another approval of it');
    await done(again.task_id);
    expect((await P.desk()).filter((c) => c.status === 'PENDING' && c.task_id === again.task_id)).toEqual([]);
    expect(pending.status).toBe('PENDING');
    // Approved: still one; asking again is refused as already approved-or-done (here: done, so the books refuse it).
    await approve(first.task_id);
    const after = await once('ledger.bill.record', { ...bill, card: CARD });
    expect(after.first).toMatch(/not_possible.*bill CS-DUP-1 is already recorded/);
    await done(after.task_id);
  });
});

describe('aging a running period (38a5153)', () => {
  it('an aging asked to a future month end is measured to today; a bill due today is due within 7 days, not overdue', async () => {
    const t = today();
    const bill = { vendor: 'CloudSoft India', number: 'CS-TODAY', issue_date: addDays(t, -10), due_date: t, currency: 'INR', gst_rate_bps: 0, lines: [{ description: 'Due today', amount_minor: 777_700, account_code: '6200' }] };
    const r = await once('ledger.bill.record', { ...bill, card: CARD });
    expect(r.first).toMatch(/Proposal .* is written/);
    await approve(r.task_id);

    const monthEnd = addDays(`${t.slice(0, 7)}-01`, 40).slice(0, 7) + '-01'; // a date safely ahead of today
    const ap = await read('ledger.report.aging_analysis', { kind: 'payable', as_of: monthEnd });
    expect(ap.as_of).toBe(t);
    expect(ap.sources.basis).toContain(`aged to today, ${t}`);
    const mine = ap.items.find((i: any) => i.number === 'CS-TODAY');
    expect(mine).toMatchObject({ days_past_due: 0, bucket: 'Current' });
    expect(ap.overdue_minor).toBe(ap.items.filter((i: any) => i.days_past_due > 0).reduce((s: number, i: any) => s + i.outstanding_minor, 0));
    expect(ap.due_in_7_minor).toBeGreaterThanOrEqual(777_700);

    const simple = await read('ledger.report.aging', { kind: 'payable', as_of: monthEnd });
    expect(simple.as_of).toBe(t);
    expect(simple.items.find((i: any) => i.number === 'CS-TODAY')).toMatchObject({ days_past_due: 0, bucket: 'current' });
    // A date already past is left as asked.
    expect((await read('ledger.report.aging', { kind: 'payable', as_of: '2026-09-01' })).as_of).toBe('2026-09-01');

    // The documents list says the same, with totals to quote rather than add up.
    const docs = await read('ledger.documents.list', { kind: 'bill', as_of: monthEnd });
    expect(docs.as_of).toBe(t);
    expect(docs.documents.find((d: any) => d.number === 'CS-TODAY').overdue_days).toBe(0);
    expect(docs.totals.outstanding_minor).toBe(docs.documents.reduce((s: number, d: any) => s + d.outstanding_minor, 0));
    expect(docs.totals.overdue_minor).toBe(docs.documents.filter((d: any) => d.overdue_days > 0).reduce((s: number, d: any) => s + d.outstanding_minor, 0));
    expect(docs.totals.due_in_7_minor).toBeGreaterThanOrEqual(777_700);
  });
});

describe('names that match nothing: "Did you mean …?" (4fa4f94, 7055884)', () => {
  it('a mis-typed vendor is refused with the closest real vendor, as data, and nothing is proposed', async () => {
    const before = (await P.desk()).length;
    const r = await once('ledger.bill.record', {
      vendor: 'Mehta Wholsale Suppliers',
      number: 'MW-999',
      issue_date: '2026-09-20',
      due_date: '2026-10-20',
      currency: 'INR',
      gst_rate_bps: 1800,
      lines: [{ description: 'Stock', amount_minor: 100, account_code: '1200' }],
      card: CARD,
    });
    expect(r.first).toMatch(/Refused by the gate \(unknown_name\): no vendor called "Mehta Wholsale Suppliers"/);
    expect(r.first).toContain('Ask the person which one they meant (job_ask)');
    expect(r.first).toMatch(/<data source="books" trust="untrusted">[\s\S]*Mehta Wholesale Supplies[\s\S]*<\/data>/);
    await done(r.task_id);
    expect((await P.desk()).length).toBe(before);
  });

  it('a manual posting to an account that is not in the chart is refused whole, naming it and the closest accounts (1f1fb4d)', async () => {
    const before = (await P.desk()).length;
    const r = await once('ledger.journal.post', {
      date: '2026-09-20',
      memo: 'Rent correction',
      currency: 'INR',
      lines: [
        { account_code: '6150', debit_minor: 5_000, credit_minor: 0 },
        { account_code: '1010', debit_minor: 0, credit_minor: 5_000 },
      ],
      card: CARD,
    });
    expect(r.first).toMatch(/\(unknown_name\): no account "6150" in the chart of accounts\. Nothing was done/);
    expect(r.first).toMatch(/<data source="books"[\s\S]*6100 Office rent[\s\S]*<\/data>/);
    await done(r.task_id);
    expect((await P.desk()).length).toBe(before);
    const posted = await read('ledger.journal.list', { from: '2026-09-20', to: '2026-09-20', search: 'Rent correction' });
    expect(posted.entries).toEqual([]);
  });

  it('a category named in words is read from the chart: one match is used (the card binds the code); several are asked about', async () => {
    const ok = await once('ledger.expense.record', {
      date: '2026-09-21',
      currency: 'INR',
      description: 'Design tool licence',
      amount_minor: 50_000,
      gst_rate_bps: 1800,
      account_code: 'Software subscription',
      card: CARD,
    });
    expect(ok.first).toMatch(/Proposal .* is written/);
    const card = await P.waitFor(async () => (await P.desk()).find((c) => c.task_id === ok.task_id && c.status === 'PENDING'), 'card');
    const row = (await P.platform.db.query('select args from neos.v_desk_cards where id = $1', [card.id])).rows[0];
    expect(row.args.account_code).toBe('6200');
    P.setBrain((v) => (v.job.includes('WOKEN') ? finish('declined, nothing recorded') : { text: 'waiting' }));
    await P.api('POST', `/api/desk/${card.id}/answer`, { decision: 'no', fingerprint_seen: card.fingerprint });
    await done(ok.task_id);

    const several = await once('ledger.expense.record', { date: '2026-09-21', currency: 'INR', description: 'Chair', amount_minor: 50_000, gst_rate_bps: 1800, account_code: 'office', card: CARD });
    expect(several.first).toMatch(/\(unknown_name\): no expense category "office" in the chart of accounts/);
    expect(several.first).toMatch(/6100 Office rent[\s\S]*1500 Office equipment|1500 Office equipment[\s\S]*6100 Office rent/);
    await done(several.task_id);
  });
});

describe('a question for a change lists every required field (0f51089)', () => {
  it('job.ask with for_ability: the gate adds the required inputs the model left out, and none it already has', async () => {
    P.setBrain((v) =>
      v.calls === 0
        ? call('job.ask', {
            text: 'To record the office supplies expense, I need a few details.',
            why: 'An expense cannot be recorded without them.',
            fields: [{ key: 'vendor', label: 'Supplier name', required: false }],
            for_ability: 'ledger.expense.record',
            known: { description: 'office supplies', currency: 'INR' },
          })
        : { text: 'waiting' },
    );
    const t = await P.ask('Prepare an expense for office supplies');
    const q = await P.waitFor(async () => (await P.platform.db.query("select * from neos.questions where task_id = $1 and status = 'OPEN'", [t.task_id])).rows[0], 'question');
    expect(q.fields.map((f: any) => f.key)).toEqual(['vendor', 'date', 'amount_minor', 'gst_rate_bps', 'account_code']);
    expect(q.fields.find((f: any) => f.key === 'amount_minor')).toMatchObject({ label: 'Amount (in minor units: paise or cents)', type: 'number', required: true });
    expect(q.fields.find((f: any) => f.key === 'date')).toMatchObject({ type: 'date', required: true });

    // for_ability must be one of this job's write tools.
    let refused = '';
    P.setBrain((v) => (v.calls === 0 ? call('job.ask', { text: 'x?', why: 'y', fields: [], for_ability: 'ledger.report.pnl' }) : ((refused = v.results[0]!.text), finish('could not ask'))));
    const t2 = await P.ask('ask about a read');
    await done(t2.task_id);
    expect(refused).toMatch(/for_ability must name one of your write tools/);
  });
});
