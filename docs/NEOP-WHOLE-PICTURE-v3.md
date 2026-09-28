# NEOP — The whole picture (v3)

Status: DRAFT · 26 September 2026 · supersedes v2 where they differ.
v2 (`docs/source/NEOP-WHOLE-PICTURE-v2.md`) stays the plain-words introduction. The technical plan
found twenty defects in it; this version folds every one in, and records the few places the build
chose differently. Each change names the code and the test that hold it, so this document and the
system cannot quietly drift apart again.

**One app, one subject, one assistant you can talk to — and a book it cannot lie to.** Unchanged.

---

## 1. The flow, as built

The platform flow (steps 1–9, A, B) and the NEOP inside it (7.1–7.9) are as v2 draws them, with
these corrections:

- **(7.1) and (6b) are typed, signed calls — never the room.** A room message reaches the app as a
  signed `inbox.deliver` through the gateway; the result reaches the task from the app's outbox
  (`task.completed` / `task.failed`), never by lifting text out of the room. The room is a mirror.
  *(B4 · `platform/src/bridge/bridge.ts` · rooms.test, inbound-auth.test; verified live against Synapse.)*
- **(7.7) A yes that does not match the card's fingerprint is refused at the door** and the card stays
  open for a yes to what is really on it. The app checks the fingerprint again (defence in depth).
  *(`platform.ts answer()` · proposal.test "refuses a stale yes at the desk".)*
- **(7.7→7.8) The job wakes only when execution is terminal** — DONE, FAILED or UNKNOWN — never at
  resolve. *(B2 · `execute.ts` · wake-order.test.)*
- **A platform crash between resolve and execute loses nothing**: the approval is a state machine
  (PENDING → RECORDED → RESOLVED → EXECUTED | CLOSED | EXPIRED | REFUSED) driven by a leased worker.
  *(B3 · wake-order.test.)*

## 2. The pieces

As v2, plus two that v2 did not name:

- **The LLM proxy** holds the model key, meters every call and enforces spend caps per job and per
  company-app per day, before the call. The assistant holds no key at all. *(S9 · llm-proxy.test,
  llm-openrouter.test.)*
- **The job token**: the runner mints one per job, scoped to the abilities switched on; the gate
  refuses any call without it or outside its scope. The agent container can reach its own gate and
  nothing else of value. *(S5 · jobtoken.test.)*

## 3–4. The job and the switchboard

Unchanged in substance. Additions:

- **Company rules are data** from a closed set — time window, destination, amount cap, recipient cap,
  require a person — validated **when an admin saves them** (one shared check in `@neop/contracts`)
  and again when the gate loads them. A malformed rule can no longer reach a job.
  *(`contracts/src/rules.ts` · governance.test, rules.test.)*
- **Skills are lines on the board** — on or off; greyed out, with the reason, when a tool they need is
  off; dropped from the assistant's prompt at spawn in either case. *(WP §10 · governance.test.)*
- **Installed packages' abilities are lines on the host's board**, "from <package>", at the package's
  floor, tightenable like any other. *(governance.test.)*
- Times: rules use the company's time zone; expiries use database time. *(C5.)*

## 5–6. Approvals

As v2, with the state machines made complete:

```
proposal (app book):  PROPOSED → APPROVED → EXECUTING → DONE | FAILED | UNKNOWN
                      PROPOSED → REJECTED | SUPERSEDED | EXPIRED | WITHDRAWN
                      UNKNOWN  → DONE | FAILED   (reconciliation reads back; result reaches the desk)
approval (platform):  PENDING → RECORDED → RESOLVED → EXECUTED | CLOSED | EXPIRED | REFUSED
```

- **"Exactly once" means at-least-once delivery + door-level idempotency + read-back**, with an
  UNKNOWN outcome that reconciliation settles; the door journals each payload before sending and
  recovers only within a bounded window. *(S1, S2 · providers.test · ADR 0012.)*
- **Standing yeses live on the platform** (`neos.grants`), because the gateway mints the execution
  token from them. Money needs an amount cap; they expire within a year; only admins create and
  withdraw them; they suspend themselves when a carry-out under them fails or cannot be confirmed.
  *(S3 · ADR 0008 · proposal.test, governance.test.)*
