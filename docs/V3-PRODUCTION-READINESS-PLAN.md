# Ledger NEOP V3 production-readiness plan

Status: **repository release candidate; deployment and environment acceptance owned by the deployment team**
Authority: Shivam's `NEOP-WHOLE-PICTURE-v3.md`
Implementation branch: `s9-delete-gateway`
Last verified: 30 September 2026

## Decision

The Ledger implementation is now functionally conformant to the V3 architecture for every requirement that can be proved inside this repository. The Matrix-only runtime, person-only approval path, app-owned data plane, build-pinned packages, deployment topology, migration safeguards, load target, and restart recovery are green.

This repository is the engineering handoff for deployment. The deployment team owns target-host installation, environment-specific acceptance and production cutover; those checks are listed below and do not require this coding task to obtain production access. No production deployment or destructive migration was performed. See `docs/RELEASE-HANDOFF.md` for the release boundary and verification commands.

## V3 release invariants

1. Matrix is the only runtime road between NeuralChat, people, and NEOPs; requests and responses remain typed and threaded.
2. Each NEOP owns its schema, restricted database roles, Matrix identity, switchboard, jobs, waits, proposals, operations, transcripts, and presence cursors.
3. Only a person can approve the exact fingerprint they saw. NeuralChat and peer NEOPs can never approve.
4. A yes lands through the app schema's `answer_proposal()` function. The runner executes once, reads back, records proof, and only then wakes a fresh assistant.
5. The assistant has no database access, provider credential, general shell/filesystem, or unrestricted network tool.
6. The desk uses reviewed views and SECURITY DEFINER functions; undeclared assistant reads remain private to the NEOP.
7. Packages are signed, reviewed, pinned, copied into the host build, and migrated through the host DBA bundle. There is no runtime code install.
8. Production fails closed on missing Matrix identity, invalid sender/room, stale schema, missing secret, failed conformance, or stale attestation.

## Execution completed

### Runtime and trust boundary

- Removed live L3/gateway delivery, platform-client calls, vault lending, execution tokens, and platform service-secret use from running app processes.
- Made Ledger, Marketing, and NeuralChat require their own Matrix presence; removed the production `off` fallback.
- Routed typed tasks, questions, answers, proposals, notes, results, borrowing, and app-to-app work through Matrix threads.
- Kept block reads, schedules, transcripts, cancellation, files, switchboards, grants, and approvals on app-owned database functions/views or app-owned services.
- Restricted the LLM proxy to runner signing keys; fixed the cross-session budget crash race.

### Approval, data, and migration safety

- Enforced person-only, role-aware, four-eyes, fingerprint-bound approval in the app schema.
- Preserved execute-once and read-back-first recovery for crashes and UNKNOWN external effects.
- Kept normal migration expand-only through platform 024; safe migration 024 makes the retired L3 address optional, while migration 025 remains an explicit destructive cutover.
- Added a populated migration-025 proof covering transactional abort on undrained approvals, exact archive digests, table/column removal, retained-row integrity, archive role isolation, replacement views, and idempotent rerun.
- Kept the one-way legacy door-secret exporter DBA-only; no runtime vault was restored.

### Deployment and operations

- Rewired compose, deploy, preflight verification, network policy, health checks, alerts, dashboard, and production env examples to Matrix, files, gate, and agent endpoints.
- Separated Ledger and NeuralChat Matrix identities and token files.
- Rendered both supported topologies successfully: external Matrix client mode and local Synapse appservice mode.
- Completed a production-mode clean install on an isolated PostgreSQL 17 + PgBouncer + real Synapse stack: migrations,
  attested registration, company/admin/install bootstrap, appservice room creation, the read-only verifier, a declared
  block read, and an authenticated ask through typed Matrix note/done all passed.
- Fixed three issues found only by that clean rehearsal: the pre-contract `apps.l3_url` constraint, client-only secrets
  mounted by the appservice verifier, and Synapse room alias/power-level creation ordering. Existing malformed aliases
  now fail closed instead of being bound.
- Updated the README and operator runbook so current instructions no longer direct operators to the retired gateway/L3 path.
- Preserved the registration service secret only as a one-off build/install credential; it is not mounted into running backends.
- Closed the upgrade backup bypass: a stopped/failed backup service or existing database without deployment state stops the deploy before credential generation, build or migration.
- Updated CI to exercise the Matrix-only topology with real Synapse and the required signed-files URL, including branch pushes. Matrix setup defaults to separate appservices and respects the configured secret directory.

### Tests and reliability

- Ported the suite to V3 app-owned reads and typed Matrix delivery.
- Deleted 14 obsolete pre-S9 skipped tests. Only the real S3 and real `pg_dump` integration tests remain conditional.
- Fixed Matrix question delivery, populated migration ordering, package/GST reads, signed file links, LLM budget recovery, load instrumentation, and restart recovery.
- Defined repository acceptance bounds of p95 < 1 second for direct typed Matrix ingress and p95 < 10 seconds for a 200-request same-room `/api/ask` burst. Shivam's V3 document does not set numeric latency SLOs; these are explicit engineering release bounds, not claims copied from the spec.

## Verified evidence

