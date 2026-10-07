# Standalone fleet runtimes — local implementation, not a release

The eighteen rebuilt apps now have separate backend and assistant entrypoints. They still implement internal draft workflows only. These commands do not perform migrations, register apps, deploy containers or enable provider actions. Ledger and Wage entrypoints are unchanged.

From the repository root, after installing the pinned workspace dependencies, choose one app:

```sh
pnpm --filter @neop/pay start:backend
pnpm --filter @neop/pay start:agent
```

The equivalent explicit commands are `node --import tsx apps/pay/scripts/backend.ts` and `node --import tsx apps/pay/scripts/agent.ts`. Replace `pay` with one of: asset, buy, clear, deal, desk, grant, guard, hire, post, quote, reach, renew, roster, shift, sign, sync or vet. Each wrapper hardcodes its app; `NEOP_APP`, if present, must agree. Do not share an environment file between backend and assistant.

## Backend configuration

| Setting | Requirement |
| --- | --- |
| `NEOP_APP_DB_URL`, `NEOP_RUNNER_DB_URL` | Required; respective `<app>_app` and `<app>_runner` roles for the same database. No admin link. DBA applies the reviewed migrations separately. |
| `NEOP_DIRECT_DB_URL` | Optional runner-role direct connection for LISTEN/execution locks when ordinary links use PgBouncer. Must name the same database; host may differ. |
| `NEOP_JOB_TOKEN_SECRET` | Required, at least 32 characters per comma-separated rotation key. Provision through the backend secret store. |
| `NEOP_AGENT_URL`, `NEOP_GATE_URL` | Required HTTP(S) origins; no userinfo, query, fragment or path. |
| `NEOP_PRESENCE` | `appservice` or `client` (default). No off/gateway mode. |
| `NEOP_MATRIX_HOMESERVER_URL` | Required HTTP(S) endpoint. |
| Appservice mode | `NEOP_MATRIX_HS_TOKEN`, `NEOP_MATRIX_AS_TOKEN`; `APPSERVICE_PORT` defaults to 4104. |
| Client mode | `NEOP_MATRIX_CLIENT_ACCOUNTS`: reviewed JSON list of per-company account/token-file references, as specified by the shared template. |
| `NEOP_LLM_PROXY_URL`, `NEOP_LLM_SIGNING_KEY` | Both or neither in local non-production mode; both required with `NEOS_ENV=production`. Private Ed25519 JWK with `kid`, trusted by the proxy for this app. No provider API key in this backend. |
| `NEOP_REGISTRY_JWKS` | Optional public registry key set when pinned packages need it; private keys refused. |
| `NEOP_METRICS_TOKEN` | Optional secret for the existing `/metrics` endpoint; without a token metrics are closed by default. `NEOP_METRICS_PUBLIC=1` is refused in production mode. |
| `NEOP_FILES_PUBLIC_URL` | Optional public signed-file base URL. |
| Listener controls | `FILES_PORT` 4101, `GATE_PORT` 4102; `FILES_HOST`, `GATE_HOST`, `APPSERVICE_HOST` default to `127.0.0.1`. Ports must be 0–65535 (0 is for local test allocation). |
| Other controls | `POOL_SIZE` 1–100, default 5; `RUNNER_ID` defaults to app plus process id; optional Matrix timeout values must be positive integers. |

Backend settings resolved by the launcher's configuration helper support an equivalent `_FILE` variable. Do not provide both a value and its `_FILE`; conflicts and unreadable/empty files fail closed. Host bindings are resolved before startup. The backend template's `/live`, database-connectivity `/ready`, and authenticated `/metrics` remain on the files listener; this checkpoint adds no separate metrics relay.

Database URL query parameters are limited to reviewed TLS, application-name and connection-timeout options. User/host/port/password overrides and arbitrary PostgreSQL startup `options` are refused; put connection identity in the URL authority/path so preflight and the driver agree.

