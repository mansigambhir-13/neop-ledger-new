# ADR-0026: Atomic input-answer deadlines and cancellation ordering

Status: Proposed; locally implemented, not production or business-policy approval.
Date: 2026-10-05.
Review owners: platform waiting/identity owners and DBA; sign-off outstanding.

## Context

V3 sections 5–7 and the assistant constitution require persisted questions, sourced answers, explicit expiry and a resumed job. The shared t013 answer_wait used transaction-start time and acquired the job lock only after writing answer facts. Four Pay fixture races reproduced late/cancelled input being accepted with HTTP 200 instead of HTTP 409.

Code review also found an opposing lock order: answer_wait held the wait while waiting for the job; cancel_job holds the job before updating waits. A tenant-scoped race against the real cancellation function reproduced HTTP 500 instead of a stale answer. A first attempt lacked tenant context and failed before reaching the race; both reports are retained.

Reviewing the job-first answer fix against the expiry worker then reproduced PostgreSQL 40P01: input expiry still held the wait before acquiring its job for step sequencing. The first HTTP test never reached this database race because the Desk projection already refused the expired question; a direct role-scoped answer call exposed it.

## Decision

Add forward-only t023, replacing only answer_wait with its existing signature, owner, grants, tenant isolation, validation and replay contract. Do not edit applied migrations or historical rows.

Discover the question's job without locking the wait, lock that job, then re-read and lock the wait. Refuse a missing or reassigned question instead of acting under the wrong job lock. Fresh job status and question state are checked before writing. This matches cancel_job's job-then-wait order for the tested question-only lifecycle; it is not an audit of every proposal/executor lock path.

The runner's input-expiry query now materializes eligible job rows under an ordered FOR UPDATE SKIP LOCKED selection before updating questions. Busy jobs stay pending for a later pass. Concurrent passes cannot record the same question outcome twice. Only input expiry changes; proposal, timer, a2a and scheduled-job expiry semantics are untouched.

Use wall-clock expiry after row locks and immediately before returning a new answer. All answer mutations are inside a PL/pgSQL exception block. A private PZ001 signal rolls back that block if a later fact/step/outbox lock crosses the deadline, then returns the existing stale result. It must not abort or erase unrelated work in the caller's enclosing transaction. A real role-scoped test verifies that boundary.

PostgreSQL documents the difference between transaction-start and wall-clock time in its [date/time reference](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT), and rollback of changes inside a caught exception block in its [PL/pgSQL exception reference](https://www.postgresql.org/docs/current/plpgsql-control-structures.html#PLPGSQL-ERROR-TRAPPING).

Changing only the first time check would miss later lock waits. Throwing an uncaught expiry error would change the stale-return contract and could abort callers. Keeping the previous wait-then-job order would retain the cancellation collision. This additive function replacement addresses the reproduced paths without rewriting historical data.

## Boundaries

- Matching recorded answers remain idempotent even after expiry; they are not fresh late answers.
- Human answers become sourced information, not business authorization. Relay answers remain untrusted data. Trusted internal actor strings are not proof of live Matrix identity.
- No approver roles, monetary limits, self-approval, historical/nonhuman policies or provider dispatch are invented.
- A trusted caller may still hold its transaction open after the function returns. This is not a commit-time deadline or a substitute for execution-time checks.
- Broader cancellation/proposal/executor ordering, other wait kinds, lost notifications, active-session crashes and real transport/client races are not certified.
- Historical images and DBA bundles predate t023; refresh and obtain review before release.
- The migration and corrected runner must ship in a reviewed coordinated upgrade. An old input-expiry worker retains the opposite lock order; mixed-version rolling operation is not certified. The team must rehearse quiescing/draining old workers, applying the migration, and starting current-source workers before go-live.

## Verification and follow-up

Fifteen scenarios per app exercise human/relay input, validation/isolation, replay and competing answers, restart/single wake, late wait/job/facts locks, cancellation, expiry-worker contention/concurrent passes, reassignment and caller-transaction preservation. Four populated synthetic V3 upgrades (Pay, Buy, Renew, Grant) preserve history and function ACLs/owner and reapply empty. These are not legacy conversions or production-data restores.

Forced race tests explicitly wait for runner sessions and database transactions to quiesce after stopping future polling, and bind wake counts to the fixture job's first model call. This is controlled test isolation, not a new production shutdown/drain guarantee. An isolated PostgreSQL fixture avoids a shared-cluster role-setting mismatch found in the first completed regression; the original failures remain recorded.

See [checkpoint 13](../FLEET-V3-CHECKPOINT-13.md) for executed results and all failed attempts. Debug and testing-strategy skills guided failing-then-passing local reproduction; code review expanded coverage to real cancellation rather than only direct status mutation. Documentation guidance keeps tested behavior separate from completion claims.
