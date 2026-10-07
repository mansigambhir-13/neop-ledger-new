# ADR-0019: Persisted jobs through the shipped backend and assistant processes

**Status:** Accepted for local verification; not release or business-policy approval

**Date:** 2026-10-01

**Deciders:** Rebuild implementation; domain owners and operations retain acceptance sign-off

## Context

Checkpoint 3's draft workflows used an in-process pilot. Checkpoint 4 tested standalone startup without installed jobs, and checkpoint 5 tested assistant images against a fixture gate. None proved a persisted draft job passing between the real standalone backend and assistant. V3 sections 5–7 and 13 require durable waits, exact-content human decisions, a fresh assistant after a wait and the backend-owned record book.

Minimal backend image work also needs a reviewed target-platform sandbox runtime. The shared backend contains the Deno protocol sandbox; copying the macOS executable or silently omitting that execution path would not establish a complete backend artifact. This checkpoint therefore closes the process-job verification gap independently. Backend packaging remains an uncompleted implementation step, not an external blocker or a claimed deliverable.

## Decision

Run each remaining app's shipped scripts/backend.ts and scripts/agent.ts in separate Node child processes. Use production-mode startup validation with synthetic local credentials, clean worker environments and disposable PostgreSQL. Keep the actual gate, runner, book, app-specific handlers, assistant SDK and signed/metered LLM proxy path. Fake only the Matrix homeserver and the upstream model; the scripted model uses the real Anthropic-compatible SSE protocol.

Use one disposable platform/database fixture to register/install the apps for testing. This setup runs in test mode and issues no release attestation. Each app receives its own company, two linked fixture humans, one allowlisted bridge and a company-bound room. Drive jobs and decisions through typed Matrix events rather than calling business handlers from the test. Database reads verify persisted outcomes; no test updates a job/proposal/business row to simulate success.

The parent owns loopback-only TCP relays for stable gate/worker addresses across child restarts. These merely forward bytes to the currently bound local port: no authorization, business behavior, credential injection or production gateway is added. Children bind ephemeral ports and hold their normal app/runner roles. Only the local upstream fixture receives the synthetic provider key; workers receive runner-minted short-lived model tokens through the existing session protocol.

For every app, exercise an empty read, guarded configuration/import, preparation of an internal draft, rejection and cancellation. Hard-kill the waiting backend before approving the import; replace the waiting worker before rejecting cancellation. Require distinct persisted session IDs and transcript evidence of the wake/proof. This proves waiting-state recovery, not recovery after an external effect or mid-tool crash.

## Options considered

- Extend the in-process pilot only: fast and useful for domain coverage, but still would not exercise the shipped process boundaries or startup environment.
- Put a fake gate behind the standalone worker: already covered by checkpoint 5; cannot prove persisted proposals, runner execution or job recovery.
- Launch real backend/worker processes with local transport fixtures: chosen. Covers the missing protocol/persistence chain while preserving existing implementation and enabling deterministic negatives. It is slower than unit tests and does not replace packaged or live-environment acceptance.

## Test plan and interpretation

| Scenario, for each app | Evidence required |
| --- | --- |
| Sender/company/room boundary and empty read | Invalid ingress creates no jobs; actual SDK reads empty data; redelivery keeps one persisted job and one done event |
| Model sessions | Real runner signature accepted by the real proxy; app/company-scoped metering; provider fixture sees only its own synthetic key |
| Configuration/import | A proposal exists before the record change; bridge yes, stale fingerprint and wrong thread are refused; exact human approval executes |
| Waiting backend crash | SIGKILL, new backend PID, existing proposal resumes, one import record, proof/read-back and two distinct persisted assistant sessions |
| Domain draft | App-specific sample values and derived read results match; forged actor/approved/success fields create no draft; persisted receipt explicitly says no external completion |
| Waiting worker replacement | New assistant process, human rejection, unchanged draft and no cancellation receipt |
| Cancellation and replay | Bound input hash; one cancellation receipt; same-event and new-event replay do not duplicate the effect or done event |
| Cleanup and regression | Only owned child processes, relays, fixture services and the created disposable database are closed; full regression and typecheck remain required |

Physical tables, declared reads and execution receipts have different contracts. In particular, external_completed is a derived read/receipt field, not a stored terminal-success flag. Receipt assertions bind the actual execution reference rather than assuming a nonexistent ability column.

## Limits and follow-up

- These remain internal-draft lifecycles. Approval of an import or cancellation is not authorization to pay, send, sign, provision, export or file. No business provider is enabled and no new domain capability is added.
- Two fixture humans exercise the shared approval path; they do not certify missing app-specific four-eyes/elevated entitlement rules or changing membership/policy at execution time.
- There is no real Matrix/model/provider/NEOS UI acceptance, no Linux backend artifact, and no network-isolation claim from host child processes. Checkpoint 5's assistant-image evidence remains separately scoped.
- Active-session crashes, in-flight effects, concurrent executors, proxy/homeserver outages, uncertain outcomes and load/recovery need additional scenarios. Existing in-process tests are useful but not substitutes for the missing process cases.
- Next, supply minimal backend artifacts with a verified Linux sandbox runtime and per-app configuration/network templates, then repeat persisted-job scenarios against both packaged processes. Continue checkpoint 3's business authorization, provider, source-parity, migration and privacy gaps in parallel with those local verification steps.
