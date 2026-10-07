# ADR-0029: Preserve newer wakes during outbound answer finalization

Date: 2026-10-05. Status: locally implemented; not release-certified.

## Problem and evidence

Three unchanged-runtime fixtures reproduced a2a.answer finalization defects: it erased a newer question received while the first answer was being sent, consumed an unrelated wait readied during that send, and committed after another runner acquired the job. Two additional targeted assertions reproduced false certainty: transport failure was described as proof the peer did not receive the answer, including when the fake peer had already received it.

## Decision

Prepare the return wait under job-before-thread locking. Recheck the current company, RUNNING job and owning session; resolve only this company's outgoing task thread for this job. Snapshot the IDs of ready waits claimed by that session. Commit this preparation before any network operation.

After a successful send, recheck ownership under the job lock. Clear the thread question only if its peer wait ID still matches the answered question. A later question or terminal result is retained. Consume only the captured ready IDs still belonging to this job/company/session; newly arrived or unclaimed wakes are still owed. Write the WAITING transition and final step atomically with these changes, including task/question/return-wait IDs in step metadata.

On a send exception, recheck job/session ownership before cleaning up the separately prepared pending wait. Record SEND_UNCONFIRMED, not NOT_OPENED, and report delivery uncertainty. A reply that already readied the return wait is not consumed by that cleanup. A send error does not establish non-delivery. The model-facing warning against changing the answer on retry is not an enforced content-binding mechanism.

No network send occurs under database locks. No migration, shipping manifest, domain/provider capability, approval policy or source-parity change.

## Coverage

Twelve synthetic cases per app cover a next question during send plus fresh-assistant recovery; late unrelated wakes before/during preparation; ownership transfer during successful or failed sends; cancellation during send; a terminal reply before finalization plus fresh-assistant/result mirroring; injected final-step rollback; send exceptions both before and after fake delivery; and foreign-company/borrowed-call thread rejection.

Fixtures use real PostgreSQL, runner claims, gate, bus receiver and session-end handling. The first answer call is driven directly through the real gate using its locally acquired runner claim; subsequent questions/results use a fresh scripted assistant. Outgoing receiver state is seeded. A synthetic tasks.open target exists only in the in-memory test definition. These are not full domain hand-offs, real Matrix/model sessions or production acceptance.

## Deliberate limits

Preparation, network send and finalization remain separate. A crash or finalization exception can leave a prepared pending wait; this checkpoint verifies rollback, not automatic repair or idempotent wait reuse. No durable immutable outbound answer intent exists yet. Concurrent calls and retries with changed answers are not content-bound by the gate, and the current tool contract has no expected peer wait ID. A question changing before preparation can therefore still require explicit version binding. Historical recovery must be audited, not guessed.

A network send already in flight can reach the peer after cancellation or ownership transfer; local fencing cannot unsend it. Ownership checks here compare current job/session identity, not a new wall-clock lease or transport cancellation guarantee. Other gate tools and hand-off paths are unchanged; no universal session-fencing claim.

Live-job deadlines/late results, mixed-wait expiry ordering, generic dependencies, early questions before root persistence and other ingress atomicity remain open. Earlier unexplained Pay approval wake-count and Ledger presence failures are not claimed repaired.

## Rollout and release

Drain/quiesce old answer senders and question/result receivers for a coordinated backend release. Mixed-version rolling compatibility is not certified. Preserve the t023/input-expiry-worker coordination requirement and refresh current-source artifacts. All eighteen products remain incomplete. Approver roles, amount/currency caps, self-approval and historical/nonhuman policy need owner decisions; provider/source parity, privacy/legacy conversion, production restore/DBA and live Matrix/model/NEOS UI acceptance remain outstanding. Deployment belongs to the user's team.
