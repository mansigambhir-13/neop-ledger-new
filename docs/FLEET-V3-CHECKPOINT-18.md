# Fleet V3 rebuild — eighteenth implementation checkpoint

Date: 2026-10-05. Branch: rebuild/fleet-v3. Starting commit: a04ded9d9d926235273ea6209ec4ceb2bb80300b.

## Scope actually delivered

a2a.answer now requires the expected peer question_wait_id. Contract version 2 refuses absent/malformed identity and refuses stale or cross-task identity under job-before-thread locks before preparing a return wait or calling the bus. It cannot silently attach an old answer to a newer question. Current-job pending outgoing questions are rebuilt into fresh assistant context, including after asking a person and restarting; opaque IDs and question contents stay inside escaped untrusted-data blocks.

This is question-identity binding and persisted context recovery, not immutable answer-content binding, idempotent return-wait reuse or crash-safe send recovery. No migration, shipping manifest, domain/provider capability, business approval policy or source-parity change. All eighteen remain incomplete internal-draft products.

## Verification

Final complete regression: **3,637 passed, zero failed, two existing conditional skips across 314 files**, 784.27 seconds. Started 2026-10-05T16:23:20.532Z. All 205 new cases (eleven per app, 198, plus seven shared contract cases) are included, not additive. Full report SHA-256: afe3d2b7c508ae575d3ba0d8daa31e49b48b815365e6e96a679d28df46515a90.

The first complete run had 3,636 passes, one failed legacy bus-room fixture and two conditional skips across 314 files (803.81 seconds). The 644-pass targeted run across forty files preceded that test-only caller correction. The corrected bus-focused run passed 42 tests across four files; these runs overlap the complete regression. TypeScript passed. All 108 pinned source snapshots verify; the complete-product gate correctly returns nonzero. Nine runtime/test source hashes were frozen for the first full run; ten were refrozen before the definitive complete rerun after correcting the legacy test caller. The existing conditional skips concern matching PostgreSQL dump/restore tools and a real S3 endpoint, not certified backup/storage acceptance.

New per-app coverage: stale question already present; legacy call without identity; four malformed identity cases; identity from another task; question changed between gate admission and preparation; opaque ID escaping with fresh-assistant recovery; valid-wire Unicode identity; and human-input/restart recovery using only persisted context. The latter also excludes foreign-company, other-job, incoming, borrowed-call, closed, rootless and missing-identity threads from the new context surface. The seven unit cases verify contract version/required keys, strict argument validation and exact opaque IDs.

Fixtures seed outgoing state, use real PostgreSQL/gate/runner/receiver, and only fake Matrix/model transports. A synthetic tasks.open target is declared in memory only. The Marketing/ Ledger human relay regression no longer supplies remembered task/question IDs from a cross-session test closure. None of this is live acceptance or new production borrowing.

## Retained diagnostic history

- Three selected assertions failed on the unchanged checkpoint-17 runtime: stale calls and missing identity were accepted, including a change between gate admission and preparation. Twelve cases were excluded by the test-name filter, not disabled.
- The initial fixed focused run passed 28 tests across three files.
- The first context reproduction timed out because the fixture waited for database BLOCKED rather than DONE for a blocked-result report. The corrected fixture uses the API question ID (looked up by its wait ID), waits for the actual database state, and then reproduced the missing persisted-context assertion. Both reports remain; each selected run excluded fifteen cases.
- Expanded focused result: 34 passed, one fixture SQL-parameter error. Its copied bus-thread insert reused a UUID parameter as text without an explicit cast. TypeScript separately caught an overly narrow inferred UUID type for opaque IDs. Fixture-only corrections retain assertions and timeouts; corrected focused run: 35 passed.
- The first fleet-targeted run passed 626 tests across forty files.
- The exploratory Unicode run passed one model-contract test and failed one setup assertion: the 200-emoji question was rejected at typed ingress, before any answer gate call. It did not reproduce a new gate defect. Inspection showed the existing wire validator counts UTF-16 code units while JSON schema counts code points. The corrected valid-wire fixture uses 100 supplementary characters (200 code units); the broader discrepancy remains open. Twenty-eight cases in that exploratory run were name-filtered out, not acceptance skips.
- Final targeted result: 644 passes across forty files. No failed case was disabled; no timeout was increased. Runtime/test sources were frozen after all fixture corrections.
- The first complete regression then had 3,636 passes, one failure and two conditional skips. apps/ledger/tests/bus-room.test.ts still parsed the old prompt string and called a2a.answer without explicit question identity. A selected diagnostic reproduced FAILED with five interrupted attempts; stored steps reported the scripted model's null-regex error, and job/session/claim/result evidence is retained. The corrected scripted caller reads a2a.answer_context and supplies its explicit IDs; its existing completion/result/thread/operation assertions and timeouts remain intact, with failure-only diagnostics added. No runtime change for this correction. The corrected four-file run passed 42 tests. Earlier Pay/Ledger intermittent failures are not attributed to this deterministic fixture parser bug.

