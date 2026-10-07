# Changelog

## Release hardening — 2026-09-30
- The appservice overlay makes Synapse part of the default Compose lifecycle, including ordinary startup and teardown.
- Final local regression: 94 test files, 609 passed, zero failed, two conditional integration skips; compiler and history secret scan pass.
- Fixed a Matrix receipt race: a reply arriving before the card's send receipt is persisted now waits for its fingerprint binding and follows the normal person/role approval checks.
- CI starts the required Matrix topology with real Synapse and runs on the release branch.
- Upgrades stop before mutation when a backup cannot be taken, or a database survives without its original deployment state.
- Matrix setup defaults to distinct platform/NEOP registrations and honours the configured secret directory.
- Corrected the PostgreSQL client type used by LLM settlement during shutdown; added deployment failure-path regressions.
- Deployment ownership and the release boundary are recorded in `docs/RELEASE-HANDOFF.md`.

## neop-ledger 2.0.0-rc.1 · V3 Matrix-only release candidate — 2026-09-29
- **One road:** NeuralChat, people, Ledger and peer NEOPs now exchange typed Matrix events in task threads. The runtime gateway/L3, platform-client, execution-token and fallback delivery paths are removed.
- **One owner:** jobs, waits, proposals, approvals, operations, transcripts, switchboards, grants, presence cursors and declared reads live in the app's schema behind restricted roles and reviewed functions/views.
- **Person-only approval:** NeuralChat and peer NEOPs cannot approve. A person's fingerprint-bound answer lands through `answer_proposal()`; the runner executes once, reads back and wakes only after a terminal proof.
- **Build-time packages and private doors:** packages are signed, reviewed and pinned into the host build; door credentials are per-app/per-company files mounted only into the backend.
- **Deployment:** external-client and local-appservice Matrix topologies, fail-closed verification, Matrix/files observability, safe expand migration 024, guarded contract migration 025, and updated operator documentation.
- **Evidence:** 601 regression tests, 200-request load, 50-restart chaos, populated migration-025 rehearsal, PostgreSQL 17 dump/restore, real S3-compatible round trip, and a production-mode clean install against real local Synapse are green. The rehearsal includes attested registration, appservice rooms, verifier (12 PASS/0 WARN), a declared read, and a completed typed-Matrix ask. Production Matrix, NEOS UI, GSP and production-data cutover acceptance remain explicit go-live gates.

## neop-ledger 1.5.0 · go-live — 2026-09-27
Ready for the NEOS reasoning agent's Matrix road (neos-agent-neuralchat #143) and a one-command deploy.
- **Approvals in the chat (Shivam's option 2):** an admin may let a named bridge relay yeses (`may_approve`); its go-ahead approves only the card Ledger just showed in that DM, bound to the fingerprint and expiry, deterministic yes/no words, amounts must match, approver policy applies; a refused plain go-ahead re-shows the still-open card. Plain declines bind to the card (explicit decline words only). Reply deadline 55 s.
- **Bridge answers need `key: value`** unless threaded; a question never swallows a new request.
- **New companies get a starter chart of accounts** (Indian SME, 38 accounts).
- **Deploy kit:** `scripts/deploy.sh` (idempotent; pre-upgrade backup, attested registration, starter chart, allowlist, verify, smoke), `deploy/compose.matrix-external.yml`, `deploy/production.env.example`, `docs/GO-LIVE.md`, release attestation in `deploy/attestations/`.
- **Tools:** `scripts/neuralchat-sim.ts`, `scripts/live-validate.ts`, `scripts/verify-install.ts` (read-only per transaction — a session SET leaked read-only mode through PgBouncer; guard test added).
- **Inherited from Shivam's live testing:** aging to today, no duplicate approvals, "did you mean …?", questions list required fields, plain Matrix answers.
- **Answers and attached documents belong to their job** (and its follow-ups) — found by the live validator.

## neop-ledger 1.4.0 · validated against the plan — 2026-09-27
Every plan item traced to working code and a test; each gap fixed and run live (`docs/DRIFT-PLAN.md`, third pass).
- **Runtime:** job-keyed model budget; version and switch re-checked at execute; timers and schedules; rolling summary; untrusted wrapping for every outside text; the 40-call and session limits tested.
- **Platform:** no stuck approvals; `ability_version` in tokens; model-based NeuralChat routing; conformance attestation at registration; durable key rotation; registry author signatures, four-eyes, install self-tests, audited drop; ACL and switchboard pushes retried; `tasks.open` retried for a window.
- **GST:** GSTR-3B from the books, filed through a GSP after a person's yes.
- **Ops:** nightly backups, Jaeger/Prometheus/Grafana, egress allow-list, CI netcheck, migration safety lints, dedicated-DB tier, live kill -9 chaos.
- **Inherited from the arch-shiv Ledger:** Matrix client road (bridges never approve), opening balances, settings, aging analysis, cash forecast, tax return per regime, exports, paid expenses, bank match/ignore, documents door (PDF/XLSX/CSV, no model) wired through attachments on an ask, legacy import.

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
