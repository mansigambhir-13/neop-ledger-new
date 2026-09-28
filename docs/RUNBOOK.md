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
   - It runs platform, template (`t###`) and Ledger (`###`) migrations — Ledger's set carries the migrations of the packages installed into its build (v3 S7, see *Installing a package*) — and gives each installed package its role.
   - It is safe to re-run.
   - `NEOS_APPS` picks the apps (default `ledger`).
   - At the end it hands over what the retired approvals worker had in hand (v3 S2, see *Approvals*): every
     `neos.approvals` row still `RECORDED`/`RESOLVED` is answered once more through the app's `answer_proposal()`.
     It prints `[approvals] N in hand, M handed over, K already held` and exits 1 if one could not be handed over.
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
   - **Client road instead (`MATRIX_MODE=client`):** `scripts/matrix-setup.sh deploy/compose.pilot.yml neops <server> client` prints the operator steps: create the ordinary account `@ledger:<server>`, issue its access token once into `deploy/secrets/matrix_ledger_token`, start with `MATRIX_MODE=client` (accounts in `MATRIX_CLIENT_ACCOUNTS`, one per company-app install). The platform runs a `/sync` loop per account (cursor in `neos.chat_accounts`), joins invites only from allowlisted senders and only 1:1 rooms, and answers each plain message with exactly one `m.notice` when its task settles (the fixed failure sentence after `MATRIX_REPLY_DEADLINE_MS`, default 55 s — under NeuralChat's 60 s wait). An admin sets who may DM the account: `PUT /api/chat/allowlist {app, matrix_id, kind: "person"|"bridge", acts_for?}` (a person must be linked first; a bridge such as `@reasoning_agent` relays for `acts_for` and approves nothing — only a person's reply to the card in their own DM, or the desk). `GET /api/chat/allowlist`, `DELETE /api/chat/allowlist/<app>/<matrix_id>`, `GET /api/chat/client` (running / stopped reason).
   - **NeuralChat never approves (v3 §5/§8/§16).** A bridge's go-ahead is refused with one reply — "I can't take a yes through NeuralChat. Please approve #<card> on your desk." — re-showing the card, audited `chat.bridge_consent` (`not_a_yes`); nothing executes. A person approves on the desk (`POST /api/desk/<id>/answer`) or with their own reply in their own DM. Migration 017 revoked every 016 `may_approve` grant (audited `chat.bridge_approve_revoked`) and forbids new ones; `PUT /api/chat/allowlist … may_approve:true` is `400 bridge_cannot_approve`. Declines from any allowlisted bridge are still taken.
   - **Typed events (v3 §8, both roads, alongside the plain text):** senders may also post `neos.neop.task|answer|approve` (people), `task|answer` (the reasoning agent), `task|ask|answer|propose|done|note` (another NEOP, allowlisted as a `bridge` with an `@neop_…` id). Ledger answers a typed task in its thread with `neos.neop.note` / `ask` / `propose` / `done` (each also carrying the plain text as `body`). Only a person sending as themselves can `approve`; in a room they need the approve level. Anything refused or malformed is dropped and audited: `GET /api/audit?action=chat.typed_in` (outcome `refused:<type>`, `invalid` with the error, `unknown_sender`, `stale`, …).
   - **Rooms must be invite-only, unencrypted, and give only people the approve level.** Create one with `MATRIX_ADMIN_TOKEN=… scripts/matrix-setup.sh deploy/compose.pilot.yml neops <server> room ledger <company slug> @person:<server>…`, then bind it. A bind of a room that is end-to-end encrypted, public, or where the app/a bridge could post `neos.neop.approve` answers **409 `room_unfit`** naming each problem; fix the room (or make a new one) and bind again. The appservice registration reserves `@neop_.*` and `@neuralchat_.*` (re-run `scripts/matrix-setup.sh` to regenerate it on an older install).
   - **Client stopped** (`GET /api/chat/client` shows `token_rejected` or `account_mismatch`): the token was revoked or belongs to another account. The client does not retry, log in or log out. Issue a new token into the secret file and restart the platform; the cursor resumes, nothing is answered twice.
