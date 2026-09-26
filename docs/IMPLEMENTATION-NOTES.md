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
    - **What the load test asserts** is the plan's metric, the app's own ack time: at 200 concurrent new jobs, p95 ≤ 200 ms.
    - **End to end through the gateway** it is ~450–530 ms in the test harness. There the platform, app and agents share one Node process, so token signing and verification queue on one thread. Measure it again on the real topology before quoting it.
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
36. **Package abilities are switchboard lines.** An installed package's abilities (from the registry entry's `offers`) can be tightened per company like the host's own, never below the package's floor.
37. **Governance surfaces:** list/create/withdraw standing yeses (admin-only withdraw, audited; money needs a cap; expiry ≤ 1 year), who may ask Ledger (ACL list), the audit trail (paged, filtered, named), the registry catalogue (offers, requires, signature, pins), switchboard history, assistant spend against caps, and a job's full record (approvals with who and fingerprint seen, proof, cost, standing-yes uses). A reconciled UNKNOWN now updates the desk's proof.
38. **LLM proxy speaks to OpenRouter too:** `NEOP_LLM_UPSTREAM_AUTH=bearer` and `NEOP_LLM_UPSTREAM_MODEL_PREFIX=anthropic/`; pricing and caps stay on the agent-facing model id.

39. **Screens are blocks; the desk is the platform's.** Blocks are validated at registration (reads only, effects only as asks, no markup) and drawn by one renderer in the platform-owned desk, which is multi-app. Ledger ships no UI code. (`contracts/src/blocks.ts`, `platform/src/web/`.)
40. **Bookkeeping logic stays in the app.** The home figures and the close checklist are Ledger reads (`ledger.home.summary`, `ledger.close.checklist`), not screen code.
41. **Skills are switchboard lines** (`skill:<key>`, on/off), dropped at spawn when off or when a tool they need is off.
42. **Uninstall disables a package and keeps its tables**; the platform tells the app at once (`switchboard.changed` also drops the package cache).
43. **PgBouncer in transaction mode** for query pools; LISTEN and the execution lock use a direct connection (`NEOP_DIRECT_DB_URL`); statement/lock/idle timeouts are role defaults set by the migrator.
44. **Listeners bind per network.** L3 only on the l3 network (`ledger-l3`), the gate only on the agent network (`ledger-gate`), the agent only on its backend's network (`ledger-agent-rpc`). Register apps by the l3 alias. A runtime probe checks every row.
45. **Rooms can be re-bound** without losing history (old room retired, migration 010); admins bind rooms and link chat identities over the API; the bot registers in the appservice namespace and joins before it speaks.
46. **Reports always cite sources.** If the assistant does not list them, `job.finish` fills them from the reads the job made (each read step records its basis).
47. **Borrowing ranges are checked at registration, both ways.** A `uses` entry must name a read at a version in its semver range; an owner cannot re-register in a way that breaks a borrower. An owner not registered yet is checked when it registers, so deploy order is free.
48. **Every migration is listed in `migrate.json`**, in order; in production each must carry `proven_on_populated_data` (migration.test proves on a populated copy, then marks it). An unlisted, missing or out-of-order file is refused before anything runs.
49. **The `neop.v1` bridge to today's NEOS platform** (`docs/pilot-ledger-integration.md`): the descriptor is generated from the manifest; reads, `ledger.ask` and `ledger.job` are capabilities; `ledger.proposal.decide` is human-gated and never dispatched; every operation token is verified claim by claim against the exact body and burned.
50. **Every output schema is closed** (`additionalProperties: false` at every level), so results can be validated strictly by the platform and a new field is a deliberate, versioned change.
51. **The desk is a test harness** (compose profile `test`, refuses production); the product UI is the NEOS app.

