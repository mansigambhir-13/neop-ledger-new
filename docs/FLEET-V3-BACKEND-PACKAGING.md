# Fleet backend artifacts — local packaging, not a release

Each of the eighteen fixed-app backends can be built from the explicit generated context using `deploy/fleet/backend.Dockerfile`. Do not use the repository root as its build context. Ledger/Wage Dockerfiles and entrypoints are unchanged.

## Inputs and generation

Install the approved pinned workspace dependencies. Supply a Linux Deno npm archive matching the existing template dependency and target platform in `pnpm-lock.yaml`. This checkpoint uses `@deno/linux-arm64-glibc@2.9.6`; the official archive is at `https://registry.npmjs.org/@deno/linux-arm64-glibc/-/linux-arm64-glibc-2.9.6.tgz`. Never substitute a host executable or bypass an integrity failure. The generator itself performs no downloads or dependency installation.

From the repository root, choosing a NEW context directory:

```sh
node --import tsx scripts/fleet/packaging/backend-context.ts build /absolute/new-backend-context /absolute/deno-linux-arm64-glibc-2.9.6.tgz arm64
node --import tsx scripts/fleet/packaging/backend-context.ts verify /absolute/new-backend-context
docker build --pull=false --network=none --platform linux/arm64 --build-arg NEOP_APP=pay -t neop-pay-backend:local /absolute/new-backend-context
```

Use one of the eighteen fleet app IDs for `NEOP_APP`. The base image must already be available locally. The current source lock supports an x64 Deno archive too, but this checkpoint supplies no x64 execution evidence.

The generated context records file/link inventory, lockfile and generator hashes, exact installed dependency versions, absent optional peers, and Deno archive/binary integrity. Verification checks content against this local inventory; a signed release manifest and trusted artifact distribution remain separate requirements. Copying an artifact and its manifest from an untrusted source does not establish provenance.

## Runtime configuration

See `FLEET-V3-RUNTIME.md` for required backend configuration and `_FILE` support. The image defaults to non-root and production mode, but intentionally contains no database link, signing key, Matrix token or door credential. Missing configuration must refuse startup. The DBA applies migrations separately; the backend checks them but never migrates at boot.

Run with a read-only root filesystem, dropped capabilities, no-new-privileges, bounded memory/PIDs and a small writable `/tmp` for the Deno cache. Code and the Deno executable are root-owned. Bind the files, gate and appservice listeners to their reviewed networks explicitly; loopback remains the default. Secret mounts, document storage, Matrix registration, network policy and image signing are team-owned release configuration still to be completed, not provided by the Dockerfile alone.

## Opt-in local rehearsal

```sh
node --import tsx scripts/fleet/packaging/check-backend-images.ts /absolute/new-backend-context /absolute/new-report.json
```

This command builds all eighteen images with network-disabled build steps. It starts a new labelled disposable PostgreSQL container, migrates only that new database, uses synthetic runtime credentials and a local HTTP fixture, and probes every backend. It never takes a production DB URL as input. Images are retained locally; its containers and networks are removed with ownership checks. Existing output reports are never overwritten. No host data directory is mounted into the database. Failed cleanup makes the result unsuccessful.

The rehearsal checks boot, health, app/runner roles, fixed app identity, model-package absence, schema-drift and provider-key refusal, appservice token checks and actual Deno deny-by-default permissions plus synthetic host RPC. It does not run a complete business job, use a real homeserver/model, or certify storage, backup, production egress or provider behavior. Checkpoint 6's persisted host-process jobs and checkpoint 5's assistant images are separate evidence; neither substitutes for a complete two-image job rehearsal.
