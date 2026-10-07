# Fleet V3 rebuild — seventeenth implementation checkpoint

Date: 2026-10-05. Branch: rebuild/fleet-v3. Starting commit: 2dbac0df65a47fefcfa5e0b6cf1fba9a802e6a3b.

## Scope actually delivered

Bounded outbound a2a.answer finalization fixes: prepare under job/thread locks; recheck current session ownership before preparation, failure cleanup and finalization; preserve a newer question received during the send; consume only ready waits captured for that session; and report send failure as unconfirmed rather than proof of non-delivery. Final step metadata identifies task, peer question and return wait. ADR-0029 explains the transaction boundaries.

This does not implement a durable outbound intent, complete crash-safe delivery, changed-answer retry enforcement or idempotent return-wait reuse. All eighteen remain incomplete internal-draft products. No shipping manifest, domain/provider capability, business approval, migration or source-parity change.

## Verification

Final complete regression: **3,432 passed, zero failed, two existing conditional skips across 313 files**, 1,006.16 seconds. Started 2026-10-05T15:15:37.083Z.

The 216 new cases (twelve per app) are included in the full result, not additive. They exercise a newer question during send plus fresh-assistant recovery; newly ready/unclaimed waits before and during send; session transfer on success/failure; cancellation while in flight; terminal results before finalization and subsequent assistant/report mirroring; rollback on final evidence failure; transport errors before and after fake delivery; and foreign-company/borrowed-call thread refusal.

Initial answers run through the real gate using a locally acquired runner claim; later question/result recovery uses a fresh scripted assistant. Fixtures seed outgoing thread/wait state and declare a synthetic tasks.open target only in memory. Matrix/model transports are fake. No real messages or provider effects are executed. This is not new production domain borrowing or eighteen complete business workflows.

The corrected targeted run passed 264 tests across 24 files on final runtime/test sources; the earlier focused run passed 20 across four files on intermediate sources. The six-test catalog rerun after documentation also passed. These overlap the full run. TypeScript passed; 108 pinned source snapshots verified; the incomplete release gate correctly exits 1. Every app remains fifteen partial/three pending groups, production_ready=false and full_parity=false.

The two existing conditional skips require matching PostgreSQL dump/restore tools and a real S3 endpoint; neither is backup/storage acceptance. No failing case was disabled and no timeout increased.

Evidence: docs/evidence/FLEET-V3-CHECKPOINT-17-BUS-ANSWERS.json. Reports: /Users/mansi.gambhir/Documents/Codex/2026-09-28/lo/work/fleet-v3-checkpoint-17-*.json. Full report SHA-256: c0fbc96ed5f450e279a66fdfa1da69448db51e55508ecfe7ba22ecff3f67bd5a. Twenty-one changed runtime/test source hashes were frozen after fixture corrections and before the complete run, then verified afterward.

## Failure and correction history

Before runtime edits, three Pay assertions failed: the sender cleared a newer question, consumed a late unrelated wait and finalized after another runner acquired the job. A separate selected run reproduced two false non-delivery assertions before changing transport-error reporting, including an answer already accepted by the fake peer. That name-filtered run excluded ten other cases; those are not conditional acceptance skips or disabled failing tests.

The expanded focused run had 59 passes and one fixture timeout: it checked database JobStatus against API COMPLETED instead of database DONE. The following fleet run had 246 passes and eighteen fixture assertions because it read the asynchronous task mirror immediately after database completion; the API was still ACKNOWLEDGED. The corrected fixture waits for both database DONE and API COMPLETED using the same timeout and retains the completion and consumed-wait assertions. Corrected targeted result: 264 passes. Runtime unchanged for these fixture corrections. All reports and hashes are retained.

Older Pay approval wake-count and Ledger presence failures remain unexplained, not repaired by these green runs. The debugging/testing guidance required reproductions before fixes; code review added ownership/scope and uncertainty checks; documentation guidance keeps test and product-readiness claims distinct.

## Owned fixture cleanup

Only this turn's owned container neop-fleet17-20261005 (label neop.fixture=fleet-checkpoint-17; exact ID in evidence) was used: cached PostgreSQL 17, loopback-only ephemeral port, tmpfs and no persistent mounts. After tests there were zero residual synthetic databases and zero active test sessions. neos_desk remained NOLOGIN, NOBYPASSRLS and NOSUPERUSER. The container and disposable fixture credentials were removed; the label inventory was empty. Synthetic database contents are not recoverable; reports remain. No shared development cluster, unrelated rehearsal fixture, production database or production credential was used.

## Remaining work and next safe slice

Preparation, send and finalization remain separate. A crash/finalization failure can leave a prepared pending wait. No immutable content-bound outbound intent or automatic repair exists; concurrent or changed-answer retries and expected question-version binding are still open. The tool contract carries task ID but not expected peer wait ID, so questions changing before preparation remain a separate binding problem. A warning to the assistant is not runtime enforcement.

A message already in flight can reach the peer after cancellation or session transfer; local finalization checks cannot undo delivery. These checks are not a new wall-clock lease guarantee or global fencing for all gate/hand-off paths. Live-job deadlines/late replies, mixed-wait expiry, dependencies, early questions before root persistence, other ingress, historical receipt recovery and privacy/retention-safe identity remain open.

Next: design and reproduce a content-bound expected-question/answer intent with idempotent wait reuse and precise recovery across send/finalize failures, without enabling domain effects. Inspect existing outbound event keys and historical records; do not infer or automatically replay missing content. Continue other safe work if broader policy decisions block a slice.

Business authorization still needs owner choices for eligible/elevated approver roles, amount/currency limits, self-approval and historical/nonhuman handling. Complete workflows, source parity, providers, privacy/legacy conversion, production restore/DBA approval and real Matrix/model/NEOS UI/provider acceptance remain outstanding. Quiesce old answer senders/question/result receivers for coordinated rollout; mixed-version compatibility is not certified. Preserve t023/input-expiry-worker coordination and refresh current-source artifacts.

Root integrate/v3 and the separate Ledger release checkout are unchanged. No push, merge or deployment. Deployment remains with the user's team.
