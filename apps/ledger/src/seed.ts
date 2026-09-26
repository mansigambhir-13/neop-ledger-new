// Deterministic demo books: a small Indian trading company, Jul–Sep 2026, INR, 18% GST.
import { withCompany, type Pool } from '@neop/pgkit';

const ACCOUNTS: [string, string, string, string][] = [
  ['1000', 'Cash in hand', 'asset', 'cash'],
  ['1010', 'HDFC current account', 'asset', 'bank'],
  ['1100', 'Accounts receivable', 'asset', 'receivable'],
  ['1200', 'Inventory', 'asset', 'inventory'],
  ['1300', 'GST input credit', 'asset', 'tax_input'],
  ['1500', 'Office equipment', 'asset', 'fixed_asset'],
  ['2000', 'Accounts payable', 'liability', 'payable'],
  ['2100', 'GST output payable', 'liability', 'tax_output'],
  ['2500', 'Bank term loan', 'liability', 'loan'],
  ['3000', "Owners' capital", 'equity', 'equity'],
  ['3100', 'Retained earnings', 'equity', 'retained_earnings'],
  ['4000', 'Sales', 'income', 'revenue'],
  ['4100', 'Interest income', 'income', 'other_income'],
  ['5000', 'Cost of goods sold', 'expense', 'cogs'],
  ['6000', 'Salaries', 'expense', 'opex'],
  ['6100', 'Office rent', 'expense', 'opex'],
  ['6200', 'Software subscriptions', 'expense', 'opex'],
  ['6300', 'Bank charges', 'expense', 'other_expense'],
  ['6400', 'Marketing and advertising', 'expense', 'opex'],
];

type L = [code: string, debit: number, credit: number];
const R = (rupees: number) => Math.round(rupees * 100);

