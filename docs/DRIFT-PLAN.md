# Closing the drift from the NEOP plan

Validation of the build against `docs/source/NEOP-End-to-End-Technical-Plan.html` and
`NEOP-WHOLE-PICTURE-v2.md` (26 Sep 2026) found the core on track — B1–B5, S1–S7, S9, C1–C6,
contracts, runner, gate, decisions D1–D8 and the Phase 6 bar — and nine drifts. This is the
order they are closed in, each with the evidence that closes it.

| # | Drift | Plan says | Step | Done when |
|---|---|---|---|---|
| 1 | The UI is a Ledger-owned JavaScript app | "blocks/ — the NEOS UI · descriptions of screens · never JavaScript"; "block renderer, My Desk: once, on the platform" (WP §8, §13) | **1a** a block contract in `@neop/contracts` with a validator (reads only; effects only as asks; no markup) · **1b** the platform stores each app's blocks at registration and serves them · **1c** Ledger's screens rewritten as blocks, its domain logic as reads (`ledger.home.summary`, `ledger.close.checklist`) · **1d** the desk moves into the platform: multi-app, one renderer, governance surfaces per app | Ledger ships no JavaScript; a block that tries a write or markup is refused at registration; web + block tests green; live in Docker |
| 2 | Skills are not on the switchboard | "A skill line is on or off only … turning a required tool off greys the skill out … the board shows the reason" (WP §10) | Skill lines (own + registry skills) on the board with needs → and greyed state; `skill:<key>` settings; the runner drops a switched-off skill at spawn | switching a skill off removes it from the assistant's prompt; test green |
| 3 | No package uninstall | "Uninstall disables the package and keeps its tables; a drop is a separate, audited platform action" | `DELETE /api/registry/installs` → `disabled`; host stops loading it; lines leave the board; re-install re-enables | test: disabled package's abilities are refused and invisible; tables kept |
| 4 | PgBouncer not deployed (S8) | "PgBouncer for queries, one direct connection per runner for LISTEN" | PgBouncer (transaction mode) in compose; app/runner query pools through it; runner LISTEN direct | live stack runs through PgBouncer; network test pins who reaches what |
| 5 | Registry has two entry kinds, not four | "four entry kinds with one header (skill, ability, package, door)" | ADR 0013: abilities and doors are declared in manifests and reached through ACL/doors; the registry holds publishable know-how (skill, package) | ADR written; plan and code agree |
| 6 | Matrix never exercised live (Phase 3) | Phase 3 exit: same job from a room and the app gives identical entries | Synapse in the `chat` profile with a generated appservice registration; a live room drives a job | a real room message becomes a job and the result is mirrored |
| 7 | Network policy only checked statically | "Both a firewall rule and a failing test guard each row" | `scripts/netprobe.ts` run inside the containers: agent/web cannot reach Postgres, vault or the internet; backend/proxy can reach what they must | probe green against the live stack |
| 8 | Phase 0 not closed | "the v2 picture should be re-issued as v3 with the 20 findings folded in" | `docs/NEOP-WHOLE-PICTURE-v3.md` · ADR review pack updated | v3 written; ADRs remain for the team to accept |
| 9 | Pilot acceptance not run | "20 real Ledger requests … 100% produce a job and an ack; every gated action has a person's yes with a matching fingerprint; zero effects without a proposal; zero duplicates; every report fact links to its source" | `scripts/pilot-acceptance.ts`: 20 real requests against the live stack with a real model, answering cards, then checking each criterion from the platform's and the app's records | report produced from a live run |

Everything is gated on the full suite, type-check and a live Docker run before it is pushed.

## Status · 26 September 2026 — all nine closed

| # | Closed by | Proven by |
| --- | --- | --- |
| 1 | `contracts/src/blocks.ts` (validator), `neos.apps.blocks` (migration 009), Ledger's 31 blocks + `ledger.home.summary` / `ledger.close.checklist`, the desk moved to `packages/platform/src/web` with one renderer | blocks.test (8), web.test (11); live desk on the dev stack; Ledger registers 31 blocks in Docker |
| 2 | `skill:<key>` switchboard lines, `skillLines()`, spawn-time filter in `agent/context.ts` | governance.test — the assistant's system prompt loses a switched-off skill |
| 3 | `DELETE /api/registry/installs` → disabled, tables kept, app notified at once | governance.test |
| 4 | PgBouncer (transaction mode) in compose, `NEOP_DIRECT_DB_URL` for LISTEN + execution lock, timeouts as role defaults | network.test; live: LISTEN from the backend's own address, app roles through PgBouncer |
| 5 | ADR 0013 | — |
| 6 | `deploy/compose.chat.yml`, `scripts/matrix-setup.sh`, bot register+join, `/api/chat/rooms`, `/api/users/:id/chat`, room re-binding (migration 010) | rooms.test; live against Synapse v1.139: a room ask → job → result; a card answered "yes" in the room → executed once, verified |
| 7 | `scripts/netprobe.ts` + `scripts/netcheck.sh`; listeners bound per network (L3 on l3, gate on agent network, agent RPC on its own) | live probe found two real gaps (agent→L3, proxy→backend/agent), fixed; policy holds in every container |
| 8 | `docs/NEOP-WHOLE-PICTURE-v3.md` | — |
| 9 | `scripts/pilot-acceptance.ts` | `docs/PILOT-ACCEPTANCE.md`: 5/5 criteria, 20 real requests, real model. The first run failed one criterion (a report without sources); the book now fills sources from the job's reads (honesty.test) |

