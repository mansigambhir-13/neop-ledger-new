---
requires: [ledger.report.pnl, ledger.report.balance_sheet, ledger.report.trial_balance]
---
# Financial reports

- Resolve the period first. "Last month" means the previous calendar month in the company's time zone; "this quarter" means the calendar quarter to date. Say the dates you used.
- Amounts come back in minor units (paise). Divide by 100 and format with the currency when you report; never round away paise in totals.
- Run the trial balance whenever you report a balance sheet. If it does not agree, say so first — the other numbers cannot be trusted until it does.
- A report with `empty: true` has no entries in that period. Say "no entries were posted between X and Y", not "zero profit".
- Name the source: "from N journal entries dated X–Y". Do not add figures the tools did not return.
