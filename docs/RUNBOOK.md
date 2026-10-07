# neop-ledger runbook

For whoever deploys and operates Ledger on a customer VM. The platform desk,
NeuralChat Matrix runtime, registry, and LLM proxy ship in the same repo.

## Deploy

Production is Matrix-only and fails closed. The supported automated production path uses an external homeserver with distinct ordinary accounts and tokens for Ledger and NeuralChat.

1. Copy `deploy/production.env.example` to a private 0600 file and fill every required value. Keep provider and Matrix tokens in the separate files named by that env file.
2. Generate a green conformance attestation for the exact checkout:
   ```sh
   pnpm exec tsx scripts/conformance.ts ledger --out deploy/attestations/ledger.json
   ```
   Generate this only after the release commit and manifest are frozen. Production registration rejects a missing, failing, or mismatched attestation.
3. Deploy or upgrade:
   ```sh
   scripts/deploy.sh /private/path/production.env
   ```
   The script validates distinct Matrix identities/token files, takes a pre-upgrade backup when applicable, generates non-overwriting secrets, builds, runs expand migrations, registers the attested app, bootstraps the company/admin/install, starts `compose.pilot.yml` with `compose.presence-client.yml`, verifies both Matrix accounts, optionally installs the email door credential, runs the read-only verifier, and performs a declared block-read smoke check.
   An upgrade refuses to continue if its backup service is stopped or its recovery backup fails. If the database container or its Compose volume exists but deployment state is missing, recover the original secrets and `deploy-state.json` before retrying. Never regenerate encryption/database credentials over existing volumes.
4. Run the live network policy check after the stack is up:
   ```sh
   scripts/netcheck.sh deploy/compose.pilot.yml,deploy/compose.presence-client.yml <project>
   ```
   It proves the agent cannot reach Postgres, the platform, or the internet; backend/provider traffic uses the allow-listing egress proxy.
5. Ask through the real NeuralChat Matrix account and confirm the typed task, note/proposal, and done events remain in one thread. Only a person may approve, from the desk or their own Matrix identity.

The local Synapse appservice topology is `compose.pilot.yml` + `compose.chat.yml`. Generate both exclusive registrations with `scripts/matrix-setup.sh`, confirm only Ledger owns `@neop_ledger_.*` and the platform owns `@neuralchat_.*`, then render and inspect the merged compose before starting it. The automated `deploy.sh` intentionally accepts only external client mode.

`scripts/migrate.ts` is expand-only through platform migration 024 plus all app/package migrations. Migration 024 makes the retired app L3 address optional so V3 registration works before contraction. Platform migration 025 is the destructive S9 contract migration and is never applied by normal deploy. Before invoking it: restore a production-shaped backup into an isolated database, prove its undrained-approval abort, drain/copy required legacy state, compare archive row counts/digests, prove recovery, and obtain explicit DBA/operator approval.

### Verification

- `docker compose ... run --rm verify` runs `scripts/verify-install.ts`: read-only role/schema/RLS, manifest/attestation, switchboard, door-file metadata, files endpoint, Matrix account identity, and production configuration checks. It reads no secret value and sends no Matrix event.
- `pnpm exec tsx scripts/live-validate.ts --app ledger --expect-road matrix ...` exercises reads, writes, governance, questions, documents, schedules, and blocks through the person-facing API and typed Matrix path. Use `--email-to` only with a mailbox you own; use `--gst` only against an approved GSP sandbox.
- The repository `web` service is a development/CI harness and refuses `NEOS_ENV=production`. Product acceptance must use the real NEOS UI.

### Runtime endpoints

- Platform health and desk API: `/live` on the loopback-published platform port.
- Ledger signed files and health: `/ready` on the loopback-published files listener.
- Ledger gate and agent RPC are private network listeners; they are not platform APIs.
- Metrics: platform `/metrics` plus the Ledger telemetry listener. See `deploy/observability/`.

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
- **One-time upgrade from the retired platform vault (only before applying contract migration 025):** move every
  stored credential once, then mount the result:
  ```
  docker compose -f deploy/compose.pilot.yml run --rm --no-deps -T \
    -e NEOS_DB_URL_FILE=/run/secrets/neos_app_url -e NEOS_VAULT_KEYS_FILE=/run/secrets/vault_keys \
    -v "$NEOS_SECRETS_DIR/doors:/out" platform tsx scripts/v3/export-door-secrets.ts /out [--company <id>] [--dry-run]
  ```
  It opens each row exactly as the platform did (keyring + the (company, app, door) binding), writes 0600 files,
  keeps files already there unless `--overwrite`, prints names and paths only, and exits 1 if any row could not be
  opened. Then `sudo chown -R 1000:1000 "$NEOS_SECRETS_DIR/doors"` (or re-run `scripts/deploy.sh`). After migration
  024 the source is the private DBA-only archive; no runtime vault API exists.
