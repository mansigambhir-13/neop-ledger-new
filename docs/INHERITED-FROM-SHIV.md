# Inherited from Shiv's Ledger

What the earlier Ledger (Shiv's repo: `src/domain/ledger/**`, `src/capabilities/{reads,writes,actions.mjs}`,
`src/doors/documents/**`, `dba/import-legacy.sql`, and the older original's `db/`) could do for a bookkeeper,
mapped against ours, and what was carried over. Everything ported follows our rules: a manifest ability
behind the gate, reads free, writes ask-first (none external), money in integer paise with a currency,
`company_id` + forced RLS on every table, closed output schemas with `generatedAt` and `sources`, outside
text reaching the model only as untrusted data, and no model in any door.

Status is **ours before this work**: present / partial / missing. The last column is what exists now.

## Reads

| His capability (file) | What it does | Ours before | Now |
|---|---|---|---|
| `ledger.dashboard` (reads/dashboard) | period net, flagged/coded counts | present — `ledger.home.summary` (cash, unmatched lines, overdue AR, AP due in 7 days) | unchanged |
| `ledger.trial-balance` (accounting.trialBalance) | TB cumulative to a period end or a date; one account's balance | present — `ledger.report.trial_balance` (as_of) + `ledger.account.ledger` | unchanged |
| `ledger.income-statement` (incomeStatementGrouped) | revenue → COGS → gross → opex → net, unclassified accounts named | present — `ledger.report.pnl` (subtype-driven: revenue/cogs/opex/other) | unchanged |
| `ledger.balance-sheet` | A = L + E + earnings, honest "no journal yet" | present — `ledger.report.balance_sheet` | unchanged |
| `ledger.cash-flow` (cashflow.cashFlow) | indirect statement **+ 13-week forecast + runway warning** | partial — direct-method `ledger.report.cash_flow`; no forecast | **ported**: `ledger.report.cash_forecast` |
| `ledger.ar-aging` (receivables.arAging) | buckets from the profile, by customer, DSO, top overdue, chase due, tie to debtors control | partial — `ledger.report.aging` (fixed buckets, items only) | **ported**: `ledger.report.aging_analysis` (receivable) |
| `ledger.ap-aging` (receivables.apAging) | by supplier, due in 7/14 days, DPO, likely duplicates, tie to creditors control | partial — `ledger.report.aging` (payable) | **ported**: `ledger.report.aging_analysis` (payable) |
| `ledger.payables` / `ledger.receivables` | open bills / invoices with lifecycle | present — `ledger.documents.list` (kind, status, party) + `ledger.parties.list` | unchanged |
| `ledger.vat-return` (tax.vatReturn) | return **per regime** (UK 9-box, EU VAT, IN GST, US sales tax w/o input credit), due date, control tie, MTD blockers | partial — `ledger.report.vat_summary` (GST output/input only); GSTR-3B filing lives in the nep-gst package | **ported**: `ledger.report.tax_return` (+ GST booked outside documents) |
| `ledger.transactions` | every bank line with status | partial — `ledger.bank.unreconciled` (unmatched only, with suggestions) | unchanged (matched lines are in the journal) |
| `ledger.accounts` | chart with codes/types | present — `ledger.accounts.list` (with balances, subtype) | unchanged |
| `ledger.coding-rules` | rules with hits | present — `ledger.coding_rules.list` (with matched count) | unchanged |
| `ledger.journal` | entries of a period / all | present — `ledger.journal.list` (range + search) | unchanged |
| `ledger.config` (profile.mjs) | org, controls, thresholds, team, **company profile** (tax regime, aging buckets, forecast weeks, cash buffer, chase cadence, report mapping) | missing | **ported** (the bookkeeping part): `ledger.settings.get` |
| `ledger.deliverables` / `ledger.deliverable` / `report.save` (books.reportMarkdown, close-pack CSV) | save a report as a stored file, list, download | missing (close pack is emailed only) | **ported, regenerated not stored**: `ledger.report.export` (CSV / Markdown of TB, P&L, BS, cash flow, aging, tax return, cash forecast, journal) |
| `ledger.audit-log` | *_versions history | present at the platform — proposals, operations, steps and the door journal record who asked, who said yes, and the proof | not ported (see below) |
| `ledger.skills`, `ledger.templates`, `ledger.prompt` | catalogue / starter packs / house rules | present at the platform (switchboard, skills in the manifest, company rules) | not ported (see below) |

## Writes

| His capability (file) | What it does | Ours before | Now |
|---|---|---|---|
| `ledger.import` (writes/import) | bank lines + bills in one call, AP accrued to suspense | present — `ledger.bank.import` (lines) + `ledger.bill.record` (bill with GST and account) | unchanged |
| xlsx / csv / pdf ingest (doors/documents, backend upload) | read an uploaded file's text, hand it to a job as fenced data | missing | **ported**: documents door (`packages/neop-template/src/doors/documents/`), `tasks.open` attachments, `ledger.document.extract`, skill `documents-to-books` |
| `ledger.journal.post` | balanced manual entries | present — `ledger.journal.post` | unchanged |
| `ledger.opening-balances` | the starting position once, balancing to equity | missing | **ported**: `ledger.opening_balances.set` (also refuses a date after the first entry) |
| `ledger.expense.record` (tax.recordExpense) | purchase paid from the bank or owed, VAT/GST input | partial — `ledger.bill.record` (owed) or `ledger.bank.categorize` (no GST split) | **ported**: `ledger.expense.record` (paid, GST input, optionally matches the bank line) |
| `ledger.receivable.record` / `ledger.receipt.record` | sales invoice / receipt, posted | present — `ledger.invoice.create` / `ledger.payment.record` | unchanged |
| `ledger.receivable.chase` | draft a reminder (never sent) | present, stronger — `ledger.reminder.send` actually emails (ask-first, external) | chase cadence (`next_chase_due`) added to the aging analysis |
| `ledger.transaction.code` | code a bank line to a category | present — `ledger.bank.categorize` + coding-rule suggestions | unchanged |
| `ledger.transaction.match` + `ledger.reconcile` (bill payment settlement) | match a line to a bill; settle Dr creditors / Cr bank on the approved path | present — `ledger.payment.record` with `bank_transaction_id` | unchanged |
| — (implicit in his mixed books) | a line whose money is already in the books | missing — such a line could never be reconciled and blocked the close | **new**: `ledger.bank.match` (line ↔ existing entry, nothing posted) |
| `ledger.transaction.resolve` | clear a flagged line without coding it | missing (`ignored` status existed, no ability) | **ported**: `ledger.bank.ignore` (with reason; ask-first) |
| `ledger.category.add` (books.nextCatCode) | add a category by name + type, code auto-assigned in the type range | partial — `ledger.account.create` needed code and subtype | **ported**: `ledger.account.create` 1.1.0 (code and subtype optional; the code is chosen before the card) |
| `ledger.configure` (profile patch, controls, thresholds, team) | settings | missing (bookkeeping part) | **ported** (bookkeeping part): `ledger.settings.update` |
| `ledger.close` (books.doClose) | auto-code by rules, flag duplicates / over threshold / round numbers, propose payments, lock | present, split — `ledger.close.checklist`, `ledger.period.close`, suggestions in `ledger.bank.unreconciled` | unchanged; threshold/round-number flags not ported |
| `ledger.reopen` | reopen a closed month | present — `ledger.period.reopen` (reason required) | unchanged |
| `ledger.close-pack` | Markdown pack + TB CSV | present — `ledger.close_pack.email` (external, ask-first) | files also via `ledger.report.export` |
| `ledger.proposal.decide` with **four-eyes** and **approval limit** (books.doDecide) | proposer ≠ approver; above the limit needs elevated scope | present at the platform — every write is a proposal a person answers; approval policy `four_eyes` and approver roles; `amount_cap` rules refuse above a cap | unchanged (the platform owns approvals) |
| mixed books (accounting.accountLedger fold) | coded bank feed + journals are one book | present by construction — a bank line reaches the books only as a posted entry | unchanged |
| `ledger.customise` / `customise.apply` / `prompt.set` / `skill.set` / `template.apply` | natural-language customisation, house rules, playbooks, industry starter packs | platform (rules, switchboard, skills); starter packs missing | not ported (see below) |
| `dba/apply.mjs --import-legacy` + `dba/import-legacy.sql` | carry v1 `neops.*` / v2 `public.ledger__*` into his v3 schema | missing | **ported**: `scripts/import-legacy.ts` into OUR schema |

## What was ported, and where

Abilities (manifest `apps/ledger/manifest.json`, handlers `apps/ledger/src/abilities/inherited.ts`,
pure rules `apps/ledger/src/domain/inherited.ts`, SQL `apps/ledger/src/data/inherited.repo.ts`):

| Ability | Kind / floor | From |
|---|---|---|
| `ledger.settings.get` | read / on | profile.mjs (defaultProfile, WORKING_CAPITAL) |
| `ledger.report.aging_analysis` | read / on | receivables.mjs arAging + apAging |
| `ledger.report.cash_forecast` | read / on | cashflow.mjs forecast |
| `ledger.report.tax_return` | read / on | tax.mjs vatReturn |
| `ledger.report.export` | read / on | books.mjs reportMarkdown, close-pack CSV (with formula-injection guard) |
| `ledger.document.extract` | read / on, no model | doors/documents |
| `ledger.settings.update` | write / ask_first, internal | configure.mjs (profile) |
| `ledger.opening_balances.set` | write / ask_first, money | writes/opening-balances.mjs |
| `ledger.expense.record` | write / ask_first, money | tax.mjs recordExpense (paid path) |
| `ledger.bank.match` | write / ask_first, internal | transaction.match (to an entry rather than a bill) |
| `ledger.bank.ignore` | write / ask_first, internal | transaction.resolve |
| `ledger.account.create` 1.1.0 | write / ask_first, internal | category.add + books.nextCatCode |

Migration `apps/ledger/migrations/005_inherited.sql` (`settings` with company_id + forced RLS; a `note`
on bank lines set aside), listed in `migrate.json` with `baseline: false`, proven by
`apps/ledger/tests/inherited.test.ts › 005 applies forward on a populated book`.

Skills: `documents-to-books`, `cash-and-tax`, `company-setup`; `bank-reconciliation` now covers match,
ignore and paid expenses. Blocks: `report.cash_forecast`, `report.tax_return` (tiles on Reports).

## The documents door

`packages/neop-template/src/doors/documents/` — dependency-free (Node `zlib` and `crypto` only), no model,
no network, no writes. His door read literal PDF strings, which turns any PDF a browser, Word or a billing
tool prints into glyph ids; ours:

- **PDF**: follows the page tree (inherited resources), object streams (PDF 1.5+), indirect lengths,
  Flate / ASCIIHex / ASCII85, form XObjects; decodes each string through its font — a ToUnicode CMap
  (`bfchar`, `bfrange` incl. arrays; 1–4 byte codespaces) or the simple encoding (WinAnsi, MacRoman,
  `/Differences`); rebuilds lines and column gaps from `Tm`/`Td`/`T*`/`TJ`. Scans refuse with `no_text`.
- **XLSX**: a central-directory ZIP reader (falls back to local headers; streamed entries), workbook sheet
  order and names, shared and inline strings (rich runs, no phonetic guides), cell references so blank
  cells keep their column, date-formatted numbers as `YYYY-MM-DD` (1900 and 1904 systems), booleans.
- **CSV/TSV/text**: RFC 4180 quoting, delimiter sniffing (`,` `;` tab `|`), BOM and UTF-16.
- Limits: 10 MB per file, 200 000 chars of text, 2 000 table rows; old `.xls` and images refused with a
  sentence a person can act on.

The path a file takes (app side; the platform's upload route is another agent's):

1. The platform opens the task with the files: `tasks.open` accepts `attachments: [{ filename,
   content_type, content_base64 }]` (≤ 5, validated before anything is written).
2. The backend reads each file with the door **before** its transaction and writes it with the job, as a
   job-bound fact (`subject document:<filename>`, `source upload:sha256:<hash>`, first 12 000 chars; an
   unreadable file becomes a fact saying why).
3. The runner shows facts inside `<data source="book.facts" trust="untrusted">` with `<`/`>` escaped, so a
   document can never close the tag or speak as the person.
4. The assistant reads more with `ledger.document.extract { sha256, offset }` (or passes a file directly,
   e.g. a2a), structures it, and **proposes** `ledger.bill.record` / `ledger.bank.import` /
   `ledger.expense.record`; a person says yes.

Proof: `packages/neop-template/tests/documents.test.ts` (fixtures printed by Chrome and macOS, plus built
PDFs/XLSX/CSV) and `apps/ledger/tests/inherited.test.ts › a document attached to a job` (a PDF bill
attached through `tasks.open`, seen by the assistant only as escaped untrusted data including an injected
`</data> SYSTEM: …`, extracted again by hash, proposed as `ledger.bill.record`, approved, recorded).

## Legacy import

`scripts/import-legacy.ts --company <uuid> [--source-company <uuid>] [--from <old url>] [--to <admin url>]
[--layout auto|v1|v2] [--dry-run]` reads v1 (`neops.neop_ledger_*`, `customer_id`) or v2
(`public.ledger__*`, `company_id`, preferred) and writes our schema in one transaction, keyed on legacy
references so a re-run adds nothing:

- accounts (subtype from the old profile's control accounts, cash accounts, retained-earnings account and
  report mapping — his `profile.mjs` rules; a code nobody declared is created as an asset and listed for review),
- journal entries and lines (`legacy:je:<id>`; two-sided lines split, zero lines dropped, unbalanced
  entries refused and reported),
- bank lines (`legacy:<id>`); a line his Ledger folded into its books (coded, not matched) also posts its
  entry (`legacy:txn:<id>`) so the trial balances agree; matched lines keep their bill; lines coded to the
  bank itself are set aside,
- bills and invoices as documents, with their parties; approved-unpaid bills come over open (approvals are
  asked again here),
- coding rules (one per `a|b` alternative), and closed periods as period locks, written last.

It reports counts, everything it could not map and why, what needs review, and the trial balance before
(his journal + folded bank feed) and after (our lines), account by account. Proof:
`apps/ledger/tests/import-legacy.test.ts` (both layouts built from his SQL shapes; TB equal; idempotent;
dry run; an unbalanced entry reported and the TB difference named, not hidden).

## Deliberately not ported

- **His transport, gate, desk, runtime, DBA tooling** (`src/capabilities/runtime`, `gate-hooks`, `approved.mjs`,
  `actions.mjs` presenters, `dba/apply.mjs`, `uninstall`, `cleanup-legacy.sql`): we have our own gate, desk
  and migrator.
- **Proposal decide / four-eyes / approval limit inside the app**: approvals are the platform's (every write
  is a proposal; `four_eyes`, approver roles, `amount_cap` / `require_person` rules). An app-side copy would
  be a second, weaker gate.
