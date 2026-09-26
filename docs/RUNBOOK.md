# neop-ledger runbook

For whoever deploys and operates Ledger on a customer VM. The platform pieces it
depends on (gateway, desk, vault, LLM proxy) ship in the same repo.

## Deploy
This whole sequence has been run end to end in Docker Compose. Every image sets `NEOS_ENV=production`, so a missing credential stops the service; it never falls back to a dev default.

1. **Secrets:**
   ```
   pnpm exec tsx scripts/gen-secrets.ts                 # fills deploy/secrets/ (git-ignored, 0600, never overwrites)
   echo "<provider key>" > deploy/secrets/llm_upstream_key
   # OpenRouter instead of Anthropic: export NEOP_LLM_UPSTREAM_URL=https://openrouter.ai/api NEOP_LLM_UPSTREAM_AUTH=bearer NEOP_LLM_UPSTREAM_MODEL_PREFIX=anthropic/
   ```
   It generates the Postgres admin, a password per role, matching connection URLs, Ledger's service, job-token and package keys, the vault key and the metrics token. The signing keyrings are not secrets files: they rotate in place, so they live on the `platform-keys` volume and are created on first boot. **Back that volume up.**
2. **Migrate:**
   ```
   docker compose -f deploy/compose.pilot.yml run --rm migrate
   ```
   - This is the only process with the admin connection.
   - It runs platform, template (`t###`) and Ledger (`###`) migrations, plus any package migrations that installs are waiting on.
   - It is safe to re-run.
   - `NEOS_APPS` picks the apps (default `ledger`).
3. **Start:**
   ```
   docker compose -f deploy/compose.pilot.yml up -d
   ```
   The platform and the backend report healthy on `/live` and `/l3/ready`. A missing setting makes a service exit with code 78 and a JSON log line naming every missing variable.
4. **Bootstrap.** Run these once, in the platform image. `NEOS_DB_URL_FILE` and the service secret come from the same secrets directory.
   ```
   OPS="docker compose -f deploy/compose.pilot.yml run --rm --no-deps \
        -e NEOS_DB_URL_FILE=/run/secrets/neos_app_url \
        -e NEOP_SERVICE_SECRET_FILE=/run/secrets/ledger_service_secret \
        -v $PWD/deploy/secrets/ledger_service_secret:/run/secrets/ledger_service_secret:ro \
        platform tsx scripts/ops.ts"
   $OPS register-app ledger http://ledger-l3:4101   # L3 is reachable only on the l3 network, by this alias
   $OPS create-company "Acme Traders" Asia/Kolkata          # → {"id": "<company_id>", ...}
   $OPS create-user <company_id> "Priya" priya@acme.in admin # → the admin's desk token, shown once
   $OPS install <company_id> ledger
   ```
   Desk tokens are stored as a SHA-256 hash only; a lost token is replaced, not recovered.
5. **Test harness desk (development and CI only):** `docker compose -f deploy/compose.pilot.yml --profile test up -d web`, then open `http://127.0.0.1:4780`. It stands in for the NEOS app so a NEOP can be driven end to end; each app's screens come from its blocks. It refuses `NEOS_ENV=production` — people use the NEOS app. Sign in with a desk token; it lives in an httpOnly cookie and the page never sees it.
6. **Smoke check:**
   - `GET /api/me` with the admin token.
   - `POST /api/apps/ledger/read/ledger.report.trial_balance {"as_of":"<today>"}`.
   - Ask something from the desk. The job should reach the agent, the LLM proxy and the provider.
7. **Network check:** `scripts/netcheck.sh deploy/compose.pilot.yml` runs a probe inside every container and fails if any row of the network policy is broken. Run it after every deploy.
8. **Chat (optional):** `scripts/matrix-setup.sh deploy/compose.pilot.yml` once, then start with `-f deploy/compose.chat.yml`. An admin binds the app's room (`POST /api/chat/rooms {app, room_id}` — invite the app's user `@neop_<app>_<company>` first) and links people (`PUT /api/users/<id>/chat {matrix_user_id}`).
9. **On today's NEOS platform** (`docs/pilot-ledger-integration.md`): set `NEOS_V1_PUBLIC_KEY_FILE` (the platform binding's Ed25519 public key, SPKI PEM) and `NEOS_V1_CUSTOMERS` (`{"<platform customer id>": "<company_id>"}`) on the backend, add the platform binding (`contractVersion: neop.v1`, loopback origin forwarded to L3), and register `apps/ledger/neos-v1/descriptor.json` + `contract.json` with `pnpm neop:register`. Regenerate them with `tsx scripts/neos-v1-descriptor.ts ledger` after any manifest change (CI fails on drift).
10. **Acceptance:** `NEOS_TOKEN_FILE=<an admin's token file> pnpm exec tsx scripts/pilot-acceptance.ts` sends 20 real requests and checks the plan's five acceptance criteria from the platform's records.

