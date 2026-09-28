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
| S1 | Switchboard/installs/grants become truth in the app schema (t010, backfill script); gate reads the DB | medium |
| S2 | The runner carries out the yes (LISTEN + poll, SKIP LOCKED, fingerprint check); approvals worker and execution tokens deleted | high — money path |
| S3 | Desk on the database; `answer_wait()`; DeskHarness in testkit | medium |
| S4 | Presence in the NEOP (appservice + client road, flag `NEOP_PRESENCE`); NeuralChat #143 plain text keeps working (task/answer, never approve) | high |
| S5 | NeuralChat posts typed tasks as its own Matrix identity; tasks/outbox delivery deleted | medium |
| S6 | NEOP to NEOP on the bus room; callee asks answered by the caller | medium-high |
| S7 | Packages at build time; publish writes `neos_registry` | medium |
| S8 | Doors from the secret store; LLM tokens without the platform | low-medium |
| S9 | Delete the gateway, L3, platform-client, execution-token and legacy platform tables | low |

Merge order: A-S1 → B-S1 → A-S2 → B-S3 → C-S4 → B-S5 → C-S6; D-S8 after A-S1; D-S7 after B-S3; S9 last.

Work packages (disjoint files): A book + approved path (template); B platform + desk (platform, testkit);
C presence + Matrix + bus room; D packages, doors, deploy kit.

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