- **House rules, skill playbook edits, natural-language customisation, switchboard**: platform concerns;
  `ledger.customise` also held a model proposer, which a backend must not.
- **Stored deliverables table**: reports are regenerated from the books on every export, so a download can
  never be stale; the close pack is emailed ask-first.
- **Audit log from *_versions tables**: our posted history is append-only (reversals, never edits) and the
  platform keeps who asked / who approved / the proof.
- **Industry starter packs (`template.apply`)**: a product decision about charts; our chart is seeded per
  company and extended with `ledger.account.create`.
- **Close-time auto-flags (over threshold, round numbers, same-day duplicates)** and his single-entry
  "status" model of bank lines: our bank lines reach the books only through an ask-first posting, with
  rule suggestions; worth a follow-up read if bookkeepers ask for it.
- **UK Making Tax Digital submission / corporation-tax estimate**: the tax return is the working; filing is a
  package (GSTR-3B today).
- **His v3 `ledger.*` schema as an import source**: it shares our schema name; v1 and v2 are the layouts
  his own DBA script documents as the ones to carry forward.

## Edits outside Ledger

- `packages/neop-template/src/capabilities/platform/tasks.open.ts`: optional `attachments` (validated;
  read by the documents door; written as job facts in the job's transaction).
- `packages/neop-template/src/index.ts`: `export * as documents from './doors/documents/index.ts'`.