- **The starter prompt no longer tells the assistant to carry out a yes.** Woken with an answer, it
  verifies the proof against what it proposed and reports. *(B5 · `SYSTEM.template.md`.)*
- **One row, one function (§6).** Every answer enters a proposal through `<schema>.answer_proposal()`
  (SECURITY DEFINER, owned by the migrator, EXECUTE for the app's app/runner roles only, never PUBLIC or
  a desk role): fingerprint, expiry, the legal transition, the event trail, the step, the outbox event
  and — for anything but a yes — the wait made ready and NOTIFY. `proposals.resolve` (L3) calls it; its
  HTTP contract is unchanged. *(A3 · t009 · v3-conformance.test "A3", proposal.test.)*
- **States move only along their lifecycle, in the database (§11 value classes).** Triggers on
  `jobs.status`, `proposals.status` and `waits.status` refuse any other UPDATE (23514). The allowed sets
  are the code's: the proposal machine above; jobs RECEIVED → RUNNING | CANCELLED | EXPIRED,
  RUNNING → WAITING | DONE | FAILED | CANCELLED, WAITING → RUNNING | CANCELLED; waits pending → ready |
  consumed, ready → consumed. *(B4 · t008 · v3-conformance.test "B4".)*
- **The notification is a hint, from the database (§6).** AFTER triggers NOTIFY the runner's channel
  (`neop_<schema>`) when a wait turns ready or a job arrives, whoever made the change; the app code still
  notifies and the poll stays the truth. *(A8 · t009 · v3-conformance.test "A8": a plain SQL UPDATE wakes
  the job with the poll 60 s away.)*

## 7–9. Gateway, other apps

Unchanged. The gateway is a module in the platform backend (ADR 0004); tokens are EdDSA, 60 s,
single-use `jti`; every call carries `Contract-Version` and `traceparent`. App-to-app calls are ACL
rows an admin grants on the Apps page; another app can never approve anything.

## 10. Sharing skills and tools

- **The registry holds skills and packages** (ADR 0013). Abilities and doors stay declared in the
  manifests that own them and are reached through ACL rows and the vault.
- **Package handlers run in a Deno subprocess with no permissions**, 256 MB and 10 s per call, talking
  to the host over a narrow RPC (its own tables, its granted doors, `book.step/fact`). *(S6 · ADR 0005 ·
  registry.test; verified live inside the Docker backend.)*
- **Publishing needs a platform co-signature after a person reviews the diff.** *(S7 · registry.test.)*
- **Uninstall disables and keeps the tables**; the host stops offering the package at once.
  *(governance.test.)*

## 11. One database

- **A schema per app** (`ledger.jobs`), not prefixed tables in one schema (C2 · ADR 0001). Three roles
  per app — migrator, app (forced RLS), runner (BYPASSRLS on the standard tables only).
- **Tenant isolation inside a family**: every table carries `company_id`; RLS keys off the company in
  the verified gateway token. *(B1 · tenant.test.)*
- **No union views.** The desk's cross-app picture is built from outbox events into the platform's own
  tables. *(S4.)*
- **Query pools go through PgBouncer (transaction mode)**; the runner's LISTEN and the execution lock
  use one direct session connection; statement/lock/idle timeouts are role defaults so they hold
  either way. *(S8 · network.test; verified live.)*
- **The nine standard tables' key columns (§11), filled by the code that does the work** (t007):
  `jobs.origin` (room event id · `timer` · the task id), `switchboard_version` + `switchboard_snapshot`
  (the board the latest session was spawned on), `heartbeat_at` (gate heartbeat);
  `proposals.manifest_version`, `answered_at`, `executed_at`, `verified_at` (read-back found it);
  `operations.request_checksum` / `result_checksum` (sha256 of RFC 8785 JCS) and `reason`; a
  `dependency` wait kind. Rows from before stay NULL (unknown). *(B3 · v3-conformance.test "B3".)*
