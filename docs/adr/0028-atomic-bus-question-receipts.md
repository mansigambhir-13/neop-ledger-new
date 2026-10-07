# ADR-0028: Atomic bus questions and persistent question identity

Date: 2026-10-05. Status: implemented locally; not production-certified.

## Problem and reproduced evidence

The outgoing-task question receiver committed bus_threads.question separately from the ready wait, step/outbox and final inbound receipt. Injected step or receipt failure returned HTTP 200 with partial state and an eager typed:received receipt. Concurrent events for one question could create duplicate ready waits. A peer repeating an answered wait ID under a new event could reopen it; questions after job cancellation still mutated history.

Five Pay assertions reproduced these defects before the runtime fix. The initial fixture could not exercise a2a.answer because shipping fleet manifests expose no tasks.open target. A synthetic target was added only to the test's in-memory definition; the corrected pre-fix run reproduced all five failures. No shipping manifest or domain capability was enabled.

## Decision

Extend ADR-0027's transaction to validated neos.neop.ask questions without a borrowed call, received from the verified NEOP sender in the company's bus room. Resolve the outgoing task by company, room, peer and thread root. Claim the event, lock job then thread, recheck live job/thread state, and commit question, ready wait, step/outbox and final receipt together. Transaction failure returns the dedicated retryable error and HTTP 503. No network or model operation runs inside this transaction.

Store the accepted peer question wait ID in the final receipt detail and wake data. Under the same job/thread locks, look for a prior accepted receipt scoped by company, job, task and peer wait ID. This keeps a repeated question from reopening after a2a.answer clears the active question. An identical current question also counts as seen, covering pre-upgrade questions still present on their thread. Different event IDs with the same accepted wait ID cannot replace the first question, even if text changes. Distinct later wait IDs remain eligible; this is not a new question-supersession policy.

Reuse the existing inbound_events job index and storage; no migration or unbounded result materialization is added. Receipts are part of deduplication history: retention/erasure must preserve an equivalent durable identity or explicitly define what replay guarantees end. This change does not certify that policy.

## Tests and boundaries

Twelve synthetic cases per app cover transaction failure, restart/redelivery, concurrent duplicate IDs, answered-question replay, cancellation before/during receipt, malformed/missing-root/foreign sender/company rejection, overlapping same-event rollback, polling after the exact fixture LISTEN connection is terminated, distinct subsequent questions and terminal-result-before-question ordering. Real PostgreSQL, runner and gate are used with fake Matrix/model transports and seeded outgoing receiver state. The in-memory fixture-only tasks.open target permits a fresh assistant to invoke the existing a2a.answer tool; production fleet manifests are unchanged.

This is not a general durable Matrix inbox, new domain borrowing, provider dispatch or live acceptance. Incoming answers to the callee's own input question and other ingress paths are separate. Outbound a2a.answer still has separate wait/send/finalization boundaries, including possible send/recovery and concurrent-question races; this checkpoint does not claim to fix them. A2a deadlines/late replies to live jobs, mixed-wait behavior, early questions before root_event_id is persisted, generic dependencies and multi-host/in-flight crash recovery remain open.

Historical eager receipts, partially committed questions/results and answered questions whose old receipts lack question_wait_id are not backfilled or automatically replayed. Recovery needs reviewed content binding and tenant scope, not inferred identity. Existing unexplained Pay approval wake-count and Ledger presence failures are not claimed repaired by these green tests.

## Rollout

Quiesce/drain old question and result receivers for a coordinated backend upgrade; old processes can acknowledge failures and use different lock sequences. Mixed-version rolling compatibility is not certified. Preserve the t023/corrected input-expiry-worker coordination requirement. Refresh current-source artifacts before release. Business policies, provider certification, source parity, privacy/legacy conversion and real Matrix/model/UI acceptance remain incomplete. Deployment stays with the user's team.