Earlier Pay approval wake-count and Ledger presence intermittent failures remain unexplained, not repaired by green reruns. The debugging skill required reproducible failures before fixes; code review caught untrusted-ID handling and context recovery; documentation guidance keeps implementation evidence separate from readiness.

Reports and hashes: docs/evidence/FLEET-V3-CHECKPOINT-18-QUESTION-BINDING.json and /Users/mansi.gambhir/Documents/Codex/2026-09-28/lo/work/fleet-v3-checkpoint-18-*.json. Earlier evidence remains unchanged.

## Owned fixture and cleanup

Verification used only this turn's owned neop-fleet18-20261005 container (label neop.fixture=fleet-checkpoint-18), cached PostgreSQL 17, loopback-only ephemeral port, tmpfs and no persistent mounts. After tests there were zero residual synthetic databases and zero active test sessions; neos_desk remained NOLOGIN, NOBYPASSRLS and NOSUPERUSER. The owned container and synthetic credentials were removed, and the label inventory was empty. Synthetic database contents are not recoverable; reports remain. No shared cluster, unrelated rehearsal fixture or production database/credential was used.

The six-test catalog rerun after the checkpoint/per-app documentation passed. Frozen runtime/test hashes were checked again after the full run. The exact staged patch is secret-scanned before commit; its digest and result are recorded in the external handoff to avoid a self-referential patch hash.

## Next work and release boundary

ADR-0030 records the decision and proposed next intent/recovery invariants. The existing bus key/outbound event record does not compare retry content. Preparation/send/finalization remain separate; a failed send or final step can leave a separately prepared wait. Next reproduce changed-content retries and duplicate return-wait creation, then implement a reviewed immutable tenant/job/thread/question/content-bound intent and idempotent wait reuse. Do not infer historical content, reassign old waits or automatically replay old records.

There is still no enforced semantic binding between a person's answer and a peer question version. Pending context is bounded to ten records and is not an exhaustive discovery API. Live deadlines/late replies, generic dependencies/mixed waits, early questions before root persistence, other ingress, retention-safe dedupe/privacy and historical recovery remain open. In-flight messages may reach peers after local cancellation/ownership changes; local checks cannot unsend them.

The v2 tool contract is breaking: drain old assistant sessions and answer senders, then coordinate refreshed backend/assistant artifacts. Old v1 calls are refused, not guessed; old backends do not enforce v2. Mixed-version rolling compatibility is not certified. Preserve old question/result-receiver coordination and t023/corrected input-expiry-worker coordination.

Owner decisions are still required on eligible/elevated approver roles, amount/currency limits, self-approval and historical/nonhuman handling. Complete business workflows, providers, source parity, privacy/legacy conversion, production restore/DBA approval and real Matrix/model/NEOS UI/provider acceptance remain open. All eighteen retain fifteen partial and three pending groups, production_ready=false and full_parity=false.

No push, merge or deployment. Root integrate/v3 and the separate Ledger release checkout remain untouched. Deployment belongs to the user's team.
