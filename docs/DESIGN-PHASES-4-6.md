# NEOP — design for the rest of the plan (Phases 4–6) and the open gaps

Status: **built** (25 Sep 2026); every row below has tests — see README. Ledger stays the product focus; Marketing exists only as the Phase 4 fixture. It extends the technical plan (the spec) and the
flow coverage in `FLOW-COVERAGE.md`. Every decision lists its trade-off and what we
would revisit at scale.

## 1. Requirements

**Functional**, beyond what is built:

| # | Requirement | Plan source |
| --- | --- | --- |
| F1 | A second app cut from the template (Marketing) with no template edits | Phase 4 |
| F2 | Borrowed abilities: Marketing reads `ledger.budget.remaining` through the gateway | §Registry, 7.5 |
| F3 | a2a tasks: one app hands multi-step work to another as a job with its own lifecycle | Phase 4, "four ways to share" |
| F4 | Registry: skills, abilities, packages, doors with versions, pins and signatures | Phase 5 |
| F5 | Skill publishing: author signature plus a platform co-signature after a person reviews the diff (S7) | Phase 5 |
| F6 | Borrowed skills added by an admin in under 2 minutes, with no deploy | Phase 5 exit |
| F7 | Packages: skill + handlers + tables; handlers sandboxed with no network (S6, D5) | Phase 5 |
| F8 | Load (200 concurrent jobs per app), chaos (50 forced restarts), backups, dashboards, secret rotation | Phase 6 |

