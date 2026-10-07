# ADR-0025: Wall-clock deadlines for recording proposal answers

Status: Proposed; local implementation, not release or business-policy approval.
Date: 2026-10-01.
Deciders: platform approval owner, DBA and domain owners; sign-off outstanding.

## Context and reproduction

V3 sections 5–7 require an expired proposal to refuse a late answer, retain the outcome and wake the job. The shared t011 answer function compared expiry with transaction-start time. A valid request could wait on the proposal or job row until after its deadline and still record yes/no/change. Six real Pay Desk/database race tests reproduced HTTP 200 where expiry refusal was required. No live provider was involved.

PostgreSQL distinguishes transaction-start now() from changing wall-clock clock_timestamp(): [official date/time documentation](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT). This is a decision deadline, not a consistent accounting timestamp.

## Decision and options

Add forward-only t022 replacing answer_proposal with the same signature, owner, grants, company isolation, role/four-eyes checks and replay/withdrawal rules. Use wall-clock expiry after acquiring the proposal lock and recheck immediately before a newly recorded answer returns. The second check is essential because subsequent job/step/wait/outbox recording can block. A late result raises the existing expiry error and rolls back the entire function's answer, event, steps, outbox hints and wait mutation. Newly recorded answered_at uses wall-clock time; historical timestamps remain untouched.

Merely changing the first comparison would still permit a later job-lock wait to cross the deadline. Reordering all locks would change concurrency semantics beyond this bounded fix. Rewriting the old migration would break checksums. An additive replacement with an end-of-function check fixes both reproduced cases without those changes.

## Consequences and boundaries

Already-recorded matching answers remain idempotent replays, not new late decisions. Withdrawal remains possible after deadline until execution has started, as required by existing stop semantics. Policy roles, limits and business authorization are not invented or expanded. No provider action, app business ability or release-ready claim is added. The function cannot constrain a trusted caller that deliberately keeps its surrounding transaction open after it returns; execution-time checks remain necessary, including the fleet internal-write authority guard. This does not implement wall-clock changes for other input/grant/timer functions or certify live transport/role propagation.

Applied migrations and all historical data stay unchanged. Shared migration changes require refreshed DBA bundles and runtime artifacts before release; prior images are historical. Review the implementation with platform/DBA owners before production use.

## Verification plan and follow-up

- All eighteen: real local gate/runner/database tests for change-to-fresh-card, stale fingerprints, pending/approved withdrawal, too-late withdrawal, expiry after runner downtime, competing execution/withdrawal and exactly-once outcome.
- All eighteen: yes/no/change blocked on both proposal and later job locks must refuse after deadline; verify no decision evidence, outbox resolution, ready wait or internal effect survives; restart then expires and wakes once.
- Pay, Buy, Renew and reserved-name Grant: populated pre-t022 forward migration preserves historical rows and function privileges, reapplies empty, rejects cross-company lookup and late answers.
- Complete regression, TypeScript, source-hash checks and fail-closed readiness; no skipped failure or weaker timing assertion is acceptable.
- Continue business lifecycles/original-proposer decision binding with owner-approved roles/limits/self-approval/historical/nonhuman policy. Provider contracts, full source parity, privacy/recovery, current-source artifacts and live acceptance remain open.

Architecture/testing-strategy/debug/code-review skills guided the bounded forward migration, failing-then-passing race evidence and replay/rollback/privilege review.
