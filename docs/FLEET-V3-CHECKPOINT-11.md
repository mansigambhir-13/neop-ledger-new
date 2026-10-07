# Fleet V3 rebuild — eleventh verified implementation checkpoint

Date: 2026-10-01. Branch: rebuild/fleet-v3. Starting commit: 1b2567e963ee5a48078266d682a3b3901fd75779.

Worktree: /Users/mansi.gambhir/Documents/NEOPS_NEW/.claude/worktrees/fleet-v3-rebuild.

## Outcome and limits

Clear, Reach, Desk, Hire, Deal, Grant, Shift, Sync, Post, Roster, Quote, Sign, Guard, Vet and Asset now opt into the internal-write authority and immutable draft-origin safeguards already implemented for Pay, Buy and Renew. All eighteen have these prerequisites; none is a complete business workflow or production-ready product.

No new business ability or provider dispatch is enabled. Existing shared t020/t021 migrations and their runtime helpers are unchanged. The fifteen apps keep their own business schemas, domain calculations and read contracts. Ledger/Wage and Pay/Buy/Renew application code, dependency locks, the root integrate/v3 checkout and separate Ledger release checkout are unchanged. Nothing was pushed, merged or deployed.

## Implemented

- Every existing settings/import/cancel handler in the fifteen apps requires a recorded person-approved proposal and rechecks exact content, current linked requester/approver identity, configured roles/four-eyes, switch-off and expiry inside the effect/receipt transaction. Standing grants cannot substitute for a person. Locks remain until commit. This checks the current internal-write job requester, not original-business-proposer separation for a future business decision.
- Prepare handlers set a transaction-local creating-job reference from authenticated backend context. Their app-specific forward 004 migrations attach the existing t021 trigger to the correct business draft table. The private company-isolated origin binds job, original human when known, explicit linked/represented/nonhuman basis, draft hash and timestamp. No document/model actor field is trusted.
- Historical drafts remain without an origin row; no guessed backfill, rehash or rewritten snapshot occurs. New origin/draft/receipt writes are atomic. Replay and cancellation do not change provenance; raw app-role draft insertion without context is refused. App origin mutation and direct function execution remain denied.
- Origin linkage is tagged as personal data but not duplicated in public reads, receipts or model output. Retention/erasure/export is still an owner-reviewed design gap, not certified by tagging.
- The fifteen manifests advance from 0.1.0 to 0.2.0; their existing write abilities advance from 1.0.0 to 1.1.0. No applied migration is edited. Grant's DBA-bundle expectation now includes its app 004 migration.
- Shared tests accept app-specific settings or no settings. Authority tests use internal master imports for these fifteen; the finance settings cases retain their assertions. Existing workflow concurrency now uses a real creating job and verifies one matching origin. Repository rollback and stale-domain-hash tests still exercise the domain error rather than accidentally passing on the earlier authority refusal.

ADR-0024 records the reuse decision and required owners. Architecture, testing-strategy and code-review skills guided the limited opt-in, negative/concurrency/migration coverage and preservation of meaningful domain assertions.

## Verification

| Check | Result |
| --- | --- |
| Complete regression | 203 files; 2110 passed; 0 failed; 2 existing conditional skips; 466.58 seconds |
| Focused Clear/Grant/Asset/Reach plus all fifteen upgrades | 22 files; 273 passed; 0 failed/skipped; 61.03 seconds |
| New authority assertions | 18 per app; 270 total |
| New origin assertions | 19 per app; 285 total |
| New populated upgrades | 15/15 passed |
| TypeScript | PASS, including final rerun |
| All-eighteen guard/version/privacy/provider inventory | PASS |
| Pinned source snapshots | 108/108 verified |
| Completion gate | Expected exit 1; no production-ready apps |
| Owned upgrade database inventory | Zero remaining |

The 570 new tests are included in 2110, not additive. Focused tests overlap the complete regression. The two existing conditional skips concern real S3 and PostgreSQL dump/restore prerequisites; they are not accepted storage or recovery evidence. No test failed, was newly skipped or had its timeout/success assertion weakened. Runtime/test/migration sources were frozen for the full run; subsequent changes document evidence only. No image rebuilding or packaged-job rerun is claimed as new implementation.

Authority tests cover current role checks, role/link revocation, malformed policy, tightened roles/four-eyes, late switch-off, expiry while waiting for identity locks, standing-grant refusal, forged contexts/arguments, altered yes evidence, receipt replay after revocation and locks through commit. Origin tests cover linked and represented humans, explicit nonhuman metadata, missing/foreign/inactive jobs, malformed/removed/conflicting identities, forged model fields, immutable/tenant/permission boundaries, cancellation/replay, context reset, raw SQL refusal, induced atomic rollback and held job/person locks.

Tests use real local gate/runner/PostgreSQL transactions with synthetic Matrix and model transports. Nonhuman cases deliberately seed synthetic job metadata; this is not live agent-transport acceptance. Platform identity mirrors and authenticated backend job context remain trust boundaries. These tests do not certify privileged concurrent identity-alias insertion, compromised backend credentials or live homeserver role propagation.

The fifteen forward-upgrade tests reproduce pre-004 V3 app schemas while retaining the already available shared template. They seed app-specific domain records, jobs and receipts, apply only app 004, compare prior rows exactly as JSON, deny fabricated app-side attribution, reapply cleanly and preserve historical domain cancellation. They do not certify legacy-source conversion, recent production restore, production-scale recovery or DBA approval. Only owned disposable synthetic databases and temporary schema copies were removed by test cleanup; that temporary state is not recoverable. No user or production data was removed.

Machine-readable evidence and 125 changed-source bindings: docs/evidence/FLEET-V3-CHECKPOINT-11-FLEET-GUARDS.json. Raw reports and hashes are recorded there under /Users/mansi.gambhir/Documents/Codex/2026-09-28/lo/work/. The exact staged secret scan and local commit are recorded in the handoff.

## Remaining work and next step

1. Implement business-state transitions, original-proposer separation in actual decisions, rejection/revocation/supersession/replay and complete domain prerequisites. Team input requested: approved approver roles, amount/currency limits, self-approval rules and historical/nonhuman handling, beginning with Pay/Buy/Renew. Do not turn internal admin/member roles or review warnings into invented business entitlements.
2. Continue source-parity entities, company configuration, dashboards/deliverables and scenario coverage. Clear matching/evidence, Roster balances, Reach consent/suppression and each app's domain-specific requirements remain outstanding. If policy input is still unavailable, safe local lifecycle/expiry/recovery and provider-contract tests can proceed without enabling effects.
3. Add reviewed provider interfaces with exact approved payloads, per-company credentials, idempotency, independent read-back and unknown-outcome reconciliation. No real payment, message, signature, access change, export or filing was executed or enabled.
4. Resolve legacy conversion, immutable-history retention/erasure/export and recovery with domain/privacy/DBA owners. Refresh current-source runtime artifacts and DBA bundles before release; checkpoint 5/7/8 images and previous review bundles are historical, not validation of this source tree.
5. Team-owned acceptance remains: real Matrix/model/mailbox/connected doors/object storage/NEOS UI, provider sandbox certification, production-sized restore/recovery, operational owners and DBA/domain approvals. Broader local active-session/in-flight/concurrent/outage and load coverage is also unfinished. Deployment remains with the team.

Each of the eighteen now has fourteen partial and four pending requirement groups, with eighteen unfulfilled groups and production_ready=false. Partial counts are not a completion percentage. Business-authorization source-parity entries remain pending. Keep hourly work active; do not send a fleet-complete notification yet.