9. **On today's NEOS platform** (`docs/pilot-ledger-integration.md`): set `NEOS_V1_PUBLIC_KEY_FILE` (the platform binding's Ed25519 public key, SPKI PEM) and `NEOS_V1_CUSTOMERS` (`{"<platform customer id>": "<company_id>"}`) on the backend, add the platform binding (`contractVersion: neop.v1`, loopback origin forwarded to L3), and register `apps/ledger/neos-v1/descriptor.json` + `contract.json` with `pnpm neop:register`. Regenerate them with `tsx scripts/neos-v1-descriptor.ts ledger` after any manifest change (CI fails on drift).
10. **Acceptance:** `NEOS_TOKEN_FILE=<an admin's token file> pnpm exec tsx scripts/pilot-acceptance.ts` sends 20 real requests and checks the plan's five acceptance criteria from the platform's records.
11. **Verify the install (read-only):** after the migrator ran and the company was installed, run where the platform's and the LLM proxy's environment is (the platform container, with the proxy's key file mounted):
    `tsx scripts/verify-install.ts ledger <company id|slug>` with `NEOS_PLATFORM_URL`, `NEOS_DB_URL[_FILE]`, `NEOP_RUNNER_DB_URL[_FILE]` (defaults to `NEOS_DB_URL`), `NEOP_LLM_UPSTREAM_KEY_FILE`, and for the client road `MATRIX_MODE=client` + `MATRIX_HOMESERVER_URL` + `MATRIX_CLIENT_ACCOUNTS[_FILE]`.
   - It prints one row per check — PASS / WARN / FAIL / SKIP — and exits 1 on any FAIL. Checks: the platform answers `/live`; the app is registered, active, attested (a WARN outside `NEOS_ENV=production`) and carries this build's manifest; the company has an active install; the `<app>_migrator/_app/_runner` roles exist, the app role is under RLS, neither app nor runner may CREATE; the schema is in step with the shipped migrations (the backend's own boot comparison: nothing pending, unknown or changed); every switchboard line is within its manifest floor; a door secret file exists for every connected door (checked by name and mode, never opened) and only the backend mounts the store (from the rendered compose config); the LLM proxy's provider key is present (never read or printed); the backend answers `/l3/ready` at the URL the platform routes to; each client-road account's token passes `whoami` and belongs to that account.
   - It writes nothing (read-only sessions), sends no chat message, never logs in or out, and prints no secret. A FAIL row says what to fix (run the migrator, register this build, set the door key, issue a new Matrix token).
12. **Acceptance — live validation of every ability:**
    ```
    NEOS_PLATFORM_URL=http://127.0.0.1:4500 NEOS_TOKEN_FILE=<admin token file> NEOS_MEMBER_TOKEN_FILE=<member token file> \
      pnpm exec tsx scripts/live-validate.ts --app ledger --budget-usd 12 --email-to <a mailbox you own> [--only reads,blocks,...] [--out docs/LIVE-VALIDATION.md]
    ```
    Uses only the person-facing API (never the DB) and the stack's **real model**. Sections: `reads` (every read with args built from today in the company's time zone; result checked against its output schema with ajv, `generatedAt`, `sources`, and `empty` agreeing with the sources cited; a read without args coverage is a FAIL "not exercised"), `writes` (every write run as one precise ask, in an order that builds on itself: party → account → coding rule → journal entry (a wrong fingerprint is refused) → its reversal → invoice → payment → bank import → match / categorise / set aside / expense → bill → settings (put back) → opening balances (reversed; SKIPPED if already set) → close a past month and reopen it → invoice email, reminder, close pack; each card checked (fields, `sha256:` fingerprint, args), approved, EXECUTED with proof DONE, exactly one `app.operation` in the audit, and the effect read back), `governance` (a read switched off and back; loosening refused 422; a standing yes within/beyond its cap; an `amount_cap` rule refusing with its id; member vs admin), `questions` (job_ask answered on the desk and by a follow-up in the conversation), `documents` (a CSV bill attached → a matching bill card, declined; the file kept and downloaded byte-identical; unauthenticated download 401), `schedules` (a daily schedule 2 minutes ahead → a timer job runs; then disabled — there is no delete), `blocks` (every read every block references, placeholders resolved). External-effect writes run only with `--email-to` and a connected door (otherwise SKIPPED with the reason); nep-gst portal writes are SKIPPED unless `--gst` (sandbox portal only). Spend is capped by `--budget-usd` (task cost from `/api/tasks/:id`, cross-checked with `/api/usage/<app>`); every job is cancelled after `--job-timeout-s` (360). Writes a markdown report plus a `.json` copy and exits 1 on any FAIL. Changes it makes are ₹1-scale and tagged `LV…` (the run tag); accounts, parties and coding rules it adds remain. Output schemas come from this checkout (the API does not serve them), so run it from the commit that is deployed — the report fails `manifest version` otherwise. Its logic is self-tested against the in-process pilot in `apps/ledger/tests/live-validate.test.ts`.

## Door secrets (v3 §12: the secret store, per (app, company))
Door credentials are files, one JSON object each, read by the app backend **at the moment of a call** (no cache;
a changed file is used on the next call, no restart). Ops provisions them; the assistant never sees them.

- **Layout:** `$NEOS_SECRETS_DIR/doors/<company_id>/<app>/<door>.json` (that app's own credential) and
  `$NEOS_SECRETS_DIR/doors/<company_id>/<door>.json` (company-wide: any app that declares the door). The app's own
  file wins. A backend only ever builds paths from its own app key and the job's company; names are checked, so
  another company's directory (or another app's file) is never read. Same binding as the old vault (migration 015).