## Re-read · 26 September 2026 — against the plan and the NEOS platform repos

A second pass read the plan's docs again together with `neos-service-platform-api` and
`neos-app-platform`, to see how the build fits the platform as it runs today.

| # | Gap | Closed by | Proven by |
| --- | --- | --- | --- |
| 10 | Phase 0 deliverable `pilot-ledger-integration.md` missing | `docs/pilot-ledger-integration.md`: where the platform is, how Ledger plugs in now, what the platform adopts | — |
| 11 | Ledger could not be installed on today's platform (descriptor registry + capability gateway) | `neop.v1` bridge (`template/src/l3/neos-v1.ts`), generated descriptor in `apps/ledger/neos-v1/`, closed output schemas | neos-v1.test (9); the platform's own `acceptDescriptorPackage` accepts the files unmodified; CI drift check |
| 12 | The desk read as a second product UI | Test harness: compose profile `test`, badge, refuses production; product UI is the NEOS app | web.test, network.test |
| 13 | "Every migration proven on populated data" was a test, not a gate | `migrate.json` per stream; production refuses an unproven file | migration.test |
| 14 | Borrowed versions not checked | semver `uses` ranges at registration, both ways | a2a.test, semver.test |

## Third pass · 26–27 September 2026 — "nothing claimed that does not work"

Four read-only audits traced every item of the technical plan, the whole-picture v2 and the user-flow
diagram to code and to a test that exercises it, and flagged anything stubbed, faked, untested or
doc-only. Every gap found was then fixed with a test, and the result was run live on a fresh Docker
stack (`neops-v3`) with a real model.

| Area | Gap found | Closed by |
| --- | --- | --- |
| Budget (S9) | per-job cap keyed by session: a crashing job could spend 5 × $5; 402 retried | cap keyed by job, 402 final with the cap named; the proxy is the only meter (llm-proxy.test) |
| Approvals (B3) | a stored `409 in_progress` could leave a card RESOLVED forever | the gateway ledgers only terminal answers; `proposal.executed` settles the card (stuck-approval.test) |
| Execute | ran after a version change or a switch-off | version and setting re-checked at effect time (runtime-gate.test) |
| Tokens | no `ability_version` claim | minted and checked |
| a2a | result could beat the wait row; a 404 counted as delivered | wait written first, 503 → retried, bounded give-up that is visible (runtime-a2a, platform-gaps) |
| Timers | no `timer` jobs, dead branch, `EXPIRED` never used | schedules + `job.wait_until`; missed slots EXPIRED (runtime-timers; live: a daily schedule fired and reported) |
| Bundle | rolling summary rebuilt, never written; facts not job-relevant | `summary` step extended across resumes; job facts first |
| NeuralChat (5a) | keyword stand-in | the model picks the app through the LLM proxy, keyword only as a recorded fallback (neuralchat.test; live through OpenRouter, including "none") |
| Registration | conformance only in CI | attestation required in production (`scripts/conformance.ts`; live: registered `attested: true`) |
| Registry (S7) | no author signature, no four-eyes, no install self-test, no audited drop | all four, with the "borrowed skill, no deploy" flow timed end to end (registry.test) |
| Keys | gateway key activation lost on restart | durable activation + retire endpoint |
| GST package | stand-in: invented endpoint, model-typed figures | GSTR-3B from the books, GSP login/save/file with the OTP from a person, filing ask-first (gst.test) |
| Ops | no backup scheduler, no trace/metrics backend, open internet egress, netcheck not in CI | nightly per-schema backups, Jaeger/Prometheus/Grafana, tinyproxy allow-list, CI netcheck (live: all hold) |
| Migrations | proofs self-attested; no expand-then-contract; RLS lint counted policies | baseline vs proven, destructive-DDL lint, policy expression checked (migration.test) |
| Chaos | graceful restarts only | kill -9 of backend/agent/platform live: 0 lost, 0 duplicate; `tasks.open` now retries for a window, not 8 attempts (task-delivery.test) |
| Inherited from the arch-shiv Ledger | — | Matrix client road (a bridge's "go ahead" is never a yes), 11 bookkeeping abilities, a no-model PDF/XLSX/CSV door wired through the ask, legacy import (docs/INHERITED-FROM-SHIV.md) |

**Still open, stated plainly:**
- A burst of 200 simultaneous asks acknowledges in p95 370–735 ms end to end on a laptop; the plan's
  metric (the app's own response) is met at p95 48 ms. See IMPLEMENTATION-NOTES #24.
- A person's GST OTP goes to a write-only vault slot, not a field on the desk card.
- The agent container exports no spans (it has no telemetry network); its session is visible through
  the gate and LLM-proxy spans around it.
- Identity is desk tokens; the product sign-in is the NEOS app's.
- The ADRs are still "Proposed" until the team accepts them.
