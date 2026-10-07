# Fleet V3 rebuild — ninth implementation checkpoint

Date: 2026-10-01. Branch: rebuild/fleet-v3. Starting commit: 569cff2b5d5b75ccf73d1fe8e8a0776edcfe9056.

Worktree: /Users/mansi.gambhir/Documents/NEOPS_NEW/.claude/worktrees/fleet-v3-rebuild.

## Outcome and exact scope

Pay, Buy and Renew now recheck human authority inside the transaction for their existing internal settings/import/cancel writes. This is the first bounded authority slice, not complete payment/PO/renewal authorization. The other fifteen apps retain their prior internal-draft behavior. No new business ability, provider dispatch or release certification is added.

The guard binds company/job/reference/ability/exact arguments to the executing person-approved proposal and stored yes actor/fingerprint, resolves linked requester and approver identities, and checks current company roles/four-eyes, active install, switch-off and expiry. It rejects unknown/revoked/ineligible authority, malformed policy, substituted content and forged execution context. A standing grant cannot replace a human on these handlers. Existing committed receipts can still be read/replayed after revocation without a second effect.

Policy and identity locks are held until the internal write and receipt commit. Expiry is checked after potentially blocking authority locks, so a yes that expires while waiting on an identity lock is refused. Receipts reference the proposal and current role/policy/version without copying personal requester/approver IDs. This uses the current platform-maintained app identity mirror; it does not certify live Matrix membership/role propagation or serializable protection against privileged insertion of conflicting aliases.

Forward-only template migration t020 adds one restricted function; it changes no existing rows or applied migrations. Function execution is granted only to the app role, with PUBLIC/runner/Desk execution denied and no new table mutation privileges. All app schemas receive the template function when migrated, but only these three apps opt into it. Five Ledger tests and Grant's DBA-bundle count were adjusted for the added shared migration; Ledger/Wage application code, root checkout and separate Ledger release checkout are unchanged.

Each finance app manifest advances to 0.2.0; its three protected ask-first abilities advance to 1.1.0. Reads and internal draft preparation remain unchanged. Dependencies are unchanged. No production data, real payment/message/access/signature/export/filing, deployment, push or merge was involved.

## Verification

| Check | Result |
| --- | --- |
| Final complete regression | 168 files; 1480 passed; 0 failed; 2 existing conditional skips; 542.85 seconds |
| Final authority/migration subset | 4 files; 57 passed; 0 failed/skipped; 13.28 seconds |
| Earlier finance subset | 13 files; 134 passed before the final timing/privacy refinements; historical only |
| TypeScript | PASS on final runtime/test sources |
| Final catalog rerun | 6 passed; overlaps the full count |
| Pinned source snapshots | 108/108 verified |
| Acceptance/evidence consistency | PASS; all eighteen explicitly incomplete |
| Completion gate | Expected exit 1; zero production-ready apps |

The 57 new tests are included in the 1480 total, not additive. The two conditional skips still require real S3 and PostgreSQL dump/restore prerequisites; they do not constitute storage/recovery acceptance. Runtime and test sources were frozen for the final full run; later edits record documentation and evidence only. No packaged-image rehearsal was run for this new source revision.

The final targeted authority/migration run passed 57 tests: eighteen authority scenarios per app and three populated migration rehearsals. Tests use real gate/Desk/runner/app-role PostgreSQL transactions with synthetic Matrix/model transports. They cover role/link revocation, current policy changes, configured self-approval refusal, malformed policy, exact content, standing grants, forged context, late switch-off, expiry while waiting, commit-time identity/policy locking and receipt replay. Existing workflow tests continue to exercise approved import and cancellation through the actual job path.

The migration rehearsals start from pre-t020 populated synthetic V3 books, preserve settings/jobs/proposals/receipts exactly, apply only t020, verify empty reapply and check function ACL/company/identity-mutation refusal. They are NOT legacy conversion, backup restoration, production-data rehearsal or DBA approval.

Two existing data-layer tests now call repository operations within a company transaction to continue checking malformed-batch rollback and stale stored domain hashes. Direct handler calls without a genuine approved-job context would now be rejected by the outer guard before reaching those checks. This does not replace the real approval-path tests or add a runtime bypass.

Machine-readable final results, report hashes and changed source bindings are recorded in docs/evidence/FLEET-V3-CHECKPOINT-9-AUTHORITY.json. Raw reports remain in `/Users/mansi.gambhir/Documents/Codex/2026-09-28/lo/work/`. Only disposable synthetic databases and template copies were removed by fixture cleanup; that test state is not recoverable. No user or production data was removed.

## Review and failure history

The initial test helper import path failed collection; exporting/importing it through @neop/testkit fixed the fixture. An initial migration test used an invalid historical fingerprint shape and correctly failed the existing constraint; the synthetic row was corrected without weakening schema validation. Typecheck caught a non-async wait predicate; it was fixed. Review removed duplicated personal IDs from receipt proof and moved expiry validation after authority lock waits, with three new expiry regressions.

The earlier full run passed 1477 tests with two existing conditional skips but began before the final expiry fix; it is retained as history and is not the final-source evidence. No failure was converted to a skip or test/assertion timeout relaxed. Architecture and testing-strategy skills guided the shared opt-in transaction boundary and real-path negative/race tests; debugging addressed fixture failures, and code review tightened timing and personal-data minimization. ADR-0022 documents the design and limits.

## Acceptance and remaining work

Pay/Buy/Renew move only approval.authority from pending to partial_implementation: fourteen partial and four pending groups each. The other fifteen remain thirteen partial and five pending. All eighteen still have eighteen unfulfilled groups and production_ready=false; no full requirement group is certified. Business authorization SOURCE-PARITY mappings remain pending.

1. Next: bind immutable original draft proposers and introduce domain authorization states/entitlements for Pay/Buy/Renew, with denied/revoked/superseded/replay tests. Job requester separation alone does not establish original business-proposer separation. Company-specific elevated roles, limits and separation rules require reviewed owner policy; do not invent them. Other fifteen apps still need opt-in execution-time authority coverage.
2. Complete domain state machines, correction/supersession, source entity/scenario/deliverable parity and honest NEOS UI behavior. Keep external dispatch absent until reviewed contracts, exact approval policy and independent read-back/reconciliation exist.
3. Legacy-data conversion, restore/recovery, privacy/retention/erasure/export policy and DBA/domain-owner review remain open. Broader active-session/in-flight-effect/concurrent/outage recovery and load testing remain open.
4. Shared runtime/template changes invalidate checkpoint 5/7/8 artifact bindings for this source revision. Those images and packaged results remain historical; refresh backend/assistant artifacts and repeat packaged acceptance before release. No old packaging run is counted as new progress here. Production network/storage/secrets/appservice manifests, SBOM/license/vulnerability/provenance and other architecture targets remain required.
5. Team-owned evidence is still needed for real Matrix/model/mailbox/connected doors/object storage/NEOS UI and operational acceptance, provider sandbox credentials/contracts, reviewed authority and retention policy and DBA/domain-owner sign-off. These are not the only remaining work: safe local implementation can continue. Deployment stays with the user's team.

Do not declare all eighteen complete. Continue hourly implementation and reporting, and report final completion only when every required criterion has evidence.
