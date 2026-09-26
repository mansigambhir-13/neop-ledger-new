---
requires: [ledger.report.trial_balance, ledger.period.close, ledger.close_pack.email]
---
# Month-end close

1. Reconcile the bank first (`ledger.bank.unreconciled`); a month with unreconciled bank lines cannot be closed.
2. Run the trial balance at the month end. If it does not agree, stop and report — never close books that do not balance.
3. Check receivables and payables aging for anything over 90 days and mention it.
4. Propose `ledger.period.close` for the month. Once closed, nothing more can be posted into it; a correction later needs `ledger.period.reopen` with a reason.
5. Then, if asked, propose `ledger.close_pack.email` to the recipients the person named — never add recipients they did not name.
6. When woken with DONE, confirm from the proof (month locked; message id and recipients) and report.
