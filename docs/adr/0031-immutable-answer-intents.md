# ADR-0031: Immutable answer intent and one return wait

Date: 2026-10-05; verification completed 2026-10-06. Status: implemented and locally tested; not release-certified.
Release deciders: runtime owner and DBA; retention/erasure requires the data-policy owner.

## Context and reproduced failure

Checkpoint 18 binds an answer to an expected peer question but not to immutable content. Two assertions failed on that unchanged runtime: after a send and finalization failure, a changed-content retry was accepted, and an exact retry created a third wait rather than reusing the prepared second wait. The existing Matrix transaction key and outbound event ID do not establish the caller's original answer content.

Constraints: company/job/thread/question isolation; current-session checks; no network call under database locks; no guessed historical content; no new shipping domain borrowing or provider effect. This is an internal relay, not human approval or business authorization.

## Options and decision

Keeping only a model warning is small but cannot enforce content identity. Putting mutable answer JSON in the thread loses previous questions and cannot prove immutable retry content. A generic durable transport outbox is broader than this bounded repair and needs sender leases, dispatch/reconciliation and retention policy. Choose a separate immutable answer-intent row with exact JSON answers, tenant/job/thread/question identity, sending Matrix account, room, peer, root and return-wait ID.

Forward-only t024 adds the intent table with forced tenant RLS, composite tenant/job/thread/wait references, unique question identity and return wait, explicit SELECT/INSERT-only app/runner grants and an update/delete trigger. The gate gets only company_id/key column reads on outbound_events to detect a recorded unbound key, not event content. Migration/default grants are verified with real restricted roles. Job/thread/wait scope indexes support those foreign keys. They add storage and migration locks: production duration and DBA approval are not inferred from a small fixture.

Preparation holds job then thread, compares the current expected question, and commits intent plus wait atomically. The first validated answer wins. JSON object property order is irrelevant; strings and value types remain exact. Nonfinite numbers are refused before JSON serialization. Replays compare JSONB content and pinned routing, reuse only the same pending live return wait, and never extend its deadline. They send the stored JSON, not fresh caller serialization. The Matrix account is checked again at send time. All network work remains outside database locks.

Transport error means SEND_UNCONFIRMED evidence in a step, not consumption of the return wait: a result may still arrive. An exact explicit retry can reuse the intent/wait after preparation, uncertain acknowledgement or final-step failure. Fresh assistant bundles expose the scoped prepared answer alongside the current pending question inside escaped untrusted data. No background replay worker is added. Concurrent exact attempts may both reach the transport with the same transaction key and stored payload; there is no new local single-sender lease or independently certified Matrix exactly-once guarantee. A later local finalizer can lose RUNNING ownership after another exact attempt already parked the job; it must not overwrite that state.

## Historical and privacy boundary

New hand-offs explicitly set answer_protocol=1. The migration leaves all historical threads at 0, including apparently unsent ones; old code also defaults new rows to 0. Current code refuses answering those threads and refuses an outbound key without an intent. It does not infer content from an event ID, assign old prepared/consumed waits to an intent, or promote protocol flags. This deliberately sacrifices automatic historical continuation. Recovery needs audited tenant-scoped evidence and owner review, not a blanket UPDATE. This column is a rollout marker, not protection against an old sender still running.

Intents duplicate answer content and may contain personal data. The SQL column comment identifies this; it is not a subject-discovery, manifest-tag or erasure implementation. Generic nulling/deletion would invalidate replay evidence; FK restrictions and immutability intentionally block it. A reviewed retention/subject-access/erasure design preserving equivalent replay identity remains a release blocker. Superuser/DDL intervention is outside the runtime integrity boundary. No retention duration is invented.

## Limits and rollout

This is not a general durable inbox/outbox, automatic repair of historical records, independently read-back delivery proof or a lease that can unsend an in-flight message after cancellation. Only explicit retries while the same question is current and original wait live qualify. Newer/terminal questions stay authoritative. Borrowed-call result sends and other uses of Bus.say remain separate; full wire-event fallback text and transport credentials are not stored in the intent. Token/endpoint rotation and live homeserver replay behavior are not certified. Human-input semantic provenance, peer deadlines/late-result policy, mixed-wait expiry locking, early questions before root persistence, other ingress, source parity and complete domain workflows remain open.

Drain/quiesce old answer senders and active assistant sessions; apply reviewed t024 and refresh matching backend/assistant artifacts. Old binaries do not enforce this protocol. Mixed-version rollout is not certified; returning to old code can bypass these protections. Preserve v2 expected-ID coordination, question/result-receiver coordination and t023/input-expiry-worker coordination. Existing protocol-0 threads require explicit audited recovery or an owner-approved stop/closure plan. No automatic promotion or replay is offered.

## Verification plan and follow-up

Integration tests cover changed/exact retries before and after acknowledgement; concurrent attempts; atomic preparation; finalization rollback; restart from persisted escaped content; route/account changes; expired/ready waits; legacy/unbound histories; JSON ordering and finite numbers. Existing question/result, ownership/cancellation and unrelated-wake tests remain. Populated synthetic upgrade tests verify unchanged historical rows, protocol-0 defaults, constraints, RLS, immutability, narrow grants and idempotent reapplication. A complete source-frozen regression is required before the checkpoint commit. These fixtures are not production restore, legacy conversion, DBA sign-off or live Matrix/model/UI acceptance.

Checkpoint 19 records the final complete regression: 4,019 passed, zero failed and two existing conditional skips across 315 files, including all 382 new cases. It also preserves prior migration-inventory failures, an unresolved Ledger bridge-refusal intermittent and the failed overnight suspension-affected run. A later green run does not establish an intermittent repair. Follow-up: reproduce deadline/late-result and mixed-wait lock-order gaps; design audited history/retention and semantic human-relay provenance. Owner-approved business roles/limits/self-approval/nonhuman policy, providers and all eighteen full product acceptance remain outstanding.
