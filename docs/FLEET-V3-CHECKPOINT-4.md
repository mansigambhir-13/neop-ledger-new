# Fleet V3 rebuild — fourth implementation checkpoint

Date: 2026-10-01. Branch: rebuild/fleet-v3. Starting commit: 91d5a81881078f50bf2f5a846d7e8914a89d2918.

Worktree: /Users/mansi.gambhir/Documents/NEOPS_NEW/.claude/worktrees/fleet-v3-rebuild.

## Outcome

All eighteen remaining NEOPs now have their own fixed-app backend and keyless-assistant entrypoints, backed by shared startup validation and real child-process tests. There are 36 new entrypoint wrappers. This closes a standalone execution gap; it does not complete business workflows or production packaging. No deployment, push, merge or real provider action occurred. The root checkout and separate Ledger release checkout were not changed.

The apps are Asset, Buy, Clear, Deal, Desk, Grant, Guard, Hire, Pay, Post, Quote, Reach, Renew, Roster, Shift, Sign, Sync and Vet. Ledger/Wage business code, shipped migrations and dependency versions remain unchanged. The fleet's existing draft abilities are unchanged; startup does not enable additional business effects.

## Implemented and checked

- Each app pins its own identity in scripts/backend.ts and scripts/agent.ts and exposes start:backend/start:agent package scripts.
- The backend uses a build-time allowlist; the worker imports neither an app definition nor that loader.
- Preflight rejects wrong app/runner roles, mismatched database names, connection-string identity overrides, malformed ports/pools/URLs, inline/file conflicts, missing Matrix configuration and malformed model-signing configuration. Production mode requires model-signing configuration and refuses public metrics.
- Worker startup refuses known credential/database/provider and file-based environment settings before reading a secret file. Only non-secret model metadata is passed to the proxy model factory; no session token means no model session.
- Listeners default to loopback; operations must supply correct interface bindings and network policies. Configuration failures and migration drift exit 78 without a started event. Diagnostics do not print secret values or supplied file paths.
- SIGTERM/SIGINT stops backend resources and workers with bounded deadlines. The shared book/runner continues to own job recovery.

## Verification

| Check | Executed result |
| --- | --- |
| Full regression run | 160 files; 1294 passed; 0 failed; 2 existing conditional skips |
| Final configuration/process rerun | 117 tests passed: 61 configuration and 56 process tests |
| TypeScript | PASS |
| Pinned source snapshots | 108/108 verified |
| Fleet completion gate | Correctly refused; no production-ready apps |
| Staged patch secret scan | PASS; no findings |
| Standalone backend/assistant smoke | All 18 apps; real child processes, local PostgreSQL and fake homeserver |
| Drift refusal | Every app refuses a changed migration checksum before a started event |
| Shutdown | Clean SIGTERM for all 18 backends and workers |
| Invalid inbound/session requests | Unauthenticated Matrix ingress, another gate, no model token and injected worker secret setting refused |

The final full regression runs against the frozen runtime sources, including the query-override guard. A separate 117-test configuration/process rerun also passed; counts are not added together because the suites overlap. The two existing conditional skips still concern S3 and PostgreSQL dump/restore prerequisites; neither establishes fleet backup or storage certification.

Process smoke tests intentionally use no installed company jobs: they prove startup, health, refusal and shutdown, with zero Matrix messages or business effects. Existing in-process tests separately cover the draft workflows. A health check is not full live acceptance. No container image or production network probe was run in this checkpoint.

The first new process-suite invocation failed during collection because the root package does not directly depend on pg. The test now uses the existing pgkit pool helper; no dependency was added, assertion weakened or failure skipped. The code-review pass also found that the pinned PostgreSQL URL parser permits user/host query overrides. The launcher now allowlists transport/observability query settings and tests refusal of identity/session overrides.

The first full run overlapped the final guard/test edit and ended with 1,293 passing tests and one failure in the newly added guard test. The test runner had already loaded the earlier runtime module; the fresh 117-test rerun passed. To avoid relying on a mixed-source result, the entire suite was rerun from a fresh process against unchanged final runtime files. The final result above supersedes that initial run; no failure was hidden or skipped.

The architecture skill guided fixed-app wrappers and shared startup policy; the testing-strategy skill required actual processes in addition to configuration tests. Debugging isolated the package-resolution issue, and code review added configuration-boundary regressions. See ADR-0017 for decisions and docs/FLEET-V3-RUNTIME.md for use and limitations.

## Remaining work and next step

1. Build and inspect separate backend/assistant images; prepare per-app appservice/secret/network manifests and actual isolation probes.
2. Exercise complete jobs across separate backend/worker processes with fixture transports, then obtain real Matrix/model/NEOS UI/provider acceptance.
3. Complete the business authorization/state machines, provider execution and reconciliation, full source parity and domain prerequisites already listed in checkpoint 3.
4. Review legacy data conversion and populated upgrade/restore, retention/erasure/export design, per-app release suites and operational sign-offs.

No new user-input blocker prevented this bounded work. Later live acceptance still needs team-controlled environments/credentials and domain-policy decisions. Do not treat draft/runtime tests as business, regulatory or production certification. Every production_ready flag remains false. Deployment stays with the user's team.

## Reproduce

- pnpm typecheck
- pnpm exec vitest run scripts/fleet/tests/runtime-config.test.ts scripts/fleet/tests/runtime-process.test.ts --maxWorkers=1
- pnpm exec vitest run --maxWorkers=4
- pnpm fleet:status --summary --check-sources
- pnpm fleet:status --summary --require-complete (expected nonzero)

Preserve checkpoint 3 as historical evidence for the domain runtimes. This fourth checkpoint records only the additional standalone launch boundary.
