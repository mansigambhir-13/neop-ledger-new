# Pilot acceptance run

2026-09-26T09:43:15.636Z · http://127.0.0.1:4400 · 20 real requests to Ledger, one company, real model · total assistant cost $3.92

| Criterion (technical plan, Phase 2 acceptance) | Result | Evidence |
| --- | --- | --- |
| 100% produce a job and an ack | ✅ pass | 20/20 jobs; ack median 53 ms, max 95 ms |
| Every gated action has a person's yes with a matching fingerprint | ✅ pass | 8 executed approvals, 0 without a matching yes |
| Zero effects without a proposal | ✅ pass | 8 gated operations, 0 not covered by an approval or standing yes |
| Zero duplicate executions | ✅ pass | 8 proposals executed, 0 more than once |
| Every report fact links to its source | ✅ pass | 12 completed reports, 0 without sources |

## Requests

| # | Request | Kind | Result | Cards | Sources | Summary |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | What was our net profit in August 2026, and what drove it? | report | COMPLETED | 0 | 2 | August 2026 (1–31 Aug) was a net loss of ₹67,590.00, not a profit — from 8 journal entries dated in that period (ledger.report.pnl). Breakdown: - Revenue (Sales, a/c 4000): ₹4,10,000.00 - COGS (a/c 5000): ₹2,40,000.00 →  |
| 2 | Show me the balance sheet as of 30 September 2026. Does it balance? | report | COMPLETED | 0 | 2 | Pulled the balance sheet and trial balance as of 30 Sep 2026. Trial balance agrees (debits = credits = ₹68,68,160.00). Balance sheet balances: total assets ₹17,36,700.00 = total liabilities ₹10,06,220.00 + total equity ₹ |
| 3 | How much cash did we have at the end of August 2026? | report | COMPLETED | 0 | 3 | Cash at end of August 2026 (2026-08-31) was ₹4,64,260.00, held in the HDFC current account (account 1010). Confirmed via both the balance sheet as of 2026-08-31 (bank balance ₹4,64,260.00) and the cash flow statement for |
| 4 | Which customer invoices are overdue today, and by how much? | report | COMPLETED | 0 | 2 | Two customer invoices are overdue as of 2026-09-26: INV-0002 (Kapoor Traders, due 2026-08-27, 30 days overdue, ₹1,77,000.00 outstanding) and INV-0003 (Sharma Retail Pvt Ltd, due 2026-09-17, 9 days overdue, ₹2,83,800.00 o |
| 5 | What do we owe suppliers and when is each bill due? | report | COMPLETED | 0 | 2 | As of 26 Sep 2026, Bharat Traders owes suppliers a total of ₹3,23,320.00 across 3 open bills (from ledger.report.aging / ledger.documents.list, based on 3 entries): 1. CloudSoft India — Bill CS-2208: ₹14,160.00, due 25 A |
| 6 | What is our GST payable for July to September 2026? | report | COMPLETED | 0 | 1 | GST payable for Jul–Sep 2026 (quarter): ₹48,420.00 net payable. - Output tax (GST collected on sales): ₹207,900.00 - Input tax (GST paid on purchases): ₹159,480.00 - Net GST payable: ₹48,420.00 Note: today is 26 Sep 2026 |
| 7 | How much of the September 2026 marketing budget (account 6400) is left? | report | COMPLETED | 0 | 1 | Marketing budget (account 6400) for September 2026: budget ₹1,00,000.00, spent ₹35,000.00, remaining ₹65,000.00. |
| 8 | Is the trial balance at 30 September 2026 in balance? Give me the totals. | report | COMPLETED | 0 | 1 | Yes — the trial balance at 30 September 2026 is in balance. Total debits = Total credits = ₹68,68,160.00 (686,816,000 paise), across 17 accounts and 32 journal entries dated up to that date. |
| 9 | Explain the cash flow for September 2026. | report | COMPLETED | 0 | 4 | Explained September 2026 cash flow: opening cash ₹4,64,260.00, operating +₹1,11,400.00 (receipts from Sharma Retail ₹2,00,000 and Kapoor Traders ₹1,77,000, interest ₹3,250, less salaries ₹1,80,000, rent ₹45,000, ads ₹35, |
| 10 | What were our three biggest expense accounts in the July to September 2026 quarter? | report | COMPLETED | 0 | 2 | Q3 2026 (Jul–Sep) isn't fully over yet — today is Sep 26, so this covers 2026-07-01 to 2026-09-26 (28 journal entries). Biggest expense accounts by amount posted so far: 1. Cost of goods sold — ₹6,80,000.00 2. Salaries — |
| 11 | The bank line "NEFT CR KAPOOR TRADERS INV-0002" is Kapoor Traders paying invoice INV-0002. Record that receipt using that bank line. | change | COMPLETED | 1 | 1 | Recorded the receipt of ₹1,77,000.00 from Kapoor Traders against invoice INV-0002, matched to the bank line "NEFT CR KAPOOR TRADERS INV-0002" dated 2026-09-26. The person approved the proposal and the app confirmed it po |
| 12 | Code the bank line "AWS INDIA PVT LTD SUBSCRIPTION" to software subscriptions (6200). | change | COMPLETED | 1 | 2 | Coded the bank line "AWS INDIA PVT LTD SUBSCRIPTION" (₹8,260.00 out, dated 2026-09-27) to account 6200 Software subscriptions, as requested. The proposal was approved and posted; the bank line is now matched. |
| 13 | Email invoice INV-0004 to Kapoor Traders. | change | COMPLETED | 1 | 1 | Emailed invoice INV-0004 (₹3,24,500.00, due 2026-10-08) to Kapoor Traders at finance@kapoortraders.example, as approved. |
| 14 | Send Sharma Retail a payment reminder for overdue invoice INV-0003. | change | COMPLETED | 1 | 1 | Sent the payment reminder for overdue invoice INV-0003 to Sharma Retail. It went to accounts@sharmaretail.example (the email on file), subject "Reminder: invoice INV-0003 is 9 days overdue", confirmed by the app (message |
| 15 | Record supplier bill CS-2210 from CloudSoft India: ₹12,000 software subscription (account 6200), 18% GST, issued 26 September 2026, due 25 October 2026. | change | COMPLETED | 1 | 1 | Recorded supplier bill CS-2210 from CloudSoft India: ₹12,000 net (account 6200, software subscriptions) + 18% GST (₹2,160) = ₹14,160 total, issued 2026-09-26, due 2026-10-25. The proposal was approved and posted; the app |
| 16 | Create an invoice for Sharma Retail Pvt Ltd: "Display racks" ₹40,000 (account 4000) at 18% GST, issued today, due in 30 days. Do not email it yet. | change | COMPLETED | 1 | 1 | Created and posted invoice INV-0005 for Sharma Retail Pvt Ltd: "Display racks" ₹40,000 net + 18% GST (₹7,200) = ₹47,200 total, issued 2026-09-26, due 2026-10-26. Not sent, per instruction. |
| 17 | Post a journal entry dated 26 September 2026 moving ₹5,000 from the HDFC current account (1010) to cash in hand (1000), memo "Petty cash top-up". | change | COMPLETED | 1 | 1 | Posted the approved journal entry dated 26 Sep 2026: debit Cash in hand (1000) ₹5,000.00, credit HDFC current account (1010) ₹5,000.00, memo "Petty cash top-up". |
| 18 | Code the bank line "SMS ALERT CHARGES" to bank charges (6300). | change | COMPLETED | 1 | 2 | Coded the bank line "SMS ALERT CHARGES" (₹118.00 out, dated 2026-09-29) to account 6300 Bank charges, as requested. |
| 19 | What is still blocking the September 2026 close? | report | COMPLETED | 0 | 5 | September 2026 close is 3 of 6 steps done. Two things are blocking it right now: 1. **One unmatched bank line** (2026-09-29, "SMS ALERT CHARGES", ₹118.00 out). It has a suggested rule to code it to 6300 Bank charges — I  |
| 20 | List the journal entries posted in September 2026 with their amounts. | report | COMPLETED | 0 | 1 | Listed all 15 journal entries posted between 2026-09-01 and 2026-09-30, with each entry's date, memo, and amount (total debit = total credit), converted to rupees. |
