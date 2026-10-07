# ADR-0018: Explicit assistant artifacts with local container-boundary evidence

**Status:** Accepted for the local rebuild; not a release or deployment approval

**Date:** 2026-10-01

**Deciders:** Rebuild implementation; operations, security and domain owners retain release sign-off

## Context

V3 section 13 requires separate backend and assistant containers. The assistant has no database link or door credentials and can reach only its own backend and the model route. Checkpoint 4 added fixed-app process entrypoints, but the existing general-purpose agent Dockerfile copies the repository and installed workspace. That is not evidence of an assistant-only artifact. The Ledger release packaging must remain unchanged.

## Decision

Generate a new build context from an explicit source allowlist and the installed dependency closure needed by the shared assistant. Include only the eighteen fixed-app agent wrappers, shared agent/configuration/process modules, selected template agent files and contracts. The template package exposes only its agent export. Do not copy app definitions, domain/data implementations, migrations, backend launchers, repository configuration, legacy snapshots or credential files.

Walk declared production dependencies and peers using installed package resolution. Require every copied name/version to occur in the existing lockfile; refuse unresolved required dependencies/peers and database/backend packages. Record absent optional dependencies/peers. Refuse source symlinks and native artifacts rather than shipping unreviewed host binaries. Preserve ESM package layout with internal relative links; verify file hashes and link containment before image builds. Canonicalize the context root before containment checks, including macOS directory aliases.

Build one fixed-app image per NEOP from this context, a digest-pinned Node 24 base and no network-enabled build steps. Use shared content layers, a non-root default user and the existing keyless assistant launcher. The artifact manifest is an inventory, not a signature, independent provenance proof or release attestation. Lockfile membership does not independently authenticate the bytes of an installed dependency.

The opt-in local Docker harness uses uniquely labelled, internal disposable networks and a read-only, capability-dropped worker. It checks each app's image, accidental credential-injection refusal, own-gate/model reachability and refusal of live database/peer canaries on another network. A scripted Anthropic-compatible SSE response exercises the installed SDK and gate adapter through a completed fixture session. No real provider, database backend, homeserver or business effect participates in that session. Cleanup is restricted to the harness's own labelled containers/networks; local images are retained as evidence.

## Options considered

- Reuse the full-repository image: simplest maintenance, but retains backend implementations/dependencies and fails the minimal-artifact goal.
- Bundle the agent into one JavaScript file: smaller potential artifact, but the current SDK's static provider registry traverses absent optional Mistral telemetry peers. Externalizing the whole SDK still requires a dependency closure; rewriting upstream imports would expand this checkpoint's risk.
- Explicit sources plus installed dependency closure: chosen. Preserves tested upstream ESM behavior without changing dependency versions. The closure is larger than a provider-specific bundle and needs review whenever dependencies change.

## Consequences and limits

- The same reviewed packaging policy and tests apply to all eighteen wrappers without changing the Ledger Dockerfiles or shared business runtime.
- This is assistant packaging only. Backend images, per-app appservice/secret manifests, production network policies and complete business jobs across the real backend/worker split remain missing.
- Only the locally built Linux ARM64 images and current proxy wire protocol are tested. Other architectures and optional provider paths require their own verification.
- Docker bridge canaries do not certify production routing, host access, metadata endpoints, CNI/firewall rules or exhaustive egress isolation. The Node base still contains operating-system tools; it is not a minimal/distroless sandbox or a guarantee of no vulnerabilities.
- Dependency installation and source review are trusted inputs. SBOM, vulnerability review, signed provenance, registry digests and manifest-bound release attestation remain release gates.

## Test plan

| Boundary | Required local evidence |
| --- | --- |
| Context contents | All eighteen identities, exact source allowlist, transitive deduplication, database-package refusal and unchanged pinned versions |
| Filesystem | Existing-output refusal, native-file/source-symlink refusal, canonical root aliases, internal relative links, escaping-link refusal and post-build mutation detection |
| Container | Every image starts non-root/read-only with no secret mount/backend libraries; injected database configuration exits 78 without logging its value |
| Reachability | Own gate and fixture model accept TCP; live database and peer canaries on a separate internal network do not |
| SDK/session | One streamed model request, one job.finish call, transcript and finished session callback; clean shutdown |
| Regression | Full Ledger/Wage/fleet suite, TypeScript and pinned source verification; no new skip or weakened assertion |

## Follow-up

1. Produce equivalent backend-only artifacts and per-app configuration/network templates; inspect both dependency closures.
2. Exercise complete persisted jobs across separately packaged backend/assistant processes with local Matrix/model fixtures, including approval, restart and recovery.
3. Continue checkpoint 3's business lifecycles, verified human authority, provider read-back, source parity and migration/privacy work.
4. Obtain team-controlled live-environment and operational acceptance before any production-ready claim.