- **Backups:** each nightly run holds `doors.enc`, the whole store sealed (AES-256-GCM) with `backup_doors_key`
  (generated by `gen-secrets`). Without that key the store is skipped, never copied in clear. Keep the key with the
  rest of `$NEOS_SECRETS_DIR`, **not** beside the backups. Restore:
  `docker compose … exec backup tsx scripts/backup.ts restore-doors /backups/<stamp>/doors.enc /tmp/doors` (then
  copy into `$NEOS_SECRETS_DIR/doors` on the host, 0600, owned by the backend's uid).

Every provider must either accept an `Idempotency-Key` and let us look the effect up afterwards, or (the GST portal) let us ask the system of record directly (RETSUM for a save, RETTRACK for a filing). Ledger journals each call before sending, so "did it happen?" always has an answer.

## Chat: NEOP presence (V3 Matrix-only)

`NEOP_PRESENCE` is mandatory and must be `client` or `appservice`; there is no production `off` or gateway fallback. Ledger reads only its own presence tables and Matrix state, opens each event/task once, and writes outbound events with stable transaction ids so restart/redelivery cannot duplicate a job or reply.

- **External homeserver/client mode:** Ledger receives only `matrix_ledger_token`; NeuralChat receives a different account/token on the platform. `/whoami` must match the configured MXID. A rejected or mismatched token stops that account; replace the file and restart the owning service. Cursors remain in each owner's schema.
- **Local Synapse/appservice mode:** Ledger has its own HS/AS token pair and exclusive `@neop_ledger_.*` namespace. NeuralChat has a separate platform registration and namespace. Rooms must be invite-only, unencrypted, and reserve approval power for people.
- **Sender rules:** people may send task/answer/approve; NeuralChat may send task/answer; peer NEOPs may send task/ask/answer/propose/note/done. NeuralChat and other NEOPs can never approve.
- **Approval:** a person's yes calls the app schema's `answer_proposal()` with the person's role and fingerprint. The runner executes, reads back, records DONE/FAILED/UNKNOWN, then wakes the job.
- **Evidence:** inspect `ledger.inbound_events`, `ledger.outbound_events`, `ledger.presence_accounts`, and the task's Matrix room/thread. `scripts/live-validate.ts --expect-road matrix` rejects any non-Matrix task road.

## Bus room setup (v3 S6 — NEOP to NEOP in `#neop-bus-<co>`)
With `NEOP_PRESENCE=appservice` on every app of a company, NEOP-to-NEOP work (a task handed to another app or one borrowed ability) travels only as typed events in the company's **bus room**, between the apps' own Matrix identities. The retired platform a2a/gateway routes and ACL table are not runtime fallbacks.

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
`NEOS_NEURALCHAT_MATRIX` is mandatory and must be `client` or `appservice`. NeuralChat has its own Matrix identity per company. A person's ask in Conversations reaches Ledger only as a typed `neos.neop.task` in the app's room/DM and stays in that thread. NeuralChat relays note/ask/propose/done into the conversation and sends typed answers to questions; it never sends `approve`. Missing Matrix identity or room/account configuration is a startup/verification failure, not a fallback.
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
- **Files** travel by reference. Ledger keeps bytes in its own document store under the app/company/hash key and returns a short-lived signed URL rooted at `NEOP_FILES_PUBLIC_URL`. The files listener validates the signature, expiry, company/person access, size, and hash; the model never receives raw bytes.
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
   - Check: `\dn` on `pg-ledger` shows `ledger`, the shared cluster has no `ledger` schema, and the Ledger `/ready` files/health listener is healthy.
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

- **Ledger or NeuralChat Matrix token:** issue the replacement for that exact account, atomically replace its token file, restart only the owning service, and confirm `/whoami` plus the persisted cursor before accepting traffic.
- **Job-token secret:** configure `new,old`, restart the backend, wait longer than the maximum job-token lifetime, then remove `old`.
- **Registration service secret:** rotate it with the operator command and update the file used only by the one-off registration process. It is not mounted into the running backend.
- **Door credential:** `scripts/deploy.sh door set … < credential.json`; atomic rename makes the next call use the new value without restart.
- **LLM provider key:** atomically replace `llm_upstream_key` and restart only `llm-proxy`.
- **LLM session-signing key:** generate the replacement key and matching public `llm_runner_keys`, restart `llm-proxy`, then the app backend. Existing sessions end at their bounded token lifetime.
## When something goes wrong
| Signal | Meaning | Do |
| --- | --- | --- |
| `NeopExecutionUnknown` | An approved action may or may not have happened (provider outage, lost answer) | Nothing at first. Reconciliation reads back every 30 s. Within 10 min (`NEOP_DOOR_RECOVERY_MS`) it can complete the send exactly once; after that it closes it as not sent and the person is told. |
| `NeopAckSlow` | Typed Matrix tasks are acknowledged slowly | Check homeserver delivery, Ledger presence state, PgBouncer (`SHOW POOLS`), Postgres, and the task acknowledgement histogram. |
| `NeopApprovalsPiling` | People are not answering cards | Product issue, not an outage. |
| Card stuck after a yes | The proposal row is APPROVED/EXECUTING but the effect is not terminal | Check the Ledger backend `/ready` listener and runner log. LISTEN is a hint and the runner poll is the recovery path; an abandoned EXECUTING row resumes with read-back first. Nothing on the platform side executes it. |
| A job keeps failing | The assistant cannot finish | Read the job's steps (activity feed). After 5 interrupted sessions it fails honestly and asks a person to look. |

## Limits worth knowing
- **Model spend** is capped per job ($5) and per company-app per day ($50) by default; change them on the switchboard (`budget`). A job over its cap is refused before it calls the model.
- **Approval policy.** Companies can require roles or four-eyes per ability on the switchboard (`approvals`); it is enforced inside the app's `answer_proposal()` (v3 S2), so no caller can get past it.
- **Closed months** take no postings until someone reopens them with a reason.
