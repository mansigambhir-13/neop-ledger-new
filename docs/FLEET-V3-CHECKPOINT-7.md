# Fleet V3 rebuild — seventh verified implementation checkpoint

Date: 2026-10-01. Branch: rebuild/fleet-v3. Starting commit: 1966d27d86f4a7d2b68fd7594befdc62c2c2285c.

Worktree: /Users/mansi.gambhir/Documents/NEOPS_NEW/.claude/worktrees/fleet-v3-rebuild.

## Outcome and scope

All eighteen remaining apps now have locally built and rehearsed Linux ARM64 backend-only images. Each image contains only its own app domain, backend/template sources, a 23-package installed dependency closure and the existing lock-pinned Linux Deno 2.9.6 sandbox. It contains no assistant worker, model SDK or platform source. The backend image works non-root with a read-only root filesystem and refuses both changed migration checksums and injected model-provider keys.

This closes the local backend-artifact gap left by checkpoint 6. It does not add a business ability, complete source parity or establish production acceptance. Full persisted jobs across BOTH packaged images are still required; checkpoint 6's real host-process jobs are separate evidence. Existing assistant images were not rebuilt in this run. No runtime business code, applied migration, dependency version, root checkout, Ledger release checkout or Ledger/Wage application code changed. No deploy, push, merge, real provider action or production-data operation occurred.

## Implemented

- Explicit backend context builder and inventory verification, separate per-app overlays and fixed-app loaders. Reviewed shared source trees reject links, hidden/unsupported files and embedded test files. Model packages are refused in the backend dependency closure. Existing assistant helper defaults remain unchanged.
- Lockfile SHA-512 verification of the official Linux Deno archive before named-member extraction to stdout, package/version/OS/CPU and ELF checks, binary/archive hashes and executable-mode checks. No host executable or dependency install hook is copied/run. A digest-pinned Node base verifies target Deno version/architecture during a network-disabled build.
- Opt-in all-eighteen image harness using a new disposable PostgreSQL container, labelled ownership, synthetic credentials, restricted app/runner roles and an internal backend network. Only the fixture database additionally has a loopback-bound control port. No host data volumes or production DB URL are used. All fixture containers/networks are removed; tested images are retained locally.
- Actual template Sandbox probes inside every backend image: filesystem read/write, environment, network and subprocess operations are denied; an allowed synthetic book-step RPC succeeds. These probes are not complete sandbox-escape or vulnerability certification.
- Per-app acceptance/rebuild evidence updated without promoting any group or readiness flag. ADR-0020 and FLEET-V3-BACKEND-PACKAGING.md describe the design, reproduction steps and limits.

## Verification

| Check | Result |
| --- | --- |
| Complete regression suite | 163 files; 1413 passed; 0 failed; 2 existing conditional skips; 428.98 seconds |
| Packaging policy subset | 29 passed: 16 backend + 13 existing assistant tests; included in full count |
| Final catalog rerun | 6 passed; overlaps full regression, not additional tests |
| TypeScript | PASS |
| Pinned source snapshots | 108/108 verified |
| Fleet completion gate | Expected exit 1; no production-ready apps |
| Backend image builds | 18/18; Linux ARM64; default non-root |
| Actual backend startup/readiness and app/runner roles | 18/18 passed |
| Own-app-only artifact, no model SDK/worker, read-only execution | 18/18 passed |
| Appservice token checks and empty job book | 18/18 passed; no complete Matrix job in this image rehearsal |
| Changed migration / injected provider key refusal | 18/18 exit 78 with safe refusal events |
| Deno permission denials plus allowed synthetic RPC | 18/18 passed |
| Clean backend shutdown and fixture cleanup | 18/18 passed; zero owned containers/networks remain |

The image rehearsal's final report is `/Users/mansi.gambhir/Documents/Codex/2026-09-28/lo/work/fleet-backend-images-7-verified.json`. Its hashes, per-app results, local image IDs and source hashes are in docs/evidence/FLEET-V3-CHECKPOINT-7-BACKENDS.json. Local image IDs are not registry digests or signed release attestations.

The complete regression report is `/Users/mansi.gambhir/Documents/Codex/2026-09-28/lo/work/fleet-v3-checkpoint-7-tests.json`. The 16 new policy tests are included in the 1413 passes, not added to them. The two existing conditional skips remain real-S3 and PostgreSQL dump/restore prerequisites; neither establishes fleet storage/backup acceptance. Source files were frozen during the final image/full-suite runs; subsequent edits record evidence only. The full suite ran concurrently with the disposable image rehearsal; no timeout or test guard was relaxed.

The final generated context is `/Users/mansi.gambhir/Documents/Codex/2026-09-28/lo/work/fleet-backend-context-7-verified`; it has 1813 inventory entries, 23 dependencies and artifact.json SHA-256 1982a8d43e905faee910cc045e3f78090ceb0c814263669a3878171fdfa5ebd1. The final source generators and context inventory were checked again after the image run.

## Failure history and review

Three earlier image-rehearsal attempts failed before a successful per-app result: Docker did not publish a port for an internal-only database network; the database readiness probe observed PostgreSQL's temporary initialization socket rather than final TCP readiness; and Deno rejected an unsupported --json option on the version command. The harness now uses a separate loopback control connection for only its disposable database, waits on TCP and checks ordinary Deno version output. Every failed run cleaned up its own containers/networks and kept a separate report. The final new-context run passed all eighteen; no application guard or test assertion was weakened.

Architecture/testing-strategy skills guided separate artifacts and actual container/sandbox tests. The debugging skill isolated fixture/CLI assumptions. Code review added direct-source symlink refusal, executable-mode checks, tamper tests, pinned fixture images, pull refusal and cleanup continuation after database-close failure. These are scoped implementation checks, not production certification.

## Remaining work, blockers and next step

1. Run complete persisted internal-draft jobs through both packaged backend and assistant images, with fixture Matrix/model transports, approvals/replays and restart recovery. Add active-session/in-flight-effect crash, concurrency, outage and load scenarios. This is the next safe local slice; no new external authority is needed.
2. Complete checkpoint 3's business authority/state machines, provider idempotency/read-back/reconciliation, corrections/supersession and full pinned source entity/scenario parity. Draft import/cancellation approval does not implement payment, signature, access, dispatch, export or filing authorization/execution.
3. Complete reviewed legacy-data conversion, populated upgrade/restore and retention/erasure/export design, with DBA/domain-owner approval.
4. Per-app appservice/secret/storage/network configuration, x64/other target builds, SBOM/license notices/vulnerability/provenance review and manifest-bound release attestation remain open. Neither local Deno permission probes nor internal Docker networks prove production host/metadata/egress isolation.
5. Real Matrix/model/mailbox/doors/storage/NEOS UI acceptance and operational ownership remain team-controlled. Required environments/credentials, reviewed authority/retention policies and sign-offs are unavailable here. No new user-input blocker prevented this local slice; deployment remains with the user's team.

All eighteen still have partial/pending requirement groups and production_ready=false. No full business/source parity or complete V3 product is claimed. Final staged-patch scan and local commit are recorded in the handoff after all evidence is finalized.
