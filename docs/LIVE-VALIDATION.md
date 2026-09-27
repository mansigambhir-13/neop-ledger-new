> **Outcome, 27 Sep 2026:** 103 of 104 checks passed on the first full run; the one FAIL (questions) was a real bug the run
> found — an answer given to an earlier job's question leaked to a later, unrelated job, which reused it instead of asking.
> Fixed (answers and attached documents belong to their job and its follow-ups; `input-waits.test` › "an answer belongs to
> the job that asked"), redeployed, and the questions section re-run live: **4/4 pass** (both the desk and the
> conversation answer paths). Also checked live on the same stack, outside this script: the Matrix client road with a real
> Synapse (a bridge's read, proposal, refused go-ahead, a person's yes in her own DM, questions answered in DMs), the
> `neop.v1` bridge with tokens signed as today's NEOS platform signs them, and `scripts/verify-install.ts` (13/13).

# Live validation — ledger

**1 FAIL** · http://127.0.0.1:4500 · company Acme Traders (Asia/Kolkata) · today 2026-09-27 · run tag `LVRNXB760`

Started 2026-09-27T12:00:03.427Z, finished 2026-09-27T12:15:21.408Z. Assistant spend $9.2528 of a $15 budget. Live manifest 1.0.0 · local schemas 1.0.0.

| Section | Pass | Fail | Skipped |
|---|---:|---:|---:|
| setup | 2 | 0 | 0 |
| documents | 4 | 0 | 0 |
| reads | 30 | 0 | 0 |
| blocks | 27 | 0 | 0 |
| governance | 14 | 0 | 0 |
| writes | 22 | 0 | 0 |
| questions | 1 | 1 | 0 |
| schedules | 3 | 0 | 0 |

## Notes

- Ability output schemas are not served by the person-facing API; they are read from this checkout (apps/<app>/manifest.json, registry/<pkg>/manifest.json) and the versions compared.
- Changes this run made to the books are tagged LVRNXB760: ₹1-scale test documents, bank lines and entries (the test journal entry is reversed; settings and the closed month are put back). Accounts, parties and coding rules are never deleted by the app, so they remain.

## setup

| Item | Result | Evidence | Cost |
|---|---|---|---:|
| manifest version | PASS | live 1.0.0 · local 1.0.0 |  |
| ability list | PASS | 44 own abilities, 0 from packages; every one has a local schema |  |

## documents

| Item | Result | Evidence | Cost |
|---|---|---|---:|
| a bill proposal whose card matches the attached file, declined | PASS | card "Record supplier bill LVB-LVRNXB760 from CloudSoft India for ₹250.00 + 18% GST (₹" · LVB-LVRNXB760 · ₹250 · source_document 6aeed7b5dfb5… · declined: HTTP 200 · bills recorded: 0 · task 9925f383 COMPLETED · "Proposed recording supplier bill LVB-LVRNXB760 from CloudSoft India (₹250.00 net + 18% GST ₹45.00 = ₹295.00 total, line to account 6300, source_document 6aeed7b" | $0.3522 |
| the file is kept (ledger.document.get) | PASS | live-validate-bill-LVRNXB760.csv · 201 bytes · text/csv · store local · link issued |  |
| download is identical (sha256) | PASS | HTTP 200 · 201 bytes · sha256 6aeed7b5dfb5e906… (want 6aeed7b5dfb5e906…) |  |
| unauthenticated download refused | PASS | HTTP 401 (want 401) |  |

## reads

