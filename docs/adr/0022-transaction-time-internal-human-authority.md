# ADR-0022 — Transaction-time human authority for internal finance writes

Status: Proposed; locally implemented for Pay, Buy and Renew. Not business-policy or production approval.
Date: 2026-10-01.

## Context

An exact-content Desk yes does not prove that the approver is still linked and eligible when a queued write executes. A role, company policy or switch can change after the answer and even after runner preflight. The three finance drafts must not introduce caller-supplied actor fields or an assistant approval route. Their existing configuration/import/cancellation decisions are not authority to disburse, order or renew.

## Decision

Add the opt-in shared `checkHumanAuthority` helper backed by additive template migration t020. Call it in the same company transaction as each existing internal settings/import/cancel mutation and its write receipt. Check replay first: read-back of a previously committed effect remains available after revocation, but no new effect can use a revoked approval.

The SQL guard matches company, job, idempotency reference, ability and exact JSON arguments to an EXECUTING person-approved proposal; matches the stored yes actor/fingerprint; requires an active install and a current WAITING/RUNNING job; resolves requester/on_behalf_of and approver through platform-maintained linked people; and enforces the current configured role/four-eyes policy and ability switch. Unknown identities/roles, missing links, malformed policy and expired approvals fail closed. The helper independently recomputes the canonical fingerprint. Identities are not accepted from tool arguments.

Use the existing company switchboard advisory lock, including policy-row insert/delete, and retain shared locks on install, proposal, job and existing human links until the app transaction commits. Do not row-lock switchboard because its mutation trigger takes the advisory lock after its row lock. Check wall-clock expiry after potentially blocking authority locks. The platform must maintain its identity mirror coherently; this does not fetch live homeserver permissions or certify their propagation. Current isolation does not claim serializable predicate protection against privileged platform insertion of new identity aliases.

Tag these handlers `requiresHumanApproval` so a standing grant cannot replace the human proposal. Their manifests already have an ask-first floor. Bump the three affected ability versions to 1.1.0 and app manifest versions to 0.2.0; unchanged draft preparation remains 1.0.0. No provider or new business ability is added. Receipts retain proposal/fingerprint/version/current role/policy/board-version evidence, without duplicating personal IDs already in proposal/job records.

The new security-definer function has a fixed pg_catalog/pg_temp search path, a non-BYPASSRLS migrator owner and explicit company predicates. PUBLIC execution is revoked; only the app role receives execution. It grants no ability to update identity or approval tables. Existing applied migrations and answer_proposal remain unchanged. All apps can migrate the shared template, but only Pay/Buy/Renew handlers opt in here; Ledger/Wage application code is unchanged.

## Alternatives and limits

Checking only in the runner leaves the effect-time race. Trusting a supplied actor/role or treating a standing grant as a person is unacceptable. A global mandatory four-eyes policy would invent company policy: this guard preserves the configured internal-write rule. It does not establish elevated finance entitlements, bind an immutable original business-draft creator or approve external dispatch. Those need explicit domain states and reviewed authority policy before providers can exist.

## Evidence and release consequences

Each app has eighteen real backend/gate/runner/database tests using synthetic Matrix/model transports. Cases include role/link revocation, changed/malformed policy, configured self-approval refusal, exact-content mismatch, late switch-off, expiry while blocked on identity, rejected standing grants/forged context, commit-time identity/policy locks and immutable receipt replay. Three populated disposable V3 migration tests verify unchanged rows, reapply and ACL refusal. See checkpoint 9 for final counts and hashes.

The shared source changes invalidate prior artifact evidence for this source revision. Refresh backend and assistant artifacts and rerun packaged jobs before release; do not reuse checkpoint 8's pass as current-code evidence. Complete business state machines, original-proposer separation, domain entitlements, source parity, legacy conversion/privacy, provider contracts and real-environment acceptance remain required.
