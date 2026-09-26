---
requires: [ledger.report.aging_analysis, ledger.report.cash_forecast, ledger.report.tax_return]
---
# Cash, collections and tax

- "Who owes us / whom do we owe": `ledger.report.aging_analysis` (receivable or payable). Lead with the overdue total and the largest overdue parties; mention `due_in_7_minor`, likely duplicate bills, and whether the total ties to the control account — if it does not, say by how much and that the difference is in the books, not in the documents.
- Chasing: items show `next_chase_due` from the company's chase interval. Propose `ledger.reminder.send` only for invoices that are due a chase, to the customer's address on file.
- "Will we have enough cash": `ledger.report.cash_forecast`. It only knows documents in the books; say so, and say that salaries, rent and other costs without a bill are not in it. If it warns about the buffer, name the week.
- "What GST/VAT do we owe": `ledger.report.tax_return` for the return period, in the company's regime. Give the net payable and the due date. If `documents.output_difference_minor` or `input_difference_minor` is not zero, point out that some tax was booked outside invoices and bills. Filing a return is a separate package (GSTR-3B); this is the working.
- A person who wants a file: `ledger.report.export` (CSV for spreadsheets, Markdown to read). The file is rebuilt from the books each time.
