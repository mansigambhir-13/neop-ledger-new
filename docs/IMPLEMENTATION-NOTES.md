# Implementation notes

Where this build fills a gap in the plan, interprets it, or departs from it.
Each item is small; flag any you disagree with.

## Blocking findings: how each is enforced
- **B1 tenant isolation** — `company_id NOT NULL` + forced RLS on every business table; the company comes only from a verified gateway or job token (`withCompany`). The migrator's tenant lint refuses a migration that breaks this. `tenant.test`.
- **B2 wake order** — `proposals.resolve` with a yes sets APPROVED and does **not** ready the wait; only `executeProposal` (DONE/FAILED/UNKNOWN) or a non-yes answer / expiry readies it. `wake-order.test`.
- **B3 approvals worker** — `neos.approvals` is a state machine (PENDING → RECORDED → RESOLVED → EXECUTED, or CLOSED/EXPIRED/REFUSED) driven by a leased, retrying worker. `wake-order.test` crashes it between resolve and execute.
- **B4 one front door** — every L3 call (including `inbox.deliver`) is a gateway-signed, single-use EdDSA token; results travel as typed outbox events, never scraped from a room. `inbound-auth.test`.
- **B5 prompt** — the starter prompt says the assistant never carries out an approved proposal; it verifies the proof. There is no execute tool.

## Interpretations
1. **Claims live on `jobs`** (`claimed_by`, `claimed_until`) and are taken with `FOR UPDATE SKIP LOCKED`; ready waits are stamped with the same claim. Semantics match the plan (one runner wakes a job once).
2. **Two infrastructure tables** beyond the eight: `schema_migrations` and `seen_tokens` (single-use jti). Both are exempt from the tenant lint.
3. **The card is part of the ask-first call.** Ask-first tools take a required `card {what, why, changes, if_no_answer}` argument; the gate strips it before fingerprinting, so the fingerprint covers only what would happen.
4. **`card.raise` does not block.** It posts a heads-up or question to the conversation. To ask before continuing, the assistant finishes with `needs_input`; the person's reply is a new task.
5. **A read set to ask-first behaves as on.** Reads have no effect to approve. *Decision needed:* should the platform refuse `ask_first` for reads?
6. **Company name and time zone** reach the app on the switchboard fetch (the only platform data the gate already reads).
7. **Switchboard changes are pushed** as a signed `switchboard.changed` call, plus `sb_version` on every token and a 30 s TTL.
8. **Migrations are run by the platform's migration runner** (`migrateApp(adminUrl, app)`); app backends hold only their app and runner roles and never run DDL.
9. **Idempotent resolve.** Repeating the same decision against the same fingerprint returns 200 without change.
10. **`attempts`** counts only interrupted sessions (re-claims of a RUNNING job); after 5 the job fails honestly.
11. **Model errors** that retrying cannot fix (401/403/invalid key) fail the job immediately; others release the claim for a retry.
12. **Platform runtime role** is `neos_app` (the plan says `neos_platform`); same privileges.
13. **Contract-Version** is `1`.

14. **Room asks become task rows.** The bridge maps the sender to a person, writes a `neos.tasks` row (origin `room`) and hands it over as a signed `inbox.deliver` carrying that task id, so rooms and the NEOS app share one task store and one result path.
15. **Execute is serialised by liveness, not a timer.** The executor holds a Postgres session advisory lock for the whole effect. While it lives, a concurrent execute gets `409 in_progress`. If it dies, its connection closes, the lock frees, and the next attempt resumes at once, reading back first. The outcome is written once, under a row lock. (A 60-second staleness timer was tried first; chaos testing showed approvals stuck for minutes under repeated restarts.)
16. **Outbox consumption is exclusive and resilient.** Each pull holds the app's cursor row; a failing event is parked in `neos.outbox_dead_letters`, never dropped silently.

17. **The agent is keyless** (R1). The runner obtains a platform-signed, budgeted session token per session; the LLM proxy holds the provider key, reserves the worst case before each call and settles real usage. The agent's own cost report is informational.
18. **Two migration streams** (R2): template `t###` and app `###`, both tracked in `schema_migrations`.
19. **Gateway keys rotate in three phases** (publish → activate → retire); apps trust a fetched JWKS for 60 s. Registry co-signatures use a separate long-lived keyring so key rotation never invalidates published entries.
20. **Borrowed reads** go through the gateway as `app:<host>`; effective setting = strictest(host floor from `uses`, host company setting, owner setting); without an ACL row it is off. Borrowed **writes** are never direct: they are a2a tasks.
21. **a2a tasks** carry `lineage`; a target already in the chain, or depth > 3, is refused at the gateway. Four-eyes follows the chain to the person who started it.
22. **Packages** run in one Deno process per package version with no permissions; the host serves `ctx.tables` (own `nep_<name>_*` tables, as the package's role, company-scoped), `ctx.book`, declared doors on the approved path only, and `ctx.reads[<key>](args)` — the host's own **reads** listed in the manifest's `requires` (never writes, never another app's), refused while the company has that read switched off, input/output checked like the gate checks them, and recorded as a step with its basis. A door's definite refusal stays definite across the RPC. Package writes may export `normalize` and `validate` (run at the gate, no doors). Artifacts are content-addressed and re-verified before every call.
23. **Reads cannot be ask-first** (R7); **approver policy** per ability (roles, four-eyes) is set by the company (R8).
24. **The ack hot path is load-tested:**
    - The gateway makes two round trips: checks plus ledger row in one statement, then ledger result plus audit.
    - The app opens a job in one statement: job, first step, mirror, ack and hint.
    - **What the load test asserts** is the plan's metric, the app's own ack time (the `neop_job_ack_seconds` histogram): at 200 concurrent new jobs, the p95 bucket ≤ 300 ms (`apps/ledger/load/phase6.test.ts`). It does not assert anything tighter.
    - **End to end through the gateway it misses the plan's 300 ms for a simultaneous burst of 200.** Measured on the real Docker topology (`neops-v3`, 26 Sep 2026, laptop, Docker Desktop, 10 CPUs):
      - one ask: 12–20 ms; 10 at once: p95 39 ms; 50 at once: p95 159–237 ms; 100 at once: p95 248–504 ms; 200 at once: p95 369–735 ms (every ask acknowledged).
      - The app's own share (L3 `tasks.open`, `neop_job_ack_seconds`) is small: p50 10 ms, p95 48 ms. The gateway call: p50 23 ms, p95 60 ms.
      - The rest is the platform queueing a burst: before the gateway (auth, conversation, registry context, task row) p95 ~260 ms, and HTTP handling before the ask's span starts.
      - Tried: registry context projected in SQL (kept); platform pool 20 → 60 plus PgBouncer 60 (no clear change); `synchronous_commit = off` (no clear change, reverted). Noise between runs is ±150 ms on this machine.
      - **Open:** profile the platform process under a burst on production-like hardware; likely levers are fewer round trips per ask (fold auth, conversation and task row into one statement) and running more than one platform process behind the load balancer. The in-process load test only bounds it (< 1 s).
25. **Shutdown is bounded** (2 s). Anything still in flight is abandoned as a crash would abandon it: connections close, advisory locks release, and the book lets the next process resume.
26. **Ledger's writes check the books before anyone is asked** (template `validate` hook). An unknown customer, overpayment, duplicate bill, locked month, double reversal or unreconciled month is refused at the gate, with no card raised.

27. **Real providers.** Email uses Resend (`provider: resend`); GSTR-3B uses a GST Suvidha Provider (`provider: gsp`, `doors/gsp.ts`); other doors use a generic HTTP adapter (`provider: http`). Every effect is written to `door_journal` first. See ADR 0012 and item 52.
28. **Pre-ship review fixes** (all have regression tests in `security.test.ts`):
    - the vault lends only to installed apps, for doors they declare
    - money abilities are always measured; grants never auto-approve an unmeasured amount
    - recipients are resolved before proposing
    - bank lines are locked when posted
    - people cannot open jobs directly, and four-eyes fails closed
    - one sandbox per company and package version, with unguessable call ids
    - documents carry the company's name
    - outbox events are scoped to their app and company
    - notes carried between jobs are untrusted
    - bank import is ask-first
    - metrics need a token
    - the event stream uses 5-minute tokens
29. **The database cannot be wedged by a dead process.** Every pool has connect, statement, lock and idle-in-transaction timeouts. Shutdown force-closes what it abandons, releasing row and advisory locks, as a crash would.
30. **A failed hand-off to the agent pool is not an interrupted attempt.** The job backs off one second instead of burning its retry budget.

31. **Production fails closed on credentials.** With `NEOS_ENV=production` (set in every image), a missing role password or admin URL stops the process instead of falling back to the known dev value. Package roles (`<host>_nep_<pkg>`) are created at install time, so their passwords are HMAC-derived from `NEOS_PKG_PW_KEY_<HOST>`: the migrator holds every host's key, each backend only its own.
32. **Desk tokens are hashed at rest** (`neos.users.token_hash`, migration 008). A leaked row or backup logs nobody in.
33. **Bootstrap has a tool.** Registering an app, the first company, its first admin and the install happen before any admin exists to call an API, so they are `scripts/ops.ts` commands run in the platform image.

