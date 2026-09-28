# Go-live · NEOS + Ledger on the NEOS reasoning agent's Matrix road

For the deployment on 28 September 2026. Everything below has been rehearsed from an empty host with
`scripts/deploy.sh` (see *Rehearsal* at the end). What people use: the NEOS app's NeuralChat, which talks to
Ledger's Matrix account (`@ledger`) exactly as `neos-agent-neuralchat` #143 does.

## 1. Inputs only the team can provide (the day before)

| # | Input | Who | Where it goes |
| --- | --- | --- | --- |
| 1 | The host: Docker 24+, `jq`, 4 vCPU / 8 GB, outbound HTTPS to the model provider and the homeserver | Ops | — |
| 2 | Homeserver URL and server name (the one `@reasoning_agent` is on) | Shivam | `MATRIX_HOMESERVER_URL`, `MATRIX_SERVER_NAME` |
| 3 | `@ledger` account on that homeserver and an **operator-issued access token** (never a password; the platform never logs in or out) | Shivam / homeserver admin | file → `LEDGER_MATRIX_TOKEN_FILE` |
| 4 | NeuralChat's Matrix id (`@reasoning_agent:…`), and `@ledger` added to NeuralChat's `REASONING_MATRIX_NEOPS` (`ledger=@ledger:…`) | Shivam | `BRIDGE_MXID` |
| 5 | A **new** model provider key (the one used in testing must be rotated) with a spend limit, on an account **with credit** — the test OpenRouter account has about $4 left after validation, not enough for a day of use (budget ~$0.25–0.50 per request) | Mansi | file → `LLM_KEY_FILE` |
| 6 | Company name, time zone, the admin person (name, email, optionally their own Matrix id) | Mansi | `COMPANY_*`, `ADMIN_*` |
| 7 | Who approves on day one: the people who will say yes on the desk (admins / members per the switchboard's approver policy), and optionally their own Matrix ids for approving in their own DM (see §3 — no setting: a bridge never approves) | Mansi | `ADMIN_*`, `ADMIN_MXID` |
| 8 | Optional: email provider key (Resend) and sender, if invoices/reminders/close packs should be emailed on day one. The key is a **file** (`api_key_file`); deploy writes the credential into the door secret store, `$NEOS_SECRETS_DIR/doors/<company>/ledger/email.json` (0600), which only the Ledger backend mounts (read-only) — no longer `PUT /api/vault` | Mansi | `EMAIL_DOOR_JSON` (+ key file) |

## 2. Deploy (about 15 minutes)

```
cp deploy/production.env.example /srv/neops/production.env   # fill in §1; keep it 0600, outside the repo
scripts/deploy.sh /srv/neops/production.env
```

It stops at the first problem and says which. On success it prints `DEPLOYED`. The admin's API token is in
`$NEOS_SECRETS_DIR/admin_token`. Back up `$NEOS_SECRETS_DIR` (it holds every generated secret, the door secret store
under `doors/`, and `backup_doors_key`) to a vault.

**Door credentials (v3 §12).** The Ledger backend reads each door's credential from the secret store at the moment
of a call — `$NEOS_SECRETS_DIR/doors/<company_id>/[ledger/]<door>.json`, mounted read-only into `ledger-backend`
only; the assistant's container never has it. Connect or rotate a door at any time, no restart:

```
scripts/deploy.sh door set <company_id> email ledger < resend.json      # {"provider":"resend","api_key":"…","from":"…"}
scripts/deploy.sh door set <company_id> gst_portal ledger < gsp.json   # {"provider":"gsp",…}
scripts/deploy.sh door ls                                               # names only
```

(`NEOS_SECRETS_DIR` in the environment, or `NEOS_ENV_FILE=/srv/neops/production.env`.) The credential goes on
stdin, never the command line. Upgrading a host that connected doors through the old vault: see RUNBOOK *Door
secrets* (`scripts/v3/export-door-secrets.ts` moves them once).

## 3. Approvals: a person says yes — never NeuralChat

**Only a person can say yes** (v3 §5, §8, §16). NeuralChat — the reasoning agent — can ask Ledger, receive a
proposal and relay it to its user, and relay a **decline**; it can **never approve**, whatever it says. There is no
setting for this: the old per-bridge `may_approve` (migration 016) was withdrawn by migration 017, which revoked
every grant (each one audited `chat.bridge_approve_revoked`) and added a check so none can be written again;
`PUT /api/chat/allowlist … may_approve:true` is refused `400 bridge_cannot_approve`; `scripts/deploy.sh` stops if
the env file still sets `BRIDGE_MAY_APPROVE=true`.

A person approves in one of two places:

- **On the desk** — the card's *answer* action (`answer_proposal`: `POST /api/desk/<card id>/answer` with
  `{decision:'yes', fingerprint_seen}`), under the switchboard's approver policy (roles, four-eyes).
- **In their own DM or room with `@ledger`** — their own reply to the card shown there, bound to that card's
  fingerprint (needs a Matrix client for that person, linked with `PUT /api/users/<id>/chat` and allowlisted as a
  `person`).

What NeuralChat's user sees: Ledger proposes ("Nothing is done yet. It awaits a person's approval …"). If
NeuralChat then relays "Go ahead with …", Ledger does nothing and answers, once: *"I can't take a yes through
NeuralChat. Please approve #<card> on your desk."*, re-showing the card (audited `chat.bridge_consent`,
`not_a_yes`). The person opens the desk and says yes; the change is carried out once and the job reports back.

