# NEOPS · Matrix-first NEOP runtime and Ledger pilot

Ledger is the reference NEOP. The current V3 architecture is Matrix-only: NeuralChat, people, and NEOPs exchange typed events in task threads; there is no runtime gateway or L3 fallback.

## Architecture

A request becomes a durable job in the NEOP's own Postgres schema. A keyless assistant receives only the job bundle and declared tools. Every tool call passes through the app-owned gate and switchboard. Writes become fingerprinted proposals; only a person can approve through the desk function or their own Matrix identity. The runner executes once, reads the effect back, records proof, and only then wakes a fresh assistant.

```text
packages/
  contracts/      typed Matrix contracts, fingerprints, schemas
  pgkit/          roles, forward-only migrations, tenant/RLS checks
  neop-template/  jobs, waits, proposals, operations, gate, runner, presence, files
  platform/       companies, desk, NeuralChat Matrix client/appservice, registry, LLM proxy
  testkit/        isolated pilot, fake homeserver/provider, conformance, load and chaos
apps/ledger/      bookkeeping NEOP and build-pinned GST package
apps/marketing/   second NEOP used to prove typed bus-room work and borrowing
deploy/           production compose, network policy, observability and verifier
```

Security boundaries:

- Each app owns one schema and restricted app/runner roles; tenant tables use forced RLS.
- The assistant has no database, provider credential, general shell, filesystem, or unrestricted network tool.
- Door credentials are per-app/per-company files mounted read-only into the backend, never the agent.
- Matrix sender class, membership, power level, event type, thread, and idempotency are checked before work opens.
- Packages are signed, reviewed, pinned, copied into the host build, and migrated through the host DBA bundle.

## Verify the build

```sh
docker compose up -d postgres
pnpm install
pnpm typecheck
pnpm test
pnpm test:load
```

`pnpm test` covers both Matrix roads, sender and approval rules, typed task/question/proposal/result threads, restart/redelivery dedupe, schema isolation, packages, GST, files, observability, migrations, backup logic, and the full Ledger books. `pnpm test:load` runs 200-task acknowledgement/completion and 50 forced restarts with duplicate-effect checks. The deterministic test assistant needs no provider key.

The two conditional infrastructure checks require `pg_dump` and `NEOP_TEST_S3_ENDPOINT`; release evidence must run them against the production PostgreSQL and object-store versions.

## Local pilot

```sh
export NEOP_LLM_UPSTREAM_KEY=...
# Configure NEOS_NEURALCHAT_MATRIX and NEOP_PRESENCE as client or appservice,
# with the matching Matrix URL, account/token or appservice variables.
pnpm dev
```

The local process exposes the platform on `:4700`, Ledger files on `:4701`, the private gate on `:4702`, and the agent RPC on `:4703`. The repository web UI is a development/test harness; the product UI is the NEOS app.

## Production

Use [docs/RUNBOOK.md](docs/RUNBOOK.md). Production requires one of these overlays:

- External homeserver: `deploy/compose.pilot.yml` + `deploy/compose.presence-client.yml`.
- Local Synapse appservice: `deploy/compose.pilot.yml` + `deploy/compose.chat.yml`.

`scripts/deploy.sh` performs the guarded install/upgrade sequence. `scripts/verify-install.ts` is the read-only release gate. Normal deploys stop at safe expand migration 024. Platform migration 025 is the explicit S9 contract migration: rehearse it on a restored production-shaped copy, drain approvals, take and prove a recovery backup, and obtain operator approval before applying it. Generate the conformance attestation only after the final commit and artifact are frozen.

Current implementation status and outstanding external acceptance are tracked in [docs/V3-PRODUCTION-READINESS-PLAN.md](docs/V3-PRODUCTION-READINESS-PLAN.md). Historical design material under `docs/source/`, `docs/IMPLEMENTATION-NOTES.md`, and `docs/V3-MIGRATION-PLAN.md` describes earlier stages and is not an operator guide.
