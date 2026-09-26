# Changelog

## neop-ledger 1.3.0 · on the NEOS platform — 2026-09-26
Aligns Ledger with the NEOS platform as it runs today (`docs/pilot-ledger-integration.md`, the plan's Phase 0 deliverable).
- **`neop.v1` bridge:** Ledger installs on `neos-service-platform-api` from a generated descriptor (accepted unmodified by the platform's own validator) and answers its gateway's operation tokens at `/capabilities/<id>`: 17 reads, `ledger.ask` (a job), `ledger.job`, and `ledger.proposal.decide` (human-gated, never dispatched). No write is a capability.
- **Closed output schemas** for every ability, so the platform validates results strictly.
- **The desk is a test harness:** compose profile `test`, visible badge, refuses production. The product UI is the NEOS app.
- **Migrations:** `migrate.json` per stream; production requires each migration proven on populated data.
- **Borrowing:** semver ranges enforced at registration, both ways; deploy order is free.
- **CI:** descriptor drift check; gitleaks over the full history.

## neop-ledger 1.2.0 · NEOS platform — 2026-09-26
Closes the nine drifts found when validating the build against the plan (`docs/DRIFT-PLAN.md`).
- **The NEOS desk is platform-owned and multi-app**; every app's screens are its validated blocks, drawn by one renderer. Ledger's console is now 31 blocks (pages, tables, statements, forms) — no app JavaScript.
- **Switchboard:** skill lines (on/off, needs →, greyed when a tool is off); package uninstall (tables kept).
- **Database:** PgBouncer in transaction mode; direct connection for LISTEN and the execution lock; timeouts as role defaults.
- **Network:** listeners bound per network; runtime probe `scripts/netcheck.sh`.
- **Chat:** Synapse overlay and setup script; admin room binding and identity linking; room re-binding; verified live.
- **Honesty:** report sources filled from the job's reads when the assistant omits them.
- **Evidence:** pilot acceptance 5/5 with a real model (`docs/PILOT-ACCEPTANCE.md`); v3 whole picture; ADR 0013.

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