| Item | Result | Evidence | Cost |
|---|---|---|---:|
| ledger.report.pnl {"from":"2026-08-01","to":"2026-09-27"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=21 · empty=false |  |
| ledger.report.balance_sheet {"as_of":"2026-09-27"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=34 · empty=false |  |
| ledger.report.cash_flow {"from":"2026-08-01","to":"2026-09-27"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=21 · empty=false |  |
| ledger.report.trial_balance {"as_of":"2026-09-27"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=34 · empty=false |  |
| ledger.report.aging {"kind":"receivable","as_of":"2026-09-27"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=3 · empty=false |  |
| ledger.report.aging {"kind":"payable","as_of":"2026-09-27"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=4 · empty=false |  |
| ledger.report.vat_summary {"from":"2026-07-01","to":"2026-09-30"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=39 · empty=false |  |
| ledger.budget.remaining {"account_code":"6400","month":"2026-09"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=1 · empty=false |  |
| ledger.accounts.list {"as_of":"2026-09-27"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=19 · empty=false |  |
| ledger.accounts.list {"type":"expense","include_inactive":true} | PASS | 200 · schema ok · generatedAt ok · sources.entries=6 · empty=false |  |
| ledger.account.ledger {"account_code":"1010","from":"2026-09-01","to":"2026-09-27"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=7 · empty=false |  |
| ledger.journal.list {"from":"2026-09-01","to":"2026-09-27","limit":50} | PASS | 200 · schema ok · generatedAt ok · sources.entries=13 · empty=false |  |
| ledger.documents.list {"kind":"invoice","status":"all"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=5 · empty=false |  |
| ledger.documents.list {"kind":"bill","status":"open"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=4 · empty=false |  |
| ledger.parties.list {} | PASS | 200 · schema ok · generatedAt ok · sources.entries=5 · empty=false |  |
| ledger.parties.list {"kind":"vendor"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=2 · empty=false |  |
| ledger.bank.unreconciled {} | PASS | 200 · schema ok · generatedAt ok · sources.entries=0 · empty=true |  |
| ledger.periods.status {} | PASS | 200 · schema ok · generatedAt ok · sources.entries=0 · empty=true |  |
| ledger.coding_rules.list {} | PASS | 200 · schema ok · generatedAt ok · sources.entries=2 · empty=false |  |
| ledger.home.summary {"as_of":"2026-09-27"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=19 · empty=false |  |
| ledger.close.checklist {"month":"2026-09"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=19 · empty=false |  |
| ledger.settings.get {} | PASS | 200 · schema ok · generatedAt ok · sources.entries=0 · empty=true |  |
| ledger.report.aging_analysis {"kind":"receivable","as_of":"2026-09-27"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=3 · empty=false |  |
| ledger.report.cash_forecast {"as_of":"2026-09-27","weeks":4} | PASS | 200 · schema ok · generatedAt ok · sources.entries=41 · empty=false |  |
| ledger.report.tax_return {"from":"2026-08-01","to":"2026-08-31"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=8 · empty=false |  |
| ledger.report.export {"report":"trial_balance","format":"md","as_of":"2026-09-27"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=34 · empty=false |  |
| ledger.report.export {"report":"pnl","format":"csv","from":"2026-08-01","to":"2026-08-31"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=8 · empty=false |  |
| ledger.document.extract {"filename":"live-validate.csv","content_type":"text/csv","content_base64":"ZGF0ZSxkZXNjcmlwdGlvbixhbW91bnQKMjAyNi0wOS0y | PASS | 200 · schema ok · generatedAt ok · sources.entries=0 · empty=false |  |
| ledger.document.get {"sha256":"6aeed7b5dfb5e90644bac6426d5ab1efd53b7715418fd270d6f9e928ffa543c2"} | PASS | 200 · schema ok · generatedAt ok · sources.entries=0 · empty=false |  |
| bad args refused (ledger.report.pnl {from:"last month"}) | PASS | HTTP 400 |  |

## blocks

| Item | Result | Evidence | Cost |
|---|---|---|---:|
| gst | PASS | 1 read(s) ok: ledger.report.vat_summary {"to":"2026-09-30","from":"2026-07-01"} |  |
| home | PASS | 1 read(s) ok: ledger.home.summary |  |
| bills | PASS | 3 read(s) ok: ledger.documents.list {"kind":"bill","status":"open"}, ledger.documents.list {"kind":"bill","status":"paid"}, ledger.parties.list {"kind":"vendor"} |  |
| close | PASS | 2 read(s) ok: ledger.close.checklist {"month":"2026-09"}, ledger.report.pnl {"to":"2026-09-30","from":"2026-09-01"} |  |
| rules | PASS | 1 read(s) ok: ledger.coding_rules.list |  |
| accounts | PASS | 1 read(s) ok: ledger.accounts.list {"include_inactive":true} |  |
| invoices | PASS | 3 read(s) ok: ledger.documents.list {"kind":"invoice","status":"open"}, ledger.documents.list {"kind":"invoice","status":"paid"}, ledger.parties.list {"kind":"customer"} |  |
| overview | PASS | 4 read(s) ok: ledger.report.pnl {"to":"2026-09-30","from":"2026-09-01"}, ledger.report.cash_flow {"to":"2026-09-30","from":"2026-09-01"}, ledger.report.balance_sheet {"as_of":"2026-09-30"}, ledger.close.checklist {"month":"2026-09"} |  |
| form.bill | PASS | 2 read(s) ok: ledger.parties.list {"kind":"vendor"}, ledger.accounts.list {"type":"expense"} |  |
| form.rule | PASS | 1 read(s) ok: ledger.accounts.list |  |
| reconcile | PASS | 2 read(s) ok: ledger.bank.unreconciled, ledger.periods.status |  |
| report.pnl | PASS | 1 read(s) ok: ledger.report.pnl {"to":"2026-09-30","from":"2026-09-01"} |  |
| form.import | PASS | 1 read(s) ok: ledger.accounts.list {"type":"asset"} |  |
| form.invoice | PASS | 2 read(s) ok: ledger.parties.list {"kind":"customer"}, ledger.accounts.list {"type":"income"} |  |
| form.journal | PASS | 1 read(s) ok: ledger.accounts.list |  |
| form.payment | PASS | 1 read(s) ok: ledger.accounts.list {"type":"asset"} |  |
| form.receipt | PASS | 1 read(s) ok: ledger.accounts.list {"type":"asset"} |  |
| transactions | PASS | 1 read(s) ok: ledger.journal.list {"to":"2026-09-30","from":"2026-09-01","limit":200} |  |
| account.ledger | PASS | 1 read(s) ok: ledger.account.ledger {"to":"2026-09-30","from":"2026-09-01","account_code":"1010"} |  |
| report.aging_ap | PASS | 1 read(s) ok: ledger.report.aging {"kind":"payable","as_of":"2026-09-30"} |  |
| report.aging_ar | PASS | 1 read(s) ok: ledger.report.aging {"kind":"receivable","as_of":"2026-09-30"} |  |
| report.cash_flow | PASS | 1 read(s) ok: ledger.report.cash_flow {"to":"2026-09-30","from":"2026-09-01"} |  |
| report.tax_return | PASS | 1 read(s) ok: ledger.report.tax_return {"to":"2026-09-30","from":"2026-09-01"} |  |
| report.balance_sheet | PASS | 1 read(s) ok: ledger.report.balance_sheet {"as_of":"2026-09-30"} |  |
| report.cash_forecast | PASS | 1 read(s) ok: ledger.report.cash_forecast {"as_of":"2026-09-30"} |  |
| report.trial_balance | PASS | 1 read(s) ok: ledger.report.trial_balance {"as_of":"2026-09-30"} |  |
| 7 blocks without reads | PASS | reports, desk.list, form.reopen, form.vendor, form.account, form.customer, form.close_pack |  |

## governance

| Item | Result | Evidence | Cost |
|---|---|---|---:|
| switch ledger.budget.remaining off and back | PASS | off: HTTP 200 · in registry while off: false · direct read while off: HTTP 403 switched_off · back to on: HTTP 200 · read again: HTTP 200 |  |
| loosen ledger.journal.post to on | PASS | HTTP 422 cannot_loosen |  |
| a read set to ask_first | PASS | HTTP 422 read_cannot_ask_first |  |
| standing yes within its cap (₹1.00 ≤ ₹10.00) | PASS | cards 0 · grant uses 1 · entries 1 · task 62f25f12 COMPLETED · "Posted the requested test journal entry exactly as specified. It was carried out under a standing yes (proposal 0318e0f5-8145-4536-8d0b-87692adec309), outcome D" | $0.3278 |
| standing yes beyond its cap (₹20.00 > ₹10.00) asks | PASS | cards 1 (declined) · entries 0 · task 8eeba35a COMPLETED · "Live-validate task LVRNXB760/grant-over: proposed the single journal entry exactly as specified (2026-09-27, INR, memo "Live validation grant cap test LVRNXB760" | $0.3341 |
| standing yes withdrawn | PASS | DELETE /api/grants/2cf52944: HTTP 200 |  |
| amount_cap rule lv-cap-lvrnxb760 refuses ₹10.00 (cap ₹5.00) | PASS | refused step: "Refused ledger.journal.post: amount 1000 exceeds per-call cap 500 INR" · transcript cites rule:lv-cap-lvrnxb760: true · cards 0 · entries 0 · task 631a2e0a | $0.3272 |
| company rules restored | PASS | HTTP 200 (0 rules as before) |  |
| member changes the switchboard | PASS | HTTP 403 (want 403) |  |
| member creates a standing yes | PASS | HTTP 403 (want 403) |  |
| member reads the audit trail | PASS | HTTP 403 (want 403) |  |
| member sets a schedule | PASS | HTTP 403 (want 403) |  |
| member reads the switchboard | PASS | HTTP 200 (want 200) |  |
| member runs a read | PASS | HTTP 200 (want 200) |  |

## writes

| Item | Result | Evidence | Cost |
|---|---|---|---:|
| ledger.party.create | PASS | 1 operation (DONE) · parties.list has LV Test Customer LVRNXB760 once · task 7641b726 | $0.3244 |
| ledger.account.create | PASS | card "Add expense account LVRNXB760" sha256:4687226d… · EXECUTED, proof DONE (cd0ada70-5f10-481b-ad94-2d0b610579d1) · 1 operation (DONE) · accounts.list has LVRNXB760 "Live validation LVRNXB760" · task 5d173dd1 | $0.4075 |
| ledger.coding_rule.add | PASS | 1 operation (DONE) · coding_rules.list has LVTEST-LVRNXB760 → 6300 · task 72a28dc9 | $0.2364 |
| ledger.journal.post | PASS | card "Post ₹1.00 test entry LVRNXB760" sha256:75f27f7c… · wrong fingerprint refused (409 stale_fingerprint, card still PENDING) · EXECUTED, proof DONE (fc2f43aa-849e-4c30-8ca3-a7e50c0b2a3c) · 1 operation (DONE) · journal.list has entry fc2f43aa · task c959da9d | $0.3270 |
| ledger.entry.reverse | PASS | card "Reverse test entry LVRNXB760" sha256:1f2be3cb… · EXECUTED, proof DONE (ca132edd-e650-4727-82a1-7d750e32823a) · 1 operation (DONE) · journal.list has reversal ca132edd of fc2f43aa · task ef528968 | $0.3355 |
| ledger.invoice.create | PASS | card "Invoice LV Test Customer LVRNXB760 ₹1.18" sha256:3389bbd9… · EXECUTED, proof DONE (INV-0006) · 1 operation (DONE) · documents.list has INV-0006 for ₹1.18 · task 6217404c | $0.3420 |
| ledger.payment.record | PASS | card "Record ₹1.18 received on INV-0006" sha256:b91b5689… · EXECUTED, proof DONE (447cbc8e-f3bc-451f-be8a-faa3baac75cb) · 1 operation (DONE) · INV-0006 is paid · task f1da53d9 | $0.3322 |
| ledger.bank.import | PASS | card "Import 4 test bank lines LVRNXB760" sha256:2ca3b1ab… · EXECUTED, proof DONE (4 of 4 lines new) · 1 operation (DONE) · bank.unreconciled has the 4 lines · task 82dbf56a | $0.3396 |
| ledger.bank.match | PASS | card "Match the ₹1.18 receipt line" sha256:282aa73f… · EXECUTED, proof DONE (4e0d85af-258d-4def-8899-3ec9eab86e0c) · 1 operation (DONE) · receipt line reconciled · task 4711bf6c | $0.3363 |
| ledger.bank.categorize | PASS | card "Categorise the ₹1.00 charges line" sha256:6292e720… · EXECUTED, proof DONE (c5ac595d-3164-43d2-bafc-7ad6ea97e845) · 1 operation (DONE) · charges line reconciled · task c19340fa | $0.3331 |
| ledger.bank.ignore | PASS | card "Set aside the ₹0.50 duplicate line" sha256:0cabb8a9… · EXECUTED, proof DONE (44be5735-726f-4c5d-9677-f5dc8c3a1ac3) · 1 operation (DONE) · duplicate line set aside · task 73a3bf0e | $0.2454 |
| ledger.expense.record | PASS | card "Record the ₹1.18 stationery expense" sha256:072495d0… · EXECUTED, proof DONE (749507ea-bbd3-46b6-a1fd-e24456bc1f1c) · 1 operation (DONE) · entry 749507ea, bank line matched · task 96fbeb05 | $0.3346 |
| ledger.bill.record | PASS | card "Record bill LV-LVRNXB760 from CloudSoft India" sha256:3e79c1ab… · EXECUTED, proof DONE (LV-LVRNXB760) · 1 operation (DONE) · documents.list has bill LV-LVRNXB760 (₹1.18) · task 24fcff01 | $0.3325 |
| ledger.settings.update | PASS | card "Set cash forecast to 12 weeks" sha256:ca9101eb… · EXECUTED, proof DONE (settings) · 1 operation (DONE) · settings.get forecast_weeks=12 · task fb61ee98 | $0.3233 |
| ledger.settings.update (restore settings) | PASS | card "Put cash forecast back to 13 weeks" sha256:a2c1412d… · EXECUTED, proof DONE (settings) · 1 operation (DONE) · forecast_weeks back to 13 · task 43b771b2 | $0.3238 |
| ledger.opening_balances.set | PASS | card "Set a ₹1.00 opening balance on 1000" sha256:b89c086d… · EXECUTED, proof DONE (fce76aac-ca59-4f5e-9813-178eed8772a8) · 1 operation (DONE) · opening entry fce76aac on 2026-07-01 · task b12bc031 | $0.3251 |
| ledger.entry.reverse (reverse opening balances) | PASS | card "Reverse the ₹1.00 opening balance" sha256:977d3efa… · EXECUTED, proof DONE (6c2d07c2-e5a5-4299-9927-a06ed82a69d7) · 1 operation (DONE) · opening balance reversed · task 1aede0e2 | $0.3243 |
| ledger.period.close | PASS | card "Close 2026-08" sha256:dcc88823… · EXECUTED, proof DONE (2026-08) · 1 operation (DONE) · periods.status lists 2026-08 closed · task f2638e04 | $0.3213 |
| ledger.period.reopen | PASS | card "Reopen 2026-08" sha256:9432e389… · EXECUTED, proof DONE (2026-08) · 1 operation (DONE) · 2026-08 open again · task ad2d3d85 | $0.3208 |
| ledger.invoice.send | PASS | card "Email INV-0006 to cfo@acme.example" sha256:9112a559… · EXECUTED, proof DONE (msg_8fdeca13f1c7) · 1 operation (DONE) · INV-0006 sent_at 2026-09-27T12:11:51.654Z · task 2c168bb1 | $0.4031 |
| ledger.reminder.send | PASS | card "Remind about INV-0003 (to cfo@acme.example)" sha256:7460336b… · EXECUTED, proof DONE (msg_4afd1cef425d) · 1 operation (DONE) · INV-0003 reminded_at 2026-09-27T12:12:25.979Z · task 6d807467 | $0.3246 |
| ledger.close_pack.email | PASS | card "Email the 2026-08 close pack to cfo@acme.example" sha256:a302a45f… · EXECUTED, proof DONE (msg_3df37025e887) · 1 operation (DONE) · proof {"id":"msg_3df37025e887","to":["cfo@acme.example"],"sent_at":"2026-09-27T12:12:54.232Z","subject":"Close pack 2026-08-01 · task 9f2ff64e | $0.3253 |

## questions

| Item | Result | Evidence | Cost |
|---|---|---|---:|
| question answered via desk | PASS | asked "How much was the expense, in rupees?" fields ["amount_rupees"] · POST /api/questions/b6123061/answer → 200 · question ANSWERED via desk · task 38c94970 COMPLETED · "Acceptance check LVRNXB760/q-desk: asked for the missing expense amount, received the answer, and per instructions did not record anything or use any changing a" | $0.3064 |
| question answered via conversation | **FAIL** | no question was asked ·  · question ? via ? · task 43bc898b COMPLETED · "amount_rupees=37. Per the request, no expense was recorded and no ability that changes anything was used — this was an acceptance check only. The answer (37) ca" | $0.1647 |

## schedules

| Item | Result | Evidence | Cost |
|---|---|---|---:|
| create a schedule (daily at 17:45 Asia/Kolkata) | PASS | schedule b0110f1d · next run 2026-09-27T12:15:00.000Z |  |
| a timer job runs and completes | PASS | job 70f6e2c2 report: "Cash on hand as of 2026-09-27 is ₹752,999.00 (75,299,900 paise), per ledger.home.summary. No changes were made." · last_run_at 2026-09-27T12:15:00.000Z · timer job cost is not attributable per job (counted in the app's usage today) |  |
| disable the schedule | PASS | HTTP 200 · enabled false (there is no delete; a disabled schedule never runs) |  |

## Re-run after the fix: questions

| Item | Result | Evidence | Cost |
|---|---|---|---:|
| manifest version | PASS | live 1.0.0 · local 1.0.0 |  |
| ability list | PASS | 44 own abilities, 0 from packages; every one has a local schema |  |
| Item | Result | Evidence | Cost |
|---|---|---|---:|
| question answered via desk | PASS | asked "How much was the expense, in rupees?" fields ["amount_rupees"] · POST /api/questions/90d89781/answer → 200 · question ANSWERED via desk · task 01c0977f COMPLETED · "Acceptance check LVSFHKAB6/q-desk: asked for the missing amount via job_ask, received the answer, and recorded nothing per instructions. amount_rupees=37" | $0.2265 |
| question answered via conversation | PASS | asked "How much was the expense, in rupees?" fields ["amount_rupees"] · follow-up /api/ask in conversation 33f2fc7a → 200 answered question 5d190fe1 · question ANSWERED via conversation · task f9053b97 COMPLETED · "amount_rupees=41. As instructed, I asked for the amount with job_ask (one field, amount_rupees), received the answer from the user (41), and did not record any " | $0.3065 |