## Configure a company's providers (admin, write-only)
- **Email (Resend):**
  ```
  PUT /api/vault/email
  {"provider":"resend","api_key":"re_…","from":"Acme Books <books@acme.in>"}
  ```
- **GST filing (a GST Suvidha Provider):** install `nep-gst` (2.x), enable API access for the taxpayer's username on the GST portal, then set the GSP credential. Paths default to the GSTN taxpayer API layout; override them (and add any GSP-specific headers) to match your GSP.
  ```
  PUT /api/vault/gst_portal
  {"provider":"gsp","base_url":"https://<gsp>","client_id":"…","client_secret":"…","username":"<GST portal username>",
   "gstin":"27AAPFU0939F1ZV","signatory_pan":"AAPFU0939F","assume_supply":"intra_state",
   "paths":{"authenticate":"/taxpayerapi/v1.0/authenticate","gstr3b":"/taxpayerapi/v1.1/returns/gstr3b","returns":"/taxpayerapi/v0.3/returns"},
   "headers":{}, "timeout_ms":5000}
  ```
  `assume_supply` is used only when the chart keeps a single output and a single input GST account (the books then cannot tell CGST/SGST from IGST); name the tax accounts per head (IGST / CGST / SGST / cess) and the split is read from the books instead.
  OTPs are entered by a person, never by the assistant: when the portal sends one (login, or the signatory's EVC OTP before a filing), an admin puts it on the OTP door:
  ```
  PUT /api/vault/gst_portal_otp
  {"provider":"person","auth_otp":"123456"}        or        {"provider":"person","evc_otp":"654321"}
  ```
  The GSP session token lives only in the backend's memory (a restart means a new login OTP).
- **Check what is configured:** `GET /api/vault` lists door names and dates only. Secrets are never returned.

Every provider must either accept an `Idempotency-Key` and let us look the effect up afterwards, or (the GST portal) let us ask the system of record directly (RETSUM for a save, RETTRACK for a filing). Ledger journals each call before sending, so "did it happen?" always has an answer.

## Everyday operations
- **Backups.** Run a nightly `pg_dump --schema=ledger`, plus per-company logical exports: `pnpm backup export ledger <company_id> > file.json`. Restoring one company (`pnpm backup import file.json`) touches no other company.
- **Metrics.** Compose already wires `metrics_token` to both services. Scrape `/metrics` (platform) and `/l3/metrics` (backend) with `Authorization: Bearer <metrics_token>`. The dashboard is `deploy/observability/neop-dashboard.json`; alerts are in `deploy/observability/alerts.yml`.
- **Traces.** Set `OTEL_EXPORTER_OTLP_ENDPOINT`. One trace follows a request from the ask to the door.

## Rotating secrets
- **Gateway signing key:** `POST /api/ops/keys/rotate` (operator). This publishes the new key first; it starts signing after `activate_after_ms` (default 120 s). Call `retirePrevious` after a further 2 minutes.
- **Job-token secret:** set `NEOP_JOB_TOKEN_SECRET="new,old"`, restart, then drop `old` after 20 minutes.
- **Service secret:** write the new value to `deploy/secrets/ledger_service_secret`, run `$OPS rotate-service-secret ledger`, then restart `ledger-backend`. The old one keeps working for 24 h.
- **Vault key:** add a new key id to `NEOS_VAULT_KEYS`, make it `active`, and restart. Boot re-encrypts every secret.

## When something goes wrong
| Signal | Meaning | Do |
| --- | --- | --- |
| `NeopExecutionUnknown` | An approved action may or may not have happened (provider outage, lost answer) | Nothing at first. Reconciliation reads back every 30 s. Within 10 min (`NEOP_DOOR_RECOVERY_MS`) it can complete the send exactly once; after that it closes it as not sent and the person is told. |
| `NeopDeadLetters` | The platform could not apply an app event | Fix the cause, then `POST /api/dead-letters/ledger/<id>/replay`. Nothing is lost while it is parked. |
| `NeopAckSlow` | New jobs are acknowledged slowly | Check PgBouncer (`SHOW POOLS`) and Postgres; check `neop_gateway_latency_seconds`. |
| `NeopApprovalsPiling` | People are not answering cards | Product issue, not an outage. |
| Card stuck in RESOLVED | The app was unreachable when executing | The approvals worker retries with backoff. An execution whose process died is resumed as soon as its connection closes. |
| A job keeps failing | The assistant cannot finish | Read the job's steps (activity feed). After 5 interrupted sessions it fails honestly and asks a person to look. |

## Limits worth knowing
- **Model spend** is capped per job ($5) and per company-app per day ($50) by default; change them on the switchboard (`budget`). A job over its cap is refused before it calls the model.
- **Approval policy.** Companies can require roles or four-eyes per ability on the switchboard (`approvals`).
- **Closed months** take no postings until someone reopens them with a reason.
