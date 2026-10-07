# ADR-0021: Run the persisted draft lifecycle through both packaged runtimes

Status: Accepted for local fixture verification, not production acceptance.
Date: 2026-10-01.
Deciders: implementation checkpoint; domain, DBA and operational owners retain release approval.

## Context

V3 sections 5, 12 and 13 require backend/assistant separation, a durable book and recoverable short-lived assistant sessions. Checkpoint 6 exercised persisted jobs through host processes; checkpoints 5 and 7 tested the two artifacts separately. Neither established that both packaged runtimes could complete those jobs together.

## Decision

Add an opt-in Docker driver to the existing ninety persisted-job assertions, rather than duplicate or weaken them. Default regression still launches host processes. Docker mode uses the exact local Linux ARM64 image IDs from the verified checkpoint evidence, with no builds, mutable-tag fallback or image pulls. Before allocating fixtures, verify both retained artifact inventories, their evidence hashes, the current lockfile, original packaged source hashes and each cached image's app/platform/user identity. This guards against accidentally reporting current-code success while executing older packaged source; it is not a signed release attestation or a completeness check for newly added source absent from those inventories.

Use a newly created PostgreSQL container with tmpfs data and a loopback-only control port. Host fixture tooling runs the real platform/metered model proxy and scripted Matrix/upstream-model servers. The actual app backend and assistant run non-root, read-only, capability-dropped in their existing images with separate configuration. No handler shortcut or successful-job SQL mutation is added.

Each assistant joins only its app's internal network. Its own backend gate and a fixed-target model TCP relay are reachable there; backend file/appservice listeners bind only the control interface. A separate fixed-target relay listener exposes the assistant's control endpoint to the host through loopback. Relays contain no business logic, authorization decisions or arbitrary destination routing. The backend is dual-homed to reach the synthetic database and host fixtures. This is test plumbing, not production network policy.

At initial startup for each app, probe actual assistant connectivity: gate/model succeed; file service, Matrix ingress, direct disposable-database IP and host-published database port fail. These narrow canaries do not establish general internet, host, cloud metadata or malicious-egress resistance. App/runner credentials remain backend-only; the worker receives short-lived signed job/model tokens through the normal runner.

Cleanup only targets names tracked by this invocation and bearing its random ownership label. A cleanup failure does not prevent other fixture cleanup attempts. Creation is refused after shutdown begins, and shutdown waits for tracked in-flight creations. Fixture cleanup and test outcomes are recorded separately; clean fixtures cannot imply a passing test.

## Alternatives

- Repeating standalone image boot checks is cheaper but leaves the actual persistence and model-session chain untested.
- Reimplementing a smaller container-only happy path duplicates contracts and risks bypassing failure/replay assertions.
- Using live Matrix/model/provider services adds credentials and side effects that are neither needed nor authorized for this local slice.

## Verification and limits

Reuse all five scenarios per app: ingress/empty read/redelivery; approval-bound import with a waiting backend crash; app-specific draft plus forged-authority refusal; rejection after worker replacement; exact cancellation and replay dedupe. Run the ordinary full regression separately and do not add repeated Docker executions to its distinct test count. Unit-test image coverage, immutable identities, fixture URL restrictions, source binding and cleanup continuation.

Still required: broader active-session/in-flight-effect recovery, concurrency/outage/load scenarios; business authority/state machines; full source parity and provider interfaces; reviewed migration/privacy policy; release manifests, SBOM/license/vulnerability/provenance review; other target architectures and real Matrix/model/doors/UI/operational acceptance. No production-ready flag or external effect is enabled. Checkpoint 8 records executed results and failure history.