- **`switchboard`, `installs`, `grants` are read-only mirrors in the app's schema** (t009), written by the
  runner role whenever the backend (re)loads the board from the platform (and on `switchboard.changed`,
  before it answers) or a grant lookup returns a standing yes; the app role may only read them. **The
  platform stays the source of truth** (a deliberate difference from v3's "the desk writes it": the desk
  is the platform, and the gate never decides from the mirror). `installs.matrix_user` and
  `grants.limits`/`expires_at` stay NULL: the backend is not told them. *(A7/A9 · v3-conformance.test.)*
- **search_path = the app's schema** for its app and runner roles (pgkit bootstrap, role default).
  *(schema-only.test.)*
- **The DBA path is one file.** `tsx scripts/dba-bundle.ts <app> [--out f.sql]` renders the roles and
  grants bootstrap makes, the schema, and every shipped migration with `{{schema}}` substituted and its
  sha256, each in its own transaction as the migrator, recording `schema_migrations` exactly as
  `migrate` does. It prints; it never connects. *(B5 · dba-bundle.test: every checksum present; applied
  to an empty database it yields the same ledger, columns, RLS and grants as `migrate`.)*
- **Heavy reads as declared views** (Ledger 007): `ledger.v_account_balances` (posted amounts per account
  per day and currency) and `ledger.v_ageing` (open items with what is owed), `security_invoker` so RLS
  scopes them. The reads keep their own SQL; the views are proven to agree with the trial balance and
  ageing on the demo books. *(B11 · v3-conformance.test "B11".)*

## 13. The blueprint: what is the app's and what is the platform's

As v2, and v2's own rule now holds in the build: **`blocks/` are the app's screens, as data, never
JavaScript.** The platform validates them at registration — every source must be a read of the app, the
only effect a block can cause is an ask, no markup anywhere — and **the NEOS desk (platform-owned, one
for every app) draws them with one renderer**. My Desk, approvals, jobs, switchboards, standing yeses,
doors, packages, apps, audit and team are platform surfaces, shared by every NEOP. The desk in this
repo is a **test harness** for those surfaces; the product UI is the NEOS app, which adopts the one
renderer. *(`docs/pilot-ledger-integration.md`.)*

The standard tests (§13) are in `apps/ledger/tests/`: contract, proposal, switchboard, resume,
injection, **sender** (a stranger, another company's person and the app itself open nothing in a room or a
DM; an app can neither resolve a proposal nor answer a wait — gateway, L3 and `answer_proposal()` all
refuse; a bridge's "go ahead" without may_approve is not a yes), **honesty** (every read returns a fresh
`generatedAt`), migration, and **schema-only** (as `ledger_app` and `ledger_runner` every `marketing.*` and
`neos.*` relation is 42501; the assistant's deployment, entry script and session hand-off carry no DB link).

## 14. On the NEOS platform as it runs today

Ledger installs on today's platform (`neos-service-platform-api`) through its descriptor registry and
capability gateway, under contract `neop.v1`: its reads as capabilities, a person's request as a job
(`ledger.ask`), and the yes as a human-gated capability the platform never dispatches. No write is a
capability. The platform's own descriptor validator accepts the generated descriptor unmodified.
*(`template/src/l3/neos-v1.ts` · neos-v1.test.)*
*(`contracts/src/blocks.ts`, `platform/src/web/` · blocks.test, web.test.)*

## Deployment and the network

Each app is two containers — backend (database role, borrowed keys, no model) and agent (model via the
proxy, no keys, no database) — plus the platform, the LLM proxy and PgBouncer (and, for testing only, the desk). Network policy
is enforced by the listeners, not only by the networks: L3 binds only on the gateway network, the gate
only on the agent network, the agent only on its own backend's network. A runtime probe
(`scripts/netcheck.sh`) runs inside every container and fails if any row of the policy is broken.
*(network.test · live netcheck.)*

## What the build proved, live (26 Sep 2026)

- A pilot acceptance run of 20 real requests with a real model (`docs/PILOT-ACCEPTANCE.md`).
- A Matrix room driving a job, and a card answered "yes" in the room, recorded on the platform's row
  with the fingerprint shown, carried out once and verified.
- The network policy holding at run time in every container.
- 200 concurrent jobs acknowledged at p95 < 300 ms; zero lost or duplicated across 50 forced restarts.

---

*NEOP · the whole picture, third version · 26 September 2026 · decisions are ADRs 0001–0013, for review.*
