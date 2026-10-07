# Fleet V3 rebuild — thirteenth implementation checkpoint

Date: 2026-10-05. Branch: rebuild/fleet-v3. Starting commit: d3de5b938d2cb8f242330e610fd70ca35d7b49d3.

Worktree: /Users/mansi.gambhir/Documents/NEOPS_NEW/.claude/worktrees/fleet-v3-rebuild.

## Outcome and limits

Shared input-question handling now refuses lock-delayed answers after expiry or cancellation, preserves atomic answer evidence and uses a consistent job-before-question lock order with cancellation and input expiry. All eighteen gain local synthetic input-lifecycle coverage. This is not business authorization, complete source parity, provider dispatch or production acceptance.

The shared function is replaced through forward-only t023; the runner's input-expiry query also changes. Applied migrations, app business handlers, manifests, source-parity mappings and dependency locks are unchanged. Ledger test expectations account for the new shared migration, and its secret-export test scopes a subprocess to its own fixture. The root integrate/v3 and separate Ledger release checkout are untouched. No push, merge or deployment occurred.

## Implemented

- The answer function locks the job before the question, then re-reads and validates the question. Reassigned questions fail closed. This serializes answers with real cancellation, not merely a direct status update.
- Wall-clock expiry is checked after row locks and after recording evidence. If a later lock crosses the deadline, the nested exception block rolls back answer/fact/step/outbox changes and returns the existing stale result, preserving unrelated work in the caller's transaction.
- Matching recorded answers remain idempotent after expiry; changed answers remain stale. Human input is sourced information, not business approval. Relayed bridge/agent/app answers remain untrusted data.
- Input expiry locks eligible jobs first, skipping busy jobs for the next pass. Tests exercise an answer racing actual expiry, retry after contention and two concurrent expiry passes producing one outcome and wake.
- Fifteen scenarios per app use actual local gate/runner/Desk/PostgreSQL with scripted model/Matrix fixtures. Direct database actor strings exercise the existing trusted interface; they are not live Matrix identity evidence.
- Four populated synthetic V3 books (Pay, Buy, Renew, Grant) preserve input history, function ownership/security settings and role privileges when applying t023; reapplication is empty. This is not eighteen populated upgrades, legacy conversion, a production-data restore or DBA approval.
- Per-app ACCEPTANCE.json links the bounded evidence. All eighteen still have fifteen partial and three pending groups, all eighteen groups unfulfilled, production_ready=false and full_parity=false. These counts are not a completion percentage.

[ADR-0026](adr/0026-input-deadlines-and-cancellation-order.md) records the design and limits. Debug/testing-strategy guidance required failing-then-passing races; code review uncovered the cancellation and expiry lock interactions; documentation guidance keeps implementation and release evidence distinct.

## Verification

Bounded implementation checkpoint, not an all-green full-suite attestation:

| Check | Result |
| --- | --- |
| Completed isolated full regression | 241 files; 2603 passed; 1 fixture-environment failure; 2 existing conditional skips; 1224.49 seconds |
| New tests within that run | All 274 passed: 15 input lifecycle tests per app plus four populated upgrades |
| Corrected Ledger secret-store file | 9 passed; zero failed/skipped; 27.00 seconds |
| Completed shared-cluster regression | 2601 passed; 3 failed; 2 conditional skips; 803.74 seconds |

The isolated full run's one failed fixture inherited the cluster bootstrap URL, which takes precedence over its pilot URL in the export CLI. The test subprocess environment was corrected; the entire nine-test file then passed. Runtime/migration/new-test sources are unchanged from the isolated full run. No clean full-suite rerun was performed after this fixture-only correction; that remains the next verification step. Do not report 2604 passing in a single full run or add overlapping focused totals.

Focused final isolated checks: 56 passed, zero failed/skipped across six files in 32.17 seconds (Pay/Grant/Vet input lifecycle, four upgrades, Grant bundle and unchanged Ledger Desk views). Earlier focused checks passed 35 before full-suite test-isolation review. Catalog: 6 passed in 2.50 seconds. TypeScript passes. Pinned source snapshots: 108/108. Completion gate correctly returns exit 1 with no production-ready apps.

The new distinct tests are 270 lifecycle tests (15 per app) plus four populated upgrades. Focused/catalog tests overlap the full suite; do not add their totals. The two pre-existing conditional checks require real S3 and matching PostgreSQL dump/restore prerequisites; no storage or recovery acceptance is inferred.

Runtime, migration and new-test sources were frozen before the isolated complete run; hashes verify those thirty files stayed unchanged afterward. The only subsequent source change is the existing Ledger secret-export fixture environment, verified by its full targeted file and final TypeScript. No image rebuild or packaged-job rehearsal is claimed. Prior images and review bundles are historical and need refresh for t023 and the runner change before release.

Upgrade constraint: t023 and the corrected runner require a reviewed coordinated rollout. Old expiry workers retain the opposite lock order. Quiesce/drain, migration and current-source worker startup must be rehearsed by the team; mixed-version rolling compatibility is not claimed.

## Failure and correction history

