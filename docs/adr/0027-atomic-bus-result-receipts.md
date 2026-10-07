# ADR-0027: Atomic terminal bus-result receipts

Date: 2026-10-05. Status: implemented locally, not production-certified.

## Problem

The result receiver committed its thread before readying the wait and writing operation/step evidence. A later failure left a terminal thread with a pending wait. The eager inbound receipt and HTTP 200 made exact-event redelivery a duplicate. Concurrent distinct replies could both observe an open thread and produce two ready waits; replies after cancellation still changed thread/history.

## Decision

For validated NEOP task results and answers to outgoing borrowed calls in the verified company bus room, insert the event receipt and update thread, wait, operation, step/outbox and final receipt outcome in one runner transaction. Lock the job before the thread and waits; recheck state after locking. Match company, room and peer explicitly. An event ID remains unique, and a terminal thread accepts no competing result. A cancelled/terminal job records only a stale receipt.

The result-specific transaction precedes generic eager inbound claiming. A failed transaction raises a dedicated retryable error; the appservice finishes processing its batch but returns HTTP 503, so the homeserver can redeliver. A concurrent delivery of the same event waits for the receipt transaction and can proceed if that transaction rolls back. Already committed events are deduplicated.

Align outgoing hand-off/re-answer finalization with job-first locking. Network sends remain outside database transactions. Preserve the existing early-result path while the sending thread has no recorded root.

## Limits and rollout

This is not a general durable Matrix inbox. Questions, input answers and other ingress paths retain separate recovery gaps. Historic eager receipts/partially completed threads are not repaired automatically; any recovery requires an audited, content-bound plan. A2a deadlines and late replies to still-live jobs retain existing semantics. Mixed wait types, multi-host fencing, broad outage/kill testing and real Matrix acceptance remain open.

No migration, provider, manifest or business-policy change. Refresh all backend artifacts before release. Drain/quiesce old result receivers for a coordinated rollout: old processes still acknowledge failures and use different lock sequences. Mixed-version rolling compatibility is not certified. The separate t023/input-expiry-worker coordination requirement remains.

Synthetic tests exercise seeded outgoing receiver state under every app schema, not new domain hand-offs. Existing Ledger/Marketing tests retain real local gate/task/question/borrowed-read/write paths with fixture transports. All eighteen products remain incomplete.
