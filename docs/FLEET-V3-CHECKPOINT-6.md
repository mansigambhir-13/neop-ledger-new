# Fleet V3 rebuild — sixth verified implementation checkpoint

Date: 2026-10-01. Branch: rebuild/fleet-v3. Starting commit: 50ccfdf12607203c6c7ecc2d5012f1597ae323d9.

Worktree: /Users/mansi.gambhir/Documents/NEOPS_NEW/.claude/worktrees/fleet-v3-rebuild.

## Outcome and scope

All eighteen remaining NEOPs now have passing persisted internal-draft job rehearsals through their actual standalone backend and assistant processes. Ninety new tests cover Matrix ingress, the signed/metered model-proxy path, real SDK tool calls through the gate, human decisions, waiting-state process crashes/restarts and receipt/replay checks. The prior startup and fixture-gate tests did not prove this complete local persistence chain.

This checkpoint adds verification infrastructure and acceptance evidence, not new business abilities. It does not build backend images, complete domain lifecycles or certify production. Assistant images from checkpoint 5 remain separately scoped evidence and were not rebuilt in this run. The root checkout, separate Ledger release checkout, Ledger/Wage code, production runtime code, dependency versions and migrations were not changed. No deploy, push, merge, live provider call or real payment/message/signature/access change/export/filing occurred.

The apps are Asset, Buy, Clear, Deal, Desk, Grant, Guard, Hire, Pay, Post, Quote, Reach, Renew, Roster, Shift, Sign, Sync and Vet. Each has five passing process-lifecycle scenarios; the shared helpers launch the app's fixed wrapper and supply its own reviewed synthetic business inputs.

## What is real and what is a fixture

| Component | Executed mode |
| --- | --- |
| Backend and assistant | Actual shipped launchers in separate Node child processes with production-mode startup checks |
| Data, gate, runner and handlers | Actual disposable PostgreSQL schemas/roles, proposals, waits, receipts, read-back, transcripts and typed events |
| Model SDK and session authorization | Actual Anthropic-compatible SDK path and real runner-signed, app/company-scoped tokens through the real metered proxy |
| Matrix homeserver and upstream model | Local scripted fixtures, no external network or real provider |
| Platform registration/identity setup | Disposable test-mode platform; no production registration or release attestation |
| Stable restart addresses | Fixture-only loopback TCP forwarding with no authorization/business logic |

No business handler is called directly by these new tests and no job/proposal row is edited to fake successful progress. Fixture setup creates companies/users/installs through the existing platform and links synthetic identities. Test assertions read persisted state through the test administrator, while actual jobs use the backend's restricted application/runner roles.

## Verified for every app

1. Unknown senders, wrong company and wrong room create no job. A valid typed task completes an honest empty read through the real SDK. Re-delivery creates neither a second job nor a second done event. The real proxy records app/company-scoped model spend.
2. Configuration where applicable and source-record import require exact human approval. No source record exists beforehand. An allowlisted bridge's yes, a stale fingerprint and a wrong-thread answer are refused. A waiting backend is SIGKILLed and relaunched with a new PID; the existing import proposal completes after the valid human answer.
3. Import recovery records read-back proof and two distinct assistant session IDs/transcripts; the resumed session receives proof from the book. This is waiting-state recovery, not a crash between an external effect and its receipt.
4. Forged actor, approved-status and external-success fields from the scripted model create no draft. A valid app-specific draft persists with its hash and receipt; the declared read returns the expected domain fields and external_completed=false.
5. Replacing the waiting assistant process before a human rejection leaves the draft unchanged and creates no cancellation receipt. Later exact-content cancellation changes only the permitted state and retains the input hash. Same-event and new-event approval replay leave one cancellation receipt and one completion event.

## Final verification

| Check | Result |
| --- | --- |
| Full regression | 162 files; 1397 passed; 0 failed; 2 existing conditional skips; 179.52 seconds |
| New process scenarios | 90/90 passed; five per app; included in the full count |
| Targeted Pay/Clear/Grant rerun | 15/15 selected tests passed; other cases excluded by name filter, not disabled |
| TypeScript | PASS |
| Source snapshots | 108/108 pinned hashes verified |
| Fleet completion gate | Correctly refused with exit 1; no production-ready apps |

The two existing conditional skips concern real S3 and PostgreSQL dump/restore prerequisites. They do not certify fleet storage/backup. No new skip, timing extension or relaxed application guard was added.

Per-app test names, results, source hashes and the raw-report hash are committed in docs/evidence/FLEET-V3-CHECKPOINT-6-JOBS.json. The full local JSON report is `/Users/mansi.gambhir/Documents/Codex/2026-09-28/lo/work/fleet-v3-checkpoint-6-tests.json`. Source/runtime files were unchanged during the final full run; subsequent edits only record evidence. The test harness closes its owned children and loopback fixtures and drops its uniquely created disposable database; no user or production data is targeted.

## Debugging and review

Initial typecheck found that the root workspace does not directly link @neop/contracts. The new test imports the existing local contracts source explicitly; no dependency was added. The first Pay process run passed two scenarios and failed three new assertions: external_completed was incorrectly expected as a physical table column, and receipt assertions referred to a nonexistent ability column. The assertions now verify that field in actual declared reads/execution receipts and bind receipts to the actual execution reference. They retain the intended no-external-effect and exactly-once checks; no application behavior was changed to satisfy tests. The corrected targeted run and fresh full regression passed.

Architecture and testing-strategy skills guided the real-process/fixture split. Debugging isolated test-contract assumptions, and code review made failed child starts settle without leaving tracked processes/unhandled promise rejection. ADR-0019 records the design, alternatives and remaining test coverage.

## Remaining work and next step

- Backend-only image contexts with a reviewed Linux Deno sandbox/runtime remain unbuilt. Copying the host executable or silently omitting installed-protocol execution would not complete that artifact. This is safe local work still to do, not a new request for deployment authority.
- Repeat persisted jobs with both packaged processes, and add active-session/in-flight-effect crashes, concurrent runners, proxy/homeserver outages, recovery/load and production network/host/metadata checks. Child-process tests do not establish container network policy.
- Complete checkpoint 3's missing business authorization/state machines, full source entity/scenario parity, provider credentials/idempotency/read-back/reconciliation and correction/supersession workflows. Imports and cancellations do not authorize external effects.
- Reviewed legacy-data conversion, populated upgrade/restore, retention/erasure/export design and DBA/domain-owner approval remain required.
- Team-controlled Matrix/model/mailbox/doors/storage and real NEOS UI acceptance remain unavailable. Later acceptance needs those environments/credentials plus reviewed business authority/retention rules and operational sign-off. No new user-input blocker prevented this checkpoint.

All production_ready flags remain false. No requirement group is promoted to full certification. Implementation completion and team-owned production acceptance remain separate; deployment stays with the user's team.

## Reproduce

- pnpm typecheck
- pnpm exec vitest run scripts/fleet/tests/runtime-jobs.test.ts --maxWorkers=1
- pnpm exec vitest run --maxWorkers=4
- pnpm fleet:status --summary --check-sources
- pnpm fleet:status --summary --require-complete (expected nonzero)

Use only the repository's local disposable test database configuration. Do not point these fixtures at a production database or replace mock Matrix/model URLs with live services. Final staged-patch scan and commit evidence are recorded in the local handoff after the evidence files are finalized.