**Non-functional** (the plan's acceptance bars): ack p95 < 300 ms; zero lost jobs across
restarts; zero duplicate executions; every effect in the app's book and the platform audit;
the model never holds a key, a DB role or an execution token.

**Constraints**: one customer VM with one Postgres cluster (D2); a four-engineer team; Node 24 + TypeScript;
no new infrastructure beyond Postgres unless it earns its place (the platform already
runs pg-boss-style work on Postgres).

## 2. Gaps found in review

Each is a gap in the plan or in the current build, not only a missing feature.

| # | Gap | Why it matters | Resolution |
| --- | --- | --- | --- |
| **R1** | **Spend caps trust the agent.** The gate counts cost the agent container *reports*. A hijacked agent under-reports. The agent also holds a long-lived model key. | S9 cap and "the model never holds a key" are both promises, not walls. | **LLM proxy** (§4). The platform mints a short-lived session token per job session; the proxy holds the real key, meters actual usage and refuses past the budget, using reserve-then-settle. |
| **R2** | **Template upgrades have no migration stream.** The template owns `001`; apps own `002+`. A template change to the standard tables has no number to take. | "Every app takes the template upgrade" is impossible without it. | Two ordered streams: template `t###_*.sql` and app `###_*.sql`, both tracked in `schema_migrations`. |
| **R3** | **a2a loops.** App A asks B, which asks A… The plan has no depth or cycle rule. | Runaway jobs and spend. | Every a2a task carries its `lineage` (app keys). The gateway refuses a target already in the lineage, or depth > 3. |
| **R4** | **Borrowed-call accounting.** "Both operations tables match the audit" needs a shared id. | Phase 4 exit criterion. | The gateway `request_id` is written into the caller's operation, the owner's operation and `neos.audit`. |
| **R5** | **Registry code at request time.** The plan forbids serving code from a row, but it does not say how a host gets it. | Integrity of package code. | Artifacts are content-addressed (`sha256`) and platform-signed. The host unpacks by hash into a read-only cache, and the sandbox refuses to start on a hash mismatch (a hand-edited package fails at spawn). |
| **R6** | **Package DB access.** No DB inside the sandbox, yet packages have tables. | S6. | The host proxies `ctx.tables.*` over RPC as the package's own role (`<host>_nep_<name>`), limited to its `nep_<name>_*` tables, with company RLS. |
| **R7** | **Reads set to ask-first** are meaningless: there is no effect to approve. | Ambiguous switchboard. | Refused for reads, in the manifest and in the switchboard API. |
| **R8** | **Approver policy.** Any person may approve. | Money needs separation of duties. | Per-ability policy in the switchboard: allowed roles and four-eyes (the requester may not approve their own). The company can only tighten. |
| **R9** | **Vault in plaintext.** | Leaked DB = leaked door keys. | AES-256-GCM envelope with a key id; a keyring allows rotation. |
| **R10** | **Keys cannot rotate.** One gateway key, one job-token secret, one service secret. | "Rotate on detection" (plan §Security) is impossible. | Keyrings everywhere: the JWKS publishes active + previous keys; verifiers accept any key still in the ring. |
| **R11** | **Outbox never shrinks**, and the gateway ledger grows forever. | Disk. | The platform acks its cursor (`outbox.ack`); the app prunes acked events older than 7 days. The gateway ledger is pruned after 30 days; the audit is never pruned. |
| **R12** | **Dead letters are parked, not replayable.** | Recovery needs a person. | Admin list and replay endpoints; a replayed event is marked, never deleted. |
| **R13** | **One trace** from ask to door was specified, not built. | Debugging a four-hop flow. | W3C `traceparent` through gateway → L3 → job → session → gate → door. Spans are exported as OTLP/JSON when a collector is configured; `trace_id` is stored on jobs, operations and the audit. |
| **R14** | **The standard tests are Ledger-specific.** | The template must ship the bar every app passes. | `@neop/template/testing` conformance suite, parameterised by app fixtures; Ledger and Marketing both run it. |
| **R15** | **(9) The answer is only reachable by polling.** | UX. | Server-sent events per conversation. |

## 3. High-level design (after this work)

```
 NEOS app / desk / rooms
        │ HTTPS (session)          Matrix appservice
        ▼                                ▼
 ┌─────────────────────────── PLATFORM ───────────────────────────┐
 │ conversations · NeuralChat · task store · desk/approvals        │
 │ registry (entries, artifacts, installs, reviews) · switchboards │
 │ GATEWAY (keyring, ACL, lineage, idempotency, audit)             │
 │ vault (AES-GCM keyring) · outbox consumer · metrics · tracing   │
 └───┬───────────────────────────────┬─────────────────────────┬──┘
     │ signed L3 calls               │ /internal (service)      │ session tokens (EdDSA)
     ▼                               ▼                          ▼
 ┌──────── APP BACKEND (per app) ────────┐              ┌── LLM PROXY ──┐
 │ L3 · gate · runner · doors · book      │◄──gate────── │ meters, caps, │
 │ package host ──RPC──► Deno sandbox     │   agent ────►│ holds real key│
 └───────────────────────────────────────┘              └───────────────┘
```

## 4. Deep dives

### 4.1 LLM proxy (R1)
- **Token**: when the runner spawns a session, the backend asks the platform (`/internal/llm/session`, service-authenticated) for a token: EdDSA, `aud: llm-proxy`, claims `{app, company_id, job_id, sid, budget_micros}`, TTL = session max + 1 min. The agent uses it as its API key; it never sees a provider key.
- **Proxy**: `POST /v1/messages` is Anthropic-compatible, including SSE streaming passthrough.
  1. Verify the token against the JWKS.
  2. **Reserve** the worst case (`max_tokens × output price` + prompt bytes / 4 × input price) against both the job budget and the company-app day budget, in one `UPDATE … WHERE spent + reserved + est <= cap`. If it cannot reserve, return 402 before any upstream call.
  3. Stream upstream and parse `message_start` / `message_delta` usage.
  4. **Settle** the actual cost and release the reservation.
- **Trade-off**: an extra hop (~1 ms locally) and a component on the critical path. It is stateless apart from Postgres, so it runs as two replicas. The reservation makes overshoot at most zero rather than one call's cost. Revisit: batch the settles if Postgres write load matters (it will not at 200 jobs).

### 4.2 Borrowing and a2a (F2, F3, R3, R4)
- **Borrowed read** (synchronous, via the gateway):
  - The host manifest lists `uses: [{app, ability, range}]`.
  - The gate shows a borrowed tool only when the host switchboard line for it is on *and* the owner's setting at that company is not off. Effective setting = strictest(host, owner).
  - The call path is gate → platform `/internal/gateway/call` (the backend's service secret proves `app:<host>`) → gateway (ACL, install, lineage) → owner L3 `abilities/<key>`.
  - The owner records an operation `served:<caller>`, the caller records `borrowed`, both with the gateway `request_id`.
  - The owner still runs its own switchboard check (off → 403).
- **Borrowed write**: never direct. It becomes an a2a task, so the owner proposes and a person approves.
- **a2a task** (asynchronous):
  1. The gate tool `a2a.request {app, ask}` asks the platform to open a task (`requester: app:<host>`, `parent_task`, `lineage`) and writes a wait of kind `a2a_task` whose ref is that task id.
  2. The target runs a normal job. Any proposals go to the desk, because only a person approves.
  3. On `task.completed` / `task.failed`, the platform makes a signed `tasks.result` call to the host.
  4. The host readies the wait, and the host job wakes with the typed result.
- **Loop control** (R3): lineage and depth are checked at the gateway, the only place that sees both apps.

### 4.3 Registry, skills, packages (F4–F7, R5, R6)
- **Tables**:
  - `neos.registry_entries(key, version, kind, owner_app, requires, offers, body, artifact_hash, author_sig, platform_sig, status)`
  - `neos.registry_artifacts(hash, bytes)`
  - `neos.registry_reviews` (desk review of a diff, fingerprint-bound)
  - `neos.registry_installs(company, host_app, entry_key, pinned_version)`
- **Publishing**:
  1. The author submits with its signature (HMAC of the app's service secret over the content hash, proving the owner app).
  2. The platform opens a review card showing the diff against the last published version.
  3. A person's yes on that fingerprint leads to a platform co-signature (Ed25519 over `sha256(JCS{key, version, kind, body, requires, artifact_hash})`) and status `published`.
- **Versions**: an entry cannot be retired while any pin is live, unless 30 days have passed since deprecation. A requirement added in a new version does not move pins until an admin re-pins.
- **Borrowed skill install**: an admin pins it for a host app. The platform writes the ACL rows its `requires` need, in one transaction and audited, with no deploy. At spawn, the host fetches its company's pinned skills, verifies the platform signature offline, and loads a skill only when every requirement is on.
- **Package install**:
  1. The platform migration runner creates the role `<host>_nep_<name>` and runs the package migrations in the host schema. The tenant lint applies.
  2. The host app role gets `SELECT` only.
  3. The host unpacks the artifact by hash into `var/packages/<key>@<version>/`.
  4. Each sandbox start re-hashes the files and refuses on mismatch.
- **Sandbox** (D5): one long-lived `deno run --no-prompt` per package version.
  - The code is loaded as a data: URL, so there are no `--allow-*` flags: no network, no filesystem, no environment, no subprocesses (verified).
  - `--v8-flags=--max-old-space-size=256`. A call over 10 s kills and restarts the sandbox, and the call fails.
  - RPC is JSON lines over stdio. The package reaches `ctx.book.step`, `ctx.book.fact`, `ctx.tables.{select, insert, update}` (its own tables only, run by the host as the package role with company RLS) and `ctx.doors.<granted>`.
- **Trade-off**: Deno adds a ~40 MB binary and ~50 ms cold start per package version (warm afterwards), in exchange for OS-enforced permission flags. isolated-vm would be faster but has no I/O model (D5).

### 4.4 Reliability and operations (F8, R9–R13)
- **Keyrings** (R10): gateway keys `[{kid, key, state: active|previous|retired}]`. The JWKS lists active + previous. `rotate()` makes a new key active; the previous one is retired after 2 × token TTL. Job-token and service secrets accept a list, and the first entry signs.
- **Vault** (R9): `{v:1, kid, iv, tag, ct}` with AES-256-GCM. `rekey()` re-encrypts under the active key.
- **Outbox ack and prune** (R11): the platform calls `outbox.ack` with the cursor it committed; the app deletes acked rows older than 7 days.
- **Tracing** (R13):
  - One trace id per request. The gateway starts it, L3 stores it on the job, and the runner passes it into the bundle. The agent sends `traceparent` to the gate, and gate operations record it.
  - Spans are exported as OTLP/JSON to `OTEL_EXPORTER_OTLP_ENDPOINT` when set, and are no-ops otherwise.
- **Metrics**: `/metrics` in Prometheus text.
  - Counters and histograms kept in process: ack latency, gate decisions, execute outcomes, proxy spend.
  - Gauges read from the database at scrape time: jobs by status, open waits, pending approvals, dead letters.
  - A Grafana dashboard JSON is in `deploy/observability/`.
- **Backups**: per-schema `pg_dump`, plus a per-company logical export/import. That is every table carrying `company_id`, in foreign-key order, restored under that company's RLS setting so no other company is touched.
- **Load and chaos**: `pnpm test:load` runs 200 concurrent asks against one app (ack p95 asserted < 300 ms) and 50 forced backend restarts during work (every task terminal exactly once, no duplicate operations). The default suite runs a small version of both.

## 5. Trade-offs we accept now, and what to revisit
- **Postgres for everything** (queues, metering, registry artifacts). It is simple and transactional with the book. Revisit if artifacts exceed ~50 MB or the proxy's settle rate saturates writes; move artifacts to object storage keyed by the same hash.
- **Synchronous borrowed reads** add latency to the host job; there is a 10 s timeout and a refusal on error. Revisit with caching only for idempotent, versioned reads.
- **One sandbox per package version**, not per call: faster, but a package keeps state between calls. Handlers must be written statelessly; restarts happen on timeout and every 1,000 calls.
- **Proxy reservations are pessimistic**: a job near its cap may be refused a call that would have fit. That is the right direction for money.
