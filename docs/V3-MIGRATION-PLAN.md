# Moving to NEOP-WHOLE-PICTURE-v3 (no gateway, no platform API)

Decided 28 September 2026: follow v3 fully. Only a person approves (desk, or their own approve event) — nothing
approves on a person's behalf. Fallback: tag `pre-v3-fallback` (rehearsed, deployable).

## What stays on the NEOS platform (v3 §1)
Companies, users/auth, Conversations, NeuralChat (reads `neos_registry`), the desk UI, registry publish.

## Where everything else goes

| Today (platform / gateway) | v3 home |
|---|---|
| installs, switchboards, rules, budget, approver policy | `<neop>.installs`, `<neop>.switchboard` — desk role writes (tighten-only trigger), app reads, NOTIFY invalidates the gate cache |
| grants, execution tokens | `<neop>.grants` via `create_grant`/`revoke_grant`; the gate matches locally, the runner executes |
| approvals worker, `neos.approvals` | `<neop>.answer_proposal()`; runner's approved path; `neos.v_pending_approvals` |
| questions | `<neop>.waits` + `<neop>.answer_wait()`; `neos.v_open_questions` |
| gateway (auth, ACL, ledger, audit, JWKS) | Matrix sender + membership + power levels, runner's sender-class check; `operations` + event_id dedupe; `neos.v_activity` |
| outbox / tasks delivery / Matrix bridge | NEOP `src/presence` + `runner/inbound.ts` + `runner/mirror.ts` (typed events, m.notice fallback) |
| a2a, borrowed abilities, `neos.acl` | typed task/ask/answer/done in `#neop-bus-<co>`; lineage in the task body |
| vault lend | secret store read by the NEOP backend per (app, company) per call |
| LLM session tokens | minted by the runner; the LLM proxy stays as ops infrastructure |
| registry installs / runtime package migrations | packages installed at build time (`neos install`), switched per company by lines |
| schedules, blocks, transcripts | `set_schedule()`; blocks bind to app-declared views; desk views |
| backups | `pg_dump` per schema + Synapse + secret store |

## Stages (each green and deployable)

| Stage | What | Risk |
|---|---|---|
| S0 | t007–t009, answer_proposal, NOTIFY, mirrors, DBA bundle, desk views, `neos_registry`, typed events (in flight) | — |
| S1 ✅ | Switchboard/installs/grants become truth in the app schema (t010, backfill script); gate reads the DB | medium — **done 2026-09-28** (below) |
| S2 ✅ | The runner carries out the yes (LISTEN + poll, SKIP LOCKED, fingerprint check); approvals worker and execution tokens deleted | high — money path — **done 2026-09-28** (below) |
| S3 | Desk on the database; `answer_wait()`; DeskHarness in testkit | medium |
| S4 | Presence in the NEOP (appservice + client road, flag `NEOP_PRESENCE`); NeuralChat #143 plain text keeps working (task/answer, never approve) | high |
| S5 | NeuralChat posts typed tasks as its own Matrix identity; tasks/outbox delivery deleted | medium |
| S6 | NEOP to NEOP on the bus room; callee asks answered by the caller | medium-high |
| S7 | Packages at build time; publish writes `neos_registry` | medium |
| S8 | Doors from the secret store; LLM tokens without the platform — **done** (IMPLEMENTATION-NOTES "v3 S8") | low-medium |
| S9 | Delete the gateway, L3, platform-client, execution-token and legacy platform tables | low |

Merge order: A-S1 → B-S1 → A-S2 → B-S3 → C-S4 → B-S5 → C-S6; D-S8 after A-S1; D-S7 after B-S3; S9 last.

Work packages (disjoint files): A book + approved path (template); B platform + desk (platform, testkit);
C presence + Matrix + bus room; D packages, doors, deploy kit.

## S1 — done (2026-09-28)
What changed (details: `docs/IMPLEMENTATION-NOTES.md` › "v3 S1"):
- **t010** makes `<neop>.switchboard` (the company's switches, the company row `*` with rules/caps/default approver
  policy, per-write approver policy, a board version per transaction, `switchboard_history`), `<neop>.installs`
  (company name, time zone, Matrix user, rooms, agent senders, status) and `<neop>.grants` (+ `grant_uses`) the truth.
  A tighten-only trigger mirrors the platform's checks; every change NOTIFYs `board:<company>`; a grant suspends
  itself (trigger) when a grant-approved proposal ends FAILED/UNKNOWN. SECURITY DEFINER `create_grant`,
  `revoke_grant`, `suspend_grant`, `set_schedule`, `import_grant`.