- **Where it is mounted:** read-only at `/run/secrets/doors` into `ledger-backend` (`NEOP_DOOR_SECRETS_DIR`), and
  into `backup`, which seals it (below). Never into an agent, never into `web` or the platform. `verify-install`
  checks both: a file for every connected door (by name and mode — never opened), and no agent/web mount.
  With several NEOPs on one host, each backend still mounts the whole `doors/` tree read-only; isolation between
  apps is the backend's path rule. For hard isolation, mount `doors/<company>/<app>` per app instead (company-wide
  files then have to be copied into each app's directory).
- **Set / rotate / remove** (the credential on stdin — never on the command line; files 0600, directories 0700, owned
  by the backend's uid `NEOS_DOORS_UID`, default 1000):
  ```
  scripts/deploy.sh door set <company_id> email ledger < resend.json
     {"provider":"resend","api_key":"re_…","from":"Acme Books <books@acme.in>"}
  scripts/deploy.sh door set <company_id> gst_portal ledger < gsp.json
     {"provider":"gsp","base_url":"https://<gsp>","client_id":"…","client_secret":"…","username":"<GST portal username>",
      "gstin":"27AAPFU0939F1ZV","signatory_pan":"AAPFU0939F","assume_supply":"intra_state",
      "paths":{"authenticate":"/taxpayerapi/v1.0/authenticate","gstr3b":"/taxpayerapi/v1.1/returns/gstr3b","returns":"/taxpayerapi/v0.3/returns"},
      "headers":{}, "timeout_ms":5000}
  scripts/deploy.sh door rm <company_id> <door> [app]        # the door then fails definitely: "not connected", nothing sent
  scripts/deploy.sh door ls                                   # names only
  ```
  (`NEOS_SECRETS_DIR` from the environment, or `NEOS_ENV_FILE=<deploy env file>`.) Rotation is write-then-rename,
  so a call in flight sees the old credential or the new one, never half of one.
- **GST (nep-gst 2.x):** nep-gst is built into Ledger (see *Installing a package*); enable API access for the taxpayer's username on the GST portal, then
  set `gst_portal` as above. Paths default to the GSTN taxpayer API layout; override them (and add GSP-specific
  headers) to match your GSP. `assume_supply` is used only when the chart keeps a single output and a single input
  GST account; name the tax accounts per head (IGST / CGST / SGST / cess) and the split is read from the books.
  OTPs are entered by a person, never by the assistant: when the portal sends one (login, or the signatory's EVC OTP
  before a filing), ops writes it on the OTP slot — `scripts/deploy.sh door set <company_id> gst_portal_otp ledger`
  with `{"provider":"person","auth_otp":"123456"}` or `{"provider":"person","evc_otp":"654321"}` on stdin. (A desk
  path for the person to enter it themselves is a later stage.) The GSP session token lives only in the backend's
  memory (a restart means a new login OTP).
- **A door switched off** (`door:<key>` off on the switchboard) is refused by the gate before anything, and the
  backend reads no key for it even if a file exists.
- **Upgrading from the platform vault (before v3 S8):** move every stored credential once, then mount the result:
  ```
  docker compose -f deploy/compose.pilot.yml run --rm --no-deps -T \
    -e NEOS_DB_URL_FILE=/run/secrets/neos_app_url -e NEOS_VAULT_KEYS_FILE=/run/secrets/vault_keys \
    -v "$NEOS_SECRETS_DIR/doors:/out" platform tsx scripts/v3/export-door-secrets.ts /out [--company <id>] [--dry-run]
  ```
  It opens each row exactly as the platform did (keyring + the (company, app, door) binding), writes 0600 files,
  keeps files already there unless `--overwrite`, prints names and paths only, and exits 1 if any row could not be
  opened. Then `sudo chown -R 1000:1000 "$NEOS_SECRETS_DIR/doors"` (or re-run `scripts/deploy.sh`). `PUT /api/vault`
  still answers but is **deprecated** — no backend reads the vault any more (S9 deletes it).
- **Backups:** each nightly run holds `doors.enc`, the whole store sealed (AES-256-GCM) with `backup_doors_key`
  (generated by `gen-secrets`). Without that key the store is skipped, never copied in clear. Keep the key with the
  rest of `$NEOS_SECRETS_DIR`, **not** beside the backups. Restore:
  `docker compose … exec backup tsx scripts/backup.ts restore-doors /backups/<stamp>/doors.enc /tmp/doors` (then
  copy into `$NEOS_SECRETS_DIR/doors` on the host, 0600, owned by the backend's uid).

Every provider must either accept an `Idempotency-Key` and let us look the effect up afterwards, or (the GST portal) let us ask the system of record directly (RETSUM for a save, RETTRACK for a filing). Ledger journals each call before sending, so "did it happen?" always has an answer.

## Chat: NEOP presence (v3 S4 — the NEOP on Matrix itself)
`NEOP_PRESENCE` on the **ledger backend** says who speaks for Ledger in Matrix. Default `off`: the platform's bridge
(everything in *Deploy* step 8 above), as rehearsed. `client` or `appservice`: the ledger backend itself — its jobs,
answers and a person's yes go straight into Ledger's own schema; the platform keeps no Matrix token for Ledger.
NeuralChat (#143) sees no difference: plain `m.text` to `@ledger`, exactly one threaded `m.notice` back within
`MATRIX_REPLY_DEADLINE_MS`, a relayed go-ahead is never a yes ("Please approve #<id> on your desk").

- **What the backend reads** — only Ledger's own schema: `ledger.installs.matrix_user` (its name at the company),
  `room_ids`, `agent_senders` + `agent_acts_for` (the allowlisted bridges/NEOPs and whom each relays for), and
  `ledger.people` (who a Matrix id is: user id, name, role, `chat_person` = may DM Ledger). The platform writes these
  through as `neos_desk` whenever a person is linked, the allowlist changes or Ledger is installed (`Platform.syncChat`),
  so the admin API is the same as before (`PUT /api/users/<id>/chat`, `PUT|DELETE /api/chat/allowlist`), plus
  `GET|PUT /api/chat/presence {app, matrix_user?, room_ids?}` for Ledger's own name and rooms (admin, audited
  `chat.presence_set`).
- **Switch an install to the client road (production, external homeserver):**
  1. `NEOP_PRESENCE=client` in the deploy env file, then `scripts/deploy.sh <env>`. It uses
     `deploy/compose.presence-client.yml` instead of `compose.matrix-external.yml`: the platform starts **without** a
     Matrix account for Ledger (its `MATRIX_CLIENT_ACCOUNTS` entry is gone — two processes must never /sync one
     account), the ledger backend gets `matrix_ledger_token` and `NEOP_MATRIX_CLIENT_ACCOUNTS=[{account, token_file}]`,
     the homeserver's host is added to the egress allow-list, and step 8 writes `PUT /api/chat/presence
     {"app":"ledger","matrix_user":"$LEDGER_MXID"}`.
  2. Check: `GET /api/chat/presence?app=ledger` names the account; the backend logs `NEOP presence on`, then
     `presence: client: listening from now`. A stopped client logs `STOPPED — …` with the reason
     (`token_rejected`, `account_mismatch`, `no_install`) and records it in `ledger.presence_accounts.stopped_reason`;
     fix it and restart the **backend** (no retries, no login, never `/logout`).
  3. The first start reads no history (the /sync cursor starts now, kept in `ledger.presence_accounts`); messages
     sent during the switch-over are not answered twice — the old cursor lives in `neos.chat_accounts`, the new one
     in Ledger's schema. Tell NeuralChat's operators nothing: its road is unchanged.
- **Switch back** (`NEOP_PRESENCE=off`): set it in the env file and re-run `scripts/deploy.sh <env>` — the platform
  gets its `MATRIX_CLIENT_ACCOUNTS` entry and the token back, the backend stops /syncing. Replies already owed by the
  backend are dropped with it (each person gets at most one reply per message); cards and questions stay in the
  books and on the desk.
- **The appservice road (local Synapse, `deploy/compose.chat.yml`):** `NEOP_PRESENCE=appservice
  scripts/matrix-setup.sh deploy/compose.pilot.yml` writes `secrets/appservice.ledger.yaml` (id `neop-ledger`, url
  `http://ledger-backend:4104`, exclusive `@neop_ledger_.*`, Ledger's own `matrix_ledger_hs_token` /
  `matrix_ledger_as_token`), registers it, and narrows the platform's registration to `@neop_(?!ledger_).*`. Start
  with `NEOP_PRESENCE=appservice docker compose … -f deploy/compose.chat.yml up -d`; name the company's bot and bind its
  rooms with `PUT /api/chat/presence {"app":"ledger","matrix_user":"@neop_ledger_<slug>:<server>","room_ids":["!…"]}`.
  The backend joins each room once and checks it (invite-only, unencrypted, only people at the approve level); an
  unfit room is logged `room not fit for this app` and nothing said there is acted on. A wrong `hs_token` is 403.
- **What to look at:** `ledger.inbound_events` (each Matrix event once: outcome, job, proposal/wait, the reply's
  state), `ledger.outbound_events` (what Ledger said where, by key = txn id — never twice), `ledger.presence_mirror`
  (how far the room mirror read Ledger's outbox). The platform's desk keeps showing Ledger's cards (from its outbox).
- **A person's yes in Matrix** goes into `ledger.answer_proposal()` with the person's role (the approver policy —
  roles, four-eyes — is the database's, as for the desk) and is carried out by the runner's approved path, like a desk
  yes; the desk shows the same card (`neos.v_desk_cards`).

## Bus room setup (v3 S6 — NEOP to NEOP in `#neop-bus-<co>`)
With `NEOP_PRESENCE=appservice` on every app of a company, NEOP-to-NEOP work (a task handed to another app, one
borrowed ability) goes over typed events in the company's **bus room**, between the apps' own Matrix names — the
platform's a2a routing (`/internal/a2a/open`, `/internal/borrow/describe`, `/internal/gateway/call`, `neos.acl`,
`a2aResultsTick`) is not used for those apps. With `NEOP_PRESENCE=off` the old platform road still works unchanged
(S9 deletes it).

1. Each app's name is set first (`PUT /api/chat/presence {"app":"<app>","matrix_user":"@neop_<app>_<slug>:<server>"}`;
   `scripts/deploy.sh` does it) and each app's appservice registration is live.
2. Run, once per company (idempotent — it finds rooms by alias and fills only what is missing):
   ```sh
   NEOS_URL=https://neos.example NEOS_ADMIN_TOKEN_FILE=/run/secrets/neos_admin \
   NEOP_MATRIX_HOMESERVER_URL=https://matrix.example \
   tsx scripts/rooms-setup.ts --company <slug> \
     --app ledger=/run/secrets/matrix_ledger_as_token --app marketing=/run/secrets/matrix_marketing_as_token \
     --person @priya:<server> [--admin @ops:<server>] [--agent @neuralchat_<slug>:<server>]
   ```
   It creates `#<app>-<slug>` (people + the app) and `#neop-bus-<slug>` (apps only; made by the first app's name, the
   others invited): invite-only, **no** end-to-end encryption, power levels people 50 · NEOPs 20 · reasoning agent 10;
   `neos.neop.approve` needs 50 (only people), task/answer 10, ask/propose/done/note 20. Then, through the platform's
   `neos_desk` write-through, it writes into each `<app>.installs`: `room_ids`, `bus_room_id`, and `bus_peers` (the other
   apps on the bus, Matrix id → app key — the only senders an app acts on in the bus room).
3. Check: `GET /api/chat/presence?app=<app>` shows `bus_room_id` and `bus_peers`; each backend joins the bus room on
   its next room refresh (≈ 2 s) and checks it like any room (`room not fit for this app` otherwise).
4. **Borrowing** needs the borrower's own line switched on — a `uses` line on its switchboard, off until the company
   sets it: `PUT /api/switchboards/<borrower> {"settings":{"<owner ability>":"on"}}` (on/off only; no ACL row). The
   owner still checks its own line and that the borrower's manifest declares it (`neos_registry.uses`) when the ask
   arrives. A borrowed write becomes the owner's proposal (written by the owner's runner, no model) and waits for a
   person on the desk or in the owner's room; the borrower is answered after it is carried out, with the proof.
