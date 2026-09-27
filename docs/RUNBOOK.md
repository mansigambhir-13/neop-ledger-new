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
   It generates the Postgres admin, a password per role, matching connection URLs, Ledger's service, job-token and package keys, the vault key, the metrics token and Grafana's admin password. The database defaults to `postgres:5432`; `--db-host`/`--db-port` (or `NEOS_DB_HOST`/`NEOS_DB_PORT`) move it, and `--dedicated <app>=<host>[:port]` gives one app its own cluster (see *Dedicated database for one app*). Compose reads the files from `deploy/secrets/` unless `NEOS_SECRETS_DIR` names another directory (absolute path). The signing keyrings are not secrets files: they rotate in place, so they live on the `platform-keys` volume and are created on first boot. **Back that volume up.**
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
   - This also starts `egress-proxy` (the stack's only way to the internet) and `backup` (nightly exports).
   - If this company files GST through a GSP, start with `NEOS_GSP_HOST=<gsp api host>` so the egress proxy allows it.
   - Dashboards and traces: add `--profile observability` (see *Observability*).
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
7. **Network check:** `scripts/netcheck.sh deploy/compose.pilot.yml [project]` runs a probe inside every container and fails if any row of the network policy is broken. Run it after every deploy; CI runs it on every push (job `netcheck`).
   - It covers raw sockets (the agent reaches no database, platform or internet; the backup reaches only the database).
   - It covers egress: from the backend and the LLM proxy, an allowed host answers through `egress-proxy` and `https://example.com` is refused. A direct connection to the internet fails.
   - It needs internet access. Override the probe URLs with `NETCHECK_ALLOWED_URL` and `NETCHECK_DENIED_URL`.
   - Pass overlays comma-separated: `scripts/netcheck.sh deploy/compose.pilot.yml,deploy/compose.chat.yml`.
8. **Chat (optional):** `scripts/matrix-setup.sh deploy/compose.pilot.yml` once, then start with `-f deploy/compose.chat.yml`. An admin binds the app's room (`POST /api/chat/rooms {app, room_id}` — invite the app's user `@neop_<app>_<company>` first) and links people (`PUT /api/users/<id>/chat {matrix_user_id}`).
   - **Client road instead (`MATRIX_MODE=client`):** `scripts/matrix-setup.sh deploy/compose.pilot.yml neops <server> client` prints the operator steps: create the ordinary account `@ledger:<server>`, issue its access token once into `deploy/secrets/matrix_ledger_token`, start with `MATRIX_MODE=client` (accounts in `MATRIX_CLIENT_ACCOUNTS`, one per company-app install). The platform runs a `/sync` loop per account (cursor in `neos.chat_accounts`), joins invites only from allowlisted senders and only 1:1 rooms, and answers each plain message with exactly one `m.notice` when its task settles (the fixed failure sentence after 50 s). An admin sets who may DM the account: `PUT /api/chat/allowlist {app, matrix_id, kind: "person"|"bridge", acts_for?}` (a person must be linked first; a bridge such as `@reasoning_agent` relays for `acts_for` and **never approves** — only a person's reply to the card in their own DM, or the desk). `GET /api/chat/allowlist`, `DELETE /api/chat/allowlist/<app>/<matrix_id>`, `GET /api/chat/client` (running / stopped reason).
   - **Client stopped** (`GET /api/chat/client` shows `token_rejected` or `account_mismatch`): the token was revoked or belongs to another account. The client does not retry, log in or log out. Issue a new token into the secret file and restart the platform; the cursor resumes, nothing is answered twice.
9. **On today's NEOS platform** (`docs/pilot-ledger-integration.md`): set `NEOS_V1_PUBLIC_KEY_FILE` (the platform binding's Ed25519 public key, SPKI PEM) and `NEOS_V1_CUSTOMERS` (`{"<platform customer id>": "<company_id>"}`) on the backend, add the platform binding (`contractVersion: neop.v1`, loopback origin forwarded to L3), and register `apps/ledger/neos-v1/descriptor.json` + `contract.json` with `pnpm neop:register`. Regenerate them with `tsx scripts/neos-v1-descriptor.ts ledger` after any manifest change (CI fails on drift).
10. **Acceptance:** `NEOS_TOKEN_FILE=<an admin's token file> pnpm exec tsx scripts/pilot-acceptance.ts` sends 20 real requests and checks the plan's five acceptance criteria from the platform's records.
11. **Verify the install (read-only):** after the migrator ran and the company was installed, run where the platform's and the LLM proxy's environment is (the platform container, with the proxy's key file mounted):
    `tsx scripts/verify-install.ts ledger <company id|slug>` with `NEOS_PLATFORM_URL`, `NEOS_DB_URL[_FILE]`, `NEOP_RUNNER_DB_URL[_FILE]` (defaults to `NEOS_DB_URL`), `NEOP_LLM_UPSTREAM_KEY_FILE`, and for the client road `MATRIX_MODE=client` + `MATRIX_HOMESERVER_URL` + `MATRIX_CLIENT_ACCOUNTS[_FILE]`.
   - It prints one row per check — PASS / WARN / FAIL / SKIP — and exits 1 on any FAIL. Checks: the platform answers `/live`; the app is registered, active, attested (a WARN outside `NEOS_ENV=production`) and carries this build's manifest; the company has an active install; the `<app>_migrator/_app/_runner` roles exist, the app role is under RLS, neither app nor runner may CREATE; the schema is in step with the shipped migrations (the backend's own boot comparison: nothing pending, unknown or changed); every switchboard line is within its manifest floor; a vault door key exists for every declared door; the LLM proxy's provider key is present (never read or printed); the backend answers `/l3/ready` at the URL the platform routes to; each client-road account's token passes `whoami` and belongs to that account.
   - It writes nothing (read-only sessions), sends no chat message, never logs in or out, and prints no secret. A FAIL row says what to fix (run the migrator, register this build, set the door key, issue a new Matrix token).

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
- **Backups** run nightly by themselves (see *Backups and restore*). Check that last night's run logged `backup complete`.
- **Metrics, alerts, traces:** the `observability` profile (see *Observability*).
- **Migrations:** see *Writing a migration* before adding one.

