# Fleet V3 rebuild — fifth verified implementation checkpoint

Date: 2026-10-01. Branch: rebuild/fleet-v3. Starting commit: c758642fb56425ef87f0d00341fc94a3f11d2db5.

Worktree: /Users/mansi.gambhir/Documents/NEOPS_NEW/.claude/worktrees/fleet-v3-rebuild.

## Outcome

All eighteen remaining NEOPs now have assistant-only build contexts and locally built, tested Linux ARM64 assistant images. Every image passed non-root/read-only execution, dependency/filesystem checks, accidental database-credential refusal, local network canaries, a streamed mock-model session through the actual SDK, and clean shutdown. This closes an assistant-packaging gap; it does not complete backend packaging, business workflows or production acceptance.

The apps are Asset, Buy, Clear, Deal, Desk, Grant, Guard, Hire, Pay, Post, Quote, Reach, Renew, Roster, Shift, Sign, Sync and Vet. No business implementation, migration, dependency version, Ledger/Wage runtime or existing release Dockerfile changed. No deployment, push, merge, external provider action or production-data operation occurred. The root checkout and separate Ledger release checkout were not changed.

## Implemented

- An explicit source/dependency context builder, with an agent-only template export, fixed-app entries, internal relative dependency links, file hashes and lockfile/generator hashes. The actual context has 114 installed dependency instances and 18,429 inventory entries. It contains no application backend/data implementation or pg/pgkit/platform/Deno package.
- Required dependency/peer and pinned-version checks; database-package/native-artifact/unreviewed-symlink refusal; refusal to overwrite an existing context; mutation and escaping-link detection. Unavailable optional peers are recorded, not installed or certified.
- A separate fleet assistant Dockerfile based on a digest-pinned Node 24 image, built from the generated context with no network-enabled build step. All eighteen images have fixed app identities and share common layers.
- An opt-in Docker rehearsal with unique ownership labels, internal fixture networks, non-root/read-only workers, dropped capabilities, no secret mount and bounded local fixtures. Cleanup touches only the run's labelled resources.
- Per-app acceptance evidence and rebuild notes updated without changing any production-ready flag or claiming additional source/business parity. ADR-0018 and FLEET-V3-AGENT-PACKAGING.md explain the design and reproduction steps.

## Executed verification

| Check | Final result |
| --- | --- |
| Complete regression suite | 161 files; 1307 passed; 0 failed; 2 existing conditional skips; 219.83 seconds |
| Packaging policy suite | 13 passed, included in the full-suite count |
| TypeScript | PASS |
| Pinned source snapshots | 108/108 verified |
| Fleet completion gate | Expected exit 1; no production-ready apps |
| Assistant image builds | 18/18; Linux ARM64; non-root default |
| Filesystem/dependency inspection | 18/18; read-only, no credential mount, selected backend/database paths/packages absent |
| Injected credential setting | 18/18 exit 78, safe configuration-refused event, no fixture value logged |
| Local network canaries | 18/18 reach own gate/model; cannot reach live database/peer canaries on the other internal network |
| Actual SDK with mock SSE transport | 18/18: one streamed model call, one job.finish, transcript and finished session callback |
| Shutdown and cleanup | 18/18 clean worker shutdowns; no owned containers/networks remain |

The two conditional skips remain the existing real-S3 and PostgreSQL dump/restore prerequisite checks. They are not new skips and do not establish backup/storage certification. The full regression used disposable local databases and fixture services; the image rehearsal used synthetic data and mock model/gate endpoints only. No real model API, Matrix homeserver or business provider was contacted.

Local image IDs, architecture, per-app results, generator/lockfile hashes and harness/fixture hashes are recorded in docs/evidence/FLEET-V3-CHECKPOINT-5-IMAGES.json. Images are retained locally; IDs are not registry digests or signed attestations. The authoritative local generated context for this run is:

`/Users/mansi.gambhir/Documents/Codex/2026-09-28/lo/work/fleet-agent-context-5-verified`

Its artifact.json SHA-256 is d0dbba4d696a1ca20b1fe04d63110229577325ef0f24d2824fb28abd6914aff1. The generator and lockfile hashes were checked against the final source. The full regression JSON is retained at:

`/Users/mansi.gambhir/Documents/Codex/2026-09-28/lo/work/fleet-v3-checkpoint-5-verified-tests.json`

## Failure history and review

A read-only single-file bundling experiment encountered missing optional Mistral telemetry peers in the installed SDK's provider registry. No dependency was upgraded or installed to hide that issue. The chosen layout preserves installed ESM packages and explicitly records absent optional peers; only the exercised proxy protocol is covered.

The first 12-test packaging run and initial full regression exposed four failures in inventory containment: macOS reports a temporary directory through /var, while realpath returns /private/var. The initial full run had 1302 passes, four failures and two skips. Canonicalizing the root fixes the false rejection without permitting escaping links. A new explicit root-alias/relative-escape test was added. The final 13-test run and fresh full regression above passed against unchanged final code; no assertion was weakened or failed test skipped. Earlier run evidence remains separate.

The first image rehearsal passed all eighteen images. Following code review, required-peer/lockfile checks and per-image secret-injection negatives were included in the final verification. The context was regenerated with the finalized packager and all eighteen images were rebuilt/retested; the recorded image report is from that final run, not the earlier rehearsal. Report files cannot silently overwrite prior evidence, and failed cleanup makes the report unsuccessful.

The architecture skill led to explicit assistant artifacts without changing the Ledger baseline. The testing-strategy skill added actual container and wire-protocol checks beyond unit mocks; debugging preserved symlink containment through the macOS alias fix. Code review added negative/refusal and evidence-preservation checks. These checks remain scoped implementation evidence, not product or release certification.

## Remaining gaps, blockers and next step

1. Build minimal backend-only images and per-app appservice/secret/network configuration templates. Then exercise complete persisted jobs across packaged backend/worker processes with fixture Matrix/model transports, approval, restart and recovery. This is the next safe local step.
2. Complete checkpoint 3's business lifecycles, authenticated proposer/approver separation, entitlements/revocation, provider idempotency/read-back/reconciliation and full pinned source scenarios. Draft tests and job.finish fixtures do not cover these gaps.
3. Resolve reviewed legacy conversion and populated upgrade/restore, retention/erasure/export policy and DBA approval. Immutable personal/business records need explicit policy; no policy was invented in this checkpoint.
4. Finish target-architecture builds, SBOM/vulnerability/provenance review, manifest-bound release suites, load/chaos/recovery and production network/host/metadata isolation. Docker bridge canaries are not an exhaustive production egress test.
5. Team-controlled Matrix/model/mailbox/door/storage environments, real NEOS UI acceptance and operational/domain-owner sign-off remain necessary. Provider credentials, reviewed business authority/retention rules and those acceptance environments are still unavailable here; no new input was needed for this local packaging work.

All eighteen remain internally tested draft products, not complete V3 products and not production-ready. Deployment stays with the user's team. No request for deployment authority or credentials is needed to continue the next local implementation slice.

## Reproduce

- pnpm typecheck
- pnpm exec vitest run scripts/fleet/tests/agent-context.test.ts
- pnpm exec vitest run --maxWorkers=4
- pnpm fleet:status --summary --check-sources
- pnpm fleet:status --summary --require-complete (expected nonzero)
- Build/verify a new context and run the opt-in Docker harness as described in FLEET-V3-AGENT-PACKAGING.md.

Final staged-patch checks and the local commit are recorded with the handoff after all evidence files are finalized; this document does not self-assert a future commit hash or release attestation.
