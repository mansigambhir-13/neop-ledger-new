# neop-ledger

Ledger keeps a company's books on NEOS. It is cut from the template (`packages/neop-template`)
and adds only what makes it Ledger: the manifest, migrations `002`–`004`, one handler per ability,
pure domain logic (`src/domain/`), the prompt fill-ins and skills (`src/agent/`), and UI blocks (`blocks/`).

- **Money** is integer minor units (paise) with an ISO currency. Every journal entry balances; the database checks this at commit.
- **Corrections** are reversals, never edits. A closed month takes no postings until someone reopens it with a reason.
- **Writes** that change the books, or leave the company, are ask-first. A person approves the exact thing on the desk, bound to its fingerprint. The app then carries it out once and reads it back.
- **Before asking**, every write checks the books (unknown customer, overpayment, locked month, duplicate bill …), so nobody is asked to approve the impossible.
- **Other apps** may borrow the budget read. The **GST package** (`registry/nep-gst`) adds GSTR-3B preparation and filing.

## Abilities (29)

| Ability | What | Kind | Floor | Effect |
| --- | --- | --- | --- | --- |
| `ledger.report.pnl` | Profit and loss | read | on |  |
| `ledger.report.balance_sheet` | Balance sheet | read | on |  |
| `ledger.report.cash_flow` | Cash flow | read | on |  |
| `ledger.report.trial_balance` | Trial balance | read | on |  |
| `ledger.report.aging` | Receivables or payables aging | read | on |  |
| `ledger.report.vat_summary` | VAT / GST summary | read | on |  |
| `ledger.budget.remaining` | Budget remaining | read | on |  |
| `ledger.journal.post` | Post a journal entry | write | ask-first | money |
| `ledger.close_pack.email` | Email the month-end close pack | write | ask-first | leaves the company |
| `ledger.accounts.list` | Chart of accounts | read | on |  |
| `ledger.account.ledger` | Account ledger | read | on |  |
| `ledger.journal.list` | Journal entries | read | on |  |
| `ledger.documents.list` | Invoices or bills | read | on |  |
| `ledger.parties.list` | Customers and vendors | read | on |  |
| `ledger.bank.unreconciled` | Unreconciled bank lines | read | on |  |
| `ledger.periods.status` | Closed periods | read | on |  |
| `ledger.invoice.create` | Raise a customer invoice | write | ask-first | money |
| `ledger.bill.record` | Record a supplier bill | write | ask-first | money |
| `ledger.payment.record` | Record a receipt or payment | write | ask-first | money |
| `ledger.invoice.send` | Email an invoice | write | ask-first | leaves the company |
| `ledger.reminder.send` | Chase an overdue invoice | write | ask-first | leaves the company |
| `ledger.bank.import` | Import bank statement lines | write | on |  |
| `ledger.bank.categorize` | Post a bank line to an account | write | ask-first |  |
| `ledger.coding_rule.add` | Add a bank coding rule | write | on |  |
| `ledger.entry.reverse` | Reverse a journal entry | write | ask-first |  |
| `ledger.period.close` | Close a month | write | ask-first |  |
| `ledger.period.reopen` | Reopen a closed month | write | ask-first |  |
| `ledger.account.create` | Add an account | write | ask-first |  |
| `ledger.party.create` | Add a customer or vendor | write | on |  |

A company can switch any of these off or make an `on` write ask-first. It can never loosen a floor.

## Skills
financial-reports · month-end-close · invoicing-and-collections · bank-reconciliation · corrections (plus borrowed and package skills a company installs).

## Tests
`apps/ledger/tests/` — the template conformance bar, books end to end (`books.test.ts`), domain rules, and the platform flows. Run `pnpm test` from the repo root.