export async function seedLedger(pool: Pool, companyId: string): Promise<{ entries: number }> {
  return withCompany(pool, companyId, async (c) => {
    const ids = new Map<string, string>();
    for (const [code, name, type, subtype] of ACCOUNTS) {
      const r = await c.query<{ id: string }>(
        `insert into ledger.accounts (company_id, code, name, type, subtype) values ($1,$2,$3,$4,$5)
         on conflict (company_id, code) do update set name = excluded.name returning id`,
        [companyId, code, name, type, subtype],
      );
      ids.set(code, r.rows[0]!.id);
    }
    const parties = new Map<string, string>();
    for (const [kind, name, email] of [
      ['customer', 'Sharma Retail Pvt Ltd', 'accounts@sharmaretail.example'],
      ['customer', 'Kapoor Traders', 'finance@kapoortraders.example'],
      ['vendor', 'Mehta Wholesale Supplies', 'billing@mehta.example'],
      ['vendor', 'CloudSoft India', 'invoices@cloudsoft.example'],
    ] as const) {
      const existing = await c.query<{ id: string }>('select id from ledger.parties where name = $1', [name]);
      const id = existing.rows[0]?.id ?? (await c.query<{ id: string }>('insert into ledger.parties (company_id, kind, name, email) values ($1,$2,$3,$4) returning id', [companyId, kind, name, email])).rows[0]!.id;
      parties.set(name, id);
    }
    let n = 0;
    const post = async (ref: string, date: string, memo: string, lines: L[]) => {
      const e = await c.query<{ id: string }>(
        `insert into ledger.journal_entries (company_id, entry_date, memo, reference, currency, source) values ($1,$2,$3,$4,'INR','seed')
         on conflict (company_id, reference) do nothing returning id`,
        [companyId, date, memo, `seed:${ref}`],
      );
      if (!e.rows[0]) return (await c.query<{ id: string }>('select id from ledger.journal_entries where reference = $1', [`seed:${ref}`])).rows[0]!.id;
      for (const [code, d, cr] of lines) {
        await c.query('insert into ledger.journal_lines (company_id, entry_id, account_id, debit_minor, credit_minor) values ($1,$2,$3,$4,$5)', [
          companyId,
          e.rows[0].id,
          ids.get(code),
          d,
          cr,
        ]);
      }
      n++;
      return e.rows[0].id;
    };
    const doc = async (kind: 'invoice' | 'bill', number: string, party: string, issue: string, due: string, net: number, paid: number, entryId: string) => {
      const tax = Math.round(net * 0.18);
      await c.query(
        `insert into ledger.documents (company_id, kind, party_id, number, issue_date, due_date, currency, net_minor, tax_minor, total_minor, paid_minor, status, entry_id)
         values ($1,$2,$3,$4,$5,$6,'INR',$7,$8,$9,$10,$11,$12) on conflict (company_id, kind, number) do nothing`,
        [companyId, kind, parties.get(party), number, issue, due, net, tax, net + tax, paid, paid >= net + tax ? 'paid' : 'open', entryId],
      );
    };
    const sale = async (no: string, party: string, date: string, due: string, netRs: number, costRs: number, paidRs: number) => {
      const net = R(netRs), tax = Math.round(net * 0.18);
      const id = await post(`inv-${no}`, date, `Invoice ${no} to ${party}`, [['1100', net + tax, 0], ['4000', 0, net], ['2100', 0, tax]]);
      await post(`cogs-${no}`, date, `Cost of goods for invoice ${no}`, [['5000', R(costRs), 0], ['1200', 0, R(costRs)]]);
      await doc('invoice', no, party, date, due, net, R(paidRs), id);
    };
    const purchase = async (no: string, party: string, date: string, due: string, netRs: number, account: string, paidRs: number) => {
      const net = R(netRs), tax = Math.round(net * 0.18);
      const id = await post(`bill-${no}`, date, `Bill ${no} from ${party}`, [[account, net, 0], ['1300', tax, 0], ['2000', 0, net + tax]]);
      await doc('bill', no, party, date, due, net, R(paidRs), id);
    };

    await post('capital', '2026-07-01', 'Owners introduce capital', [['1010', R(1_000_000), 0], ['3000', 0, R(1_000_000)]]);
    await post('loan', '2026-07-02', 'Term loan disbursed by HDFC', [['1010', R(500_000), 0], ['2500', 0, R(500_000)]]);
    await post('equipment', '2026-07-05', 'Laptops and printers', [['1500', R(240_000), 0], ['1010', 0, R(240_000)]]);
    await purchase('MW-101', 'Mehta Wholesale Supplies', '2026-07-06', '2026-08-05', 600_000, '1200', 708_000);
    await post('pay-MW-101', '2026-08-04', 'Paid Mehta Wholesale bill MW-101', [['2000', R(708_000), 0], ['1010', 0, R(708_000)]]);

    for (const [m, mm] of [['Jul', '07'], ['Aug', '08'], ['Sep', '09']] as const) {
      await post(`rent-${mm}`, `2026-${mm}-01`, `Office rent ${m}`, [['6100', R(45_000), 0], ['1010', 0, R(45_000)]]);
      await post(`salary-${mm}`, `2026-${mm}-28`, `Salaries ${m}`, [['6000', R(180_000), 0], ['1010', 0, R(180_000)]]);
      await post(`charges-${mm}`, `2026-${mm}-28`, `Bank charges ${m}`, [['6300', R(590), 0], ['1010', 0, R(590)]]);
    }
    await purchase('CS-2207', 'CloudSoft India', '2026-07-10', '2026-07-25', 12_000, '6200', 14_160);
    await post('pay-CS-2207', '2026-07-24', 'Paid CloudSoft CS-2207', [['2000', R(14_160), 0], ['1010', 0, R(14_160)]]);
    await purchase('CS-2208', 'CloudSoft India', '2026-08-10', '2026-08-25', 12_000, '6200', 0);
    await purchase('CS-2209', 'CloudSoft India', '2026-09-10', '2026-09-25', 12_000, '6200', 0);
    await purchase('MW-117', 'Mehta Wholesale Supplies', '2026-09-02', '2026-10-02', 250_000, '1200', 0);

    await sale('INV-0001', 'Sharma Retail Pvt Ltd', '2026-07-15', '2026-08-14', 320_000, 190_000, 377_600);
    await post('rcpt-INV-0001', '2026-08-12', 'Receipt from Sharma Retail for INV-0001', [['1010', R(377_600), 0], ['1100', 0, R(377_600)]]);
    await sale('INV-0002', 'Kapoor Traders', '2026-07-28', '2026-08-27', 150_000, 90_000, 0);
    await sale('INV-0003', 'Sharma Retail Pvt Ltd', '2026-08-18', '2026-09-17', 410_000, 240_000, 200_000);
    await post('rcpt-INV-0003', '2026-09-15', 'Part receipt from Sharma Retail for INV-0003', [['1010', R(200_000), 0], ['1100', 0, R(200_000)]]);
    await sale('INV-0004', 'Kapoor Traders', '2026-09-08', '2026-10-08', 275_000, 160_000, 0);
    await post('interest-09', '2026-09-30', 'Interest on sweep deposit', [['1010', R(3_250), 0], ['4100', 0, R(3_250)]]);
    await post('emi-09', '2026-09-30', 'Loan principal repayment', [['2500', R(25_000), 0], ['1010', 0, R(25_000)]]);
    await post('ads-09', '2026-09-12', 'Search ads September', [['6400', R(35_000), 0], ['1010', 0, R(35_000)]]);
    // September bank statement lines not yet in the books, and two coding rules.
    for (const [ext, date, desc, amt] of [
      ['HDFC-0926-01', '2026-09-26', 'NEFT CR KAPOOR TRADERS INV-0002', 177_000],
      ['HDFC-0927-02', '2026-09-27', 'AWS INDIA PVT LTD SUBSCRIPTION', -8_260],
      ['HDFC-0929-03', '2026-09-29', 'SMS ALERT CHARGES', -118],
    ] as const) {
      await c.query(
        `insert into ledger.bank_transactions (company_id, bank_account_id, external_id, txn_date, description, amount_minor, currency, import_ref)
         values ($1, $2, $3, $4, $5, $6, 'INR', 'seed') on conflict do nothing`,
        [companyId, ids.get('1010'), ext, date, desc, R(amt)],
      );
    }
    for (const [pattern, code, dir] of [['AWS', '6200', 'out'], ['CHARGES', '6300', 'out']] as const) {
      await c.query(
        `insert into ledger.coding_rules (company_id, pattern, account_id, direction, reference) values ($1, $2, $3, $4, $5) on conflict do nothing`,
        [companyId, pattern, ids.get(code), dir, `seed:rule:${pattern}`],
      );
    }
    for (const [month, rupees] of [['2026-09-01', 100_000], ['2026-10-01', 120_000]] as const) {
      await c.query(
        `insert into ledger.budgets (company_id, account_id, month, currency, amount_minor) values ($1, $2, $3, 'INR', $4)
         on conflict (company_id, account_id, month, currency) do nothing`,
        [companyId, ids.get('6400'), month, R(rupees)],
      );
    }
    return { entries: n };
  });
}