- **What to look at:** `<app>.bus_threads` (one row per thread: out = what this app asked, in = what it took; the
  root event, the peer, the chain `lineage`/`depth`, status and result), `<app>.inbound_events` outcomes
  `typed:task_opened`, `typed:refused:a2a_depth|a2a_loop|bad_lineage|not_declared|…`, `typed:call_served`,
  `typed:call_opened`, `typed:call_refused:<code>`, `typed:bus:done|question|answered|not_ours|stale`, and both apps'
  `operations` (`task:<peer>`, `borrow:<owner>:<ability>`, and the owner's `served` row for a read).
- **Limits:** the bus is the appservice road only (a client-road app has no voice there: its hand-offs are refused
  `no_bus`); a chain stops at depth 3 and never loops (refused by the callee, and early by the asker's gate).

## Chat: NeuralChat speaks Matrix (v3 S5)
`NEOS_NEURALCHAT_MATRIX` on the **platform** (default `off`). On, the platform's NeuralChat has its own Matrix name per
company and a person's ask in Conversations reaches an app that runs with NEOP presence **only** as a typed
`neos.neop.task` posted by that name in the app's room (appservice) or its 1:1 room with the app's account (client),
the thread rooted there. It reads the app's `note` / `ask` / `propose` / `done` from that thread into the
conversation and `neos.tasks`, answers the app's questions with a typed `answer` when the person replies in
Conversations, and never sends `approve` (a person approves on the desk). An app with presence off (no Matrix name in
its install row), or a company NeuralChat has no name at, keeps the gateway road (`tasks.open`) — S9 removes it.
- **appservice** (`NEOS_NEURALCHAT_MATRIX=appservice`): reuses the platform's registration (`MATRIX_HOMESERVER_URL`,
  `MATRIX_SERVER_NAME`, `MATRIX_HS_TOKEN`, `MATRIX_AS_TOKEN`; `deploy/appservice.yaml` already reserves
  `@neuralchat_.*`). The name is `@neuralchat_<company slug>:<server>`; it registers and joins the app's first bound
  room (`PUT /api/chat/presence {"app":"ledger","room_ids":[…]}`) on first use. Give it a level **below** approve in the
  room (rooms-setup: reasoning agent 10, approve 50). The homeserver pushes to the platform's
  `/_matrix/app/v1/transactions` (served by the bridge when it runs, by NeuralChat's own routes otherwise).
- **client** (`NEOS_NEURALCHAT_MATRIX=client`): `MATRIX_HOMESERVER_URL` and `MATRIX_NEURALCHAT_ACCOUNTS[_FILE]` =
  `[{"company":"<id or slug>","account":"@neuralchat_acme:hs","token_file":"/run/secrets/…"}]` — one ordinary account
  per company, /sync in the platform process (cursor in `neos.neuralchat_accounts`; a rejected token stops that account,
  `stopped_reason = token_rejected`). It opens a 1:1 room with the app's account on first use (`neos.neuralchat_rooms`);
  the app's presence joins it because NeuralChat's name is on its allowlist.
- **What the app is told.** `Platform.syncChat` writes NeuralChat's name into every app's `installs.agent_senders`, and a
  `people` row (not a sender: NeuralChat's own namespace) `@neuralchat_<slug>_person_<user id>` for every person with no
  Matrix id of their own — that is how a task names the person it is for (`on_behalf_of`).
- **Files** travel by reference: `fields.neos_file_<n>` = `{id, filename, sha256, bytes, link}`; `link` is a path on the
  platform (`/neuralchat/files/<task>/<n>?exp&sig`, HMAC from the vault keys, 1 h), which the app resolves against its
  own `platformUrl`, fetches and checks (size, sha256). The platform drops the bytes when the app says "on it" (then the
  link is 410). The backend must reach the platform over HTTP (it already does).
- **Retries.** A send the homeserver did not take is resent with the same txnId `nc-task-<task>` (never a second
  event); an app that is down gets the event when Matrix redelivers it; the app opens the job once (event id and task
  id). A task nobody acknowledged within the delivery window (`taskDeliveryWindowMs`, 10 min) is FAILED with
  `the app never acknowledged the task in Matrix`.
- **What to look at:** `neos.tasks` (`road = 'matrix'`, `matrix_room`, `matrix_account`, `matrix_event_id`,
  `delivered_at`, `last_error`), `neos.neuralchat_events` (each thread event once, with what it became), the audit
  (`neuralchat.task_posted`, `neuralchat.answer_posted`). `scripts/live-validate.ts --expect-road matrix` checks that
  every task it opens took the Matrix road.
- `scripts/neuralchat-sim.ts` is unchanged: it still simulates the **external** NeuralChat (#143, plain `m.text` as
  `@reasoning_agent`), which keeps working against the app's presence.

## Everyday operations
- **Backups** run nightly by themselves (see *Backups and restore*). Check that last night's run logged `backup complete`.
- **Metrics, alerts, traces:** the `observability` profile (see *Observability*).
- **Migrations:** see *Writing a migration* before adding one.

## Approvals (v3 S2: a yes lands on one row; the app's runner carries it out)
- **Where a yes goes.** A person's answer on the desk (`POST /api/desk/<card>/answer`, unchanged) or their own reply /
  typed approve in their DM or room goes to **one** place: `<app>.answer_proposal()` on the app's own proposal row,
  called by the platform as `neos_desk` (`SET LOCAL ROLE`, transaction-scoped). The function checks the fingerprint
  the person saw, the expiry, that the card is still open, and the company's **approver policy** (the write's own
  `approvers`, else the company row `*`: `roles` — only a person holding one may say yes or "change this first";
  `four_eyes` — the person the job serves may not approve it). The platform passes the person's role; four-eyes is
  decided in the database from the job's own requester. Refusals: `409 stale_fingerprint` (kept in the proposal's
  history), `409 not_open` (answered, closed or expired), `403 not_an_approver`, `403 four_eyes`, `409 too_late`
  (a withdrawal after the runner started). Nothing else in the app's schema is open to the desk.
- **Who carries it out.** The app's **runner**, not the platform and not a model: it hears `approved:<proposal>` on
  its channel (the hint) and polls `APPROVED` rows every `pollMs` (the truth), claims one with `FOR UPDATE SKIP
  LOCKED` plus the execution advisory lock, re-checks at effect time (the fingerprint on the `answered:yes` event,
  not expired, the ability version, the switch, the company rules), calls the door once (idempotency key, read-back),
  writes DONE / FAILED / UNKNOWN, and only then makes the job's wait ready and wakes a fresh assistant with the proof.
  Several runners carry a yes out once. A runner that dies mid-effect leaves the proposal `EXECUTING` with no lock
  holder; the next poll (any runner) resumes it read-back first, with the same idempotency key. A standing yes
  (grant) is carried out inline by the gate through the same code; the runner adopts one left `APPROVED` > 30 s.
- **The desk list** is the apps' own rows: `neos.v_desk_cards` (every person-facing proposal, in the desk's statuses
  PENDING / RESOLVED = a yes being carried out / EXECUTED / FAILED / UNKNOWN / CLOSED / EXPIRED; a card's id is its
  proposal id) and `neos.v_pending_approvals` (the waiting ones). `neos.approvals` is a **frozen** legacy copy
  (platform migration 020): read only to map a card id from before the move, never written.
