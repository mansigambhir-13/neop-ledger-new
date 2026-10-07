# Fleet V3 rebuild — fifteenth implementation checkpoint

Date: 2026-10-05. Branch: rebuild/fleet-v3. Starting commit: 847ffa299857d870eab12516ff1dafd36f0be412.

## Scope

Atomic terminal cross-NEOP result receipts in the shared template, with sixteen receiver tests per app (288 total). All eighteen remain internal-draft products, not complete business workflows or production-ready apps.

ADR-0027 describes the transaction, retry and lock-order changes. No new domain ability, provider dispatch, migration, manifest or source-parity capability is added. The root integrate/v3 and separate Ledger release checkout are unchanged; no push, merge or deployment.

## Verification

Final complete regression: **3,000 passed, zero failed, two existing conditional skips across 277 files**, 509.16 seconds. Started 2026-10-05T11:50:45.405Z. All 288 new cases (sixteen per app) are included, not additional passes. The six-test catalog rerun after documentation also passed (overlapping the full run). TypeScript passed; all 108 pinned source snapshots verified; the fleet completion gate correctly exits 1. Every app still has fifteen partial and three pending requirement groups, with production_ready and full_parity false.

The sixteen cases per app cover both task results and borrowed-call answers: injected step/final-receipt failure and atomic rollback (including outbox), exact-event retry after restart, distinct concurrent replies, cancelled jobs, cancellation queued before reply on the job lock, malformed/unknown-peer/wrong-root/wrong-company events, overlapping same-event delivery when the first transaction rolls back, and real polling after the exact fixture LISTEN connection is terminated. A fresh assistant receives one persisted result as untrusted data; no proposal or provider effect is created.

Earlier targeted runs passed sixteen Pay cases and 308 cases across all eighteen receiver wrappers plus four existing bus integration files. These overlap the complete run. The fleet-targeted run was not source-frozen across the final company/job scope guards; use the frozen final complete run as definitive current-source evidence. Existing tests cover early replies before hand-off returns and the local Ledger/Marketing task/question/read/write paths with fixture transports.

The two existing skips require matching PostgreSQL dump/restore tooling and a real S3-compatible endpoint. They are not backup/storage acceptance. No failing test was skipped.

Evidence: docs/evidence/FLEET-V3-CHECKPOINT-15-BUS-RESULTS.json. Raw reports remain under /Users/mansi.gambhir/Documents/Codex/2026-09-28/lo/work/fleet-v3-checkpoint-15-*.json. The final full report SHA-256 is 38209eb4eef4657e4654ce8b1d16a09bf47ba587bfdd1119a7fdddc755d3ef5b. Twenty-six changed runtime/test source hashes were frozen before the complete run and verified afterward.

## Fixture cleanup

Only this run's owned container neop-fleet15-20261005 (label neop.fixture=fleet-checkpoint-15; exact ID in the evidence) was used. It ran cached PostgreSQL 17 on loopback with tmpfs storage and no persistent mounts. After tests there were no residual pilot databases or pilot sessions; neos_desk remained NOLOGIN, NOBYPASSRLS and NOSUPERUSER. The container and its fixture credentials were removed and the label inventory confirmed empty. Synthetic database contents are not recoverable; reports remain. No shared cluster, unrelated fixture, production credential or production database was used.

## Reproduced failures and scope

On unchanged runtime code, six Pay assertions failed: both terminal reply types left a committed done thread, pending wait, typed:received receipt and HTTP 200 after injected evidence failure; competing distinct replies made two ready waits; replies after cancellation changed result/history. Three earlier six-failure runs found fixture mistakes (illegal direct RECEIVED-to-WAITING setup, SQL parameter type ambiguity and selecting a nonexistent operations result column); these are not runtime defect evidence.

The first post-fix focused run had 22 passes and four fixture assertions counting a final assistant report as an extra bus step. The next had 26 passes and six fixture failures: an existing job-open outbox entry was incorrectly expected absent, and a cancellation blocker lookup assumed the wrong session role. Assertions now distinguish system result steps, compare the pre-existing outbox and observe actual blocking PIDs. Timeouts and runtime assertions were not weakened. Corrected focused run: 32 passes across five files. Reports are retained externally. A source-status command initially hit the sandbox's tsx IPC restriction; it passed with the scoped local execution permission.

Debugging/testing guidance required a valid failing reproduction before runtime changes. Code review drove explicit company/job scoping and lock-order checks; documentation guidance kept historical failures, test boundaries and rollout cautions separate from product readiness.

## Boundaries and next work

New tests seed receiver-side outgoing threads/waits, use fake Matrix/model transports and real disposable PostgreSQL. They do not enable app-specific borrowed abilities or establish external effects, live acceptance or legacy migration.

Next: reproduce a2a deadline/late-result behavior and question/re-answer atomicity; inspect generic dependency wait support and mixed-wait interactions. Historic typed:received receipts and partial terminal threads need an audited recovery design, not automatic replay. No claim that earlier intermittent Pay approval wake-count or Ledger presence failures are fixed.

Owner decisions remain required for business approver/elevated roles, amount/currency limits, self-approval and historical/nonhuman handling. Complete workflows, provider contracts/credentials, source parity, privacy/legacy conversion, current-source artifacts and real Matrix/model/NEOS UI/provider acceptance remain open.

Coordinate current backend rollout with drained old receivers; mixed-version lock/acknowledgment behavior is not certified. t023 and corrected input-expiry workers must still roll out together. Deployment remains with the user's team.
