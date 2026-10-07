# Fleet V3 rebuild — twelfth implementation checkpoint

Date: 2026-10-01. Branch: rebuild/fleet-v3. Starting commit: b78a29fec6b9a325e53d23690789678aeffdab66.

Worktree: /Users/mansi.gambhir/Documents/NEOPS_NEW/.claude/worktrees/fleet-v3-rebuild.

## Outcome and limits

All eighteen have new locally exercised internal-import waiting-lifecycle coverage. A reproduced shared approval bug is fixed by forward-only migration t022: an answer that waits on a database lock beyond the proposal deadline is refused, including when the lock is acquired later while recording the answer. This is not business authorization, full source parity, provider dispatch or production acceptance.

No app business handler, manifest, provider capability, applied migration, dependency lock or source-parity mapping changed. Ledger test expectations include the new shared migration; Ledger application code, the root integrate/v3 checkout and the separate Ledger release checkout are untouched. Nothing was pushed, merged or deployed. Only synthetic local fixtures were used.

## Implemented

- Shared answer_proposal checks wall-clock expiry after acquiring the proposal row and immediately before a fresh answer returns. The final check catches a deadline crossed on later job/history/wait/outbox locks. Failure atomically rolls back decision evidence, steps, outbox entries and wait updates.
- The function signature, owner, RLS, role/four-eyes rules and existing matching-answer replay behavior remain. Withdrawal remains deadline-exempt until execution has started. No historical timestamp or row is rewritten.
- Per-app tests exercise immutable supersession with feedback and a fresh approval card, pending/approved withdrawal, too-late withdrawal, expiry after runner downtime, one persisted outcome/wake and withdrawal racing two executor instances.
- Six deadline cases per app cover yes/no/change delayed on proposal and later job locks, no surviving answer/effect, then expiry and a single wake after restart.
- Four populated synthetic V3 upgrades (Pay, Buy, Renew, Grant) preserve historical jobs/proposals/waits/events/receipts and function privileges, reapply cleanly, and retain company and expiry refusal boundaries. They do not constitute eighteen populated upgrades, legacy conversion, a production-data restore or DBA approval.
- Each ACCEPTANCE.json now links this bounded waiting evidence. All eighteen have fifteen partial and three pending groups; all eighteen groups remain unfulfilled and production_ready=false. These counts are not a completion percentage. Full source parity remains false for every app.

ADR-0025 records the trade-off, owners and limits. Architecture, testing-strategy, debug and code-review skills guided the forward-only change, failing-then-passing race tests and replay/rollback/privilege review.

## Verification

| Check | Result |
| --- | --- |
| Final complete regression, same worker count/assertions | 222 files; 2330 passed; 0 failed; 2 existing conditional skips; 580.51 seconds |
| Initial complete regression | 2329 passed; 1 failed; 2 existing conditional skips; 680.40 seconds; failure retained below |
| Pay/Grant focused lifecycle | 24 passed; 0 failed/skipped; 22.92 seconds |
| Four populated upgrades plus Grant DBA-bundle test | 5 passed; 0 failed/skipped; 6.73 seconds |
| Unchanged Ledger diagnostic file | 10 passed; 0 failed/skipped; 9.60 seconds |
| Final catalog rerun | 6 passed; 0 failed/skipped; 5.67 seconds |
| TypeScript | PASS, including final rerun |
| Pinned source snapshots | 108/108 verified |
| Deadline-only SQL comparison to t011 | PASS |
| All-eighteen readiness/parity/provider inventory | PASS; no provider doors or external effects |
| Completion gate | Expected exit 1; no production-ready apps |
| Owned upgrade database inventory | Zero remaining |

The 220 new tests comprise 216 lifecycle assertions (12 per app) and four populated upgrades, included in the full regression total, not additive. Focused runs and diagnostic reruns overlap the full suite. The two existing conditional skips require real S3 and PostgreSQL dump/restore prerequisites; neither is accepted storage or recovery evidence. No test was disabled or given a weaker timeout/success assertion.

