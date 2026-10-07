# ADR-0017: Fixed-app standalone entrypoints with shared startup validation

**Status:** Accepted for the local rebuild; not a deployment approval

**Date:** 2026-10-01

**Deciders:** Rebuild implementation; operations and domain owners retain release sign-off

## Context

Checkpoint 3 exercised all eighteen draft runtimes inside integration fixtures. None had its own backend or assistant executable. V3 sections 11 and 13 require schema-drift refusal and separate backend/assistant processes; they do not permit an assistant to receive database or door credentials. The Ledger release entrypoints must remain unchanged.

## Decision

Ship two fixed-app wrappers in each remaining app's `scripts/` directory. Reuse shared launch machinery under `scripts/fleet/runtime/`, leaving the existing template responsible for the gate, runner and Matrix transport. A backend-only, build-time allowlist resolves app definitions. The assistant never imports this loader or an app definition and receives only non-secret model metadata at startup; model credentials remain short-lived session inputs from the runner.

Validate configuration before opening listeners. Require the app's own named application/runner roles and matching database names, bounded integer settings, explicit Matrix configuration, credential-free HTTP endpoints and a sufficiently long job-token secret. Normalize Matrix modes before validating road-specific settings. Validate runner signing keys before startup. Mounted backend settings support `_FILE`, but simultaneous inline/file values are rejected. Worker startup refuses known database/provider/secret settings and file-based settings rather than silently ignoring a leaked credential.

Listeners default to loopback. Operations must explicitly bind each container interface; these defaults and checks are not a substitute for deployment network policies. Production-mode backend startup requires runner model-signing configuration and refuses public metrics. Startup never migrates, installs, registers or enables provider effects. Configuration/schema mismatches exit 78; other startup failures exit 1. Logs use reviewed fields rather than arbitrary exception text, to avoid credential-bearing URL/path leakage. Signals stop the process within a bounded deadline; durable jobs remain owned by the shared book/runner, not process memory.

## Options considered

- Copy Ledger's entrypoint eighteen times: low initial effort, but creates nineteen independently drifting startup/security implementations and carries Ledger-only configuration into unrelated apps.
- Change Ledger's entrypoint to a dynamic environment-selected universal launcher: fewer wrappers, but touches the release baseline and makes app identity an operational runtime choice.
- Fixed-app wrappers with a shared fleet launcher: chosen. Small per-app executables pin identity, while startup validation and tests remain shared. Shared changes still require fleet regression.

## Trade-offs and limits

This establishes standalone process execution only. It does not create minimal container images, prove an assistant's transitive dependency graph is free of backend libraries, enforce network reachability, or establish real Matrix/model/provider/UI acceptance. The worker's environment check is defense against accidental injection, not an exhaustive secret detector. Role-name checks do not certify production database grants. `/ready` means database connectivity, not completion of live integration or business acceptance.

Detailed underlying startup exception text is deliberately not logged by these wrappers; operational diagnosis uses safe event codes, named settings and infrastructure diagnostics. A future reviewed structured error vocabulary can improve this without exposing secrets.

## Test plan

| Boundary | Evidence |
| --- | --- |
| Fixed identity and explicit app loader | Every app; unknown/case-changed/path-like names refused |
| Configuration | Invalid ports/pools, credential-bearing endpoints, wrong DB roles/databases, missing Matrix, file conflicts, malformed signing material and secret-free diagnostics |
| Assistant startup | Every app in a child process with a clean environment; own gate only; no model session means refusal; accidentally supplied secret-file setting refused before read |
| Backend startup | Every app in a child process against a disposable migrated database and local fake homeserver; health, restricted role connections, unauthenticated ingress refusal and zero jobs/effects |
| Schema consistency | Altered migration checksum makes every app exit 78 without a started event |
| Shutdown | SIGTERM exits cleanly for every backend and worker; test cleanup owns only its child processes and disposable database |
| Regression | Full existing Ledger/Wage/fleet suite, typecheck and pinned-source checks |

These are startup/process tests, not new business end-to-end tests. Existing draft workflows continue to be exercised separately in the integration harness. No skip or mock success is promoted to release acceptance.

## Follow-up

1. Build and inspect separate backend/assistant images; pin dependencies and prove runtime network boundaries.
2. Rehearse complete jobs through separate processes with fixture model/Matrix transports, then obtain real-environment acceptance.
3. Complete missing business authorization, provider interfaces, source parity, migration/privacy policy and individual release suites.
4. Keep deployment with the user's team and all fleet production-ready flags false until evidence supports release.