52. **GSTR-3B through a GSP (nep-gst 2.0.0).** What is real and tested (`gst.test`, `gst-package.test`, `registry.test`):
    - **Figures from the books.** `gst.gstr3b.prepare` takes only the month; it reads `ledger.report.vat_summary`, `ledger.report.pnl` and the tax accounts through `ctx.reads`, and its input schema refuses typed-in amounts. Each read is a step with its basis; the output tax, ITC, taxable value and split are facts with their source.
    - **The GSTN GSTR-3B document** (`gstin`, `ret_period` MMYYYY, `sup_details` 3.1, `sup_inter` 3.2, `itc_elg` 4 with `itc_avl`/`itc_rev`/`itc_net`/`itc_inelg`, `inward_sup` 5, `intr_ltfee` 5.1), rupees to 2 decimals from paise, validated against `registry/nep-gst/gstr3b.schema.json` (the handlers embed the same schema; a test checks it, and Ajv plus the fake GSP's independent GSTN checks agree).
    - **Tax heads.** Read per head from the books when every tax account names IGST/CGST/SGST/cess (must add up to the VAT summary). Ledger's standard chart keeps one output and one input account, so it **cannot** distinguish; then the door's `assume_supply` (intra_state → CGST = SGST, odd paisa to CGST; inter_state → IGST) applies and is stated on the return, the card and the facts. No assumption configured → prepare refuses. Also assumed and stated: taxable value = revenue; zero-rated/exempt/non-GST/reverse-charge, imports/ISD/reversals/ineligible ITC, the 3.2 place-of-supply table, interest and late fee are 0.
    - **GSP flow** in the door: OTP login (OTPREQUEST → a person enters the OTP on the `gst_portal_otp` vault slot → AUTHTOKEN), token refresh and re-login on auth errors, RETSAVE → RETSTATUS, RETSUM read-back compared figure by figure, RETSUBMIT → RETFILE with EVC (`sid` = PAN|OTP) → ARN, RETTRACK read-back. Tokens live only in backend memory per company; OTPs are never in a tool result or the database, and a used OTP is not replayed. Paths and extra headers are configuration.
    - **Filing is ask-first and bound to the saved document:** `normalize` puts the saved return's id, figures and sha256 into the proposal, so the fingerprint covers what is filed; execute refuses if the saved return changed or the portal's copy differs; a month already on RETTRACK is never filed again; a filed month cannot be proposed again.
    - **Faults tested against the fake GSP:** auth expiry → refresh → retry; refused refresh → new OTP, definite failure; 4xx validation → FAILED, nothing saved; filing answered 503 with an outage → UNKNOWN → reconciled by RETTRACK → DONE, filed once; filing that times out → read-back confirms, not re-sent.
    - **The person's OTP goes through the vault, not the desk card.** The desk answer carries only decision/fingerprint/feedback and feedback is shown to the model, so an OTP cannot travel there. Until the desk gains a write-only "door input" on a card (a platform change), the admin enters it on `PUT /api/vault/gst_portal_otp`. The console's door form (`platform/src/web/public/app.js`) still offers the old `http` GSP fields and needs the `gsp` fields.

## Stand-ins (pilot only)
- **NeuralChat** — `pickApp()` matches the ask against manifest words. The real NeuralChat replaces it.
- **Identity** — dev bearer tokens in `neos.users`. Real sign-in replaces it.
- **Vault** — plaintext JSON in `neos.vault_secrets`; lent per call and audited. Needs encryption at rest before production.
- **LLM proxy prices** — defaults are placeholders (`NEOP_LLM_PRICES` sets per-contract prices); unknown models are refused.
- **The desk** — a test harness that renders blocks; the NEOS app adopts the renderer (`docs/pilot-ledger-integration.md`).
- **Approvals on the NEOS platform** — My Desk there is read-only today; until it gains the fingerprint-bound decide route, yeses are answered on this repo's platform module.

## Not built yet
- **To confirm with a commercial GSP account** (cannot be tested without one; the fake GSP follows the public GSTN taxpayer API pattern):
  - the GSP's exact paths, header names (client id/secret, any GSP API key), and whether it wants plain JSON (assumed: the GSP does GSTN's AES/RSA payload encryption and the EVC signing envelope) — a direct GSTN integration would need that encryption in `gsp.ts`;
  - the OTP login semantics (API access enabled on the portal for the username, token lifetime, refresh window) and the `EVCOTP` call's exact form;
  - the error codes it uses for an expired session (we treat HTTP 401/403 and any `AUTH*` code as an auth problem) and for validation failures;
  - the filing sequence for the current GSTR-3B: we SAVE → SUBMIT → FILE; offsetting the liability (RETOFFSET) and paying tax (PMT-06 challan / cash ledger) are **not** implemented, so a return with net tax payable will be refused by the portal until the liability is offset;
  - the shape of RETSUM (we compare only the figures we sent) and RETTRACK (`EFiledlist`, `status: Filed`);
  - DSC signing (only EVC is implemented).
- A desk card field for a person's write-only door input (OTP/EVC), instead of the vault slot.
- The registry improvement loop (plan: after the second app ships).
- Wage (if chosen as the second real NEOP).
