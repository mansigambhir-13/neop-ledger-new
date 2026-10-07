# Fleet V3 rebuild — sixteenth implementation checkpoint

Date: 2026-10-05. Branch: rebuild/fleet-v3. Starting commit: 0aeb6ac76794360311ac24d6c07b9e770a4d6a14.

## Scope

Incoming cross-NEOP question receipt/thread/wait/step/outbox changes are now atomic, with HTTP 503 on transaction failure and job-before-thread locking. Accepted peer wait IDs are retained in receipt history so a new event cannot reopen an answered question. ADR-0028 records the design and boundaries.

Twelve synthetic receiver cases per app (216 total) cover all eighteen schemas. They seed outgoing receiver state and add a synthetic tasks.open target only to an in-memory test definition, allowing the fresh assistant to invoke the existing a2a.answer tool. No shipping manifest, business ability, provider, migration or source-parity capability changes. All eighteen remain incomplete internal-draft products.

## Verification

Final complete regression: **3,216 passed, zero failed, two existing conditional skips across 295 files**, 549.20 seconds. Started 2026-10-05T12:47:26.154Z. All 216 new cases are included, not additive. TypeScript passed and all 108 pinned source snapshots verified. Completion remains correctly refused: each app has fifteen partial and three pending groups, production_ready=false and full_parity=false.

The twelve cases cover step/final-receipt rollback, exact-event retry after restart, simultaneous different events for one question, answered wait-ID replay, cancellation before and while waiting on the job lock, malformed/missing-root/wrong-peer/wrong-company events, overlapping same-event rollback, polling after terminating the exact fixture LISTEN connection, a distinct subsequent question without old-ID replacement, and terminal results before/queued ahead of questions. Question data remains untrusted. No proposals, provider operations or real messages are created by these fixture answers.

Earlier focused runs passed 41 tests across six files, twelve expanded Pay cases, and 252 tests across 23 files. The six-test catalog rerun after documentation also passed. They overlap the full run, not additional passes. The expanded/targeted runs preceded a test-only TypeScript correction; the final frozen-source complete run is definitive. Existing Ledger/Marketing hand-off/question/borrowed read/write and early-result regressions are included.

The two existing conditional skips concern matching PostgreSQL dump/restore tooling and a real S3 endpoint, not backup/storage acceptance. No failing test was skipped or timeout weakened.

Evidence: docs/evidence/FLEET-V3-CHECKPOINT-16-BUS-QUESTIONS.json. Raw reports: /Users/mansi.gambhir/Documents/Codex/2026-09-28/lo/work/fleet-v3-checkpoint-16-*.json. The full report SHA-256 is 18e6c87e07d4364bc3dd36ebc8a4929fba36281fd6b6941285392d0c13de50fd. All 24 changed runtime/test source hashes were frozen before the definitive full run and verified afterward.

## Diagnostic history

The first pre-fix run had five failures: four runtime assertions and a fixture timeout because the fleet's shipping manifests do not expose a tasks.open target. After adding only the in-memory synthetic target, the unchanged runtime failed all five assertions: injected step/receipt failures returned HTTP 200 with partial state; competing question events produced duplicate ready waits; an answered wait ID could reopen; and a cancelled job's question/history changed.

An initial complete run was deliberately interrupted with SIGINT/exit 130 after TypeScript caught a UUID comparison mismatch in the new second-question assertion. It has no complete JSON report or claimed pass total. The comparison now uses equality against each UUID, preserving the exact two-answer assertion. TypeScript passed, the 24 changed runtime/test source hashes were refrozen, and the complete run restarted. No runtime semantics changed after the 252-test targeted run.

After the interruption, four synthetic databases remained with no active sessions; neos_desk was NOLOGIN, NOBYPASSRLS and NOSUPERUSER. Only this turn's owned isolated cluster was reused. Older Pay approval wake-count and Ledger presence failures remain unexplained, not repaired by green reruns.

The debugging/testing guidance required valid pre-fix reproductions. Code-review guidance focused on company/room/peer boundaries, locking, duplicate identity and answer-finalization limits. Documentation guidance keeps these scoped results separate from product readiness.

## Fixture cleanup

Only this turn's owned container neop-fleet16-20261005 (neop.fixture=fleet-checkpoint-16; exact ID in evidence) was used: cached PostgreSQL 17, loopback-only ephemeral port, tmpfs and no persistent mounts. After the final run no test sessions remained. Four inactive synthetic databases from the interrupted attempt remained; they were discarded with the container. neos_desk remained NOLOGIN, NOBYPASSRLS and NOSUPERUSER. The container and fixture credentials were removed and the label inventory was empty. Synthetic data is not recoverable; all reports remain. No shared cluster, unrelated fixture or production credential/database was used.

## Remaining work and handoff

This is not a general durable inbox. Outbound a2a.answer still has separate wait/send/finalization transactions; its crash and concurrent-new-question behavior needs reproduction and a content-bound recovery design. Incoming answers to local input questions, live-job deadlines/late results, early questions before the root is persisted, generic dependencies and mixed-wait ordering remain open. Receipt retention must preserve equivalent deduplication identity; no privacy/erasure certification is implied.

Old eager receipts, partial questions/results and old answered receipts without question_wait_id are not automatically repaired. No claim of mixed-version rolling compatibility: quiesce/drain old question/result receivers, retain coordinated t023/input-expiry-worker rollout and refresh current-source artifacts before release.

Business authorization needs owner decisions on eligible/elevated approver roles, amount/currency limits, self-approval and historical/nonhuman handling. Complete workflows, source parity, provider contracts/credentials, privacy/legacy conversion, production restore/DBA approval and real Matrix/model/NEOS UI/provider acceptance remain outstanding. Deployment stays with the user's team. Root integrate/v3 and the separate Ledger release checkout are untouched; no push, merge or deployment.

Next safe slice: reproduce outbound re-answer send/finalization and concurrent-new-question or live-job deadline behavior; inspect mixed-wait expiry locking before any changes. Use a new owned disposable fixture and preserve failing evidence.