No model signing configuration in local mode produces an explicit `model_sessions_unconfigured` warning. It never falls back to a provider key or pretends an assistant job succeeded.

## Assistant configuration

- Required: `NEOP_ALLOWED_GATE`, the exact origin of this app's backend gate.
- Optional: `HOST` (loopback by default), `PORT` (4103), `POOL_SIZE` (5).
- Optional non-secret model metadata: `NEOP_LLM_MODEL`, `NEOP_LLM_API`, `NEOP_LLM_PROVIDER`, `NEOP_LLM_COST_IN`, `NEOP_LLM_COST_OUT`.
- Never inject database links, Matrix credentials, job-token signing secrets, door/registry secrets, provider keys, cloud access keys or `_FILE` settings. Startup refuses detected sensitive settings. Short-lived model/job tokens arrive only inside runner-created session requests.

The assistant listens for its own runner and exposes `/live`. A session with another gate is refused, and a session without a model token is refused. It has no fallback direct-model credential. Deployment still needs an isolated network limiting it to its own backend and the model proxy, a secret-free filesystem/image and no host/cloud credential mounts. The process checks do not prove those deployment properties.

## Errors and shutdown

Structured events include `configuration_refused` (setting names only), `schema_refused` (pending/unknown/changed migrations), `startup_failed`, `started`, `stopping` and bounded-shutdown failures. Configuration/schema errors exit 78; other failures exit 1. Arbitrary exception text, secret values and secret paths are not logged by the wrapper.

SIGTERM/SIGINT stops listeners and backend resources, with a 10-second backend deadline and 5-second worker deadline. A worker's in-flight session may be abandoned; the book and runner's existing claim/restart protocol own recovery. This is not evidence of graceful completion of an external business action.

## Remaining release work

Checkpoint 5 covers local assistant images and network canaries. Checkpoint 6 covers persisted internal-draft jobs through actual backend/assistant child processes, including waiting-state restart and exact-content decisions, with local Matrix/model fixtures. Checkpoint 7 covers own-app Linux ARM64 backend images with the lock-pinned Deno sandbox, no model SDK, startup/role/health and refusal checks. Checkpoint 8 repeats the ninety persisted-job assertions through both exact images with isolated synthetic fixtures. These do not establish complete business or live acceptance.

Appservice registrations, secret/storage provisioning, production network policy/probes, active-session/in-flight-effect recovery, other architecture builds, SBOM/license/vulnerability/provenance review, live environment acceptance and business workflow completion are still required. `/ready` is not a production-readiness attestation. See FLEET-V3-BACKEND-PACKAGING.md, FLEET-V3-PACKAGED-JOBS.md, ADR-0017, ADR-0019, ADR-0020, ADR-0021 and the latest checkpoint evidence before any release decision.

## Checkpoint 9 source change

Pay/Buy/Renew internal settings/import/cancel handlers now require transaction-time human authority; their manifest versions are 0.2.0 and those three ask-first abilities are 1.1.0. Shared forward migration t020 must be reviewed/applied before these sources can boot. Migration rehearsals used synthetic populated V3 books, not production restores. Prior backend/assistant images and checkpoint 8 packaged runs remain historical evidence only; shared template/gate changes require artifact refresh and new packaged acceptance. See ADR-0022 and FLEET-V3-CHECKPOINT-9.md. No external dispatch exists.

## Checkpoint 10 draft provenance

Pay/Buy/Renew advance to manifest 0.3.0 and prepare ability 1.1.0. Shared t021 and each app's 004 migration add an opt-in origin trigger and an immutable app-owned origin table. Preparation now requires a real active creating-job context; a standalone handler call with no job is refused. Historical rows are not attributed retroactively. Regenerate reviewed DBA bundles, both artifacts and packaged acceptance; prior bundle/image evidence does not cover this revision. This is not business approval or a privacy/retention certification. See ADR-0023 and FLEET-V3-CHECKPOINT-10.md.