34. **The console is designed from the plan, not from the old app** (`docs/CONSOLE-DESIGN.md`). Work (Today, Jobs, Approvals) and Govern (Switchboard, Standing yeses, Doors, Packages, Apps, Audit) come first; Books is the subject. Every figure carries its source line. It is a BFF + static UI in its own container that reaches only the platform's person-facing API.
35. **Company rules are validated where they are saved.** One shared check (`@neop/contracts` `rulesProblem`) runs in the platform when an admin saves the switchboard and in the gate when it loads it; a malformed rule used to be stored and then fail every job.
36. **Package abilities are switchboard lines.** An installed package's abilities (from the registry entry's `offers`) can be tightened per company like the host's own, never below the package's floor. *(v3 S7: the lines come from the host manifest's `packages`, written by `neos install` at build time.)*
37. **Governance surfaces:** list/create/withdraw standing yeses (admin-only withdraw, audited; money needs a cap; expiry ≤ 1 year), who may ask Ledger (ACL list), the audit trail (paged, filtered, named), the registry catalogue (offers, requires, signature, pins), switchboard history, assistant spend against caps, and a job's full record (approvals with who and fingerprint seen, proof, cost, standing-yes uses). A reconciled UNKNOWN now updates the desk's proof.
38. **LLM proxy speaks to OpenRouter too:** `NEOP_LLM_UPSTREAM_AUTH=bearer` and `NEOP_LLM_UPSTREAM_MODEL_PREFIX=anthropic/`; pricing and caps stay on the agent-facing model id.

39. **Screens are blocks; the desk is the platform's.** Blocks are validated at registration (reads only, effects only as asks, no markup) and drawn by one renderer in the platform-owned desk, which is multi-app. Ledger ships no UI code. (`contracts/src/blocks.ts`, `platform/src/web/`.)
40. **Bookkeeping logic stays in the app.** The home figures and the close checklist are Ledger reads (`ledger.home.summary`, `ledger.close.checklist`), not screen code.
41. **Skills are switchboard lines** (`skill:<key>`, on/off), dropped at spawn when off or when a tool they need is off.
42. **Uninstall disables a package and keeps its tables**; the platform tells the app at once (`switchboard.changed` also drops the package cache). *(Superseded by v3 S7: there is no run-time install or uninstall; `neos install --remove` takes a package out of the build and keeps its tables.)*
43. **PgBouncer in transaction mode** for query pools; LISTEN and the execution lock use a direct connection (`NEOP_DIRECT_DB_URL`); statement/lock/idle timeouts are role defaults set by the migrator.
44. **Listeners bind per network.** L3 only on the l3 network (`ledger-l3`), the gate only on the agent network (`ledger-gate`), the agent only on its backend's network (`ledger-agent-rpc`). Register apps by the l3 alias. A runtime probe checks every row.
45. **Rooms can be re-bound** without losing history (old room retired, migration 010); admins bind rooms and link chat identities over the API; the bot registers in the appservice namespace and joins before it speaks.
46. **Reports always cite sources.** If the assistant does not list them, `job.finish` fills them from the reads the job made (each read step records its basis).
47. **Borrowing ranges are checked at registration, both ways.** A `uses` entry must name a read at a version in its semver range; an owner cannot re-register in a way that breaks a borrower. An owner not registered yet is checked when it registers, so deploy order is free.
48. **Every migration is listed in `migrate.json`** (`{file, tables, baseline?, proven_on_populated_data?}`), in order. The first release's files are `"baseline": true`: they were applied to empty schemas, so they claim no proof (the earlier `proven_on_populated_data` strings on them were self-attested and are gone). Baseline files must come first and may not claim proof. In production every non-baseline file must carry `proven_on_populated_data`. An unlisted, missing or out-of-order file is refused before anything runs.
49. **The `neop.v1` bridge to today's NEOS platform** (`docs/pilot-ledger-integration.md`): the descriptor is generated from the manifest; reads, `ledger.ask` and `ledger.job` are capabilities; `ledger.proposal.decide` is human-gated and never dispatched; every operation token is verified claim by claim against the exact body and burned.
50. **Every output schema is closed** (`additionalProperties: false` at every level), so results can be validated strictly by the platform and a new field is a deliberate, versioned change.
51. **The desk is a test harness** (compose profile `test`, refuses production); the product UI is the NEOS app.
52. **Expand then contract is enforced, not advised** (`pgkit/migrate.ts`). A pending non-baseline migration containing DROP TABLE/SCHEMA/COLUMN, TRUNCATE, RENAME, ALTER COLUMN … TYPE, SET NOT NULL, or ADD COLUMN … NOT NULL without a DEFAULT is refused, before any file in the run applies, unless it carries `-- contract: <reason>; expanded by <earlier file>` naming an earlier migration in the same stream. The check is textual (comments ignored), so a false positive is resolved by a real contract marker, never by a bypass flag.
53. **The tenant lint reads each policy.** Every permissive RLS policy on a business table must be keyed `company_id = current_setting('neos.company_id' …)` in USING (and WITH CHECK when present), with no OR. `using (true)`, another column, or a second loose permissive policy (they OR together) fails the migration. Restrictive policies may add conditions.
54. **Nightly per-schema backups run** (compose `backup`, `scripts/backup.ts schedule`): `pg_dump -Fc` per migrated schema (neos + each app) plus one JSON export per company per app, sha256 in a manifest, retention by run count, pruned only after a complete run. It sits on the db network only. One schema restores with `pg_restore --clean --single-transaction --schema`; one company with `importCompany`. Both are proven in `backup.test` (the dump test needs pg_dump 17; CI installs it) and live in compose.
55. **Egress is an allow-list.** The LLM proxy and backends are on internal networks only; their only way out is `egress-proxy` (tinyproxy, exact host names from `NEOS_EGRESS_ALLOW`, CONNECT to 443 only). Node 24 sends `fetch` through it with `NODE_USE_ENV_PROXY=1`; stack-internal names are `NO_PROXY`. Node tunnels plain `http://` with CONNECT as well, so a non-443 upstream needs `NEOS_EGRESS_PORTS` (the chaos overlay's fake provider uses 4900).
56. **Backend metrics have their own listener.** The scraper must not join the gateway-only `l3` network, so the backend relays `/l3/metrics` (same bearer token) on `METRICS_HOST` (the `ledger-metrics` alias on the telemetry network) and answers nothing else there.
57. **The dedicated-DB tier (D2) is a configuration, not a fork.** `gen-secrets --dedicated <app>=<host>[:port]` points that app's roles, direct URLs, PgBouncer entry (`neos_<app>`) and admin URL (`pg_admin_url_<app>` → `NEOS_ADMIN_URL_<APP>` for the migrate runner) at its own cluster; the platform stays on the shared one.
58. **Chaos is also run live** (`scripts/chaos-live.sh`): `docker kill -s KILL` on real containers (backend repeatedly, the agent and the platform once each), checked from the platform API and the provider's own send count. The in-process chaos tests (`chaos.test`, `pnpm test:load`) stop the backend in-process; only the live run kills processes.
    - **Measured (2026-09-26, 100 asks, 50 SIGKILLs: backend ×48, agent ×1, platform ×1, fake provider):**
      - **Kills every ~5 s** (`CHAOS_INTERVAL_MS=10000`): 0 lost, 0 duplicate results, 49/49 approvals executed exactly once, and 49 emails sent for 49 keys.
        - 99 tasks COMPLETED. One (a gated job) FAILED honestly: the assistant hit its session cap after repeated resumes, and no card was raised.
        - **This is not the plan's "every task completes".**
      - **Kills every ~1.7 s** (`3000`): 0 lost, 0 duplicate executions (46 emails, 46 keys), but only 92 COMPLETED.
        - 6 tasks FAILED at the platform: `tasks.open` gave up after its 8 delivery attempts (1 s → 60 s backoff) while the backend was down almost continuously. Those 6 never reached the app.
        - 2 more FAILED on the session cap.
      - **Fixed since:** `tasks.open` delivery now retries for a time window (default 10 minutes, `timings.taskDeliveryWindowMs`) instead of 8 attempts, and fails at once only on a definite refusal (a 4xx other than 408/429). Proven by `task-delivery.test.ts`. The two session-cap failures remain: a job resumed again and again under repeated kills can exhaust its session cap and end FAILED with that reason.
59. **Vault secrets are encrypted at rest** (`packages/platform/src/vault.ts`): AES-256-GCM envelopes tagged with a key id (`NEOS_VAULT_KEYS`, the `vault_keys` secret); adding a key and making it active re-encrypts every secret at boot. They are still lent per call and audited.

52. **GSTR-3B through a GSP (nep-gst 2.0.0).** What is real and tested (`gst.test`, `gst-package.test`, `registry.test`):
    - **Figures from the books.** `gst.gstr3b.prepare` takes only the month; it reads `ledger.report.vat_summary`, `ledger.report.pnl` and the tax accounts through `ctx.reads`, and its input schema refuses typed-in amounts. Each read is a step with its basis; the output tax, ITC, taxable value and split are facts with their source.
    - **The GSTN GSTR-3B document** (`gstin`, `ret_period` MMYYYY, `sup_details` 3.1, `sup_inter` 3.2, `itc_elg` 4 with `itc_avl`/`itc_rev`/`itc_net`/`itc_inelg`, `inward_sup` 5, `intr_ltfee` 5.1), rupees to 2 decimals from paise, validated against `registry/nep-gst/gstr3b.schema.json` (the handlers embed the same schema; a test checks it, and Ajv plus the fake GSP's independent GSTN checks agree).
    - **Tax heads.** Read per head from the books when every tax account names IGST/CGST/SGST/cess (must add up to the VAT summary). Ledger's standard chart keeps one output and one input account, so it **cannot** distinguish; then the door's `assume_supply` (intra_state → CGST = SGST, odd paisa to CGST; inter_state → IGST) applies and is stated on the return, the card and the facts. No assumption configured → prepare refuses. Also assumed and stated: taxable value = revenue; zero-rated/exempt/non-GST/reverse-charge, imports/ISD/reversals/ineligible ITC, the 3.2 place-of-supply table, interest and late fee are 0.
    - **GSP flow** in the door: OTP login (OTPREQUEST → a person enters the OTP on the `gst_portal_otp` vault slot → AUTHTOKEN), token refresh and re-login on auth errors, RETSAVE → RETSTATUS, RETSUM read-back compared figure by figure, RETSUBMIT → RETFILE with EVC (`sid` = PAN|OTP) → ARN, RETTRACK read-back. Tokens live only in backend memory per company; OTPs are never in a tool result or the database, and a used OTP is not replayed. Paths and extra headers are configuration.
    - **Filing is ask-first and bound to the saved document:** `normalize` puts the saved return's id, figures and sha256 into the proposal, so the fingerprint covers what is filed; execute refuses if the saved return changed or the portal's copy differs; a month already on RETTRACK is never filed again; a filed month cannot be proposed again.
    - **Faults tested against the fake GSP:** auth expiry → refresh → retry; refused refresh → new OTP, definite failure; 4xx validation → FAILED, nothing saved; filing answered 503 with an outage → UNKNOWN → reconciled by RETTRACK → DONE, filed once; filing that times out → read-back confirms, not re-sent.
    - **The person's OTP goes through the vault, not the desk card.** The desk answer carries only decision/fingerprint/feedback and feedback is shown to the model, so an OTP cannot travel there. Until the desk gains a write-only "door input" on a card (a platform change), the admin enters it on `PUT /api/vault/gst_portal_otp`. The console's door form (`platform/src/web/public/app.js`) still offers the old `http` GSP fields and needs the `gsp` fields.

60. **Input waits (WP §8 `ask`/`answer`, §14).** The assistant asks with the builtin `job.ask` {text, why, fields[{key, label, type?, required?}], due_in_hours? (default 48, at most 336)}: the gate writes an `input` wait carrying the question (t005), sets the job WAITING, emits `question.asked` and ends the session. Only the platform may call `POST /l3/waits.answer` {wait_id, answers, answered_by, via}; the app checks the wait is open and the answers cover the required fields and match their types, marks it ready (idempotent on the wait: the same answer again returns `idempotent: true`; anything else on a closed or expired wait is 409 `stale`), writes one sourced fact per field (`answer:<key>`) and a step, and wakes the job. An unanswered question is expired by the runner's expiry loop and wakes the job to say so. **Trust:** an answer given by a person for themselves (`via` desk / conversation / chat, `answered_by user:<id>`) is shown to the assistant as the person's words; one relayed by a bridge, the reasoning agent (the NEOS v1 `<app>.answer`) or anything else is wrapped as untrusted data, and its words are kept out of the step list. `job.finish` with `needs_input` remains only for when asking is impossible.
61. **Questions on the platform** (migration 014, `neos.questions`) are the projection of `question.*` outbox events. A question is put to the person the chain started from (`asked_of`, `root_task_id`): the requester, or for an a2a hand-off the person the calling app worked for. The task goes to `NEEDS_INPUT`; the root conversation gets the question. `GET /api/questions`, `POST /api/questions/:id/answer` (signed gateway call to `waits.answer`; `waits.answer` and `jobs.transcript` are platform doors — an app is refused at the gateway and at L3, so **the calling app never answers for a person**). On the Matrix client road the question is the one reply in the DM it was asked from, is posted into the asking person's own DM (also when a bridge asked, or when the job came from the desk), and a reply to that notice answers it: a person's as their words (`answered_via chat`), a bridge's as relayed data (`answered_via bridge`). An answer is never a yes.
62. **A follow-up continues the job (WP §8 thread correlation).** `/api/ask` with a `conversation_id` whose last task (or an app it handed work to) waits on an open question: the text is the answer (a question with one field takes the whole text; otherwise `key: value` lines) and no new job is opened. Otherwise the follow-up stays with the same app — no re-routing — and carries `parent_job_id` of the last job to `tasks.open`; the new job's bundle shows the parent's ask and report (as data) and the parent's facts first. A parent that is not a job in the app's book is not followed.
63. **on_behalf_of (WP §9).** `tasks.open` carries the person the work is for: the requester for a person's ask, the chain's root person (platform `rootRequester`) for an a2a hand-off. It is stored on the job (`jobs.on_behalf_of`, t005) and shown in the bundle ("Asked by app:marketing (a2a) on behalf of user:…"). A person asking cannot name someone else.
64. **Withdraw — the rule.** The proposal state machine (`domain/proposals.ts`) allows `PROPOSED → WITHDRAWN` and `APPROVED → WITHDRAWN`, never `EXECUTING → WITHDRAWN`. So the desk allows it too: a person may withdraw a PENDING card (it closes and the job wakes to say so), **and a yes that has not started to be carried out** (desk card RECORDED/RESOLVED). The app decides under the proposal row lock that execute also takes, so exactly one wins: if the withdrawal wins, execute finds WITHDRAWN and does nothing; if execution has begun (EXECUTING) or finished, the withdrawal is refused with 409 `too_late` and the yes stands. The platform worker's own state changes are conditional on the state it expects, so a card withdrawn mid-drive ends CLOSED/withdraw, not REFUSED. (`input-waits.test` › withdraw.)
65. **facts.valid_until (t005).** A fact may say until when it holds (`book.note` facts accept `valid_until`); after it, the bundle leaves the fact out (database time). The fact stays in the book — nothing is deleted or rewritten.
66. **The job transcript is kept for audit (WP §12).** At the end of every session the agent worker sends its raw transcript (system prompt, model inputs and outputs, tool calls and results; over 2 MB keeps the first and latest messages and says so) to the gate, which stores it in `<app>.transcripts` (t005, company_id + RLS, append-only). The platform reads it with the platform-only `GET /l3/jobs.transcript`; admins with `GET /api/tasks/:id/transcript` (audited). It is never put in a bundle: the rolling summary in steps remains the assistant's only memory.
67. **NEOS v1 bridge:** `<app>.job` also lists the open questions (wait_id, text, why, fields, due_at) and `<app>.answer` {job_id, wait_id, answers: [{key, value}]} (scope `<app>.ask`, not gated) answers one, so NeuralChat's `needs_input` → answer works today. The answer is recorded as relayed by the reasoning agent (`agent:neuralchat:user:<act>`), i.e. untrusted data for the assistant; a conflicting answer is 409 `conflict`.
68. **WITHDRAWN 2026-09-28 (v3 conformance B1, below): a bridge never approves.** Kept for the record. **A bridge's go-ahead on the Matrix client road (opt-in per bridge; Shivam's review, option 2; 2026-09-27).** Without it nothing gated could be approved from NeuralChat in production (the platform-side decide route does not exist yet). The accepted rule: *accepted only for bridge senders, under the same fingerprint and expiry rules* as a person's yes.
    - **Contract (NeuralChat, neos-agent-neuralchat #143, `reasoning/matrix_neop.py`).** The reasoning agent sends plain `m.text` (never a reply) to `@ledger`, ≤ 4 000 chars, and reads the one `m.notice` threaded to it by `m.in_reply_to` within 60 s (≤ 8 000 chars). Approval happens in its chat: Ledger proposes and asks "Shall I go ahead?", NeuralChat asks its user, and only in a run resumed by the user's own answer accepting that exact change does it send a free-text go-ahead ("Go ahead with the ₹500 expense.") — no card id, no fingerprint (`test_neop_go_ahead_consent.py`).
    - **Grant (migration 016).** `neos.chat_allowlist.may_approve boolean not null default false`, with a check that a may-approve row is a bridge with `acts_for`. Only an admin writes it: `PUT /api/chat/allowlist {…, kind:'bridge', acts_for, may_approve:true}`; a person entry or a bridge without `acts_for` is 400; a member is 403; audited `chat.allowlist_set` with `may_approve` in the detail. Any PUT that leaves `may_approve` out writes false. It is read live on every message: a revoke is instant.
    - **The proposal a may-approve bridge is shown** (the one reply to its ask when the job raises a card): what is proposed (card `what`, `changes`), the money amounts from the args (`Amounts: amount ₹500.00`), the card id and expiry, "Nothing is done yet. To drop it, say no." and last "Shall I go ahead?". It is recorded as an outbound card row with the fingerprint shown. Other bridges keep today's wording ("awaits a person's approval — a bridge cannot approve it …").
    - **Accepted only when ALL hold** (`client-sync.ts` `goAheadByBridge`), else ONE reply says exactly why and what to do, audited `chat.bridge_go_ahead` `refused:<reason>`, and no job is opened:
      (a) the sender is an allowlisted bridge with `may_approve` and `acts_for` a person of the company (`no_person`);
      (b) **bound**: a reply to the card notice in this bridge's own DM, or a plain message while that DM is AT the card — the latest thing Ledger said there is the card notice (`latestSaid`, the same rule that binds a plain answer to a question). Moved on, or a reply to anything else while a card shown here is pending → `not_bound`. A card shown in another DM is never reachable. A text with no pending card ever shown in this DM is not a go-ahead attempt: it is an ordinary request;
      (c) the card is PENDING (`not_open`), not expired (`expired`), and its fingerprint is the one recorded when it was shown in this DM (`changed`);
      (d) the text is a clear affirmative by `GO_AHEAD_LEXICON` (documented constant): an affirmative (yes, yeah, yep, go ahead, proceed, approve(d), confirm(ed), do it, ok/okay, sure, carry on, apply it) and **no** hold word (no, not, don't/do not, any "…n't", cancel, stop, hold, wait, later, never, decline, reject, drop, and "change" used as a request to change: "change:", "change it/the/to …", "with/some changes"). "Go ahead with the ₹500 change." is a go-ahead. Affirmative + hold is ambiguous: not a go-ahead, handled as an ordinary request (as before);
      (e) every number in the text is on the card — its words, its exact args, and every `*_minor` amount in major units — after normalising ₹/Rs/INR, commas, Indian grouping and decimals ("₹500" = "₹500.00", "50,000" = "₹50,000.00"); the card's own id and fingerprint are not numbers of it; a number glued to a letter still counts ("₹5k" is 5). Otherwise `amount_mismatch`: "that does not match the change I proposed …";
      (f) `platform.answer()` as the acts_for person, decision `yes`, `fingerprint_seen` = the shown fingerprint: the same approver roles and four-eyes as the desk (`not_an_approver`, `four_eyes`, `stale_fingerprint`, `not_open`).
      Accepted: recorded as decided by that person with feedback "approved via <bridge> on behalf of <name>", audited `recorded_yes`, and the one reply is sent when the job's resumed result settles (the same owed-reply machinery and deadline as any message) and states what was done.
    - **Declines are unchanged:** every allowlisted bridge's clear decline, as a reply to the card or naming its id, is the person's no. A bridge without `may_approve` keeps today's refusal ("Nothing was done: a bridge cannot approve …").
    - **Deadline:** `MATRIX_REPLY_DEADLINE_MS` defaults to 55 000 (under NeuralChat's 60 s), configurable; `deploy/compose.chat.yml` defaults to the same.
    - Tests: `apps/ledger/tests/matrix-go-ahead.test.ts` (the flow, every refusal, four-eyes and roles, another DM, the decline, the API, a live revoke, migration 016 on a populated database).
69. **A bridge's plain message answers a question only with explicit pairs (found live with a NeuralChat-shaped simulator).** NeuralChat keeps one DM for all its tasks, so its next unrelated request ("Transfer ₹10,000 to Kapoor Traders right now.") arrived while a one-field question was open and was swallowed as the answer. Now, for a bridge, a plain (non-reply) message answers the question the DM is at only with `key: value` (or `label: value`) pairs; the whole text answers a one-field question only for a person in their own DM, or for a bridge's reply threaded to the question notice. The notice keeps its "Reply … as key: value" instruction.
70. **v3 §8 typed events (2026-09-28): an additional, stricter road on both Matrix roads; the plain-text road is unchanged.** `packages/contracts/src/matrix-events.ts` holds the shared part (so a runner can take it over later): the seven types `neos.neop.task|ask|answer|propose|approve|done|note`, a JSON Schema per body exactly as v3's table (`propose` carries the card as `text`; `additionalProperties: false`, checked by a dependency-free validator), the sender-class rule (`TYPED_SENDERS`: person → task/answer/approve · agent → task/answer · neop → task/ask/answer/propose/done/note), thread helpers (`m.relates_to` `rel_type: m.thread` rooted at the task event) and the room checks. `packages/platform/src/bridge/typed.ts` maps them; `client-sync.ts` (DMs) and `bridge.ts` (appservice rooms) each supply a thin road adapter. No migration: records live in the existing `chat_client_events` / `room_events` (outcome `typed:*`, outbound rows keyed by `typed:<kind>:<id>`), audit in `neos.audit` (`chat.typed_in`).
    - **Who is writing.** Client road: the allowlist as before; a `bridge` entry whose id is in the apps' namespace (`@neop_…`) is class `neop`, any other bridge is `agent`. Appservice road: a linked person of the room's company is a `person`; otherwise a `bridge` entry on the allowlist for that company+app (same neop/agent split); anyone else is dropped (`unknown_sender`). The room's own app identity is ignored (our echo).
    - **In.** Deduped on `event_id` (the same insert-once row as the plain road), then: a type the class may not send → dropped `refused:<type>`; a body that fails its schema → dropped `invalid` (the audit row carries the validator's error); both audited, nothing sent back. `task` → `platform.openTask` as a person: a person only for themselves (`on_behalf_of` = sender), an agent/NEOP for the linked person it names, else its `acts_for`; `company` must be this install's id or slug. `answer` → `platform.answerQuestion` for a wait shown in this room/DM, only in the thread of its task when threaded; an agent/NEOP answers only a wait of a task it opened; answered as `bridge:<id>` / `app:<id>` (untrusted data to the job), a person's as their own words; a closed wait → a typed `note` back (`stale: …`, `step_id: stale-<wait>`). `approve` → **people only**, sending as themselves (whatever the allowlist grants a bridge — `may_approve` has no bearing here), for a card shown in this room/DM, in its thread when threaded, and in a room only when the room's power levels give them the approve level: `platform.answer()` with the fingerprint the event carries, so a stale fingerprint is refused by the book and the card stays open. `ask`/`propose`/`done`/`note` from another NEOP are recorded as information only (this app takes no work from them).
    - **Out.** Only in threads rooted at a **typed** `task` (a plain-text sender never receives typed events it did not ask for, so NeuralChat's DM and the room tests are unchanged): `note` "on it" once the job is acknowledged, then one per mirrored step (deduped by step id), `ask` for each open question, `propose` for each pending card (`proposal_id`, `fingerprint`, `expires`, the card text), `done` once (`task_id` = the SENDER's task id, read back from the audit row of its task). Each carries today's m.notice text as `body`/`msgtype`, and a deterministic txn id, so a resend is the same event. The client road's one m.notice reply to a typed event goes in the typed thread (`m.thread` + `m.in_reply_to`); the plain road's replies are byte-for-byte as before.
    - **Rooms (B7).** `createAppRoom` now joins first, reads the room state and refuses (409 `room_unfit`, nothing bound) a room that is end-to-end encrypted, not invite-only, lets everyone or the app/an allowlisted bridge reach the level of `neos.neop.approve`, or where the app cannot post its notices/typed events. `ChatBridge.createRoom` creates one right (private preset, no `m.room.encryption`, people at 50, app/bridges/NEOPs at 10, approve at 50); `scripts/matrix-setup.sh … room <app> <company> <@person…>` does the same as an admin. A transport without `roomState` (a test double) skips the check; `MatrixTransport` always reads it.
    - **Namespaces (A11).** The appservice registration (`scripts/matrix-setup.sh`, `deploy/appservice.yaml`) reserves `@neuralchat_.*` exclusively as well as `@neop_.*`, so nobody can register a look-alike of the reasoning agent. Appservice road only: the client road has no registration.
    - Tests: `apps/ledger/tests/matrix-typed.test.ts` (every type both directions on both roads, sender classes, stale fingerprint then EXECUTED once, invalid bodies, stale answer, thread correlation, redelivery), `apps/ledger/tests/rooms.test.ts` (E2EE / public / power-level refusals, room creation).

## WP v3 §11–§12: one database, where things live (2026-09-27)
- **Boot refuses a schema out of step (§11 step 8).** `startBackend` reads `<schema>.schema_migrations` (the migrator now grants SELECT on it to the app and runner roles) and compares names and sha256 checksums with the set this build ships: the template stream (`001_standard`, `t###`) then the app's (`###`), listed by the same pgkit code the migrator uses. Anything pending, unknown (applied but not shipped) or changed (checksum differs) → `SchemaMismatchError` naming each file; `apps/ledger/scripts/backend.ts` logs it as a `fatal` JSON line and exits **78** (EX_CONFIG). Package migrations (`nep-x@1.0.0/…`) are the registry's and are not compared. `apps/ledger/tests/boot-schema.test.ts`.
- **Source documents kept (§11 "files go to object storage keyed under the schema name; the row keeps the id").** `tasks.open` stores each attachment's bytes **before** extraction in the document store (`packages/neop-template/src/doors/documents/store.ts`) under `<schema>/<company_id>/<sha256>`, then writes `<schema>.documents_files` (template migration **t006**: company_id, RLS, sha256 → filename, type, size, store, stored_at, job; the app role cannot update or delete) and puts `document_id` on the job's fact. Backends: a local directory (default; compose mounts the `ledger-files` volume at `/var/lib/neop/files`) or any S3-compatible bucket (`NEOP_DOCUMENTS_BACKEND=s3`, fetch + a minimal AWS SigV4 signer, checked against AWS's published example and round-tripped live against MinIO). Ledger migration **006** adds `documents.source_document`; `ledger.bill.record` 1.1.0 takes `source_document` and refuses a sha256 the company never attached. `ledger.document.get` returns metadata, the bills that cite the file and a **10-minute download link**; the platform serves it at `GET /api/documents/<app>/<sha256>?exp&sig` to a signed-in person of that company, fetching the bytes from L3 (`documents.fetch`, platform-only) through the gateway. The link is HMAC-signed by the backend (key derived from its job-token secret) over company, file and expiry, and checked by the same backend. The model never receives bytes. `documents-kept.test.ts`, `document-store.test.ts`.
  - Purging a company (`ops.ts uninstall --purge`) removes kept files only where `NEOP_DOCUMENTS_DIR` is visible to the script; otherwise it prints the prefix to remove from the backend's volume (or bucket).
- **Personal data tagged (§11).** The manifest contract has `personal_data: [{table, columns[], subject_key}]`, validated by `personalDataProblems` at registration and at backend boot. Ledger tags `parties` (`name`, `email`, `gstin`; subject key `id`) — it holds no phone or address. `scripts/erase.ts find|export|erase` (also `ops.ts personal-*`) runs as the migrator under the company's RLS setting, touches only tagged columns, and writes `personal_data.export` / `personal_data.erase` to `neos.audit` in the same transaction. Erase is a dry run without `--yes`; it pseudonymises required text (`erased-<hash>`) and nulls optional columns, never deletes rows, so invoices, payments and journal entries keep their party and their money. `company-data.test.ts`.
- **Company-scoped uninstall (§11).** `ops.ts uninstall <company> <app> [--purge] [--yes]`: dry run by default (the rows per table that would go); `--yes` marks `neos.installs` removed (registry context drops it, the gateway answers `not_installed`); `--purge` first writes that company's rows as a JSON export (restorable with `backup.ts import`, plus a `pg_dump` of the schema when `pg_dump` is on PATH), then deletes the company's rows from every company_id table in the schema — template, app and `nep_*` package tables — children first, in one transaction as the migrator, counting before and after. `company-data.test.ts`.
- **Door credentials per (app, company) (§12).** Platform migration **015** adds `vault_secrets.app_key` (default `'*'` = company-wide; every existing row), backfills it, and makes `(company_id, app_key, door)` the key. The old `(company_id, door)` key constraint is replaced, not kept: no data is dropped, but a second app could never hold its own row under it, and the platform (its only writer) ships with its migrations. `lend()` returns the app's own key, else the company-wide one, never another app's; sealed secrets are bound (AAD) to company + app + door, company-wide rows keep their old binding so they still open. `PUT /api/vault/<door>?app=<key>` (installed app, declared door) or company-wide without `app`; `GET /api/vault` lists owners and dates. The console's door form defaults to "only for this app". `packages/platform/tests/vault-per-app.test.ts`.

## v3 conformance (2026-09-28)
What WP v3 §6, §11 and §13 ask of the standard tables, the DBA path and the standard tests. Template migrations **t007–t009** and Ledger **007**, all expand-only, each proven on a populated book by `apps/ledger/tests/v3-conformance.test.ts` › "t007 + t008 + t009 + 007 apply forward on a populated book" (named in both `migrate.json` files).
- **B3 · standard columns (t007).** `jobs.origin` — `inbox.deliver` passes the room event id, a schedule's job says `timer`, everything else its task id (`openJobAtomic`); `jobs.switchboard_version` / `switchboard_snapshot` — written by `Runner.spawn` from the board the session runs on (`EffectiveBoard.snapshot()`: the effective setting per line, the company's switches, rules, budget); `jobs.heartbeat_at` — `Gate.heartbeat`. `proposals.manifest_version` (the app manifest's version, at insert), `answered_at` (by `answer_proposal()`; a grant-approved proposal is answered at insert), `executed_at` (execute `finish`, any outcome), `verified_at` (finish or reconcile with outcome DONE — a read-back found it). `operations.request_checksum` / `result_checksum` = sha256 of the RFC 8785 canonical JSON (`@neop/contracts` `canonicalize`) of the args / the result or proof, and `reason` (why it ran: whose yes, switched on, borrowed from, served to) — for every writer: execute, direct writes, borrowed reads, reads served to another app. `waits.kind` gains `dependency`. Rows written before stay NULL.
- **B4 · transitions in the database (t008).** `<schema>.legal_transition(table, from, to)` holds the allowed sets, derived from the code: proposals = `domain/proposals.ts` NEXT (incl. APPROVED → WITHDRAWN on withdraw/cancel and UNKNOWN → DONE | FAILED on reconcile); jobs RECEIVED → RUNNING (claim) | CANCELLED (cancel) | EXPIRED (a timer job past `run_by`), RUNNING → WAITING | DONE | FAILED | CANCELLED, WAITING → RUNNING (claim with a ready wait) | CANCELLED; waits pending → ready | consumed (not opened, cancel), ready → consumed. BEFORE UPDATE OF status triggers refuse anything else with 23514 `illegal transition: <table>.status A → B`. An UPDATE that leaves the status alone always passes; INSERTs are not constrained (a proposal may be born APPROVED under a grant). The full suite runs green with the triggers on; no allowed set had to be widened.
- **A8 · NOTIFY triggers (t009).** AFTER triggers `pg_notify('neop_<schema>', 'wait:<job>' | 'job:<id>')` when a wait becomes ready (update or insert) and when a job is inserted — the channel `Runner.start` LISTENs on. The app code's own notifies stay; duplicate hints are harmless; the poll is the truth.
- **A3 · `answer_proposal()` (t009).** `<schema>.answer_proposal(p_id, p_fingerprint, p_decision, p_by, p_feedback)` — SECURITY DEFINER, owned by `<schema>_migrator`, `search_path` pinned, EXECUTE revoked from PUBLIC and granted to `<schema>_app` and `<schema>_runner` only. Forced RLS applies to the owner too, so the caller's `neos.company_id` still scopes it. It checks decision and person (`user:`), the idempotent repeat, open-ness and the legal transition, the fingerprint (a mismatch is kept as `answer_refused:fingerprint` and returned as `refused`, not raised, so the record commits), expiry; then writes the status, `decided_by`, `feedback`, `approved_via`, `answered_at`, the `answered:<decision>` event, the step (+ `step.mirror`) and `proposal.resolved` in the outbox, and for anything but a yes readies the wait and notifies. Returns `{status, idempotent, job_id[, refused]}`; raises `not_found:` / `not_open:` / `expired:` / `bad_request:`, which `proposals.resolve.ts` maps to the same HTTP errors as before.
- **A7/A9 · read-only mirrors (t009) — superseded by S1 below: these tables are now the truth.** (As first built:) `<schema>.switchboard(company_id, line, kind, floor, setting, caps, rules, version, updated_at)`, `<schema>.installs(company_id, status, matrix_user, updated_at)`, `<schema>.grants(company_id, grant_id, ability_key, limits, expires_at, status, updated_at)`: company_id + forced RLS, SELECT for the app role, DML for the runner. `data/mirror.ts` (`PlatformMirror`, the `SwitchboardCache` observer) writes a board whenever the backend loads a version it has not written (and deletes lines the platform no longer lists), marks the install `active` on a load and `not_installed` on a 403; `l3 switchboard.changed` now reloads the board before it answers, so the mirror is current when the platform hears "ok". A grant is noted when a grant lookup returns one. Limits: the platform does not tell the backend a grant's limits/expiry or a later suspension, or the company's Matrix name, so those stay NULL / as last seen — the platform remains the source of truth and nothing reads the mirrors to decide.
- **B5 · the DBA bundle.** `scripts/dba-bundle.ts <app> [--out file.sql]` → `renderDbaBundle` (pgkit `bundle.ts`): the checksum table, `familyBootstrapSql` (roles, options, role defaults incl. `search_path`, database grants — idempotent, no passwords), the schema and `schema_migrations`, each migration in its own transaction as the migrator with its ledger insert, and the SELECT grant `migrate` makes. It refuses a `.ts` data migration (run those with `scripts/migrate.ts`). It does not run the tenant lint — that is `migrate`'s and the DBA's review. Roles now get `search_path = <schema>` in `bootstrapFamily` too (app families only; the platform's `neos` family is unchanged).
- **B11 · views (Ledger 007).** `ledger.v_account_balances` and `ledger.v_ageing`, `security_invoker = true`. The reads were not switched (they already filter in SQL; switching changes nothing observable and would need its own proof).
- **Standard tests.** `schema-only.test.ts`, `sender.test.ts`, `honesty.test.ts` (generatedAt on every read), `v3-conformance.test.ts`, `dba-bundle.test.ts`. Two existing tests changed shape, not meaning: `migration.test.ts` lists the new files; `company-data.test.ts` takes the trial balance before its snapshot (a read loads the board, which the book now mirrors).
- **B1 · Only a person can say yes (v3 §5/§8/§16).** Decided by the user: nothing approves on a person's behalf — no
  exception, no flag. `client-sync.ts` never takes a bridge's go-ahead as a yes (`goAheadByBridge` and the
  `may_approve` read are gone): a clear consent from any bridge, when a card from its asks is open, gets ONE reply —
  "Nothing was done: a bridge cannot approve. I can't take a yes through NeuralChat. Please approve #<id> on your
  desk." — naming who can answer and re-showing the card (recorded with its fingerprint, so a following "no" binds),
  audited `chat.bridge_consent` `not_a_yes`; no job opens, nothing executes. A negated/ambiguous go-ahead ("don't go
  ahead yet") is an ordinary request. Declines are unchanged. `PUT /api/chat/allowlist` with `may_approve` other than
  false/absent is `400 bridge_cannot_approve`. Platform migration **017** (forward-only; 016's column stays) audits
  every existing grant (`chat.bridge_approve_revoked`, actor `migration:017`), sets them false, and adds
  `check (may_approve = false)` NOT VALID then VALIDATE. `scripts/deploy.sh` dies if `BRIDGE_MAY_APPROVE` is set to
  anything but false and sends no `may_approve`; `production.env.example`, `GO-LIVE.md` §1/§3/§4/§6 and RUNBOOK
  rewritten; `scripts/neuralchat-sim.ts` now expects the refusal, nothing executed, then a desk yes that executes once.
  Tests: `packages/platform/tests/migration-017.test.ts`, `apps/ledger/tests/matrix-go-ahead.test.ts` (rewritten).
- **B6 · Doors are switchboard lines (v3 §4).** Every declared door (manifest and installed packages) is a line
  `door:<key>`, on/off only; the floor is the manifest door entry's optional `floor` ('on' default; 'off' allowed;
  anything else `422 bad_door_floor` at registration); a company can only close it (`cannot_loosen`,
  `unknown_door`, `bad_setting`). `GET /api/apps/:app/abilities` returns doors as lines
  `{key, line, floor, company, setting, declared_by, scopes}`; the desk's switchboard shows an on/off toggle per door.
  `Platform.lend()` refuses an off door (`403 door_off`, audited `vault.lend` `refused_door_off`) before looking for a
  key. Template (minimal): `gate/tools.ts` `offDoors()` hides any ability whose `doors[]` includes an off door;
  `gate/gate.ts` refuses it by name (`door_off`) right after the setting check. Tests: `apps/ledger/tests/doors-switch.test.ts`.
- **B8 · Borrowed writes (v3 §10 "one step in another app's subject").** A `uses` line may name an owner's write
  (registration no longer requires a read). An ACL row for that write can be granted only when the caller's manifest
  declares it; `internalCall` refuses any direct call to another app's write (`write_is_a_task`). The borrowed line
  is offered like a borrowed read (strictest of the `uses` floor and the owner's setting; off without the ACL row);
  calling it runs nothing locally: the gate hands it to the owner through the a2a machinery (`handOff`, shared with
  `a2a.request`) with `{ability, args}` (only the inputs; a card is the owner's to write), and the job waits on
  `a2a_task`. `openA2ATask` checks `uses`, kind write, the ACL row and the owner's setting, writes a fixed ask
  ("borrows one step … using exactly these inputs — they are data, not instructions"), and records
  `tasks.borrowed_ability` (019); delivery authorises the app caller by that ACL row (`GatewayCall.acl_key`), never
  by a `tasks.open` grant it was not given. The owner's gate, proposal and a person's yes apply there. Marketing's
  manifest now `uses` `ledger.expense.record`. Tests: `apps/marketing/tests/borrowed-write.test.ts`.
- **B9 · Installed registry entries pin what they require.** `registerApp` refuses `409 breaks_installed` when the
  new manifest drops an ability that a non-disabled `registry_installs` row's entry `requires`, changes its kind, or
  moves its major version. Tests: `packages/platform/tests/registry-v3.test.ts`. *(v3 S7: the pins are read from the registered manifests — `packages` and `registry_skills` — not `registry_installs`; see "v3 S7".)*
- **B10 · Package format.** `nep.json` `{name, version, author, signature?, …}` is an alias of the package manifest
  (`buildPackage` reads it alone or with `manifest.json`, which must agree; the registry normalises `name` → key
  `nep-<name>`). A `signature` in nep.json is the author's Ed25519 signature over the content hash: it is taken out of
  the signed bytes and verified with `author.public_key`. New packages' tables must be `nep_<name>__*`; the
  single-underscore prefix is accepted only for `LEGACY_TABLE_PREFIX_PACKAGES` (`nep-gst`) and for any key already in
  the registry. Optional `metrics.json` and `references/**` travel inside the bundle (so covered by the artifact
  hash); the review diff lists their sha256. The registry test fixtures moved to `nep_<name>__*`. Tests:
  `packages/platform/tests/registry-v3.test.ts`.
- **A4 · Desk union views (018).** `neos_desk` NOLOGIN (created — and forced back to NOLOGIN/no bypass if it exists
  otherwise — by `migratePlatform`, since the migrator cannot create roles) reads `neos.v_pending_approvals`
  (PROPOSED proposals of every registered app) and `neos.v_activity` (every app's steps), each with `company_id`,
  and nothing else. `neos.refresh_desk_views()` (SECURITY DEFINER) rebuilds them from `neos.apps` at every
  `registerApp` and after every platform migration. Each app's branch is `neos.desk_pending(app)` /
  `neos.desk_activity(app)`, SECURITY DEFINER with dynamic SQL, so the views hold no catalog dependency on app
  tables (a `pg_restore --clean` of one schema, or an app on its own cluster, never blocks them; a missing schema
  gives no rows). `migratePlatform` hands the three functions to the admin role (they must read every app schema;
  as a superuser they see every company — hence `company_id` on every row). Tests: `apps/ledger/tests/desk-views.test.ts`
  (reconciliation with `neos.approvals` PENDING before and after a yes), `packages/platform/tests/migration-018-019.test.ts`.
- **A6 · Registry schema (019).** `neos_registry.{apps, abilities, doors, uses, skills, packages}` views over
  `neos.apps` manifests and published/deprecated `neos.registry_entries` — no secrets, no company data.
  `neos.grant_registry_read(app)` (SECURITY DEFINER, owned by the views' owner) grants USAGE + SELECT to
  `<app>_app` and `<app>_runner` when they exist; called by `registerApp` and after every platform migration.
  Tests: `apps/ledger/tests/desk-views.test.ts` (both apps' roles read it; `neos.*` is 42501; no usage on `neos`).

## v3 S1 · switchboard, installs and grants are the truth in the app's schema (2026-09-28)
`docs/V3-MIGRATION-PLAN.md` stage S1. Template migration **t010** (expand-only; proven on a populated book by
`apps/ledger/tests/board-db.test.ts` › "t010 applies forward on a populated book") plus the backfill script.
- **The tables (t010).** `<schema>.switchboard` is one row per (company, line): `setting` is now the **company's own
  switch** (t009 stored the effective one — never looser, so old rows stay safe until the backfill replaces them),
  `floor`/`kind` the app's, `approvers` the approver policy of a write, `updated_by`. The **company row** `line = '*'`
  (kind `company`) holds `rules`, `caps` (the model budget) and the default policy. A line without a row is at its floor.
  Every change takes the company's next **board version** (one per transaction, `board_version_for`), is kept in
  `<schema>.switchboard_history` (before/after, who) and `pg_notify('neop_<schema>', 'board:<company>')`s — installs
  and grants notify the same. `<schema>.installs` gains `company_name`, `time_zone`, `room_ids`, `agent_senders`,
  `installed_by/at`, status `removed`/`suspended`. `<schema>.grants` gains `created_by`, `created_at`,
  `suspended_reason`, `revoked_by`; `<schema>.grant_uses` records each use (the per-month limit sums it).
- **Tighten-only trigger** (`switchboard_guard`, runs as the caller): mirrors `Platform.setSwitchboard` — refuses a
  setting looser than the floor (`cannot_loosen`), an ask-first read (`read_cannot_ask_first`), a `door:`/`skill:`
  line that is not on/off, an approver policy on anything but a write (`bad_policy`); errcode 23514, message
  `<code>: …` (the platform maps it to a 422). The desk may never loosen a floor or recast a line's kind; only the
  app's roles (`<schema>_runner`, migrator) may. A DBA's exact restore / company purge (pgkit `importCompany`,
  `purgeCompany`) sets `neos.restore = on`, honoured only when the login is a superuser (`dba_restore()`): rows go
  back as dumped, no history or version is added — the desk's pool setting it changes nothing. The runner re-stamps its manifest's floors at boot
  (`SwitchboardCache.syncFloors`; a floor that tightened pulls the company's switch up with it).
- **Functions (SECURITY DEFINER, under the caller's company).** `create_grant(ability, limits, expires_at, user:<id>)`
  (limits, currency, recipients and a ≤ 1 year expiry checked as the platform checked; `not_grantable` on a known
  non-write line), `revoke_grant(id, user:<id>)` → `{changed}` (not_found P0002), `suspend_grant(id, reason)` (the
  runner's), `set_schedule(…)` (the install's time zone), `import_grant(grant, uses)` (the backfill's only way in).
  A trigger on `proposals` suspends a grant when something approved under it ends FAILED or UNKNOWN, in the same
  transaction, with a `grant_suspended` proposal event — the platform's outbox-driven suspension is gone.
- **Roles.** App role: SELECT only (plus INSERT on `grant_uses`). Runner: SELECT, `UPDATE (kind, floor, setting, …)`
  on switchboard, `UPDATE (status)` on installs, EXECUTE `suspend_grant` — no more copying. `neos_desk`: USAGE on the
  schema, DML on `switchboard` and `installs`, SELECT on `switchboard_history`, `grants`, `grant_uses`, EXECUTE
  `answer_proposal`, `create_grant`, `revoke_grant`, `set_schedule`, `import_grant` — never the app's own tables.
  Granted in t010 when the role exists, and idempotently by pgkit `applyDeskGrants` (end of every `migrate`, and
  `migratePlatform` for every registered app) and the DBA bundle's new section 5 (`deskGrantsSql`).
- **How the platform writes through (PgBouncer-safe).** `neos_desk` stays NOLOGIN. `migratePlatform` grants it to
  the platform pool's role `neos_app` **WITH INHERIT FALSE, SET TRUE** (PostgreSQL 16+): `neos_app` holds none of the
  desk's rights until a transaction says `SET LOCAL ROLE neos_desk`, which lasts to the end of that transaction only —
  nothing is left on a pooled connection, so the same pool works through PgBouncer in transaction mode.
  `packages/platform/src/boards.ts` (`AppBoards.asDesk`) does exactly that, sets `neos.company_id` for the app
  schema's row-level security, and reads/writes the board, the install and the grants. `Platform.switchboard()`
  (so the abilities screen, NeuralChat's registry context, approver policy, door lines, `lend()`'s door check and the
  LLM budget), `setSwitchboard` (same validation, then one desk transaction; no push), `installApp` /
  `uninstallApp` / new `updateCompany` (name and time zone into every install row), `createGrant` / `revokeGrant` /
  `listGrants` (the `/api/grants` list sums `grant_uses` in the company's month), the task view's `grant_uses` and
  `/api/switchboards/:app/history` (replayed from `switchboard_history`) all go to the app's schema. The HTTP API is
  unchanged. `neos.switchboards` and `neos.grants` are frozen legacy copies (never read to decide; only the
  backfill reads them); `neos.installs` stays the platform's own record for what it still routes itself (gateway,
  Matrix bridge, NeuralChat) and is written in the same call as the app's row. The gateway no longer puts
  `sb_version` in tokens. `notifyApp` / `switchboard.changed` stay only for what the platform still holds (ACL rows,
  registry installs); `setSwitchboard` no longer pushes. `Platform.grantExecutionToken` and
  `POST /internal/grants/execution-token` are removed.
- **The gate (template).** `SwitchboardCache` reads `<schema>.switchboard` + `installs` + history version over the
  runner pool (`loadBoard`); a missing/inactive install, or one without a time zone yet, is `NotInstalled` (fail
  closed). The runner's LISTEN connection routes `board:<company>` to `invalidate` (board, borrow list, package
  lines); the cache otherwise lives `BOARD_TTL_MS` = 5 s (the poll stays the truth). Step 7 matches a standing yes
  in `<schema>.grants` (`gate/grants.ts` `matchGrant`: ACTIVE, unexpired, currency / per-call / recipients /
  per-month in the install's time zone, serialised per grant), writes the proposal APPROVED `approved_via 'grant'`
  and its `grant_uses` row in one transaction, and executes inline — no platform call, no execution token
  (`executeProposal` still re-reads the setting and rules at effect time). Person-approved proposals still execute
  through the platform's execution token (S2 removes it). `data/mirror.ts` is deleted; `PlatformClient` has no
  `switchboard()` / `grantExecutionToken()`.
- **Backfill.** `scripts/v3/backfill-boards.ts [--app] [--company] [--json]` (`backfillBoards` in `boards.ts`) copies
  `neos.installs`, the latest `neos.switchboards` version and `neos.grants` + their `grant.used` audit rows into each
  app schema. Idempotent and never stale-over-new: an install row is written when missing or a t009 mirror (no
  company name); a board is replaced (lines stamped with the platform's version, t009 mirror lines deleted) only when
  the platform's version is newer or the app has no company row and no history; grants go in through
  `import_grant` (completing a t009 mirror row, else kept). It also runs at `registerApp` (the app), `installApp`
  (app, company) and at the end of `scripts/migrate.ts`, so a fresh install has its rows.
- **Tests.** New `apps/ledger/tests/board-db.test.ts` (trigger refusals, NOTIFY → gate within 1 s, uninstall stops
  the gate, role isolation incl. the platform pool without SET ROLE, create/revoke/suspend/set_schedule, a real
  grant-approved write that FAILs suspends its grant, backfill idempotent and never over newer truth, fresh install,
  the populated t010 proof). Ported, same meaning: `runtime-gate` (the "silent" change is a DBA's hand with triggers
  off; the cache test is NOTIFY + TTL instead of sb_version + 30 s; the grant window uses `hooks.afterGrantMatched`),
  `platform-gaps` (a switch-off reaches the gate while its L3 is unreachable, nothing owed; grant limits via
  `matchGrant`; self-suspension in the app schema), `v3-conformance` A7/A9 (truth, not mirror), `security`,
  `hardening`, `doors-switch` (the probe app gets a template schema), `verify-install` (the check reads the app's
  switchboard over the runner link).
- **Not done here.** Approver policy is still checked by the platform (`checkApprover`, now from the app's board) —
  moving it into `answer_proposal` is S2/S3 (**done in S2**, below). Matrix identity, `room_ids` and `agent_senders` are columns only (S4
  fills them). An app on its own cluster (D2) cannot be written through from the platform's pool; its board must be
  written with a desk connection to that cluster (the backfill script takes one).

## v3 S2 · the runner carries out the yes (2026-09-28)
`docs/V3-MIGRATION-PLAN.md` stage S2; WP v3 §5–§7 and §15 "a yes lands on one row, and the runner carries it out before
the assistant wakes". Template migration **t011** (proof: `apps/ledger/tests/approved-path.test.ts` › "t011 applies
forward on a populated book") and platform migration **020** (proof: `packages/platform/tests/migration-020.test.ts`).
- **One row, one function (t011).** `<schema>.answer_proposal(p_id, p_fingerprint, p_decision, p_by, p_feedback,
  p_roles text[] default null)` replaces t009's five-argument function (dropped and re-created in one transaction; a
  five-argument call still resolves to it through the default). New: the **approver policy** (defaults 5) is checked
  here — the write's own `switchboard.approvers`, else the company row `*`. `roles`: only a person holding one of them
  may say yes or "change this first"; `p_roles` is the person's roles as the caller knows them, and none given with a
  roles policy is a refusal (fail closed). `four_eyes`: the person the job serves (`jobs.on_behalf_of`, else a
  `user:` requester) may not approve it, decided in the database whatever the caller passes; nobody on record → it
  cannot be satisfied. Anyone may say no or withdraw. Refusals raise `not_an_approver: …` / `four_eyes: …` (42501)
  and record nothing; the policy is checked before the idempotent-repeat branch. A yes still readies **no** wait (B2).
  Also: `approved_via` is kept on a withdrawal after a yes (t009 nulled it). Grants: app, runner, `neos_desk`
  (pgkit `deskGrantsSql` grants whichever signature exists).
- **The hint (t011).** `proposals_approved_notify` / `proposals_insert_approved_notify` `pg_notify('neop_<schema>',
  'approved:<id>')` when a proposal becomes or is born APPROVED; index `proposals_approved_ix`.
- **The approved path in the runner** (`packages/neop-template/src/runner/waits.ts`, `ApprovedPath`). The runner's
  LISTEN connection routes `approved:` to `approved.kick()`; the job poll interval kicks it too (the poll is the
  truth). A pass claims, up to capacity (exec-lock pool − 1, one left for the gate's inline grants): `select … where
  status = 'EXECUTING' or (status = 'APPROVED' and (approved_via <> 'grant' or updated_at < now() − 30 s)) … for
  update skip locked limit 20` on an exec-lock (direct) connection, then `pg_try_advisory_lock('exec:<id>')` — the
  first it gets is the claim; the session lock outlives the claim's commit and dies with the connection. An EXECUTING
  row whose lock is free is an executor that died → resumed. Execution runs under actor `runner:<runnerId>`, in the
  job's trace (`runner.approved` span → `door …`). `pause()`/`resume()` hold claiming (tests); `stop()` does not wait
  for executions in flight (`Core.close()` abandons them as a crash would).
- **execute.ts without a token.** `executeProposal(core, company, id, {actor, trace?, request_id?})` (gate, tests) and
  `executeHeld(core, lock, …)` (the runner's claim). Under the row lock, for an APPROVED row, the effect-time checks
  are made against the book: the latest `answered:yes` / `approved_by_grant` event's `fingerprint_seen` must equal the
  row's fingerprint (`fingerprint_mismatch: …`), and `expires_at > now()` (`expired: …`); then, as before, the ability
  version (`version_changed`, now just the row's `ability_version` against what runs — there is no separately
  "approved" version), the switch (`switched_off`), the company rules. Every refusal takes the legal road APPROVED →
  EXECUTING → FAILED and wakes the job (the prompt now also explains `fingerprint_mismatch` and `expired`). Operations
  and proposal events carry the actor (`runner:<id>` / `grant:<id>`). New hook `afterExecuteEffect` (tests: a crash
  after the door answered). A resumed execution (dead executor) reads back first and re-sends only with the same
  idempotency key — unchanged.
- **Grants: one code path.** A standing yes is still carried out inline by the gate (the assistant's call returns the
  proof), through the same `executeProposal`; the runner only adopts a grant-approved proposal left APPROVED for 30 s
  (`APPROVED_GRANT_GRACE`: a gate that died between the commit and the effect). Chosen over routing grants through the
  runner so the model's tool call keeps its synchronous answer and there is still exactly one execute.
- **Platform: answers go to the row.** `Platform.answer(card, user, {decision, fingerprint_seen, feedback})` looks the
  card up in `neos.v_desk_cards` (a legacy approval id maps through the frozen `neos.approvals`), then calls
  `<app>.answer_proposal()` as `neos_desk` (`AppBoards.answer`, S1's `SET LOCAL ROLE` write-through) with the person's
  role. HTTP contract unchanged: `409 stale_fingerprint` (the refusal is kept in the proposal's events), `409 not_open`
  (also for a repeat of an answer already held — the function's idempotent repeat is a no-op, the desk contract has
  always been one answer per card), `409 too_late` (withdraw once the runner started), `403 not_an_approver` /
  `four_eyes` (now from the database), `404`. Withdraw after a yes is the same call (`withdraw` through the function;
  it wins only while APPROVED — the runner takes the same row lock). `checkApprover`, `approvalsTick`,
  `driveApproval`, `withdrawApproved`, the backoff and `hooks.afterResolve` are deleted; so are the L3 routes
  `proposals.resolve` / `proposals.execute`, `capabilities/platform/proposals.resolve.ts`,
  `GatewayAuth.verifyExecution`, the gateway's `exec` claims and `GatewayCall.exec`, and the contracts' `exec`,
  `proposal_id`, `fingerprint` token claims. The retired names stay on the gateway's platform-door deny list (no ACL
  row can turn them into an ability call). The bridges (room reply, DM reply, typed approve) call the same
  `Platform.answer`; a bridge still never approves.
- **Desk cards (020).** `neos.desk_cards(app)` + `neos.v_desk_cards` (rebuilt by `neos.refresh_desk_cards()` at every
  `registerApp` and platform migration, like 018): every person-facing proposal (not grant-approved) with the desk's
  columns and statuses — PROPOSED → PENDING, APPROVED/EXECUTING → RESOLVED, DONE → EXECUTED, FAILED, UNKNOWN,
  EXPIRED, REJECTED/SUPERSEDED/WITHDRAWN → CLOSED (`decision` no/change/withdraw); `decided_by` the person's uuid,
  `decided_at` = `answered_at`, `last_error` = the proof's error. A card's **id is its proposal id**. `GET /api/desk`,
  the task view's approvals, `/api/tasks`' pending count (once per list; `v_pending_approvals` stays the desk role's alone — its grants are rebuilt by 018's refresh), the bridges and
  `/metrics` read it; `neos_desk` and `neos_app` may. The card is on the desk as soon as the app writes it, so it can
  be seen a moment before the outbox mirror marks the task WAITING.
- **neos.approvals frozen (020).** INSERT/UPDATE/DELETE revoked from `neos_app`; the FKs from `room_events`,
  `room_messages`, `chat_client_events` dropped and every legacy approval id there rewritten to its proposal id (and
  `typed:propose:<approval>` keys to `typed:propose:<proposal>`, so a typed card is not posted twice). The outbox
  consumer no longer writes approvals; `proposal.created` mirrors the card with the proposal id.
- **Drain.** `drainApprovals` (`packages/platform/src/drain.ts`), `scripts/v3/drain-approvals.ts`, and the end of
  `scripts/migrate.ts`: every `RECORDED`/`RESOLVED` row is answered again through the function (same person, role,
  fingerprint, decision). Idempotent (`already`); audited `approval.drained`. Deploy order: migrate (020, t011, drain)
  → new backends (their runners carry out what the drain handed over, and any APPROVED row the old worker left).
- **Tests.** New `apps/ledger/tests/approved-path.test.ts` (NOTIFY heard and the yes wakes nothing; a missed NOTIFY
  caught by the poll; a yes with no runner up carried out when one starts; two runners → once (deterministic race of
  two passes, and live); withdraw vs execute (before the claim, too late while EXECUTING, raced); killed after the door
  answered and before it was called → resumed read-back first, never twice; fingerprint changed after the yes and
  expired → FAILED, nothing sent, the job told; the desk role cannot read/write proposals, events or waits; woken only
  after DONE with the proof; roles and four-eyes in the database whoever calls; the drain; a slow effect (was
  stuck-approval) once with no gateway call on a yes; the t011 proof) and `packages/platform/tests/migration-020.test.ts`.
  `stuck-approval.test.ts` is **deleted** (its premise — the platform's execute call timing out and being retried —
  is gone; its cases are in approved-path). Ported, same meaning unless noted: `proposal` (the "defence in depth"
  wrong-fingerprint resolve is now a direct `answer_proposal` as the desk; a retried/racing execute is two
  `executeProposal`s; the execution-token test became "nothing carries out what nobody approved"), `runtime-gate`
  (the token-version test became "a yes on record for one version does not run under another, whoever edited the
  row"; the switch-off test resumes the runner instead of calling execute), `wake-order` (the crash is a held runner
  replaced by a restart), `input-waits` (withdraw-after-yes by holding the runner, not the platform hook), `lifecycle`,
  `matrix-go-ahead` (cards closed by a person's withdraw, not a platform row update), `flow` (waits for the task to
  reach WAITING — ordering, above), `sender` / `inbound-auth` / `injection` (the answer/execute routes are 404 for
  everyone — premise gone; the book's own refusal of a non-person stays), `observability` (`runner.approved` replaces
  the gateway hops in the one trace), `desk-views` (reconciles with the desk's cards; `neos.approvals` stays empty),
  `v3-conformance` / `board-db` / `migration` / `migration-018-019` (the applied lists include t011 / 020), and every
  test that read `neos.approvals` now reads `neos.v_desk_cards` (same columns and statuses).
- **For S4** (presence in the NEOP): `runner/inbound.ts` should call `answer_proposal(…, p_roles)` with the person's
  roles (a roles policy refuses a call without them); `runner.ts` gained only the `approved` field, the `approved:`
  notification branch, the poll kick, the start kick and the stop line.
- **Not done here.** No ops command to pause the approved path (in-process only). `neos.approvals` and its table stay
  until S9. The desk views are function-backed union views with no predicate push-down (fine at pilot volume).

## v3 S3 · the desk on the database; questions answered through a function (2026-09-28)
`docs/V3-MIGRATION-PLAN.md` stage S3; WP v3 §1 (the desk), §6 ("one row, one function"), §11 (`neos_desk`: SELECT
through the views, EXECUTE on the functions, DML on switchboard/installs, never an app's own tables). Template migration
**t013** (proof: `apps/ledger/tests/desk-functions.test.ts` › "t013 applies forward on a populated book") and platform
migration **021** (proof: `packages/platform/tests/migration-021.test.ts`).
- **One row, one function (t013).** `<schema>.answer_wait(p_wait uuid, p_answers jsonb, p_by text, p_via text default
  null)` — SECURITY DEFINER, owned by the migrator, `search_path` pinned, EXECUTE revoked from PUBLIC and granted to
  `<schema>_app`, `<schema>_runner` and `neos_desk` (in t013 when the role exists, and by pgkit `deskGrantsSql` on every
  migrate / `migratePlatform` / DBA bundle). Forced RLS applies to the owner, so the caller's `neos.company_id` scopes
  it (another company's wait is `not_found`). It is the template's `waits.answer` (t005) moved into the database, rule
  for rule: `answered_by` `user:` | `bridge:` | `agent:` | `app:` (≤ 200 chars); `via` desk | conversation | chat
  (a person's own words — `user:` only, else `bad_request: only a person answers via …`) or bridge | reasoning_agent |
  app (relayed); default desk for a person, app otherwise; `trusted` = a person via a person's road. The answers are
  checked against the stored question exactly as contracts `checkAnswers` does (unknown keys; required fields; number
  — a JSON number or a decimal string, stored as a JSON number; boolean — yes/true/no/false; date — `YYYY-MM-DD` with
  the month/day ranges `Date.parse` accepts; text ≤ 4000; strings trimmed; the same error texts). The same answer by
  the same answerer again → `{status:'answered', idempotent:true}`; anything else on a closed wait, past `expires_at`
  or on a job that has ended (DONE/FAILED/CANCELLED/EXPIRED — what the platform's projection used to call STALE) →
  `{status:'stale', reason}`, **returned, not raised**. Then, in one transaction: the wait `ready` / outcome `ANSWERED`
  with `{wait_id, question, answers, answered_by, via, trusted}`, one fact per field (`answer:<key>`, source "answered
  by …" / "relayed (untrusted) by …"), a step (a relayed answer's words stay out of it) + `step.mirror`, and
  `question.answered` in the outbox (dedupe `answered:<wait>`); `waits_ready_notify` (t009) hints the runner. Raises
  `bad_request:` / `bad_answer:` (22023), `not_found:` (P0002), `not_their_wait:` (42501).
- **Who may answer — what the database can know.** New in the function: an app named by its **key** (`app:<key>`)
  answers only a question of its own hand-off (an a2a job whose `requester` is that app) **that serves no person**
  (`on_behalf_of` null); a question put to a person is the person's (WP §9), never the calling app's. A NEOP speaking in
  Matrix (`app:@neop_…`), a bridge (`bridge:@…`) and the reasoning agent (`agent:…`) are relays: that they answer only a
  wait of a task they opened is checked by the road that saw the task opened — the platform's typed road
  (`bridge/typed.ts`, `rootOf(...).sender`), the client road (`client-sync.ts`, the inbound sender of the task), and
  since S4 `runner/inbound.ts` — the database has no record of who opened a task on the platform. (Documented, not
  moved: S5/S6 put that in the book when tasks arrive as typed events.)
- **One implementation.** `capabilities/platform/waits.answer.ts` `answerWait()` is now a thin call of the function (as
  the app role, under the company) mapping its answers to the errors callers always had (404 / 409 stale / 400 / 403).
  The NEOS v1 `answer` capability and S4's `runner/inbound.ts` `answer()` helper call it unchanged — so inbound answers
  already go through `answer_wait()` (no edit to inbound.ts was needed). **The L3 route `POST /l3/waits.answer` is
  deleted** (after the switch nothing called it); the gateway drops its path but keeps `waits.answer` on the
  platform-door deny list, and `internalCall` still refuses it (403 for an app, as before).
- **Desk questions (021).** `neos.desk_questions(app)` (SECURITY DEFINER, dynamic SQL, no catalog dependency — like 018
  and 020): every input wait with the desk's columns and statuses — OPEN (pending, before `expires_at`, the job still
  going), ANSWERED, EXPIRED (outcome, or pending past due), STALE (anything else); **a question's id is its wait id**.
  `neos.v_questions` (all) and `neos.v_open_questions` (OPEN) are rebuilt by `neos.refresh_desk_questions()` at every
  `registerApp` and after every platform migration (`DESK_FUNCTIONS` hands both functions to the admin role). SELECT
  to `neos_desk` only — the platform reads them with `SET LOCAL ROLE neos_desk` (`AppBoards.deskRead`).
- **Platform.** `GET /api/questions` reads `v_open_questions` (or `v_questions` for `?status=ANSWERED|EXPIRED|STALE`)
  and adds what only the platform knows (root task through the a2a chain, `asked_of` + name, app name, task asks) —
  same fields, same order. `POST /api/questions/:id/answer` (and every other road: conversation follow-up, client-road
  reply, typed `neos.neop.answer`) goes through `Platform.answerQuestion` → `AppBoards.answerWait` → `<app>.answer_wait()`
  as `neos_desk`. The id may be the wait id or a pre-S3 `neos.questions` id (mapped to its wait). HTTP contract
  unchanged: 404, `400 bad_answer` (early, from `checkAnswers`, and again from the function), `409 stale` (a closed
  question, a repeat — the desk's contract is one answer per question —, or the function's stale), new `403
  not_their_wait` (unreachable from the desk: it always answers as a person). The task view's `questions` come from
  `v_questions` for the task and every a2a task under it. A follow-up in the conversation finds the open question it answers in
  `v_open_questions` too (found by the full suite: the projection can lag the view, and the reply then became a new job). The bridge's projection (`neos.questions`) is updated in the
  same call and by `question.answered`; a new row's id is its **wait id** (so the desk, the DM notices and the
  conversation name a question the same way).
- **Desk reads on the database.** `/api/desk` already read `neos.v_desk_cards` (S2). `/api/activity`, the task view's
  `activity` and `/api/tasks`' `steps` / `open_questions` counts now read `neos.v_activity` / `neos.v_open_questions` as
  the desk (once per list); the a2a hand-off lines are still the platform's own `neos.activity` rows (kind `a2a`, from
  `a2a.requested` — the platform's record of a hand-off, not an app step). A step has no platform id: the feed gives it
  a stable numeric id (48 bits of md5 over app, job, seq). **Still through the gateway (L3), for S9:** block reads
  (`POST /api/apps/:app/read/:ability`), `jobs.transcript` (`GET /api/tasks/:id/transcript`), `documents.fetch`,
  `schedules.set` / `schedules.list`, `tasks.open` / `inbox.deliver` / `tasks.cancel` / `tasks.result`, `outbox.read` /
  `outbox.ack`, `switchboard.changed`, `manifest`.
- **Outbox consumer.** Nothing the desk reads depends on it any more. Still consumed, for the Matrix bridge and the
  conversation until S4/S5 (and S9): `proposal.*` (room mirrors: card, answer, expiry, proof; the conversation's
  "waiting" line; task WAITING/ACKNOWLEDGED), `question.*` (`neos.questions` — the bridge's projection: which DM showed a
  question, a reply to it, the conversation follow-up —, task NEEDS_INPUT, conversation lines, room mirror),
  `step.mirror` (`neos.activity` step rows that `bridge/typed.ts` turns into typed notes, and the room's step mirror),
  `operation.recorded` (the audit trail's `app.operation` rows: `/api/audit` pages by audit id, and no view replaces
  that page yet — pilot-acceptance and neuralchat-sim read it), `a2a.requested` (the feed's hand-off lines). So the
  consumer is unchanged except the question id.
- **DeskHarness** (`packages/testkit/src/desk.ts`): an admin/pilot connection that runs each call as `neos_desk`
  (`SET LOCAL ROLE`, `neos.company_id`) — `answerProposal`, `answerWait`, `openQuestions`, `questions`,
  `pendingApprovals`, `cards`, `activity`, `query` / `errorOf` (to prove what the desk may not do). The test harness for
  a desk on the database; the pilot's own desk still speaks HTTP.
- **Tests.** New `apps/ledger/tests/desk-functions.test.ts` (validation and normalisation, nothing written on a refusal;
  idempotent / stale answered / stale past due / stale after the job ended / not found; person-only roads; an app's
  key refused on a person's question and on another app's hand-off, accepted on its own; a relay kept out of the steps
  and wrapped as untrusted; RLS across companies; the desk role refused on waits, jobs, steps, facts, outbox,
  proposals, transcripts, the app's own tables and `neos.questions`/`neos.tasks`, allowed the views and the function;
  `neos_app` without SET ROLE refused; `v_open_questions` = the open input waits = `/api/questions`; DeskHarness yes →
  the runner carries it out once; the t013 proof) and `packages/platform/tests/migration-021.test.ts`. Ported, same
  meaning: `input-waits` (the "app is the truth" checks call `answer_wait()` through DeskHarness; the L3 route is 404;
  the relayed answer goes through the function), `sender` (L3 `waits.answer` 404 for everyone; the book refuses an
  app's key), `a2a-questions` (waits for NEEDS_INPUT — the question is on the desk from the book before the outbox marks
  the task; the book refuses Marketing's key on Priya's question), `matrix-questions` (the app's wait holds the answer:
  chat → trusted, bridge → untrusted), `e2e` (the task view's steps are the app's steps; `/api/tasks` steps; the feed),
  and the applied-migration lists in `migration`, `v3-conformance`, `board-db`, `approved-path`, `migration-018-019`,
  `migration-020`. `flow`, `observability`, `blocks`, `desk-views`, `platform-gaps`, `matrix-typed`, the presence
  suites: green unchanged.
- **Not done here.** The bridge's `neos.questions` / `neos.activity` projections and the consumer that feeds them stay
  until the platform bridge is retired (S4 flag on by default / S5). The audit page's `app.operation` rows still come
  from the outbox. Transcripts, blocks and schedules still go through L3 (S9). `neos_desk` still has no role on an app
  on its own cluster (D2) — the desk connection for that cluster must be configured (as for S1/S2).

## v3 S8 · doors from the secret store; LLM tokens without the platform (2026-09-28)
- **Door credentials (v3 §12).** `packages/neop-template/src/doors/secrets.ts`: `SecretStore { get(company, door) }`;
  `FileSecretStore` (root `NEOP_DOOR_SECRETS_DIR`, default `/run/secrets/doors`) reads
  `<root>/<company>/<app>/<door>.json` (the app's own), else `<root>/<company>/<door>.json` (company-wide) — the same
  (company, app|'*', door) binding as platform migration 015 — **on every call** (stat + read; no cache). Every path
  segment is checked (`[A-Za-z0-9][A-Za-z0-9_.-]*`, no `..`), so another company's directory or another app's file is
  never named. A world-writable file is refused; group/other-readable is warned once per file; invalid JSON is refused
  without echoing it. `MemorySecretStore` for tests. Wired as `NeopConfig.secrets` (hook; default the file store).
  `Core.doors()` gives each door a lend `(door) => Core.lendDoor(company, door, declared)`: declared by the app or the
  asking package (the package host now passes the package's declared doors, so `gst_portal_otp` is covered) →
  `undeclared_door`; switched off on the board (`offDoors`, the gate's own rule; the gate has already refused the
  ability) → `door_off`, the store not read; no file → `no_secret` "not connected for this company". All are
  `DoorError{definite:true, code}` — nothing sent, the proposal ends FAILED, never UNKNOWN. `DoorError` gained `code`.
  `PlatformClient.lend()` is gone.
- **LLM session tokens.** `packages/neop-template/src/runner/llm.ts`: `LlmSessions.mint()` signs the same claims the
  proxy always metered (company, job, sid, `budget_micros`, `day_cap_micros`, tz) with the app's Ed25519 key, issuer
  `neop-runner:<app>`, `sub app:<app>`, aud `llm-proxy`, TTL = session max + 60 s. Budget and time zone come from the
  board the session runs on (`board.budget`, `board.company.time_zone`) — the runner's own switchboard, not a
  platform call. `NeopConfig.llm = {proxyUrl, signingKey}`; unset → sessions get no token (as "no proxy" before).
  The proxy (`llmProxyApp`) gains `runnerKeys: {app: [public JWK]}`: a `neop-runner:<app>` token verifies only against
  that app's keys and must carry `sub = app:<app>`; private components are stripped if given. Platform-signed tokens
  (JWKS) still verify — the platform's router model uses them. `PlatformClient.llmSession()` is gone.
- **Platform routes.** `POST /internal/vault/lend` and `POST /internal/llm/session` are **removed** (nothing called
  them after the switch; `security.test.ts` asserts 404). `Platform.lend()` / `Platform.llmSession()` stay as
  `@deprecated` methods (tests of the vault's sealing use `lend`; S9 deletes both). `PUT /api/vault/<door>` still
  stores (sealed) but answers with a `deprecated` note: no backend reads it; `GET /api/vault` unchanged.
- **Deploy kit.** `gen-secrets` adds `<app>_llm_signing_key` (private JWK, backend only), `llm_runner_keys` (public
  halves, proxy only; derived and rewritten when it does not match), `backup_doors_key`, and `doors/`. Compose: the
  backend gets `NEOP_DOOR_SECRETS_DIR`, `NEOP_LLM_PROXY_URL`, `NEOP_LLM_SIGNING_KEY_FILE` and the `doors/` mount
  read-only; the proxy gets `NEOP_LLM_RUNNER_KEYS_FILE`; `backup` mounts `doors/` read-only and writes `doors.enc`
  (AES-256-GCM with `backup_doors_key`; skipped, never in clear, without it; `backup.ts restore-doors`). No agent,
  web or platform service has the mount (`network.test.ts`). `deploy.sh door set|rm|ls` (JSON on stdin, jq-validated,
  0600 via write-then-rename, owned by `NEOS_DOORS_UID`=1000); step 9 writes `EMAIL_DOOR_JSON` into
  `doors/<co>/ledger/email.json` instead of `PUT /api/vault`. `verify-install`: "doors: a credential file for every
  connected door (not read)" (WARN when missing or group/other-readable; off doors need none) and "deploy: the door
  secret store reaches the backend only" (from `NEOS_COMPOSE_FILE`, which deploy renders with `docker compose
  config`). `scripts/v3/export-door-secrets.ts` moves the vault into files (opens rows with `VaultCipher` + `vaultAad`,
  0600, keeps existing unless `--overwrite`, prints names only, exit 1 if a row does not open).
  `scripts/netcheck.sh` unchanged: the backend still reaches the platform (switchboard until S1, registry, a2a).
- **Tests.** New `apps/ledger/tests/secret-store.test.ts` (rotation between two calls; own over company-wide;
  another app's and another company's files never read, traversal names refused; missing → definite FAILED, nothing
  sent; the agent's session body, the brain's view and the job token carry no secret; export and backup round trips).
  Ported, same meaning: `providers`, `gst` (OTP slot is a store file), `registry`, `lifecycle`, `security` (B1 on the
  backend's lend + routes gone), `doors-switch` (backend refuses an off door without reading the store),
  `hardening` (vault sealing, deprecated), `llm-proxy` (runner-minted tokens; forged key, unknown app, crossed
  `sub` refused), `network`, `verify-install`. The testkit pilot provisions a file store per boot
  (`P.doorsDir`, `P.setDoorSecret`, `P.removeDoorSecret`) and, with `llmUpstream`, a signing key per app.
- **Not changed:** the runner's spend meter still calls the proxy's `/v1/spend`; in compose the backend is not on the
  `llm` network, so in production that read fails soft (null) exactly as before S8 — the proxy still enforces both
  caps. Person-entered GST OTPs are written by ops into `gst_portal_otp` (a desk path for the person is later).

## v3 S4 · presence: the NEOP is on Matrix itself (2026-09-28)
`docs/V3-MIGRATION-PLAN.md` stage S4. Behind `NEOP_PRESENCE=off|appservice|client` on the backend (default **off**:
today's platform bridge keeps speaking for the app, unchanged, and every platform-road test still runs). When on,
the NEOP's own backend is the app's voice in Matrix; nothing it does goes through the platform API or reads schema
`neos`. Template migration **t012** (expand-only; proven on a populated book by `presence-dedupe.test.ts` › "t012
applies forward on a populated book").
- **Who is who (`src/presence/identity.ts`).** From the app's schema only: `installs.matrix_user` (one name per
  company — `@neop_<app>_<slug>` on the appservice road, an ordinary account such as `@ledger:hs` on the client road),
  `room_ids`, `agent_senders` and the new `agent_acts_for` (the allowlisted non-people and the person each relays for),
  `company_slug` (a typed task may name its company by it), and the new `<schema>.people` (company_id, matrix_id →
  user_id, name, role, `chat_person` = on the app's allowlist as a person). **Choice (the "person identity" question):
  a platform write-through**, not a view: the app must not read `neos`, and a SECURITY DEFINER lookup into `neos` would
  be exactly that. `Platform.syncChat(company, app?)` rewrites the company's rows as `neos_desk` (the S1 `boards.ts`
  path, `AppBoards.writeChat`) after `installApp`, `PUT /api/users/:id/chat` (both routes, and `ChatBridge.linkUser`),
  and `PUT|DELETE /api/chat/allowlist`. `neos_desk` gets DML on `people` (t012 when the role exists; pgkit
  `deskGrantsSql`/`applyDeskGrants` idempotently); app and runner roles only read it. The app's own name and rooms:
  `GET|PUT /api/chat/presence {app, matrix_user?, room_ids?}` (admin, audited `chat.presence_set`;
  `Platform.setChatIdentity`). Sender classes: client road — an `agent_senders` entry is `agent`/`neop` (`@neop_…`), a
  person must be linked **and** `chat_person`; appservice road — a linked person of the room's company is a person
  (membership is the allowlist), else an `agent_senders` entry; anyone else is ignored.
- **The ear (`src/runner/inbound.ts`, one class for both roads).** Every event is claimed once in
  `<schema>.inbound_events` (event_id primary key; `presence/events.ts claimInbound`) before anything happens: Matrix
  redelivers. Typed events: `maySend(class, type)` and `validateTypedBody` from `@neop/contracts` (dropped + recorded
  with the class and the validator's error in `inbound_events.detail`, nothing sent back — the NEOP's analogue of the
  platform's `chat.typed_in` audit); `task` → `openJob` → `openJobAtomic` in the app's schema, `task_id` derived from
  the event id (a redelivery with a lost record still finds the same job), `origin` = the event id, requester and
  `on_behalf_of` = `user:<person>` (a person only for themselves; an agent/NEOP for the linked person it names, else
  its `acts_for`; `company` = this install's id or slug); `answer` → the wait through the book exactly as
  `waits.answer` writes it (`answerWait`: a person's words `user:<id>` via chat; relayed `bridge:<mxid>` /
  `app:<mxid>` via bridge — untrusted data), only for a wait shown in this room, in the thread of its task, from the
  sender that opened it (unless a person); a closed wait → a typed `note` `stale-<wait>` in the thread. (`answer_wait()`
  arrives with S3; this is the one place to switch.) `approve` → **people only**, sending as themselves, for a card
  shown to them here (and in a room at the approve power level): `<schema>.answer_proposal(p, fingerprint, decision,
  'user:<id>', feedback, [the person's role])` — the approver policy (roles, four-eyes) is checked there (t011, S2);
  `not_an_approver` / `four_eyes` come back as the one reply ("only admin may approve …"); a fingerprint mismatch
  is refused ("what you approved is not what is on the card now…") and kept by the book as `answer_refused:fingerprint`;
  an answer the book already holds (an identical second yes) is refused as "no longer open", as the desk did.
  A yes is carried out by the runner's approved path (S2, `runner/waits.ts`), exactly like a desk yes; presence
  starts nothing itself. Plain `m.text` keeps NeuralChat #143's meaning
  byte for byte (ported with its tests): a task; a reply to a question notice answers it (answersFromText); a plain
  next message answers only while the DM is **at** the question (`latestSaid` = the latest `outbound_events` row in the
  DM), a person's whole text only for a one-field question and never text ending in "?", a bridge only with
  `key: value` pairs (`plainAnswers`); a person's reply to a card in their own DM is their decision (`parseDecision`);
  a bridge's clear decline (`DECLINE`, as a reply, naming the card, or plainly worded `PLAIN_DECLINE` while the DM is at
  the card or only one card waits — never when it only postpones, `POSTPONE`) is the person's no, "declined via <bridge>
  on behalf of <name>"; a bridge's go-ahead (`isConsent` = the platform's `parseDecision`/`CONSENT`/`goAheadOf` rule) is
  never a yes: one reply "Nothing was done: a bridge cannot approve. I can't take a yes through NeuralChat. Please approve
  #<id8> on your desk." re-showing the card (recorded with its fingerprint so a later "no" binds; `inbound_events.detail
  {consent:'not_a_yes', proposals}`). Card ids shown are the proposal id's first 8 characters.
- **The one reply (client road).** `inbound_events.reply_status` none → waiting (`owe`, due now +
  `MATRIX_REPLY_DEADLINE_MS`, default 55 s) → sending → sent. `replyTick` settles from the book: job DONE → its summary
  (+ could-not); FAILED/CANCELLED/EXPIRED or overdue → the fixed sentence; a card raised since the message → the card
  (to a person) or the bridge text "awaits a person's approval…" plus the card shown in the person's own DM
  (txn `card-<proposal>`); a question since the message → the question (and, for a bridge, in the person's DM, txn
  `question-<wait>`). `questionsTick` puts questions of jobs not asked on this account (the desk) into the person's own
  DM. txnId `reply-<event_id>`; a resend after a crash is the same event. Typed events get their one reply in the
  typed thread.
- **The mouth (`src/runner/mirror.ts`).** Reads the app's own outbox per company from its own cursor
  (`<schema>.presence_mirror`; the platform keeps its own) and says, as the company's name: in the app's room (the room
  the job was asked in; a desk job goes to the company's first room) the same m.notice text the platform's bridge posted
  (`presence/cards.ts`, ported from `format.ts`): "On it — …", `· step`, the card (recorded with its fingerprint), the
  answer, expiry, execution, heads-up, question (recorded with its wait), the result; in a typed thread (either road):
  `note` ack and per step, `ask`, `propose`, `done` with the sender's own task id. Every message is keyed
  (`outbound_events` unique (account, room, key); txnId = the key): a re-read outbox or a restart never says anything
  twice. The first pass for a company starts at the outbox end, except for jobs opened from Matrix (whose whole story
  is owed). L3's outbox prune never deletes past a presence cursor. A failed send stops the company's pass there (order
  kept) and is retried, up to 10 times, then given up and logged; a client-road account that is not running has no voice
  (its typed notes are not replayed; its one reply per message is, from the book).
- **Roads.** `presence/appservice.ts`: `/_matrix/app/v1/transactions|users|rooms|ping` (+ legacy paths) on its own
  listener (`APPSERVICE_PORT`, default 4104; L3 and the gate do not serve it), `hs_token` compared in constant time
  (403 `M_FORBIDDEN` otherwise), a room not in any install's `room_ids` ignored (no record), our own names ignored;
  sends with the `as_token` and `?user_id=<name>`; each bound room joined once per process and checked with contracts
  `roomProblems` (unfit → never spoken in, events `room_unfit`); `createRoom` makes a v3 room. `presence/client.ts`: the
  ordinary-account `/sync` road ported from `client-sync.ts` (whoami → the install whose `matrix_user` is that account;
  `account_mismatch` / `no_install` / `token_rejected` stop it, no retries, no login, never `/logout`; cursor in
  `<schema>.presence_accounts`; 1:1 DMs in `<schema>.presence_dms`; invites only from allowed senders; backlog,
  notices, other msgtypes, empty bodies, non-direct rooms ignored). `presence/index.ts` (`Presence`,
  `presenceConfigFromEnv`): `NEOP_PRESENCE`, `NEOP_MATRIX_HOMESERVER_URL`, `NEOP_MATRIX_HS_TOKEN[_FILE]`,
  `NEOP_MATRIX_AS_TOKEN[_FILE]`, `APPSERVICE_PORT/HOST`, `NEOP_MATRIX_CLIENT_ACCOUNTS[_FILE]` (`[{account?, token_file}]`),
  `MATRIX_REPLY_DEADLINE_MS`, `MATRIX_SYNC_TIMEOUT_MS`. Started by `startBackend` (`NeopConfig.presence`) after the
  runner; `runner.ts` is untouched.
- **Platform.** Unchanged when presence is off. Additions: `syncChat` / `setChatIdentity` / `AppBoards.writeChat` /
  `readChatIdentity`, `GET|PUT /api/chat/presence`. The desk needs nothing new: since S2 its cards are the app's own
  rows (`neos.v_desk_cards`), so an answer given in Matrix shows there at once, and a desk yes to a card first shown
  in Matrix goes through the same `answer_proposal()`.
- **Deploy.** `deploy/appservice.ledger.yaml` (id `neop-ledger`, `http://ledger-backend:4104`, exclusive
  `@neop_ledger_.*`, Ledger's own tokens); `scripts/matrix-setup.sh` writes it with `NEOP_PRESENCE=appservice` and
  narrows the platform's registration to `@neop_(?!ledger_).*`; `deploy/compose.chat.yml` gives the ledger backend the
  presence settings and the chat network; `deploy/compose.presence-client.yml` (production, external homeserver:
  the backend holds `matrix_ledger_token`, the platform none); `scripts/deploy.sh` honours `NEOP_PRESENCE` (default off —
  unchanged; `client` swaps the overlay, allow-lists the homeserver host in egress, writes `PUT /api/chat/presence`);
  `production.env.example` `NEOP_PRESENCE=off` with a note; `scripts/netcheck.sh` checks the backend reaches synapse
  when a local synapse runs. `scripts/neuralchat-sim.ts` runs unchanged against a `NEOP_PRESENCE=client` install
  (header note): its desk and audit checks follow the app's outbox.
- **Tests** (new, both presence modes; the platform-road tests are untouched): `presence-client` (matrix-client's
  checks), `presence-questions` (matrix-questions'), `presence-go-ahead` (matrix-go-ahead's, incl. the desk yes and the
  desk card CLOSED/no the sim reads), `presence-typed` (matrix-typed's, client DMs and appservice rooms), `presence-rooms`
  (rooms'), `presence-sender` (sender's, both roads), `presence-dedupe` (redelivery never opens twice or replies twice;
  a rewound mirror/restarted backend says nothing twice; a resent reply is the same event; the t012 proof),
  `appservice-auth` (wrong/missing hs_token 403, unknown room ignored, own echo ignored, L3/gate do not serve it).
  `board-db`, `approved-path`, `migration` and `v3-conformance` list t012 among the files they see applied.
- **Not done here.** The Matrix identity of other NEOPs / the bus room (S6); NeuralChat as its own typed identity (S5);
  `answer_wait()` (S3); a2a questions asked of
  the person on a callee NEOP's wait are still the platform's (`neos.questions` root task). Per-NEOP appservice
  registration beyond Ledger is the same file with the app's key.

## v3 S6 · NEOP to NEOP on the bus room (2026-09-28)
`docs/V3-MIGRATION-PLAN.md` stage S6 (v3 §9 "Talking to other NEOPs", §10 "Borrowing one ability from another app").
Template migration **t015** (expand-only; proven on a populated book by `apps/ledger/tests/bus-room.test.ts` › "t015
applies forward on a populated book").
- **The choice is the presence flag (`Core.presenceOn`).** `NEOP_PRESENCE` on: every road to another app — `a2a.request`,
  a borrowed line, and the new `a2a.answer` — goes through `gate/a2a.ts` (extracted from `gate.ts`: `handOff`,
  `a2aRequest`, `borrow`) to the bus (`runner/bus.ts`, set as `Core.bus` by `Presence.start` on the appservice road);
  the platform's `openA2A`, `borrowDescribe`, `gatewayCall` (and so `neos.acl`, `/internal/a2a|borrow|gateway/*`,
  `a2aResultsTick`) are never called. Presence on the client road has no bus (a multi-app room needs the app's own
  appservice name): a hand-off is refused `no_bus`, nothing is sent. Off: the platform road, byte for byte (S9 deletes
  it; the platform-mode tests are unchanged).
- **t015.** `installs.bus_room_id` (the company's `#neop-bus-<co>`), `installs.bus_peers` (Matrix id → app key: the only
  senders acted on in the bus room — `Identity.busSender`; a person, the reasoning agent or a stranger there is
  `typed:unknown_sender`), `<schema>.bus_threads` (company_id + forced RLS; app and runner select/insert/update): one row
  per thread, `out` (this app asked) or `in` (this app took), kind `task` | `call`, the root event, the peer and its
  app, the job and the wait, `lineage`/`depth`, the callee's open `question`, status and result.
- **Contracts** (`matrix-events.ts`, optional and additive — every body valid before stays valid): task `lineage`
  (app keys, the asker last) and `depth`; ask `call {ability, args, on_behalf_of?}` (borrowing one ability — the
  documented form of "ask carrying {ability, args}"); answer `result` (a borrowed call's output, proof or refusal).
  `v3RoomPowerLevels` / `V3_ROOM_LEVELS` (people 50, NEOPs 20, agents 10; approve 50, task/answer 10, ask/propose/done/
  note 20); `neopRoomPowerLevels` (S4's own-room levels) unchanged.
- **Opening a task (asker).** `busHandOff`: the chain is this job's `in` thread's lineage + this app; the asker's gate
  already refuses a loop (`a2a_loop`) or depth > 3 (`a2a_depth`); the person must have a Matrix id here (`no_person`).
  The `a2a_task` wait (ref_id = the thread id = the body's `task_id`) and the `out` row are written **before** the send
  (item 5); `neos.neop.task {task_id, company, on_behalf_of, text, lineage, depth}` goes from the app's own name,
  addressed by `m.mentions` (every app on the bus receives every event; only the mentioned one acts); the root event id
  is recorded after. A send that fails closes the wait `NOT_OPENED` and refuses with the homeserver's words as
  untrusted data. `consumeReadyWaits(…, except)` never consumes the wait the hand-off just wrote, so a `done` faster
  than the send's return is kept (runtime-a2a-presence proves it).
- **Taking a task (callee, `Bus.onTask`).** Addressed to this app, from a bus peer whose manifest `uses {app: <callee>,
  ability: tasks.open}` (read in `neos_registry.uses`), for this company, with a chain that ends with the sender, does
  not contain the callee and is ≤ 3 deep — else a typed `done {job_id:'none', result:{outcome:'failed', refused:<code>},
  could_not}` in the thread (`wrong_company`, `not_declared`, `bad_lineage`, `a2a_loop`, `a2a_depth`, `no_person`,
  `registry_unavailable`). Otherwise an `in` row, then a job (`Inbound.open` with `requester app:<mxid>`, source
  `a2a`, `on_behalf_of user:<person>`, origin = the event id, task id derived from it: a redelivery opens nothing).
  It runs on the callee's switchboard; a yes is a person's (desk, or a reply in the callee's own room — the mirror
  sends a bus-origin job's plain story to the company's own room, never the bus); the asking app's `approve` is
  refused by the sender-class rule (`typed:refused:approve`). The callee's question goes back into the thread as a
  typed `ask` (mirror), its result as `done` with the asker's task id.
- **The callee asks (asker's side).** A typed `ask` (no `call`) in a thread this app opened readies its `a2a_task` wait
  with `{status:'NEEDS_INPUT', question, due}` (a job not waiting on it gets a ready wait of its own) and keeps the
  question on the row; the prompt shows the question inside the untrusted fence and says: answer with `a2a_answer`
  from the book/tools/person, else `job_ask` your person first and relay; never guess. `a2a.answer {task_id, answers}`
  (≤ 10 scalar answers) sends a typed `answer` to the callee's wait in the thread and waits again (a new `a2a_task`
  wait). At the callee it is `Inbound.onAnswer` as before: only for a wait shown in that thread, only from the app
  that opened the task, recorded `answered_by app:<mxid>`, via bridge — relayed data, never a person's word.
- **The result (asker).** `done` with this app's task id (and the thread's root) readies the wait with `{status:
  COMPLETED|FAILED|REFUSED, from_app, result (+could_not)}`, writes the step and an `operations` row
  (`task:<peer>`); the prompt shows it as untrusted data (the existing a2a_task wake).
- **Borrowing one ability.** Asker: `BorrowCache.list` with presence on reads the owner's contract from
  `neos_registry.abilities` (A6), no platform call; the line is the borrower's own `uses` line on its switchboard —
  **off until the company sets it** (`EffectiveBoard.companySetting`; `setSwitchboard` now accepts a `uses` key as a
  `borrowed` line, on/off, never looser than the `uses` floor), so no ACL row. A borrowed read or write is one typed
  `ask {…, call:{ability, args, on_behalf_of}}` (wait id = the thread id); the job waits. Owner (`Bus.onCall`): the
  asker declares it in `neos_registry.uses`, the ability exists, the owner's own line is not off, its doors are on,
  the input validates — else a typed `answer {result:{refused:{code, message}}}`. A **read** runs at once with no
  model and no job, recorded `served` (`caller app:<mxid>`, idempotency `bus:<event>`, reason "a read served to
  <app> over the bus room (no model)"), answered `{status:'DONE', output}`. A **write** opens a job (source a2a,
  requester `app:<mxid>`) that no model runs: the runner's hook (`Runner.spawn` → `Bus.takeJob`) puts the step
  through the owner's own gate exactly as asked — switched on: done now; ask first: a proposal whose card the runner
  writes ("… — borrowed by <app>", the exact inputs); a standing yes: done under it — and releases the job; when the
  proposal ends (a person's yes carried out by the approved path, a no, expiry) the runner answers `{status, proposal_id,
  decided_by, proof}` and finishes the job. Asker: the answer readies the wait (REFUSED / COMPLETED / the status) and
  writes `operations` `borrow:<owner>:<ability>` (`answered` | `refused`). Both apps write their row.
- **Rooms (`scripts/rooms-setup.ts`, idempotent).** Per company: `#<app>-<co>` for each app (people + the app) and
  `#neop-bus-<co>` (apps only, made by the first app's name, the others invited), invite-only, no `m.room.encryption`,
  `v3RoomPowerLevels`; found again by alias; each app's `room_ids`, `bus_room_id`, `bus_peers` written through the
  platform (`PUT /api/chat/presence` now takes `bus_room_id` and `bus_peers`; `Platform.setChatIdentity` →
  `AppBoards.writeChat` as `neos_desk`; `readChatIdentity` returns them when set). Each backend joins the bus room on
  its room refresh and checks it like any room (bus peers count as non-people for the approve level).
- **Testkit.** `fakeHomeserver` routes events between several apps' appservices (`route(prefix, url)`: an event an app
  sends is delivered, in order and after the send returns, to every other appservice with a name joined to the room),
  resolves aliases, records invites; `pushTyped({to})` targets one app; `bootPilot({presence:'appservice',
  presenceAll:true})` gives every app its own presence and `neopUsers`.
- **Tests.** New `apps/ledger/tests/bus-room.test.ts` (rooms-setup; Marketing → Ledger task with a question back,
  Marketing's typed answer, the result waking Marketing; a borrowed read answered with no model; the owner's line
  refusing; a borrowed write as Ledger's proposal, Marketing's approve refused, a person's yes, the proof; depth > 3,
  loop, bad chain refused; not-ours and strangers; redelivery; the asker's gate refusing early; t015 forward).
  Ported to presence mode (platform-mode versions kept): `runtime-a2a-presence.test.ts`,
  `apps/marketing/tests/a2a-questions-presence.test.ts` (in presence mode the callee's question goes to the asking
  app, which asks its own person and relays), `apps/marketing/tests/borrowed-write-presence.test.ts`.
  `migration`, `v3-conformance`, `board-db`, `approved-path` list t015 among the files they see applied.
- **Not done here.** The bus on the client road; NeuralChat (the reasoning agent) posting tasks in the bus room (S5);
  borrowing what an installed registry entry `requires` without a `uses` line (the platform-mode ACL path; S7's
  registry); deleting the platform's a2a road and `neos.acl` (S9).
## v3 S7 · packages at build time; the registry schema (2026-09-28)
`docs/V3-MIGRATION-PLAN.md` stage S7; WP v3 §10 ("a package installs into a host at build time, its migrations ride
with the host's"; "code is loaded by hash, never run from a row"; "B cannot retire an ability a pinned skill still
requires") and §13 (`src/packages/`: "nobody by hand — the installer unpacks a signed artifact here; a hand-edited
package fails verification at spawn"). Platform migration **022** (proof: `packages/platform/tests/registry-v3.test.ts`
› "022 applies forward on a populated platform database"); Ledger migrations **008–009** (nep-gst; proof:
`apps/ledger/tests/install.test.ts` › "nep-gst's host migrations apply forward on a populated book, and are skipped
where the pre-v3 runtime installer ran them"). No template migration.
- **`neos install <app> <key>@<version>`** (`scripts/neos-install.ts` → `installEntry` in
  `packages/neop-template/src/packages/install.ts`). Fetches the signed entry (`GET /api/registry/entry?key&version`)
  and a package's artifact by hash (`GET /api/registry/artifact?hash`, published/deprecated only) — an operator's
  bearer or an app's service secret; checks the entry's content hash, the registry's EdDSA co-signature (under the
  key the JWKS names by `kid`; `--trust <jwks>` additionally pins the registry's keys), `sha256(bytes) =
  artifact_hash`, and that the bundle's offers/requires hash to the signed content hash. Refusals are
  `InstallError`s: `hash_mismatch`, `bad_signature`, `not_published`, `bad_package` (a table not `nep_<name>_*`, a
  `create table` of an undeclared table, an ability that collides with the host's or another package's),
  `migration_changed`, `tests_failed`. **A refusal leaves the app folder byte for byte as it was** (every touched
  file is staged and put back).
- **What an install writes.** `src/packages/nep-<name>/` (0444): `bundle.json` — the artifact itself, byte for byte,
  the only thing the sandbox loads — and, for people, `nep.json`, `handlers.js`, `skills/*.md`, `migrations/*.sql`,
  `metrics.json`, `references/**`. `packages.lock.json`: per package the version, artifact and content hashes, the
  registry's signature with the public key it verified under (`kid`), every unpacked file's sha256, the package role,
  its tables and the host files its migrations became; per pinned skill its version, content hash, requires and
  signature. `migrations/NNN_nep_<name>__<file>.sql`, numbered after the app's last file, in the package's order,
  with a `migrate.json` row each (`baseline: false`, `--proven` → `proven_on_populated_data`). Each wraps the
  package's SQL in a `DO` block that skips it where the pre-v3 runtime installer already ran it (a
  `schema_migrations` row `nep-x@<v>/<file>`) and then makes the host role read-only on the package's tables. The
  manifest's `packages` gets `{key, version, artifact_hash, content_hash, requires, abilities (full declarations),
  doors, skills}` — the platform's source for the package's lines. A later version keeps the host files already
  shipped (a changed one is refused) and appends new ones; a reinstall after `--remove` finds its files in the set
  and reuses them.
- **Tests inside the host.** Before the install stands, the app's whole migration set (template, app, the new files)
  runs in a scratch database on `NEOS_ADMIN_URL`'s cluster (`migrateApp`, which also makes the package role), then the
  package's `selftest` runs in the sandbox as that role (`selftestPackage`, unchanged). The pilot's real tables never
  see the self-test's rows.
- **Roles.** The migrator cannot create roles, so `migrateApp` (after the migrations) runs `applyPackageGrants` for
  each locked package: `<host>_nep_<name>` LOGIN, no bypass, `search_path = <host>`, `SELECT/INSERT/UPDATE` on its
  own tables only, sequences; the app role `SELECT` only. `scripts/dba-bundle.ts` adds the same as section 6
  (`packageBootstrapSql`; the DBA sets the password or `NEOS_PKG_PW_KEY_<HOST>` derives it as before).
- **`--remove`** deletes the unpacked folder, the lock entry and the manifest entry; the host migration files and
  `migrate.json` rows stay (they ran; forward only) and so do the tables. Dropping them is a contract migration in
  the app's own set (the expand/contract lint refuses a bare `drop table`).
- **PackageHost** (`packages/neop-template/src/packages/host.ts`) reads the lock once at boot (`AppDefinition.packages
  = { root }`; Ledger sets `LEDGER_ROOT`). `forCompany` verifies every locked package at each spawn
  (`verifyInstalledPackage`: every listed file's hash, `bundle.json` = the artifact hash, the recomputed content
  hash, the signature against the recorded key and, when `NEOP_REGISTRY_JWKS[_FILE]` / `cfg.registryJwks` is set,
  that the key is trusted) and again before every sandbox call. A failure stops that package's sandboxes, skips it,
  and the job's book gets a note `Not loaded: <key>@<v> — <reason>` (once per job). The sandbox, the narrow ctx and
  per-company sandboxes are unchanged. `cfg.packageCacheDir` and the runtime cache are gone.
- **Skill-only entries.** Pinned in the lock and the manifest's `registry_skills`; at spawn the host reads the row from
  `neos_registry.skills` with the app's own role (SELECT since A6; 022 adds `body`, `offers`, `platform_sig` to the
  view), recomputes the content hash, requires it to equal the row's and the pin's, and verifies the co-signature.
  A changed row is not loaded (with a note). The skill then loads only when its `skill:` line is on and every
  requirement is on (the existing `buildBundle` filter); borrowed requirements come from the pins
  (`PackageHost.requires()`), offered when a person granted the ACL row (`/api/acl`; until S6).
- **Platform.** `Registry.pins()` / `manifestPins` / `pinsOf` read what each registered app's build pinned;
  `neos_registry.pins` (022) exposes the same. `packageAbilities`, `declaredDoors`, `skillLines`, the backfill's line
  metadata and the gateway's ability version read the host manifest instead of `registry_installs`. B9 uses the pins
  (the re-registering app's own pins from its new manifest, so a build that removes a package may drop what only it
  needed). **Publish (S7):** `Registry.submit` refuses `409 breaks_pinned` when a package version drops, recasts or
  moves the major of an ability its previous published version offered and some pinned entry requires, unless that
  previous version was deprecated more than 30 days ago; `retire` counts pins from manifests. Removed:
  `install`/`uninstall`/`forHost`/`dropPackageTables`, `pendingPackageMigrations`/`markPackageMigrated`/
  `failPackageInstall`/`applyPackageMigration`, `/internal/registry/entries`, `/internal/registry/artifacts/:hash`,
  `ops.ts drop-package-tables`; `POST/DELETE /api/registry/installs` answer `410 install_at_build`. The catalog's
  `installs` are the pins of the company's installed apps. `neos.registry_installs` and `neos.package_migrations`
  stay, unread and unwritten, until S9.
- **Scripts.** `scripts/neos-publish.ts` (replaces `publish-package.ts`): a package as an operator (optional
  `NEOS_AUTHOR_KEY_FILE` signs the content hash) or a skill folder via `registry.ts publish`. `scripts/migrate.ts`
  has no package step. `apps/ledger/scripts/dev.ts` no longer publishes/installs nep-gst (it is in the build).
- **nep-gst** was installed with the script against a throwaway registry (the committed lock therefore records that
  registry's key; production re-runs `neos install … --trust <production JWKS>` before the first deploy, or sets no
  `NEOP_REGISTRY_JWKS` and relies on the recorded key). Ledger now ships nep-gst for every company, at its floors
  (`gst.gstr3b.file` ask-first).
- **Tests.** New `apps/ledger/tests/install.test.ts` (hash mismatch; three bad signatures; a failing self-test; the
  build untouched on each refusal; migrations appended in order with their proof and in the DBA bundle; roles; a
  hand-edited file at spawn and per call; remove; a skill-only entry against its lines and a changed row; the
  nep-gst proof on a populated and on a pre-v3-installed book). Ported, same meaning: `registry.test` (install at
  build; self-test fail → build untouched; a failed update leaves the old pin; table drop via a contract migration;
  a borrowed skill pinned at build + admin grant; an added requirement greys the skill until granted), `gst.test`
  (no run-time install; asserts the lock), `gst-package.test` (+ the built copy is the source), `registry-v3.test`
  (B9 from manifests; publish `breaks_pinned`; retire from pins; 022 proof), `governance.test` (catalog shows the
  build's pin; close lines per company; remove/reinstall without re-running migrations), `security.test` (H5 with
  the package in the build; the removed internal registry endpoints are 404), `hardening.test` (service secret
  proven on the build's registry lookup), migration lists in `migration`, `v3-conformance`, `migration-018-019`,
  `migration-020`, and `dba-bundle` (section 6). testkit: `installAndRebuild`, `removeAndRebuild`, `hostCopy`,
  `pilotRegistry`, `Pilot.rebuild` (migrate the new build's file, restart on it, re-register).

## v3 S5 · NeuralChat speaks Matrix (2026-09-28)
`docs/V3-MIGRATION-PLAN.md` stage S5; WP v3 §1 steps 3–8, §7, §8, §12. Platform migration **023** (proof:
`packages/platform/tests/migration-023.test.ts`); no template migration (t012's tables were enough).
- **The Matrix tool** (`packages/platform/src/neuralchat-matrix.ts`, `NeuralChatMatrix`; `startPlatform({neuralchat})`,
  env `NEOS_NEURALCHAT_MATRIX=off|appservice|client`, `neuralChatConfigFromEnv`). NeuralChat's own name per company:
  appservice `@neuralchat_<slug>:<server>` (the platform's registration; `@neuralchat_.*` was already reserved), client
  one configured account per company (`MATRIX_NEURALCHAT_ACCOUNTS[_FILE]`, whoami-checked, /sync cursor in
  `neos.neuralchat_accounts`). **Which road** (`routeFor`): Matrix when the app's install row (its own schema, read as
  the desk) names its Matrix user — i.e. the app runs with presence — and NeuralChat has a name at the company
  (appservice: and the app has a bound room); otherwise the gateway road, unchanged (presence-off installs; flagged S9).
  Only a person's own ask from Conversations (`requester user:`, origin app) takes it; room bridges and a2a tasks are
  S4/S6's.
- **Out.** `openTask` marks the task `road = 'matrix'` and `deliver()` posts a typed `neos.neop.task` as NeuralChat, in
  the app's first room (appservice: registered and joined once per process) or its 1:1 room with the app's account
  (client: `createRoom` + invite on first use, `neos.neuralchat_rooms`), the thread rooted there. Body: `task_id` = the
  neos task id, `company` = slug, `on_behalf_of` = the person's Matrix id, or for a person with none a name in
  NeuralChat's namespace (`personName`: `@neuralchat_<slug>_person_<user id hex>`) that `syncChat` writes into the app's
  `people` (`chat_person` false — never a sender), `text`, `fields` (files, follow-up job), `trace`. txnId
  `nc-task-<task>`: a resend after a failure is the same event. The ask waits up to `ackWaitMs` (3 s) for the app's
  "on it" so its answer carries the job id as before; `P.ask` (testkit) waits for the job id if it came later.
  **Retry** (`tick`, `neuralchatMs`): a send the homeserver refused is resent (same txn) with backoff; a posted event is
  Matrix's to redeliver; a task unacknowledged past the delivery window is FAILED ("the app never acknowledged the task
  in Matrix"). `deliverTask` / `tasksTick` skip Matrix tasks (gateway road only).
- **In.** Every typed event in one of NeuralChat's task threads (appservice: `neuralChatRoutes`' transactions endpoint,
  or the bridge's, which now offers typed events to NeuralChat first; client: its /sync) is claimed once in
  `neos.neuralchat_events` (event id), accepted only from the app's own Matrix name, validated, and read: `note` ack →
  `job_id`, ACKNOWLEDGED, "On it — …" in the conversation, the bytes dropped; other notes → a `step` line ("· …"; 023
  adds the kind) and the status re-derived from the desk views (a pending card → WAITING, an open question →
  NEEDS_INPUT, else ACKNOWLEDGED); a `stale-` note → a notice; `ask` → the question in the conversation + NEEDS_INPUT;
  `propose` → "Waiting for a yes on your desk: <what>" + WAITING; `done` → result, COMPLETED/FAILED/CANCELLED, the result
  line, open question projections STALE. Each read is a span (`neuralchat.read <type>`) in the task's trace.
- **The outbox consumer** no longer drives a Matrix task: `job.acknowledged`, `proposal.created/executed`,
  `question.asked/answered/expired` (status, conversation lines), `card.raised`, `task.completed/failed` skip it (the
  `neos.questions` projection, audit, a2a and dead-letter roles stay). Chosen per task (`road`), not per app, so a
  gateway task opened before presence was switched on still gets its status.
- **Answers, never approvals.** A person's reply in the conversation to an open question of a Matrix task
  (`answerFromConversation`) is checked (`checkAnswers`) and sent as a typed `neos.neop.answer` in the thread
  (`sendAnswer`, txn `nc-answer-<wait>-<digest>`); the app records it through `answer_wait()` as relayed by
  NeuralChat (`bridge:@neuralchat_…`, untrusted data — S3's rule for relays). The desk still answers on the row
  directly (`POST /api/questions/:id/answer`, DeskHarness). NeuralChat has no approve path at all: cards are answered on
  the desk (`answer_proposal`) or by a person as themselves in their room.
- **The app side** (template, small): `runner/inbound.ts` `onTask` — reserved `fields` (contracts `readTaskFields`:
  `neos_file_<n>`, `neos_parent_job`) are taken out of "Fields given"; files are fetched by reference
  (`presence/files.ts`: the link is a platform PATH resolved against the backend's own `platformUrl`, size and sha256
  checked, else `typed:file_refused` and no job); the sender's task id is the job's `task_id` when it is a uuid no other
  sender's job holds (so a resend as a new event finds the same job, and the desk's cards/questions carry the neos task
  id); `trace` → a `presence.task` span and the job's trace. `open()` gained an options argument. S6 also edits this
  file (NEOP-sender handling): the change here is confined to `onTask` and `open`.
- **Contracts.** `trace` (W3C traceparent) is an optional body field of task, ask, answer, propose, done, note (not
  approve); `TaskFileRef`, `taskFileField`, `readTaskFields`, `TASK_PARENT_FIELD`.
- **Tests.** New `apps/ledger/tests/neuralchat-matrix.test.ts` (both roads: one typed task by NeuralChat's own name in the
  app's room/DM, no tasks.open, job opened once under redelivery / same-txn resend / a second event; note/ask/propose/done
  in the conversation and `neos.tasks`; the person's conversation answer → typed answer → `answer_wait()`; approval only
  through DeskHarness, no approve event on the road; files by reference, no bytes in events, 410 after; trace
  continuity), `presence-redelivery.test.ts` (app down → Matrix redelivers → once; homeserver down → same-txn resend;
  window → FAILED), `packages/platform/tests/migration-023.test.ts`. Ported with a Matrix variant next to the platform
  one: `flow` (gated ask, cancel), `e2e`, `attachments`, `observability` (one trace: neos.ask → neuralchat.task +
  presence.task → … → door, no tasks.open span), `live-validate` (`--expect-road matrix|gateway`, a Matrix run of writes,
  questions, documents). `task-delivery.test` stays for presence off. testkit: `bootPilot({presence, neuralchat:true})`,
  the fake homeserver routes every event between registrations (per-target queue, retried like Matrix),
  `fakeMatrix` (several client accounts on one homeserver). `scripts/neuralchat-sim.ts` unchanged (#143, plain text).
- **Not done here / for S9.** The gateway road (`tasks.open`, `inbox.deliver`, `tasksTick`, the consumer's task role) stays
  for presence-off installs. `cancelTask` still calls L3 `tasks.cancel` (there is no typed cancel event; the job's
  `task_id` is the neos task id, so it finds it) — S9. a2a tasks and questions asked by a callee are S6's. The app's
  typed replies do not carry `trace` yet (the platform reads them under the task's stored trace).

## Deliberately not built from WP v3
- **Voice.** The NEOS app transcribes speech on the device/client before it calls `POST /api/ask`; the platform and every NEOP take text only. Nothing here receives audio, so there is no speech model, audio store or consent flow to build or secure on this side. An audio note a person wants kept is an attachment like any other file (kept by the document store).
- **pgvector `similar_to`.** No Ledger ability needs similarity search: every Ledger read is exact (accounts, parties, documents by number, dates, amounts), and matching bank lines is rule- and amount-based. When an app does need it, it is the app's own concern inside its own schema, as §11 says: its migration adds `create extension if not exists vector` (the DBA enables the extension once per database), a `vector(n)` column on its own table with `company_id` and RLS like every other table, and an index (`hnsw`/`ivfflat`); a `similar_to` read is then ordinary SQL (`order by embedding <=> $1 limit k`) in that app's repository. Embeddings are computed in the backend through the LLM proxy, never by the assistant with a key. No separate vector store.

## Stand-ins (pilot only)
- **NeuralChat** — `pickApp()` matches the ask against manifest words. The real NeuralChat replaces it.
- **Identity** — dev bearer tokens in `neos.users`. Real sign-in replaces it.
- **LLM proxy prices** — defaults are placeholders (`NEOP_LLM_PRICES` sets per-contract prices); unknown models are refused.
- **The desk** — a test harness that renders blocks; the NEOS app adopts the renderer (`docs/pilot-ledger-integration.md`).
- **Approvals on the NEOS platform** — My Desk there is read-only today; until it gains the fingerprint-bound decide route, yeses are answered on this repo's platform module (which, since v3 S2, only calls the app's `answer_proposal()`).

## Not built yet
- **To confirm with a commercial GSP account** (cannot be tested without one; the fake GSP follows the public GSTN taxpayer API pattern):
  - the GSP's exact paths, header names (client id/secret, any GSP API key), and whether it wants plain JSON (assumed: the GSP does GSTN's AES/RSA payload encryption and the EVC signing envelope) — a direct GSTN integration would need that encryption in `gsp.ts`;
  - the OTP login semantics (API access enabled on the portal for the username, token lifetime, refresh window) and the `EVCOTP` call's exact form;
  - the error codes it uses for an expired session (we treat HTTP 401/403 and any `AUTH*` code as an auth problem) and for validation failures;
  - the filing sequence for the current GSTR-3B: we SAVE → SUBMIT → FILE; offsetting the liability (RETOFFSET) and paying tax (PMT-06 challan / cash ledger) are **not** implemented, so a return with net tax payable will be refused by the portal until the liability is offset;
  - the shape of RETSUM (we compare only the figures we sent) and RETTRACK (`EFiledlist`, `status: Filed`);
  - DSC signing (only EVC is implemented).
- A desk card field for a person's write-only door input (OTP/EVC), instead of the `gst_portal_otp` secret-store slot.
- The registry improvement loop (plan: after the second app ships).
- Wage (if chosen as the second real NEOP).
