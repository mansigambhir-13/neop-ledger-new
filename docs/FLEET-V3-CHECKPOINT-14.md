# Fleet V3 rebuild — fourteenth verification checkpoint

Date: 2026-10-05. Branch: rebuild/fleet-v3. Starting commit: e802c32a442ee1b8ce04502f66be76d61ccf38b9.

## Outcome and scope

The outstanding checkpoint-13 complete regression now passes on an owned isolated PostgreSQL cluster: 2,604 passed, zero failed and two existing conditional skips across 241 files. All eighteen also gain six persisted timer-recovery scenarios each, 108 new tests. These are verification improvements, not new business workflows or provider capabilities.

Only test sources and evidence/acceptance documentation change. Runtime handlers, shared runtime code, applied migrations, manifests, source-parity mappings and dependencies are unchanged. No push, merge, deployment or production connection occurred; the root integrate/v3 and separate Ledger release checkout are untouched.

## New coverage

Each app's real local gate, runner, Desk and PostgreSQL are exercised with scripted model/Matrix fixtures:

- Invalid, past, over-limit and reasonless timer requests persist no wait, proposal or operation.
- A future timer stays parked through backend restart. Once due, a fresh assistant reads its persisted reason and earlier note, consumes the wait, writes one resume step and one terminal outbox record.
- Two runner objects expire the timer once and claim the job once. An abandoned pre-dispatch claim is recovered after its lease expires without losing the ready wait. The earlier claimant cannot write after recovery completes.
- Cancellation of either pending or ready timers stays terminal across restart; no assistant resumes and no business effect is recorded.
- Terminating only the exact runner LISTEN connection in the test's database loses notification delivery. Scheduled expiry and normal polling still finish the timer without a manual kick, tick, expiry call or restart.

Timers are created safely in the future using database time. Controlled tests move only their own wait/claim timestamps; this is synthetic recovery, not a real outage or multi-host failover rehearsal. Fixture quiescence is checked before controlled restarts and counts are scoped to the uniquely tagged job. It does not certify production shutdown draining. The test does not assert automatic LISTEN reconnection; it proves polling fallback while that connection remains absent.

Testing-strategy guidance selected durable-state and negative-path assertions. Code review checked the exact fixture/session scope, stale claimant, cancellation and single-result assertions. Documentation guidance separates this test coverage from new product functionality and release approval.

## Verification

| Run | Result |
| --- | --- |
| Clean complete baseline on unchanged checkpoint 13 | 241 files; 2,604 passed; zero failed; 2 conditional skips; 449.10 seconds |
| Initial Pay/Grant timer check | 2 files; 12 passed; zero failed/skipped; 4.83 seconds |
| Eighteen timer suites plus selected Ledger/catalog regressions | 22 files; 135 passed; zero failed/skipped; 27.25 seconds |
| Final complete run including new coverage | 259 files; 2,712 passed; zero failed; 2 conditional skips; 501.31 seconds |

All 108 new tests pass within the final full run. Focused runs overlap the complete runs; do not add their totals. The two existing skips require a real S3 endpoint and compatible PostgreSQL dump/restore prerequisites, respectively. No storage, backup recovery or live acceptance is inferred. TypeScript passes after the new tests. Final catalog: 6/6 passed in 1.79 seconds. All 108 pinned source hashes pass; the completion gate correctly returns exit 1. Twenty new/changed test source hashes were frozen before the final full run and checked again for the checkpoint. Final source hashes, report hashes, catalog checks and cleanup are recorded in docs/evidence/FLEET-V3-CHECKPOINT-14-TIMER-RECOVERY.json and the handoff.

## Retained failure history

The first complete baseline attempt on this fixture had 2,561 passes, five failed tests, three setup-failed suites, 38 cases unexecuted by those setup failures and two existing conditional skips (40 reported skipped in total), across 241 files in 1,793.83 seconds. Its raw JSON is retained; it is not an accepted green result.

Host power-management logs show low-power sleep from 10:41:39 to 10:57:17 UTC (938 seconds) during that run. Two Pay tests each recorded approximately 939 seconds before timeout, followed by authority-card/quiescence failures. Hire/Roster authority and the fleet-isolation suite timed out in setup; exact hook-start times are not established by that JSON. Sleep is an observed environmental interruption, not proof of the cause of every failure.

Separately, Pay's change-after-expiry/proposal-lock test observed two wakes instead of one before the sleep (its file ran 10:34:14–10:34:48 UTC). The old helper counts first model calls without scoping them to a unique job and does not drain in-flight work on stop, but the original wake contents/claim timeline were not captured. Neither fixture contamination nor a runtime duplicate session is proven. No assertion, timeout or runtime behavior was changed to hide it. All six affected files passed unchanged (83 tests, 30.69 seconds), then the unchanged complete baseline passed. This historical intermittent failure remains open; a passing rerun is not a repair.

The subsequent full runs use a process-scoped idle-sleep inhibitor, not a permanent power-setting change. It cannot prevent all low-power, lid-close or forced suspension. Checkpoint 12's earlier intermittent Ledger presence refusal-message failure also remains unconfirmed; later passing coverage is not a root-cause finding.

The owned loopback-only PostgreSQL 17.11 ARM64 container used tmpfs with no persistent mounts. Before scoped stop/removal, three residual synthetic pilot databases remained, with zero active pilot sessions; Desk retained NOLOGIN/no-bypass/non-superuser flags. The entire owned fixture and its temporary credentials were removed. Its synthetic data is not recoverable; reports remain outside the worktree. No user/production data, shared development roles or other fixture containers were changed. Do not report zero residual databases before cleanup.

## Remaining work and next step

All eighteen remain incomplete: fifteen partial and three pending acceptance groups each, production_ready=false and full_parity=false. These are requirement groups, not completion percentages. No source-parity or business-authorization criterion is newly fulfilled.

1. Next safe slice: inspect and reproduce dependency/a2a expiry, cancellation, late/duplicate results and restart/lost-notification paths. Review atomic thread/wait/operation updates and mixed-wait lock ordering before changing semantics. Instrument any recurring wake-count failure with job/session/lease evidence.
2. Owners must specify eligible/elevated approver roles, amount/currency limits, self-approval and historical/nonhuman handling. Internal-write guards and immutable draft origins are not business decision lifecycles. Keep provider dispatch absent.
3. Complete app-specific workflows, full source parity, reviewed provider contracts, uncertain-effect/read-back handling, privacy/retention and legacy conversion.
4. Refresh current-source images/DBA bundles and rehearse the coordinated t023/current-worker rollout. Old input-expiry workers still have the opposite lock order; mixed-version rolling compatibility is not certified.
5. Team-owned acceptance still requires production-data restore/DBA approval, Matrix/model/mailbox/connected doors/object storage/NEOS UI/provider sandbox tests and operational/domain ownership. Deployment remains with the team.

Continue hourly work; no all-eighteen completion claim or automation removal is warranted.