- **The drain.** `scripts/v3/drain-approvals.ts [--app ledger] [--json]` (also the end of `scripts/migrate.ts`)
  re-answers every `neos.approvals` row still `RECORDED`/`RESOLVED` through `answer_proposal()` — same person, same
  fingerprint, same decision — and the runner carries a yes out. Idempotent: a re-run reports `already`. `closed`
  (expired/withdrawn meanwhile), `refused` (policy/fingerprint) and `not_found` rows are reported and left alone;
  `error`/`no_schema` exit 1. Each hand-over is audited `approval.drained` (actor `migration:v3-s2`).
- **Holding execution** (an incident: a door misbehaving): the runner's approved path has an in-process pause
  (`runner.approved.pause()`, used by the tests; no ops command yet); a yes then stays `APPROVED` (RESOLVED on the desk) and is
  carried out when resumed or on the next backend start. Switching the ability **off** on the switchboard is the
  company-facing way: a yes on an off line ends FAILED `switched_off` and the job says so.

## Questions (v3 S3: an answer lands on the app's own wait through one function)
- **Where an answer goes.** A job's question is the app's own input wait. The desk lists them from
  `neos.v_open_questions` (`GET /api/questions`; `?status=ANSWERED|EXPIRED|STALE` reads `neos.v_questions`), and every
  answer — the desk (`POST /api/questions/<id>/answer`), a follow-up in the conversation, a reply in a DM, a typed
  `neos.neop.answer`, NeuralChat's v1 `answer`, the NEOP's own presence — goes to `<app>.answer_wait()`, called by the
  platform as `neos_desk` (`SET LOCAL ROLE`, transaction-scoped) or by the app itself. A question's id is its wait id.
