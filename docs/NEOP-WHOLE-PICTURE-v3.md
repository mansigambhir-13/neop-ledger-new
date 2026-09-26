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

## 13. The blueprint: what is the app's and what is the platform's

As v2, and v2's own rule now holds in the build: **`blocks/` are the app's screens, as data, never
JavaScript.** The platform validates them at registration — every source must be a read of the app, the
only effect a block can cause is an ask, no markup anywhere — and **the NEOS desk (platform-owned, one
for every app) draws them with one renderer**. My Desk, approvals, jobs, switchboards, standing yeses,
doors, packages, apps, audit and team are platform surfaces, shared by every NEOP.
*(`contracts/src/blocks.ts`, `platform/src/web/` · blocks.test, web.test.)*

## Deployment and the network

Each app is two containers — backend (database role, borrowed keys, no model) and agent (model via the
proxy, no keys, no database) — plus the platform, the LLM proxy, PgBouncer and the desk. Network policy
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
