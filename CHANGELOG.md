# Changelog

## neop-ledger 1.1.0 — 2026-09-26
- **Operator console** (`web` service, port 4780): designed around the NEOP — ask bar, live job lifecycle, fingerprinted approvals with clocks and "approve & always allow", the switchboard (floor · company · in force) with company rules, spend caps and who may approve, standing yeses, doors and the key vault, packages and skills, other apps, one audit trail, and the books with sources on every figure.
- **Platform:** governance endpoints (grants list/validation, ACL list, audit, registry catalogue, switchboard history, usage, job record); company rules validated on save; package abilities on the switchboard; reconciled proofs reach the desk; member can no longer withdraw a standing yes.
- **Ledger:** `ledger.coding_rules.list` read (30 abilities).
- **LLM proxy:** OpenRouter mode.

## neop-ledger 1.0.0 — 2026-09-26
First shippable release.
- **Bookkeeping:**
  - customers and vendors
  - invoices with GST, sent by email, with reminders
  - supplier bills and receipts/payments
  - bank import and reconciliation, with coding rules
  - reversals
  - month close and reopen
- **Reports:** P&L, balance sheet, cash flow, trial balance, aging, GST summary, budgets, account ledgers, journal search; the close pack by email.
- **GST filing:** GSTR-3B via the `nep-gst` package and a GST Suvidha Provider.
- **Providers:** Resend for email, and an HTTP adapter for the GSP. Both are journaled before sending, so every send can be confirmed.
- **Safety:**
  - every change to the books or anything leaving the company is approved by a person, bound to what they saw, and carried out once
  - writes check the books before anyone is asked
  - money abilities are always measured against caps and grants
  - the assistant holds no keys
- **Operations:** metrics, traces, alerts, per-company backup and restore, key rotation, and a runbook.
- **Deploy:**
  - Debian-slim images, run as a non-root user; the package sandbox's Deno is glibc-only
  - `scripts/gen-secrets.ts` fills `deploy/secrets/` consistently and never overwrites
  - `scripts/ops.ts` registers the app and creates companies, users and installs
  - production (`NEOS_ENV=production`) refuses every dev default: role passwords, the admin URL
  - package roles get passwords derived from a per-host key
  - desk tokens are stored as SHA-256 only
  - verified end to end in Docker Compose: migrate → up → bootstrap → read → ask → agent → LLM proxy → provider
