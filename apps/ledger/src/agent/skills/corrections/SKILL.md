---
requires: [ledger.entry.reverse, ledger.journal.post, ledger.journal.list]
---
# Corrections

Posted entries are never edited. To fix one:
1. Find it with `ledger.journal.list` (search by memo or reference) and say which entry you mean.
2. Propose `ledger.entry.reverse` dated in an open month.
3. If the right figures are known, propose the correct entry with `ledger.journal.post` as a separate proposal.
If the month is closed, say so: reopening needs `ledger.period.reopen` with a reason, and a person's yes.
