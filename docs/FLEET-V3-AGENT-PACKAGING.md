# Fleet assistant packaging — local verification only

This packaging path covers Asset, Buy, Clear, Deal, Desk, Grant, Guard, Hire, Pay, Post, Quote, Reach, Renew, Roster, Shift, Sign, Sync and Vet. It does not replace the Ledger release Dockerfiles and does not create backend images. All fleet production-ready flags remain false.

## Prerequisites and safety

Use the existing frozen workspace dependencies and Node 24. The packager adds no dependencies and executes no package install scripts. Docker is needed only for the opt-in image rehearsal. Its Node base must already be available at the digest in deploy/fleet/agent.Dockerfile; the rehearsal builds with pull disabled and no build network. No environment file, provider key, production data or database connection is needed.

Choose new output paths outside the repository. The packager refuses an existing context, and the image harness refuses an existing report. Keep the earlier evidence if a run fails. An interrupted context build can leave its own partial output directory; it must not be reused as a successful artifact. Do not pass a production Docker context/daemon to this local harness.

## Build and verify the context

From the fleet worktree, with a new path substituted for `/absolute/new-agent-context`:

```sh
node --import tsx scripts/fleet/agent-context.ts build /absolute/new-agent-context
node --import tsx scripts/fleet/agent-context.ts verify /absolute/new-agent-context
```

The generated context contains selected first-party sources, vendored installed dependencies with internal links, one fixed entry per app, a Dockerfile, a restrictive .dockerignore and artifact.json. The inventory records source/dependency file hashes, the lockfile hash, generator hash and unavailable optional peers. It refuses database/backend dependencies, missing required packages, installed versions absent from the lockfile, native artifacts and escaping links.

The manifest detects changes relative to its recorded inventory. It is not authenticated: changing both the files and manifest is not prevented by an unsigned hash list. Installation provenance and source review must be trusted separately. Optional peers are not silently downloaded; do not enable untested provider paths merely because the image starts.

## Build and rehearse all eighteen images

```sh
node --import tsx scripts/fleet/packaging/check-agent-images.ts /absolute/new-agent-context /absolute/new-image-report.json
```

The harness builds every app-specific image, then checks:

- Non-root default and runtime user, read-only root filesystem, dropped capabilities, no credential mount, and absence of backend/database packages and source paths.
- An injected database setting exits 78 with a safe configuration-refused event and no fixture secret in logs.
- Actual TCP reachability of the worker's gate and model fixtures, with two live but unreachable database/peer canaries on a different internal network.
- A short-lived model token supplied only in a fixture session, the actual SDK's streamed-response path, one job.finish call, transcript recording, a finished callback and clean SIGTERM.

The fixture gate is deliberately not a database-backed NEOP. This proves packaged code and wire-protocol operation, not business authorization, database persistence, Matrix sender validation, approval/restart semantics or a complete production job. All tokens/data are synthetic and all networks are local and internal. No payment, external message, signature, access change, export or filing is performed.

Each run has a random `neop.fleet.probe` ownership label. Normal and exceptional cleanup removes only that run's owned containers/networks and records any leftovers; failed cleanup makes the report unsuccessful. Local image tags and image IDs are retained. These IDs are not published registry digests. If interrupted externally, inspect the recorded prefix and resource labels before any manual cleanup; never prune unrelated Docker resources.

## Production gates still open

The executed checkpoint records the actual architecture and test results. Linux AMD64, other model SDK paths, vulnerability/SBOM/provenance review, production network/host/metadata isolation and load/recovery are not certified by this harness. Internal Docker bridges are fixture infrastructure, not deployment manifests.

Supply a reviewed model route and only the worker's own gate in eventual deployment; never mount backend secrets or a database link in the assistant. Preserve the existing session-scoped token model and the shared gate as the authority. Backend-only images, per-app appservice/secret/network manifests, complete multi-process business jobs and real Matrix/model/provider/NEOS UI acceptance still require implementation or team-controlled acceptance. Deployment remains with the user's team.

See ADR-0018 for the alternatives and constraints, FLEET-V3-RUNTIME.md for startup behavior and FLEET-V3-CHECKPOINT-5.md for executed evidence.