## Backups and restore
Point-in-time recovery of the cluster (your Postgres host's job) rewinds every app at once. The `backup` service adds per-schema logical exports so one app, or one company in one app, can come back alone.
- **What runs:** `tsx scripts/backup.ts schedule`, every day at `NEOS_BACKUP_AT` (default `02:00`, `TZ` default UTC).
  - It writes `/backups/<UTC stamp>/` in the `backups` volume: `<schema>.dump` per migrated schema (`pg_dump -Fc`: `neos`, `ledger`, …), `companies/<schema>/<company_id>.json` per company with rows, and `manifest.json` (sizes, sha256).
  - It keeps `NEOS_BACKUP_KEEP` runs (default 14), pruning only after a complete run.
  - A failed night logs `backup failed` and does not stop the service.
- **Run one now:** `docker compose -f deploy/compose.pilot.yml exec backup tsx scripts/backup.ts nightly --dir /backups --keep 14 --companies`.
- **Copy off the VM:** the volume lives on the same disk as the database. Ship it every day:
  ```
  docker run --rm -v neops_backups:/b -v "$PWD":/out alpine tar czf /out/neops-backups.tgz -C /b .
  ```
  Or mount a remote path in its place.
- **Restore one company in one app** (nothing else is touched; the dump must belong to that company):
  ```
  docker compose -f deploy/compose.pilot.yml exec backup ls /backups                        # pick a run
  docker compose -f deploy/compose.pilot.yml exec backup tsx scripts/backup.ts import /backups/<stamp>/companies/ledger/<company_id>.json
  ```
  That company's rows in that schema are replaced in one transaction, with deferred checks (e.g. balanced entries).
- **Restore one app's whole schema** (every company in that app goes back to the dump; the platform and other apps do not):
  ```
  docker compose -f deploy/compose.pilot.yml stop ledger-backend
  docker compose -f deploy/compose.pilot.yml exec backup tsx scripts/backup.ts restore-schema /backups/<stamp>/ledger.dump ledger
  docker compose -f deploy/compose.pilot.yml start ledger-backend
  ```
  It runs `pg_restore --clean --if-exists --single-transaction --schema=ledger`, so it fails as a whole or not at all. Jobs and proposals rewind with the books. Anything the platform recorded after the dump (tasks, approvals) still refers to them: read the audit trail for that window before telling people.

## Company data: uninstall, purge, subject access and erasure

Run these in the **`backup` service**: it holds the admin link, `pg_dump` and the `/backups` volume the
safety copy is written to (the platform container has none of them, and the commands refuse to delete
without a backup).

```
X="docker compose -f deploy/compose.pilot.yml exec -T backup sh -c"
$X 'NEOS_DB_URL_FILE=$NEOS_ADMIN_URL_FILE tsx scripts/ops.ts uninstall <company_id> ledger'                  # routing stops (dry run prints counts)
$X 'NEOS_DB_URL_FILE=$NEOS_ADMIN_URL_FILE tsx scripts/ops.ts uninstall <company_id> ledger --purge --yes'    # backup to /backups/uninstall/…, then delete that company's rows
$X 'NEOS_DB_URL_FILE=$NEOS_ADMIN_URL_FILE tsx scripts/erase.ts find   <company_id> ledger "<name or email>"'
$X 'NEOS_DB_URL_FILE=$NEOS_ADMIN_URL_FILE tsx scripts/erase.ts export <company_id> ledger <subject_id> --by user:<id>'
$X 'NEOS_DB_URL_FILE=$NEOS_ADMIN_URL_FILE tsx scripts/erase.ts erase  <company_id> ledger <subject_id> --by user:<id> [--yes]'
```

Only the columns the manifest tags as `personal_data` are touched; erasure pseudonymises, never deletes
rows, so books keep balancing. Every export, erase and purge is written to `neos.audit`. Verified live on
the pilot stack (27 Sep 2026): a 23,184-row purge of one company left the other company's books identical.

## Observability
`docker compose -f deploy/compose.pilot.yml --profile observability up -d` adds:
- **otel-collector**: services post spans to it; it forwards them to Jaeger. Config: `deploy/observability/otel-collector.yml`.
  - Without the profile, spans are dropped by the sender.
- **prometheus**: scrapes the platform's `/metrics` and the backend's metrics relay (`ledger-metrics:9464`, telemetry network only) with the `metrics_token`.
  - Alert rules are `deploy/observability/alerts.yml`, loaded as-is.
  - Point `alerting:` in `deploy/observability/prometheus.yml` at your Alertmanager to get paged.
  - For a new app, add a `<app>-metrics` target.
- **jaeger**: trace store and UI.
- **grafana**: on `127.0.0.1:3000` (user `admin`, password in `deploy/secrets/grafana_admin`). Prometheus and Jaeger are provisioned, and the *NEOP pilot* dashboard comes from `deploy/observability/neop-dashboard.json`.

`network.test` fails if a dashboard or alert uses a metric name that no code registers.

## Egress (the stack's only way out)
- The LLM proxy and app backends sit on internal networks only. Their HTTP(S) goes through `egress-proxy`, which allows exact host names only.
  - The allow-list is `api.anthropic.com`, `openrouter.ai` and `api.resend.com`, plus `NEOS_GSP_HOST` and `NEOS_EGRESS_EXTRA` (comma-separated). Tunnels go to port 443 only.
- **A refused host** shows in `docker compose logs egress-proxy` as `Proxying refused on filtered domain "<host>"`. Add a host only when a provider needs it.
- **Changing the model provider's URL** (e.g. OpenRouter) needs no change: both providers are listed.

## Dedicated database for one app (D2 dedicated tier)
Shared by default; one app gets its own Postgres cluster only when a contract requires it.
For Ledger this is packaged as `deploy/compose.dedicated-ledger.yml`. It adds a `pg-ledger` service on the `db` network, gives `migrate` the app's admin URL, and adds a `backup-ledger` service. Add `-f deploy/compose.dedicated-ledger.yml` to every compose command, then follow the steps below.
1. Run a second Postgres 17: the overlay's `pg-ledger`, or a managed instance reachable from the `db` network. Its superuser password goes in `deploy/secrets/pg_admin_ledger` (gen-secrets writes one).
2. Point the app's connection files at it. Delete that app's URL files first: gen-secrets never overwrites.
   ```
   rm deploy/secrets/{ledger_app_url,ledger_runner_url,ledger_direct_url,pgbouncer_ini}
   pnpm exec tsx scripts/gen-secrets.ts deploy/secrets ledger --dedicated ledger=pg-ledger:5432
   ```
   This writes:
   - `pg_admin_url_ledger`
   - direct URLs to `pg-ledger`
   - pooled URLs through PgBouncer's new `neos_ledger` entry (in `pgbouncer_ini`, pointing at `pg-ledger`)

   Role passwords are kept, so the app keeps its identity.
3. Run `migrate`. The overlay gives it `NEOS_ADMIN_URL_LEDGER_FILE`, so it logs `[ledger] dedicated cluster pg-ledger:5432`, creates Ledger's roles and schema there, and creates the platform's on the shared cluster.
   - Check: `\dn` on `pg-ledger` shows `ledger`, the shared cluster has no `ledger` schema, and `/l3/ready` is healthy.
4. Moving an existing app's data:
   - Stop its backend.
   - Take a `backup.ts nightly --schemas ledger` run.
   - `pg_restore` the dump into the new cluster after step 3.
   - Restart PgBouncer and the backend.
5. Backups: the overlay's `backup-ledger` dumps the dedicated cluster into its own volume. The shared `backup` still covers `neos`.
   - Per-company JSON exports need `neos.companies`, which lives on the shared cluster, so `backup-ledger` writes schema dumps only.
   - Restore one company from the schema dump into a scratch database, then use `backup.ts export`/`import` against the dedicated admin URL.

## Writing a migration
- **Name it `NNN_<what>.sql` and list it in that directory's `migrate.json`** with `"baseline": false` and the tables it touches.
  - Only the first release's files are `"baseline": true`. Those were applied to empty schemas and carry no proof.
- **Before production, prove it on a populated copy.** Restore last night's dump into a scratch database, run `migrate` against it, then record where and when in `"proven_on_populated_data"`. Production refuses a non-baseline file without it.
- **Expand, then contract.** Add the new column or table, ship code that uses it, and backfill. Only in a later file drop, rename, retype or `SET NOT NULL` the old one. That file must say so:
  ```
  -- contract: nothing reads parties.region since 1.4; expanded by 005_party_region.sql
  ```
  The runner refuses destructive DDL without such a marker naming an earlier migration.
- **Every new business table** needs `company_id uuid not null`, `enable` + `force row level security`, and a policy `using (company_id = nullif(current_setting('neos.company_id', true), '')::uuid)` (same for `with check`). A policy keyed on anything else, or `using (true)`, fails the tenant lint.

## Chaos, live (Phase 6 bar)
Against a throwaway project, never a customer's:
```
docker compose -p neops-chaos -f deploy/compose.pilot.yml -f deploy/compose.chaos.yml run --rm migrate
docker compose -p neops-chaos -f deploy/compose.pilot.yml -f deploy/compose.chaos.yml up -d
scripts/chaos-live.sh neops-chaos deploy/compose.pilot.yml,deploy/compose.chaos.yml   # CHAOS_JOBS=100 CHAOS_RESTARTS=50
docker compose -p neops-chaos -f deploy/compose.pilot.yml -f deploy/compose.chaos.yml down -v
```
- The overlay replaces the model provider and Resend with a fake behind the egress proxy.
- The script bootstraps a company and sends asks in waves. It `docker kill -s KILL`s the backend again and again (the agent and the platform once each) and answers every card.
- It then checks from the platform API that every task COMPLETED with exactly one result, and that every gated task has one approval, EXECUTED once. It also checks the provider's own count: one email per execution.
- It prints a JSON report and exits 1 on any miss.

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
