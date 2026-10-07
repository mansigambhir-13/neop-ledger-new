# ADR-0030: Bind an outbound answer to its expected peer question

Date: 2026-10-05. Status: locally implemented and verified in checkpoint 18. Not release-certified.

## Problem

An assistant prepares an answer for one question. Before its gate call prepares the return wait, the peer asks a different question in the same task. Previously a2a.answer accepted only the task ID, loaded the current question and sent the old answer with the new question's wait ID. Three unchanged-runtime assertions reproduced acceptance of stale answers and calls missing expected identity, including a question change between gate admission and preparation.

Inspection also found that the current wake is not enough context after the assistant asks a person: that input wake replaces the earlier a2a wake. A corrected synthetic test reproduced missing peer context after restart without keeping task/question IDs in the fake model's memory. The existing Marketing relay fixture now obtains IDs from the persisted bundle instead of a cross-session closure.

## Decision

Version the assistant a2a.answer contract to 2 and require question_wait_id as well as task_id and answers. The peer ID is an opaque string, not necessarily a UUID. The backend uses the existing typed-event runtime's 1–200 UTF-16-code-unit limit; the model-facing JSON schema counts Unicode characters. That pre-existing wire-validator/schema discrepancy is not corrected here: an exploratory 200-emoji fixture was rejected at ingress before the gate. The corrected valid-wire fixture uses 100 supplementary characters (200 code units). Capture the supplied task/question IDs before awaiting. Under the existing company/job/direction/kind-scoped job-before-thread locks, compare the expected ID with the current question before preparing a wait or calling the bus. Missing/malformed identity is invalid_args; mismatched identity is stale_question. Never infer a missing ID, silently replace a stale ID or attach the old answer to the new question.

Rebuild up to ten pending outgoing task questions from this job's own company-scoped book in each assistant bundle. Only open task threads with a persisted root and valid string wait identity qualify; incoming, borrowed-call, closed, other-job/company, rootless and unidentified records do not. This restores context after a human-input wake or process restart. It is a bounded context list, not a complete discovery/pagination API or send authority. The gate still checks the current identity transactionally.

Place both wake answer context and pending question context inside the existing escaped untrusted-data boundary. Peer IDs and question text never become prompt instructions. Use the existing bus transaction key; do not introduce another transport or enable any shipping domain hand-off.

## Deliberate limits and next design slice

Expected-question identity is not immutable answer-content binding. Two calls for the same peer question can still offer different answer content. The existing bus key is bus:answer:<thread>:<peer-wait>; Bus.say remembers a delivered event ID but does not compare retry content. A warning to the model is not enforcement. Preparation, send and finalization remain separate; failed sends/finalization can leave a separately prepared wait, and retries do not reuse it idempotently.

The next slice should first reproduce those remaining gaps, then design a persisted tenant/job/thread/question-bound answer intent with exact validated content and an idempotent return wait. Its proposed invariants are: atomically create intent plus return wait; refuse changed content for the same identity; retain identity and content across transport uncertainty and restart; never send while holding database locks; fence finalization by current job/session; preserve newer wakes; distinguish acknowledgement from non-delivery; and record recovery transitions atomically. This is a design direction, not an implemented migration, immutable intent, automatic replay or accepted recovery policy.

Inspect historical outbound rows before defining a forward migration. Existing outbound event IDs do not prove which content a retry intended, and historical consumed/prepared waits cannot be assigned to new intents by guessing. Missing question identity stays missing. Retention must preserve equivalent deduplication/content identity or specify reviewed replay limits; no privacy/erasure certification follows from these tests.

There is no enforced semantic binding between a person's input answer and a peer question version in this change. A current question may supersede the one the person was asked about; the prompt warns against reusing that answer, but durable relay provenance needs its own design and tests. Deadlines, early questions before root persistence, broader ingress/dependency/mixed-wait handling and in-flight sends after cancellation remain open. An already sent message cannot be unsent by local checks.

## Rollout and acceptance

This is a breaking internal tool contract. Drain old assistant sessions and answer senders, and release refreshed backend/assistant artifacts together. A v1 caller without question_wait_id is deliberately refused, not adapted. Old backends do not enforce the v2 check; mixed-version rolling compatibility is not certified. Preserve prior question/result receiver coordination and t023/input-expiry-worker coordination.

No migration, shipping manifest, domain/provider capability, business authorization policy or source-parity mapping changes. All eighteen remain incomplete internal-draft products. Owner-approved approver roles, amount/currency limits, self-approval and historical/nonhuman policy, complete workflows, providers, privacy/legacy conversion, production restore/DBA approval and real Matrix/model/NEOS UI acceptance remain required. No push, merge or deployment; deployment belongs to the user's team.