| Gate | Result | Evidence/status |
| --- | --- | --- |
| TypeScript | PASS | `pnpm typecheck` |
| Full regression | PASS | 94/94 files; 609 passed; 0 failed; 2 conditional skips; includes deterministic Matrix reply-race and deployment-backup regressions |
| V3 live-validator logic | PASS | 10/10 in-process acceptance cases |
| LLM proxy | PASS | 6/6, including cross-session budget recovery |
| Migration 025 rehearsal | PASS | 1/1 populated isolated database proof |
| Direct typed Matrix ingress load | PASS | 200/200; p95 626.97 ms; max 646.26 ms |
| `/api/ask` to persisted Matrix acknowledgement | PASS | 200/200; p95 8.57 s; max 8.70 s |
| Completion load | PASS | 200/200 completed in 7.96 s |
| Restart chaos | PASS | 60/60 jobs, 30 gated mails, 50 forced restarts, zero duplicate execution/result |
| PostgreSQL 17 backup/restore | PASS | 5/5; per-schema dumps, company exports, retention, damage and single-schema restore |
| S3-compatible document store | PASS | 6/6 against isolated MinIO; write/read/delete and bad-signature refusal |
| Compose render | PASS | external-client and local-appservice merged configs |
| Clean appservice install | PASS | fresh DB; attested registration; company/admin/install; verifier 12 PASS, 0 WARN, 3 appservice-only SKIP |
| Real local Synapse | PASS | exclusive user/alias namespaces; two invite-only plaintext rooms; final NEOP level 20; authenticated ask completed through typed Matrix note/done |
| Declared read smoke | PASS | `ledger.periods.status`, HTTP 200 with sourced result |
| Release scripts | PASS | shell syntax checks; `git diff --check` |
| Runtime residue scan | PASS | no live gateway/L3/vault fallback; remaining service secret is install-only |
| Secret-history scan | PASS | gitleaks v8.28.0; three exact reviewed exceptions for a public registry signature and synthetic test fixtures; no credential findings |

The default suite keeps two environment-dependent tests conditional; both were also executed separately in this pass:

- S3-compatible document-store round trip: passed against isolated MinIO.
- PostgreSQL 17 logical dump/restore: passed using the PostgreSQL 17 client image.

## Remaining production blockers

| Priority | Gate | Required production evidence |
| --- | --- | --- |
| P0 | Production-host install and upgrade | The isolated production-mode clean install is green; repeat `scripts/deploy.sh` on the target host and upgrade a production-shaped copy from the supported pre-V3 release; run `verify-install` and `netcheck` |
| P0 | Production Matrix acceptance | Real local Synapse appservice flow is green; repeat distinct identities/tokens, membership, rooms, namespaces, redelivery, restart cursor, and person-only approval on the actual production homeserver |
| P0 | Production-shaped S9 cutover | Restore a current backup, rehearse 025, prove undrained abort, export/archive parity, backup recovery, role isolation, and obtain explicit DBA/operator approval before the real cutover |
| P0 | Production backup and object storage | Local PostgreSQL 17 and MinIO gates pass; repeat against the exact production services, retention, encryption and recovery destination |
| P0 | Real NEOS product UI | Confirm blocks, questions, fingerprint cards, approval, signed downloads, task/thread status, and accessibility in the actual NEOS renderer; the repo web UI is only a harness |
| P0 | Live provider/model validation | Run `live-validate` with the deployed model, owned mailbox, connected doors, budget cap, and exact release checkout; archive the markdown/JSON result |
| P1 | Commercial GST certification | Exercise GSP sandbox OTP login/refresh, save/read-back, liability offset/payment if required, EVC filing, RETTRACK/ARN reconciliation, timeout recovery, and DSC if the provider/regime requires it |
| P1 | Production ownership config | Replace placeholder model pricing, test identities, URLs, sender addresses, retention values, alert routes, and authentication with owned production settings |

## Controlled go-live sequence

1. Freeze the release commit, manifest, package lock, container digests, and migration bundle.
2. Generate conformance attestation from that exact state and verify registration rejects any mismatch.
3. Restore the latest production backup into isolation; run backup/restore and the 025 rehearsal; obtain DBA sign-off.
4. Provision distinct Matrix identities/tokens and validate rooms, namespaces, memberships, and power levels.
5. Run clean-host deploy and supported upgrade; execute `verify-install`, `netcheck`, real S3, and real `pg_dump` checks.
6. Run `live-validate --expect-road matrix` with the real model and safe provider sandbox/mailbox; run GSP certification separately.
7. Complete product-owner acceptance in the real NEOS UI.
8. Review alerts/dashboards, rollback ownership, on-call contacts, recovery point/time objectives, and the cutover window.
9. Apply migration 025 only under the approved cutover procedure. Preserve the backup and evidence bundle.
10. Release only if every P0 gate is signed; otherwise remain on the rehearsed pre-cutover state.

## No-go conditions

Do not release if any test is failing or unexplained, the release is dirty/unattested, Matrix accounts or namespaces overlap, a bridge can approve, schema drift exists, backup recovery is unproven, migration 025 has not been rehearsed on current data, a connected door lacks owned credentials/read-back, or the real NEOS UI has not passed acceptance.

## Evidence bundle to retain

Record the commit, package-lock and manifest hashes, container digests, attestation, compose render, migration/backup logs, 025 archive digests, Matrix room/account configuration, verifier/netcheck output, full/load/chaos results, live-validation report, S3/pg_dump evidence, GSP certification result, approver names, cutover time, and rollback decision.