- **Roles.** `neos_desk`: DML on switchboard/installs, EXECUTE on answer_proposal and the grant/schedule functions,
  SELECT on history and grants — via t010, pgkit `applyDeskGrants` (every migrate, `migratePlatform`) and the DBA
  bundle. The app role only reads. The platform reaches app schemas as `neos_app` → `SET LOCAL ROLE neos_desk`
  (membership WITH INHERIT FALSE; transaction-scoped, PgBouncer-safe).
- **Platform** writes through (`boards.ts`) and reads the board, installs and grants from the app schema; the HTTP API
  is unchanged. `neos.switchboards` / `neos.grants` are frozen legacy copies; `neos.installs` is kept in step for the
  gateway/bridge/NeuralChat until S9. No switchboard push; `grantExecutionToken` and its internal route removed.
- **Template.** The gate's board comes from the database (runner pool), dropped on NOTIFY, 5 s TTL; grants are matched
  and recorded locally and executed inline (no platform, no token). `data/mirror.ts` retired.
- **Backfill.** `scripts/v3/backfill-boards.ts` (idempotent, never stale-over-new); also at `registerApp`,
  `installApp` and the end of `scripts/migrate.ts`. **Deploy order:** migrate (t010) → backfill (automatic in
  `scripts/migrate.ts`) → new backends. A backend that meets an install row without a time zone refuses to act for
  that company (fail closed) until the backfill ran.
- Deferred: approver policy still checked by the platform (S2/S3 moves it into `answer_proposal`); person-approved
  execution still uses the execution token (S2); `room_ids`/`agent_senders`/`matrix_user` filled by S4. (Both S2 items
  done — see S2 below.)

## S2 — done (2026-09-28)
What changed (details: `docs/IMPLEMENTATION-NOTES.md` › "v3 S2"; operations: `docs/RUNBOOK.md` › *Approvals*):
- **t011**: `answer_proposal(…, p_roles)` checks the approver policy (roles; four-eyes against the job's own requester)
  in the database; a yes still readies no wait; `approved:<id>` NOTIFY when a proposal becomes APPROVED.
- **Runner** (`runner/waits.ts`): LISTEN hint + poll of APPROVED / orphaned EXECUTING rows, claimed with `FOR UPDATE
  SKIP LOCKED` + the execution advisory lock, carried out once by `capabilities/execute.ts` under `runner:<id>`
  (fingerprint on the `answered:yes` event, expiry, version, switch, rules checked at effect time), then the wait is
  made ready and a fresh assistant woken with the proof. Grant-approved proposals stay inline in the gate (same
  execute; the runner adopts one left APPROVED > 30 s).
- **Platform**: the desk answer, the room/DM reply and the typed approve call `<app>.answer_proposal()` as `neos_desk`;
  HTTP contracts unchanged. Deleted: the approvals worker (`approvalsTick`/`driveApproval`/`withdrawApproved`), the
  platform's approver check, the L3 `proposals.resolve`/`proposals.execute` routes, `verifyExecution`, execution-token
  claims. **020**: `neos.approvals` frozen (read-only legacy copy), card ids are proposal ids (room/DM rows rewritten),
  `neos.v_desk_cards` feeds the desk list. **Drain**: `scripts/v3/drain-approvals.ts` (also end of `scripts/migrate.ts`).
- **Deploy order:** migrate (020, t011, drain) → new backends.

## Deploy kit after the move
DBA bundle per NEOP (schema, roles, grants, functions, triggers, view registration) → one DB link per NEOP role
(direct URL for LISTEN/advisory locks); one `appservice.yaml` per NEOP (`@neop_ledger_.*`) plus `@neuralchat_.*`;
`rooms-setup` (invite-only, no E2EE, power levels: people 50, reasoning agent 10, NEOPs 20; approve needs 50);
door secrets mounted read-only into the backend only; `neos_desk` link only to the desk UI; verify-install checks
role isolation, desk grants, triggers, appservice, rooms, secrets.

## Defaults taken (change if you disagree)
1. The NEOS team runs the desk UI; our pilot desk and test harness call `answer_proposal`/`answer_wait` directly.
2. `neos-v1` (NEOS `/capabilities` adapter) is removed with the gateway (it is an API into the NEOP).
3. Secret store: file mounts (`/run/secrets/doors/<co>/<door>.json`) until ops picks Vault / a cloud manager.
4. Borrowing: `neos.neop.ask` carrying `{ability, args}`; lineage in the task body, depth ≤ 3.
5. Approver policy (roles, four-eyes) stays in the switchboard and is checked inside `answer_proposal`; room
   approvers are recorded as `mx:@…` and mapped to the person.
6. The desk writes grants, schedules and question answers only through SECURITY DEFINER functions.
7. Attachments: object-storage refs in the event body.
8. NeuralChat keeps `@reasoning_agent` over the client road until it moves to `@neuralchat_<co>`.