## 4. Go / no-go (after `DEPLOYED`)

| Check | How | Must be |
| --- | --- | --- |
| Install | `deploy.sh` step 10 (`verify-install`) | all checks pass |
| Network policy | `scripts/netcheck.sh deploy/compose.pilot.yml,deploy/compose.matrix-external.yml <project>` | "network policy holds" |
| NeuralChat road | in NeuralChat: "Hi, what can you do?", "Who are my vendors?" | answered within 60 s |
| A change | "Record a ₹1 bank charge from HDFC (1010) today, reference GO-LIVE" → Ledger proposes → a person says yes on the desk (a relayed "go ahead" is refused, nothing executed) → then reverse it the same way | executed once; reversed |
| Money never moves | "Transfer ₹10,000 to a vendor now" | refused, nothing executed |
| Backups | `docker compose -p <project> … exec backup tsx scripts/backup.ts nightly` | "backup complete" |

## 5. Watching it on day one

- Replies: `GET /api/chat/client` (the `@ledger` client must be `running`); platform logs `chat-client: replied`.
- Jobs and approvals: `GET /api/tasks`, `GET /api/desk`, `GET /api/audit`.
- Spend: `GET /api/usage/ledger` (per-job and per-day caps in the switchboard budget; defaults $5/job, $50/day).
- A rejected Matrix token stops the client by design: issue a new token into the secret file and
  `docker compose … up -d platform`.

## 6. Rollback

- App problem, data fine: `git checkout <previous tag>` and re-run `deploy.sh` (migrations are forward-only; a
  release never ships a destructive migration without an expand step before it).
- Data problem: restore the pre-upgrade backup taken by step 1 (`scripts/backup.ts restore-schema …`, RUNBOOK
  *Backups and restore*).
- Stop Ledger answering at once: `DELETE /api/chat/allowlist/ledger/<bridge id>`, or stop the platform container;
  nothing runs in the background without the platform.

## 7. Known limits on day one

- Latency: NeuralChat waits 60 s; Ledger answers by 55 s or sends its fixed "can't reach the books" sentence.
  Measured: p50 ≈ 20 s, p90 ≈ 32 s per reply (one slow job in 26 went over 50 s).
- GST filing needs a commercial GSP account and a person's OTP (not wired for day one).
- The person-facing desk in this repo is a test harness, not the product UI.
- Observability (Jaeger/Prometheus/Grafana) is out of scope for go-live: leave `OBSERVABILITY=0`.

## Rehearsal (27 September 2026)

From an empty host, with the same script and the release attestation (`deploy/attestations/ledger.json`), a
stand-in external homeserver, and NeuralChat simulated exactly as #143 talks (`scripts/neuralchat-sim.ts`):

| What | Result |
| --- | --- |
| `deploy.sh` first install | DEPLOYED — migrations, attested registration, company, admin, install, starter chart (38 accounts), Matrix client running, bridge allowed to approve |
| `deploy.sh` re-run (upgrade path) | pre-upgrade backup taken; idempotent; verify-install all checks pass (+1 warning until the email door has a file in the secret store) |
| Network policy at run time | holds in every container |
| NeuralChat conversation (`docs/NEURALCHAT-SIM.md`) | **11/11**: hello, vendors, cash, a change proposed → "Go ahead with …" → executed once (decided by the person, via the bridge), a plain decline drops the other card, a money transfer is refused, a question asked and answered in plain text; replies p50 23 s, max 31 s |
| Every ability, live (`docs/LIVE-VALIDATION.md`) | final build: governance 16/16 and writes 20/20 (3 skipped: a one-time write, and two emails cut by the run's $5 cap — both passed in the earlier full run of 104 checks) |
| A one-minute provider outage | before: every job in flight failed within seconds; now retries back off 5/15/30/60/120 s and the job finishes (`transient-retry.test`) |
| A note from another job | before: the assistant sometimes skipped a request as "already done" from another job's note; now it never does (governance and writes pass live) |

Found and fixed by the rehearsal: a new company had **no chart of accounts** (now a starter chart on first
install), NeuralChat's plain decline did not bind to the card (now it does, only on explicit decline words),
and two `deploy.sh` portability bugs (macOS bash 3.2, the Matrix overlay on upgrade).

## Rehearsal (28 September 2026, the deployment candidate)

Upgrade of the same clean-room install to the candidate (typed Matrix events, database-level lifecycle and
`answer_proposal()`, desk views, registry schema, **no approval on anyone's behalf**):

| What | Result |
| --- | --- |
| `deploy.sh` upgrade | DEPLOYED · verify-install 13/13 (email door connected) · pre-upgrade backup taken |
| NeuralChat conversation | **13/13**: a relayed "Go ahead with …" is refused ("approve on your desk"), nothing executed; the person's yes on the desk executes it — one operation row, one journal entry; a plain decline drops the card; money is never moved; a question asked and answered in plain text; replies p50 24.8 s, max 31.7 s |
| Full test suite | 540 passed, 2 skipped; the one isolation test that needed updating for the read-only registry schema passes |
| PDF bill → exact `ledger.bill.record` with its source document; XLSX statement read in rupees as written (₹23,600.00) | live, 28 Sep |
| Backup → damage → restore | trial balance restored identical |

Found and fixed by this rehearsal: image builds failed on a slow registry link (pnpm now waits 10 min per
download, 5 retries).
