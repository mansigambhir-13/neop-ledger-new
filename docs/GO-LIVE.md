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
| 7 | **Decision:** may NeuralChat's go-ahead approve? (see §3) | Mansi + Shivam | `BRIDGE_MAY_APPROVE` |
| 8 | Optional: email provider key (Resend) and sender, if invoices/reminders/close packs should be emailed on day one | Mansi | `EMAIL_DOOR_JSON` |

## 2. Deploy (about 15 minutes)

```
cp deploy/production.env.example /srv/neops/production.env   # fill in §1; keep it 0600, outside the repo
scripts/deploy.sh /srv/neops/production.env
```

It stops at the first problem and says which. On success it prints `DEPLOYED`. The admin's API token is in
`$NEOS_SECRETS_DIR/admin_token`. Back up `$NEOS_SECRETS_DIR` (it holds every generated secret) to a vault.

## 3. The one policy decision: can NeuralChat's "go ahead" approve?

Today the NEOS platform has no decide route (My Desk is read-only), and NeuralChat carries approvals in the
chat: Ledger proposes and asks "Shall I go ahead?", NeuralChat asks the user, and only in a run resumed by the
user's own answer does it send "Go ahead with …". So:

- `BRIDGE_MAY_APPROVE=false` (the plan's strict rule) — reads, questions and proposals work; **nothing gated can
  be approved** until the platform's decide route (PLATFORM-ISSUES item 1) exists or a person approves in their
  own DM with `@ledger` (needs a Matrix client for that person).
- `BRIDGE_MAY_APPROVE=true` (Shivam's option 2) — NeuralChat's go-ahead approves **only** the card Ledger just
  showed in that DM, bound to its fingerprint and expiry, only as a clear yes with no negation and no amount
  that differs from the card, recorded as the acting person's yes via the bridge, audited, and still subject to
  the approver policy (roles, four-eyes). Revoke at any time:
  `PUT /api/chat/allowlist {app:'ledger', matrix_id:'<bridge>', kind:'bridge', acts_for:'<user>', may_approve:false}`.

Recommendation for day one: `true`, with the go-ahead rules above — it is the only way approvals work end to end
through the channel people use tomorrow; the residual trust (NeuralChat reading the user's answer) is the one
NeuralChat already enforces (#156/#157).

## 4. Go / no-go (after `DEPLOYED`)

| Check | How | Must be |
| --- | --- | --- |
| Install | `deploy.sh` step 10 (`verify-install`) | all checks pass |
| Network policy | `scripts/netcheck.sh deploy/compose.pilot.yml,deploy/compose.matrix-external.yml <project>` | "network policy holds" |
| NeuralChat road | in NeuralChat: "Hi, what can you do?", "Who are my vendors?" | answered within 60 s |
| A change | "Record a ₹1 bank charge from HDFC (1010) today, reference GO-LIVE" → Ledger proposes → answer yes (if §3 = true) → then reverse it the same way | executed once; reversed |
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
- Stop Ledger answering at once: `PUT /api/chat/allowlist … may_approve:false`, or stop the platform container;
  nothing runs in the background without the platform.

## 7. Known limits on day one

- Latency: NeuralChat waits 60 s; Ledger answers by 55 s or sends its fixed "can't reach the books" sentence.
  Measured: p50 ≈ 20 s, p90 ≈ 32 s per reply (one slow job in 26 went over 50 s).
- GST filing needs a commercial GSP account and a person's OTP (not wired for day one).
- The person-facing desk in this repo is a test harness, not the product UI.

## Rehearsal (27 September 2026)

From an empty host, with the same script and the release attestation (`deploy/attestations/ledger.json`), a
stand-in external homeserver, and NeuralChat simulated exactly as #143 talks (`scripts/neuralchat-sim.ts`):

| What | Result |
| --- | --- |
| `deploy.sh` first install | DEPLOYED — migrations, attested registration, company, admin, install, starter chart (38 accounts), Matrix client running, bridge allowed to approve |
| `deploy.sh` re-run (upgrade path) | pre-upgrade backup taken; idempotent; verify-install 12/12 (+1 warning: email door not connected yet) |
| Network policy at run time | holds in every container |
| NeuralChat conversation (`docs/NEURALCHAT-SIM.md`) | **11/11**: hello, vendors, cash, a change proposed → "Go ahead with …" → executed once (decided by the person, via the bridge), a plain decline drops the other card, a money transfer is refused, a question asked and answered in plain text; replies p50 23 s, max 31 s |
| Every ability, live (`docs/LIVE-VALIDATION.md`) | final build: governance 16/16 and writes 20/20 (3 skipped: a one-time write, and two emails cut by the run's $5 cap — both passed in the earlier full run of 104 checks) |
| A one-minute provider outage | before: every job in flight failed within seconds; now retries back off 5/15/30/60/120 s and the job finishes (`transient-retry.test`) |
| A note from another job | before: the assistant sometimes skipped a request as "already done" from another job's note; now it never does (governance and writes pass live) |

Found and fixed by the rehearsal: a new company had **no chart of accounts** (now a starter chart on first
install), NeuralChat's plain decline did not bind to the card (now it does, only on explicit decline words),
and two `deploy.sh` portability bugs (macOS bash 3.2, the Matrix overlay on upgrade).
