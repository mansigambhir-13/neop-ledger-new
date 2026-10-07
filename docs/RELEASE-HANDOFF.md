# Ledger V3 engineering handoff

Release branch: `s9-delete-gateway`
Repository: `NEOS-Ecosystem/neos-neop-ledger-new`
Specification: `NEOP-WHOLE-PICTURE-v3.md`

The engineering deliverable is the committed, tested Matrix-only Ledger implementation. Deployment, production credentials and environment acceptance belong to the deployment team. This handoff does not certify external providers or assert that a production environment has been deployed.

## Release contents

- Matrix is the only runtime transport. Ledger and NeuralChat have separate identities and credentials.
- App-owned schemas and reviewed functions/views enforce reads, switchboards, jobs, questions, transcripts and approvals.
- Only a person can approve a proposal's exact fingerprint. Execution is recorded once with read-back evidence and restart recovery.
- Packages are reviewed, signed and pinned at build time. The assistant has no database/provider credentials or unrestricted tools.
- Normal installation applies safe expand migration 024. Destructive contract migration 025 remains an explicit operator action after restore rehearsal.
- Deployment refuses an upgrade with no successful backup. Missing deployment state alongside an existing database causes an explicit stop.
- Fast Matrix replies wait for the preceding card/question send receipt to be saved before the account interprets them; a deterministic regression covers the approval-policy race.
- CI validates the actual Matrix topology with real Synapse, plus regression, typecheck, V3 contract, image, secret-history and network checks.

## Verification

See `docs/RELEASE-VERIFICATION.md` for the final test results, local container/network checks, image digests and the GitHub Actions billing limitation.

Final local regression: 94/94 files, 609 passed, 0 failed and 2 conditional integration skips. Type-checking and the secret-history scan pass. The readiness plan also records earlier Matrix end-to-end, populated migration, load, chaos, PostgreSQL restore and S3-compatible storage evidence. The final release attestation lives in `deploy/attestations/ledger.json`.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

Tests require an isolated local PostgreSQL 17 test service; the default is `localhost:5433`. Do not point the test suite's admin connection at production. Real object-store and PostgreSQL client tests need their documented integration inputs.

Generate an attestation only after committing the source and obtaining a clean worktree:

```sh
pnpm exec tsx scripts/conformance.ts ledger --out deploy/attestations/ledger.json
```

The attestation records the source commit. A following packaging commit may contain the generated attestation; it must not change source or manifests. Image digests from earlier rehearsals belong to those earlier builds. The deployment team should build this release and record its resulting digests.

## Deployment-team boundary

Use `docs/RUNBOOK.md` and the production environment template. Keep original secrets and deployment state on persistent, backed-up storage. The external-client topology needs distinct Ledger and NeuralChat account/token files. The local-appservice topology uses `compose.chat.yml` and separate exclusive registrations.

The deployment team completes target-host install/upgrade, production Matrix acceptance, restore/cutover evidence and DBA sign-off, exact object-store recovery, provider/model/mailbox checks, real NEOS UI acceptance, GSP sandbox certification and operational ownership. Record those results against `docs/V3-PRODUCTION-READINESS-PLAN.md`.

Do not run migration 025 as part of ordinary deployment. Preserve the rollback backup and approval record for the separate cutover. The repository web service is a test harness; product UI acceptance uses the real NEOS renderer.
