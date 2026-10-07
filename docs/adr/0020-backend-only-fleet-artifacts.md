# ADR-0020: Backend-only fleet artifacts with a lock-pinned Linux sandbox

Status: Accepted for local packaging and rehearsal; not production acceptance.
Date: 2026-10-01.
Deciders: implementation checkpoint; release/DBA/operations owners retain final acceptance.

## Context

V3 sections 10 and 13 require separate backend and assistant artifacts. The backend must retain package sandbox execution, its own domain and database role, while having no model SDK. The existing Ledger Dockerfile installs the whole workspace. The developer machine's Deno executable is macOS ARM64, not a Linux runtime. Checkpoint 6 proves host-process draft jobs, not packaged-backend behavior.

## Decision

Generate an explicit offline Docker context: shared backend/template/contracts/pgkit/domain-values sources, six reviewed dependency roots and their installed lock-pinned closure, eighteen separate app overlays, and one verified platform-specific Deno binary. Each image copies one app overlay; its generated fixed-app loader rejects other app names. The image retains source manifests, blocks, prompt text and migrations but excludes model worker/SDK code, other app domains, the platform and repository credentials.

The caller supplies the official npm Linux Deno archive. Before extraction, the builder checks its SHA-512 against the template's existing lockfile and checks the pinned platform dependency/version relationship. It extracts only named members to stdout from those same verified bytes, validates package identity and ELF architecture, records binary/archive hashes, and makes the binary read-only/executable. No archive-controlled path is extracted to disk and no install hook runs. The Docker build uses a digest-pinned Node base and checks Deno architecture/version inside the target image. Dependency versions and the lockfile are unchanged.

The assistant packager's existing dependency/inventory helpers are reused with backend-specific roots and exclusions; their assistant defaults are unchanged. Explicit source files and trees reject symlinks, hidden files and unsupported source types. Both generators are hashed in backend evidence. Inventory verification detects edits, extra files and escaping links; Deno executable permissions are checked separately. This is integrity evidence relative to the reviewed source and lockfile, not a signed release attestation.

## Options considered

| Option | Complexity | Consequence |
| --- | --- | --- |
| Existing whole-workspace backend Dockerfile | Low | Includes unrelated apps and assistant/model dependencies; does not satisfy the intended artifact separation |
| Copy host Deno or omit the sandbox | Low | Wrong operating system or a silently missing package capability |
| Explicit context plus pinned Linux archive | Medium | Small backend closure and one app per image; needs target-architecture validation and artifact evidence |

## Test plan

- Unit/artifact: selected sources, fixed identity, exact archive integrity, wrong package/version/OS/CPU/ELF refusal, lock relationship, model-dependency refusal, source links/hidden files/native dependencies, overwrite refusal and inventory/mode tampering.
- Container integration, every app: non-root/read-only image; only its app domain; no model packages/worker; real boot and health with app/runner database roles; unauthenticated appservice refusal; authenticated empty transaction; unchanged empty job book; changed-migration refusal; injected provider-key refusal; clean shutdown.
- Sandbox, every image: actual template Sandbox and actual Linux Deno; filesystem read/write, environment, network and subprocess attempts denied; permitted synthetic book-step RPC round-trip succeeds. This is not all possible sandbox-escape testing or vulnerability certification.
- Regression: full existing suite, typecheck, pinned source hashes, expected incomplete-release gate and exact staged secret scan.

## Consequences and follow-ups

The opt-in rehearsal creates only labelled disposable containers and networks, with no host data volumes. Backend containers stay on an internal network. The disposable PostgreSQL container additionally joins a separate control network with a loopback-only host port for migration/assertion tooling; this is fixture plumbing, not production network design. Cleanup checks ownership and failure leaves the report unsuccessful.

This checkpoint targets Linux ARM64. x64 archive generation is supported by the same policy but is untested until separately built and rehearsed. No new domain capability or provider effect is enabled. Remaining work includes complete persisted jobs across both images, active-session/in-flight-effect recovery, per-app appservice/secret/network templates, SBOM/vulnerability/provenance review, other target architectures and real Matrix/model/provider/UI acceptance. Final counts and failure history belong in checkpoint 7, not this design decision.