1. Four pre-fix Pay races failed: answers blocked on wait/job/facts locks beyond expiry, or behind cancellation, returned HTTP 200 instead of 409. Six other cases were excluded by the filter.
2. An initial generated t023 closed with a malformed dollar delimiter. Two test suites failed during setup; all twenty cases were unexecuted, not accepted skips. Only the new migration was corrected. The next focused run passed twenty tests.
3. Four upgrade fixtures omitted ready_at on historical ready waits, violating the existing constraint. The fixture was corrected without relaxing the constraint; the next focused run passed 27 tests.
4. The first full run was intentionally interrupted for lock-order review; no complete result is claimed. The first real-cancellation test omitted tenant context and failed with not_found before exercising the race. The corrected fixture reproduced HTTP 500 instead of 409. Job-first locking fixed that path; the expanded focused run passed 31 tests.
5. The second full run was also interrupted before completion when review identified input expiry's opposite lock order. The first expiry race used HTTP and timed out waiting for a database call that the expired Desk projection correctly refused early. A direct role-scoped call then reproduced PostgreSQL deadlock 40P01. Job-first input expiry and contention/concurrency tests corrected that path; the final focused run passed 35 tests.
6. The first completed full run passed 2601, failed three and retained two conditional skips across 241 files in 803.74 seconds. The unchanged Ledger Desk-view test observed neos_desk with LOGIN enabled; that setting was independently observed after the run, while repository migration code enforces NOLOGIN. The setting's changer is not established. No manual role reset was made on the shared cluster. Subsequent verification uses an owned ephemeral PostgreSQL container, not the shared cluster.
7. Two new Vet assertions failed: expiry did not reach the expected blocking point, and a following wake count was two. Review found that stop() stops future polling but does not drain in-flight sessions/expiry transactions, and the helper counted all model calls from all jobs. The helper now waits for runner sessions/connections to quiesce and counts only first calls for its uniquely tagged job. Exact lock ownership at the earlier Vet failure was not captured; these are addressed fixture-isolation gaps, not a claim to have proven production shutdown safety. No wait timeout or runtime deadline was increased. The isolated focused rerun passed 56 tests.
8. The isolated full run passed 2603 and failed only the existing Ledger export-door-secrets fixture, with two conditional skips. All 274 new tests passed. The fixture set NEOS_DB_URL to its pilot but inherited NEOS_ADMIN_URL pointing to the cluster bootstrap database; the CLI deliberately prefers the admin URL. Its subprocess now explicitly sets the pilot admin/database URLs and generated fixture keys and removes inherited *_FILE overrides. The complete nine-test file passes. No CLI/product behavior or assertion was weakened. There is no subsequent all-green full-run claim and no failure was hidden by automatic retries.

Checkpoint 12's intermittent Ledger presence-go-ahead refusal-message failure remains an unconfirmed historical issue; a later passing run cannot establish its cause or repair.

Machine-readable reports and source/report hashes: docs/evidence/FLEET-V3-CHECKPOINT-13-INPUT-LIFECYCLE.json. Raw reports remain under /Users/mansi.gambhir/Documents/Codex/2026-09-28/lo/work/. The staged secret scan and local commit are recorded in the handoff.

Two exactly identified empty test databases left by the malformed-migration setup were removed after verifying their creation/migration times, empty tables and no active sessions. That temporary state is not recoverable. Other older fixture databases were not deleted; no global cleanup claim is made for interrupted runs. No user or production data was removed.

Final verification used the cached postgres:17-alpine image (PostgreSQL 17.11, ARM64) on a random loopback-only port, a unique container label/name, and tmpfs data. No production restore or live service was involved. Zero residual pilot databases and the expected NOLOGIN/no-bypass/non-superuser Desk flags were checked before scoped cleanup. Fixture identity and cleanup are recorded in the evidence/handoff; the shared cluster was not manually remediated.

## Remaining work and next step

1. Business lifecycles and original-proposer/decision binding remain unimplemented. Owners must specify approver roles, amount/currency limits, self-approval and historical/nonhuman handling. Internal admin/member checks are not payment, purchase or renewal entitlements.
2. First run a clean complete regression on an owned isolated cluster after the fixture-only correction; preserve failure reports and do not manually reset shared-cluster roles. Then the next safe implementation slice is persisted timer/dependency/a2a wait expiry, cancellation and recovery, including competing claims and lost-notification fallback. Inspect existing coverage first and reproduce failures before changing semantics. Broader mixed proposal/executor/cancellation lock ordering, multi-host claims and in-flight effects are not certified here.
3. Full legacy entity/configuration/dashboard/deliverable parity and reviewed provider payload/idempotency/read-back/unknown-outcome contracts remain. Keep dispatch absent until policies and contracts are approved.
4. Legacy migration, immutable-history retention/access/export/erasure, production-sized restore/recovery and DBA/privacy review remain. The function does not enforce a deadline at outer transaction commit if a trusted caller holds that transaction open after return.
5. Refresh current-source release artifacts and DBA bundles before release. Team-owned acceptance still needs real Matrix/model/mailbox/connected doors/object storage/NEOS UI, provider sandbox certification and operational/domain/DBA ownership. Deployment remains with the team.

All eighteen remain incomplete. Continue hourly work and updates; no fleet-complete notification or automation pause is warranted.
