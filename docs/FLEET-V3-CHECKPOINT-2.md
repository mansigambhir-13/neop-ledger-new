# Fleet V3 rebuild — second verified checkpoint

Date: 2026-09-30. Branch: rebuild/fleet-v3. Starting commit: b285ffd2897ee1c207a8bd0d97929debd4082fc8.
Code remains in /Users/mansi.gambhir/Documents/NEOPS_NEW/.claude/worktrees/fleet-v3-rebuild. The main integrate/v3 checkout is unchanged.

## Outcome

The rebuild has started for all eighteen remaining NEOPs in the documented twenty-app catalog. This is an explicit working roster assumption, not confirmation of the different top-level Quick Build roster. **The fleet is not complete or production-ready.**

| Apps | Verified implementation scope |
| --- | --- |
| Ledger | Existing V3 implementation preserved; no business-code/template changes |
| Wage | Previous payroll vertical slice preserved; remaining parity/certification gaps unchanged |
| Pay, Buy, Renew | Initial V3 internal-draft runtime: 7 closed abilities each, own schema/RLS, reviewed reads, immutable records and transactional receipts; no business authorization or external execution |
| Clear, Reach, Desk, Hire, Deal, Grant, Shift, Sync, Post, Roster, Quote, Sign, Guard, Vet, Asset | App-specific pure domain ports and tests; no runtime, migrations or release registration yet |

Desk in this roster is the support-agent NEOP, not the NEOS My Desk UI.

## Source and requirements evidence

- The attached V3 document matches the repository copy exactly (SHA-256 a82aedf79fd9ecd4fd4e792a92daa81226d34dfaff4a998cb37394d9ee4ffedb).
- Eighteen legacy repositories are pinned by commit, tree and blob in fleet/source-lock.json. All 108 selected source/schema/test files pass SHA-256 verification. They are ignored, read-only reference inputs, not runtime dependencies or Git payloads.
- Every captured core capability and catalog-only entry is mapped in apps/<app>/SOURCE-PARITY.json. Partial ports, retired runtime customization and unimplemented provider/authorization behavior are explicit. Full legacy parity is false for all eighteen.
- fleet/requirements.json traces V3 to 18 acceptance groups. Every app has ACCEPTANCE.json covering each group. Local coverage is scoped; no group is presented as full release certification.
- ADR-0015 applies the architecture skill's separation between shared template, app domain and external effects. The testing-strategy skill led to pure boundary tests, real PostgreSQL integration, replay/restart checks and a separate production acceptance bar.

## Verification

| Check | Result |
| --- | --- |
| TypeScript | PASS after explicitly linking the local testkit dependency for fleet-level tests |
| Complete regression suite | 124 files; 825 passed; 0 failed; 2 conditional skips |
| Final focused workflows + three-app coexistence | 4 files; 35 passed |
| Source snapshots | 108/108 hashes verified |
| Diff and secret review | git diff --cached --check passed; Gitleaks v8.28.0 found no leaks in the staged patch |
| Per-app DBA bundles | Pay, Buy and Renew: 19 migrations each, review-only; no production database connection |
| Pay conformance attestation | Correctly refused: 16 required release suites missing; no attestation generated |
| Fleet completion check | Correctly exits 1: incomplete acceptance and 15 domain-only apps; zero production-ready claims |

The two skipped checks require external S3 and PostgreSQL dump/restore prerequisites. Local integrations use a scripted assistant and fake Matrix homeserver against disposable PostgreSQL databases; they are not real Matrix/model/provider/UI acceptance. The full suite includes existing Ledger and Wage regressions. No test was skipped to hide a new failure.

The first integration iteration caught quoting/API-reference mistakes in the test helper. A concurrency assertion also compared serialized key order, which PostgreSQL jsonb does not preserve; it now compares semantic values and independently counts the one receipt. The added fleet-level test exposed a missing root workspace testkit dependency; it was declared and compilation/focused tests rerun. These were fixed without weakening security controls or suppressing tests.

## What the finance tests establish

Blank installs, ask-first settings/imports/cancellation, no pre-approval changes, exact integer money and currency checks, unknown/cross-company party refusal, duplicate business-source protection, concurrent replay with one receipt, checksum collision refusal, atomic rollback, stale fingerprint refusal, backend restart and runner read-back, immutable draft history, composite tenant foreign keys, unscoped RLS, cross-schema denial, SQL/assistant read parity, bounded pagination and tighten-only switches. Three NEOPs coexist in one database with mutually inaccessible schemas. Reapplying the initial migration set preserves populated test data; this is not a legacy production-data migration rehearsal.

Cancellation cards bind the draft ID/hash and show its source request, party, amount and currency. Drafts cannot enter paid/placed/renewed states. Review flags preserve wire, multi-year and PO-limit behavior; additional amount limits only flag review, never grant authority.

## Required next — not fulfilled

1. Complete the remaining fifteen app schemas, manifests, handlers, blocks and runtime integrations, then each app's full business lifecycle and legacy regression parity.
2. Implement verified human proposer/approver separation and elevated entitlement binding before exposing business authorization. An internal-record approval is not a payment, PO or renewal approval.
3. Build/certify provider adapters with per-company credentials, idempotency and independent read-back. Legacy caller-supplied success flags are not ported.
4. Implement reviewed legacy-to-V3 data conversion, explicit currency/UUID mapping, populated migration/recovery and DBA review.
5. Resolve personal-data retention/erasure, including immutable snapshots and audit histories; tags alone do not implement deletion.
6. Complete per-app release conformance, separate images/network isolation, live Matrix/model/mailbox/doors, real NEOS UI and operational owner acceptance. Deployment remains with the user's team.

Clear contains only source-formula scoring over supplied signals: no live screening, watchlist matcher, KYC decision or SAR certification. Roster's half-days and Deal's basis-point calculation use integer units, but domain-owner acceptance is still required. Local tests do not certify legal, tax, payroll or security policy correctness.

## Reproduce

From the rebuild worktree: pnpm typecheck; pnpm exec vitest run; pnpm fleet:status --summary --check-sources. The source-hash check requires the ignored local reference snapshots; normal tests do not. pnpm fleet:status --summary --require-complete must remain nonzero until genuine completion. DBA bundles are review artifacts, not deployment instructions.

No deployment, provider action, payment, filing or message delivery was performed. This checkpoint is saved locally; it is not a go-live approval.