- **What it refuses.** `400 bad_answer` (a required field missing, a wrong type, an unknown field), `409 stale` (already
  answered, past due, or the job ended), `404` (no such question for this company), `403 not_their_wait` (an app's key
  on a question that is not its own hand-off — a person's question is the person's). A person's answer reaches the
  assistant as their words; anything relayed (a bridge, the reasoning agent, another NEOP) as untrusted data.
- **Checking one by hand** (psql as a DBA): `set role neos_desk; select set_config('neos.company_id', '<co>', false);
  select * from neos.v_open_questions where company_id = '<co>';` — the desk reads nothing else. To answer for a person
  who cannot reach the desk: `select ledger.answer_wait('<wait>', '{"account_code":"1010"}', 'user:<their id>', 'desk');`
  (it is recorded as theirs — only with their say-so). An unanswered question expires by itself at its due time and
  wakes the job to say so.
- **The views after a restore / a new app.** `neos.v_questions` / `v_open_questions` are rebuilt at `registerApp` and by
  `scripts/migrate.ts`; `select neos.refresh_desk_questions()` (as the platform's role or the admin) rebuilds them by hand.
  A missing app schema contributes no rows (no error).
- **What the platform still copies** (`neos.questions`, `neos.activity` step rows) is for the Matrix bridge and the
  conversation only; the desk never reads them. A mismatch there is cosmetic until presence moves into the NEOP.

## Backups and restore
Point-in-time recovery of the cluster (your Postgres host's job) rewinds every app at once. The `backup` service adds per-schema logical exports so one app, or one company in one app, can come back alone.
- **What runs:** `tsx scripts/backup.ts schedule`, every day at `NEOS_BACKUP_AT` (default `02:00`, `TZ` default UTC).
  - It writes `/backups/<UTC stamp>/` in the `backups` volume: `<schema>.dump` per migrated schema (`pg_dump -Fc`: `neos`, `ledger`, …), `companies/<schema>/<company_id>.json` per company with rows, `manifest.json` (sizes, sha256), and `doors.enc` — the door secret store, sealed with `backup_doors_key` (see *Door secrets*).
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

## Installing a package (v3 S7: at build time)
A package (`nep-<name>`: know-how, handlers, migrations) or a skill-only entry goes into an app's **build**; a
company then switches the lines it adds on its switchboard. Nothing is installed, fetched or migrated at run time,
and `POST/DELETE /api/registry/installs` answers `410 install_at_build`.
1. **Publish** (once per version): `NEOS_OPERATOR_TOKEN=… pnpm neos-publish registry/nep-<name>` (a skill folder with
   `SKILL.md` is published by its owning app: `scripts/registry.ts publish`, `NEOP_APP_KEY`/`NEOP_SERVICE_SECRET`/
   `NEOP_AUTHOR_KEY_FILE`). A second operator reviews the diff on `/api/registry/reviews` and co-signs it. A package
   version that drops, recasts or major-bumps an ability some app's pinned skill or package still requires is
   refused (`409 breaks_pinned`) until the version that served it has been deprecated for 30 days.
2. **Install into the app** (a developer's machine or CI, with a Postgres for the scratch test database):
   ```
   NEOS_PLATFORM_URL=https://neos… NEOS_OPERATOR_TOKEN=… NEOS_ADMIN_URL=postgres://…/scratch-cluster \
     pnpm neos-install ledger nep-gst@2.0.0 --trust registry-jwks.json --proven "2026-09-28 · <where you proved it>"
   ```
   It fetches the entry and the artifact **by hash**, checks the hash and the registry's co-signature (with
   `--trust`, that the key is one of the registry's — save `/.well-known/registry-jwks.json` from the production
   platform), unpacks read-only into `apps/ledger/src/packages/nep-gst/`, pins it in `apps/ledger/packages.lock.json`
   (version, artifact hash, content hash, the registry's signature and public key, every file's sha256), appends its
   migrations to `apps/ledger/migrations/` as `NNN_nep_<name>__<file>.sql` (+ `migrate.json` rows; `--proven` fills
   `proven_on_populated_data`, which production requires), writes its lines into `manifest.json` `packages`, and runs
   its self-test **inside the host**: Ledger's whole migration set in a scratch database, then the package's
   `selftest` as its own role. Any refusal (`hash_mismatch`, `bad_signature`, `tests_failed`, `migration_changed`)
   leaves the app folder exactly as it was. A skill (`<owner>/<name>@x.y.z`) is only pinned (lock + manifest
   `registry_skills`); its text stays in `neos_registry.skills`.
3. **Commit, build, migrate, deploy.** `scripts/dba-bundle.ts ledger` now carries the package's migration files and
   a section creating its role (`ledger_nep_<name>`, `SELECT/INSERT/UPDATE` on its own tables only; Ledger's own role
   reads them). `pnpm migrate` does the same. Set `NEOP_REGISTRY_JWKS[_FILE]` on the backend to the same JWKS: a
   package or pinned skill signed under another key is not loaded. Deploy, then re-register the app (its manifest
   carries the new lines).
4. **Per company:** the package's abilities are lines on the switchboard at the package's floors, its doors are
   `door:` lines, a pinned skill is a `skill:` line and loads only when it and everything it requires are on
   (a borrowed requirement also needs the owner's grant: `/api/acl`).
- **Verified at spawn.** Before a package is offered — each job, and again before each call — every file is checked
  against the lock and the signature. A hand-edited file means the package is not offered and its calls are refused;
  the job's book says `Not loaded: nep-x@1.0.0 — …`. A pinned skill whose registry row no longer has the pinned
  content hash is not loaded either. Fix: re-run `neos install` (never edit `src/packages/`).
- **Upgrade:** `neos install ledger nep-gst@2.1.0`. Migrations that already shipped are kept (a version that changes
  one is refused: fix forward with a new file); new ones are appended.
- **Remove:** `pnpm neos-install ledger --remove nep-gst` takes out the files, the pin and the lines. Its migrations
  stay in the set (forward only) and its tables are kept; dropping them is a contract migration in the app's own
  set (`-- contract: …; expanded by 008_nep_gst__001_returns.sql`).
- **Books installed before v3** (the runtime installer, `schema_migrations` rows `nep-gst@<v>/<file>`): the new
  host files skip the package SQL there and only tighten the grants. Proof: `apps/ledger/tests/install.test.ts`.

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
- **Vault key** (deprecated with v3 S8; the vault is only the source for `export-door-secrets.ts`): add a new key id to `NEOS_VAULT_KEYS`, make it `active`, and restart. Boot re-encrypts every secret.
- **A door credential:** `scripts/deploy.sh door set …` with the new one (see *Door secrets*); the next call uses it.
- **LLM session-signing key** (v3 S8: each runner mints its assistants' proxy tokens): delete `<app>_llm_signing_key`, re-run `gen-secrets` (it rewrites `llm_runner_keys` to match), restart `llm-proxy` then `<app>-backend`. Sessions in flight end with their token (at most a session's length).

## When something goes wrong
| Signal | Meaning | Do |
| --- | --- | --- |
| `NeopExecutionUnknown` | An approved action may or may not have happened (provider outage, lost answer) | Nothing at first. Reconciliation reads back every 30 s. Within 10 min (`NEOP_DOOR_RECOVERY_MS`) it can complete the send exactly once; after that it closes it as not sent and the person is told. |
| `NeopDeadLetters` | The platform could not apply an app event | Fix the cause, then `POST /api/dead-letters/ledger/<id>/replay`. Nothing is lost while it is parked. |
| `NeopAckSlow` | New jobs are acknowledged slowly | Check PgBouncer (`SHOW POOLS`) and Postgres; check `neop_gateway_latency_seconds`. |
| `NeopApprovalsPiling` | People are not answering cards | Product issue, not an outage. |
| Card stuck in RESOLVED | The yes is on the row (APPROVED) but no runner has carried it out | Check the app backend is up (`/l3/ready`) and its runner log (`approved path …`). The runner's poll picks it up within `pollMs` of starting; an execution whose process died (EXECUTING, no lock holder) is resumed read-back first by the next poll. Nothing on the platform side drives it. |
| A job keeps failing | The assistant cannot finish | Read the job's steps (activity feed). After 5 interrupted sessions it fails honestly and asks a person to look. |

## Limits worth knowing
- **Model spend** is capped per job ($5) and per company-app per day ($50) by default; change them on the switchboard (`budget`). A job over its cap is refused before it calls the model.
- **Approval policy.** Companies can require roles or four-eyes per ability on the switchboard (`approvals`); it is enforced inside the app's `answer_proposal()` (v3 S2), so no caller can get past it.
- **Closed months** take no postings until someone reopens them with a reason.