Runtime/test/migration sources were frozen before both full runs. Subsequent edits record evidence only. No container rebuild or packaged-job rerun is claimed. Prior images and review-only DBA bundles predate the shared migration and must be refreshed before release.

## Failure and diagnosis history

1. An initial test-name filter matched none of twelve Pay cases because displayed parameter names included quotes. The report with twelve filter exclusions is not verification.
2. The corrected pre-fix reproduction executed six deadline cases: all failed because HTTP 200 accepted a late yes/no/change instead of refusing with 409. Six unrelated cases were excluded by the filter, not disabled.
3. The first post-fix Pay/Grant run had three passes and 21 failures in new test assertions: it queried a nonexistent operations.proposal_id and expected HTTP 200 for an already-recorded yes. The real schema keys operations by company/idempotency key; Desk intentionally returns 409 for a closed card while the underlying matching answer is idempotent. Assertions were corrected to check those contracts, one yes event and unchanged effect evidence. The fixed run passed 24/24. The deadline assertions were not relaxed.
4. The first full run passed 2329, failed one and retained two conditional skips in 680.40 seconds. All 220 new tests passed. Existing Ledger presence-go-ahead's reply-to-card refusal returned the generic unavailable text instead of the expected approval refusal. Its unchanged ten-test file then passed in isolation. The root cause was not established, and no retry, timeout increase, skip or runtime workaround was added.
5. The second complete run, on unchanged runtime/test/migration sources with the same four-worker limit, passed 2330 tests with zero failures and the same two conditional skips in 580.51 seconds. Preserve the first failure as a follow-up signal; do not claim its cause was fixed merely because a rerun passes.

Machine-readable reports, hashes and changed-source bindings: docs/evidence/FLEET-V3-CHECKPOINT-12-APPROVAL-LIFECYCLE.json. Raw reports remain under /Users/mansi.gambhir/Documents/Codex/2026-09-28/lo/work/. The staged secret scan and local commit are recorded in the handoff.

Only owned disposable synthetic databases and temporary migration copies were removed by test cleanup; that temporary state is not recoverable. No user or production data was removed.

## Remaining work and next step

1. Implement actual business decision/state lifecycles and original-proposer separation, beginning with Pay/Buy/Renew. Missing owner decisions: approver roles, amount/currency limits, self-approval rules, and historical/nonhuman handling. Internal admin/member roles are not invented business entitlements.
2. Next safe local slice: reproduce lock-delayed input-question answers in t013 (it still compares expires_at with now() and takes a later job lock), then add forward-only handling if the failure is confirmed. Do not infer a reproduced defect from source inspection alone. Continue waiting/recovery and provider-contract work while policy input is unavailable. This slice does not cover all wait types, dependency failures, arbitrary lost notifications, multi-host claims, active-session/in-flight crashes or live transport races. Investigate the unconfirmed Ledger refusal-message failure if it recurs; collect the underlying persisted outcome and logs before changing behavior.
3. Complete source-parity entities, configuration, dashboards/deliverables and domain prerequisites. Provider effects remain absent until exact payload/credential/idempotency/read-back/unknown-outcome contracts and policies are reviewed.
4. Resolve legacy conversion and immutable-history retention/access/export/erasure/recovery with domain/privacy/DBA owners. The function cannot constrain a trusted caller holding its surrounding transaction open after the function returns; execution-time authority/deadline checks remain required.
5. Refresh current-source artifacts and DBA bundles before release. Team-owned acceptance still needs real Matrix/model/mailbox/connected doors/object storage/NEOS UI, provider sandbox certification, production-sized restore/recovery, operational owners and DBA/domain approvals. Deployment remains the team's responsibility.

All eighteen remain incomplete. Continue hourly work; no fleet-complete notification or automation pause is warranted.
