# Platform user flow → code → proof

Source: `docs/source/platform-user-flow.jpeg`, with the technical plan's three
corrections applied: inbound reaches the app as a signed gateway call (B4), the
wait turns ready only after execution finishes (B2), and results travel as typed
task completions, never scraped from a room (6b).

| Step | What the diagram says | Where it lives | Proved by |
| --- | --- | --- | --- |
| 1 | Person asks in the NEOS app (text; voice is transcribed upstream) | `POST /api/ask` · `Platform.ask` | flow.test |
| 2 | Conversations: what was said and what came back | `neos.conversations`, `conversation_messages` (kinds: message, handoff, ack, waiting, card, result, notice) — the ask is stored **before** routing | flow.test "(2)…", "(1)→(9)…" |
| 3 | NeuralChat picks the app and carries on (does not block) | `pickApp` stand-in over registry context; `/api/ask` returns at once | flow.test (< 3 s, `handed_to` chosen, not named) |
| 5a | Registry context: apps, installs, what each can do, which need a yes | `neos.installs`, `Platform.registryContext`, `GET /api/registry`; gateway refuses uninstalled companies | flow.test "(5a)…", tenant.test "not installed" |
| 4 | Task written to the task store | `neos.tasks` (origin app/room) | flow.test, rooms.test |
| 5 | Picked up | `deliverTask` + retrying `tasksTick` | e2e.test |
| 6 | Request acknowledged at once | L3 `tasks.open` → job RECEIVED + `job.acknowledged` in one txn; "On it" to conversation and room | flow.test, rooms.test |
| 6b | Reply onto the task | typed `task.completed` / `task.failed` outbox events → `neos.tasks.result` | flow.test, e2e.test |
| A | People talk to an app in AgentSpace rooms and watch it work | `ChatBridge` (`packages/platform/src/bridge/`), Matrix appservice adapter, `neos.rooms`, per-company identity `@neop_<app>_<company>` | rooms.test |
| Chat bridge | Knows who is writing, checks company, permissions, approvals, one chat user per app, audit trail | `ChatBridge.onMessage` (sender → person in that company, install check, card replies → answers), `neos.room_events` | rooms.test "knows who is writing…" |
| 7 / B | Into the app | Room asks: task row + signed `inbox.deliver` (never a raw push) | rooms.test, inbound-auth.test |
| 7.1 | Runner opens a job, replies "on it" (in the room) | `openJob`; outbox → room mirror | rooms.test |
| 7.2 | Fresh assistant per job: no keys; job, switched-on list, book, SKILL.md | `Runner.spawn`, `buildBundle`, job token | resume.test, jobtoken.test |
| 7.3 | Says what it understood, plans, one step at a time | Starter prompt (`SYSTEM.template.md`) | — (prompt; not enforceable) |
| 7.4 | Gate: on → do · ask first → proposal · off / cap / rule → refuse | `Gate.call` | switchboard, proposal, injection tests |
| 7.5 | Abilities: own · packages' · borrowed via gateway | Own; packages via the Deno sandbox (`packages/host.ts`); borrowed reads through the gateway (`gate/borrowed.ts`) | registry.test, marketing phase4.test |
| Doors | Email · cal · social · keys per call | Email door; key lent by the vault per call | proposal.test, lifecycle.test |
| Record book | jobs · steps · waits · proposals · grants · operations · facts · outbox | `001_standard.sql` (grants moved to the platform, D8) | migration.test, tenant.test |
| 7.6 | Proposal: exact content + fingerprint + expiry; card → room + desk; job WAITING; assistant released | Gate ask-first path; `proposal.created` → desk card, conversation "waiting", room card with the full fingerprint | proposal.test, rooms.test |
| 7.7 | Person answers on the desk or in the room | `Platform.answer` for both; a room answer must reply to the card and binds to the fingerprint *that card showed* | proposal.test, rooms.test (incl. stale card) |
| On the platform | The yes on its own row → gateway → app resolve → carried out ONCE → read back → DONE | `neos.approvals` state machine + leased worker; `executeProposal`; concurrent executes refused (`in_progress`) | wake-order.test, proposal.test (race) |
| wait ready | The runner is told | `readyWait` only on DONE/FAILED/UNKNOWN or a non-yes answer; NOTIFY + poll | wake-order.test |
| 7.8 | Fresh assistant with answer + proof; it checks; REPORTED | `resumed` and `reported` on `proposal_events`; the prompt forbids re-executing | flow.test (trail: proposed → answered → executing → executed → resumed → reported) |
| 7.9 | Result in the room: what it did, changed, could not do | Typed `TaskResult` → room message | rooms.test |
| 8 | Conversations gets the result from the finished task | Outbox consumer writes the `result` message | flow.test |
| 9 | Answer in the NEOS app, or in the room if asked there | `/api/conversations/:id`; room mirror | flow.test, rooms.test |
| Underneath | One database; one family per app with its own migrations and role; desk reads no app tables | Schema per app (D1); tenant lint; desk built from outbox events (S4) | migration.test, tenant.test |

## Gaps found against the diagram, and what was done

| Gap | Fix |
| --- | --- |
| The ask was stored only after an app was chosen; lost if none fit | Conversations first; `neos.conversations` threads |
| No installs: any company could reach any app | `neos.installs`; gateway refuses `not_installed`; NeuralChat sees only installed apps |
| No registry context for NeuralChat ("which need a yes") | `registryContext` / `GET /api/registry` with effective settings |
| No chat bridge; rooms could not ask, see cards, answer or get results | `ChatBridge` + Matrix appservice adapter (tested against a fake homeserver) |
| "REPORTED" (and "RESUMED") missing from the approval trail | `resumed` / `reported` proposal events |
| Conversation never showed "on it" or "waiting for your yes" | `ack` and `waiting` messages from outbox events |
| Task stayed WAITING after the yes was carried out | `proposal.executed` returns it to ACKNOWLEDGED |
| Job state CANCELLED had no path | `tasks.cancel` (platform-only): withdraws open proposals, closes cards, stops the session |

## Bugs the flow tests exposed (fixed)
- **Overlapping executions.** The approvals worker released its lease after resolve and the periodic tick executed the same approval again. The door's idempotency key prevented a second email, but the outcome was written twice. Now: the lease is kept, the app refuses a second concurrent execute (`409 in_progress`) and resumes only a stale one, and the outcome is written once under a row lock.
- **Duplicate outbox application.** Overlapping outbox pulls read the same cursor. Now each pull holds the app's cursor row (`FOR UPDATE SKIP LOCKED`) and timer loops never overlap themselves.
- **One bad event stalled the outbox for good.** Each event now applies in its own savepoint; a failing one is parked in `neos.outbox_dead_letters` and audited, and later events flow.

## Still open
- **Phase 3 wiring**: register `deploy/appservice.yaml` with the real homeserver, create rooms and invite the app identities, and link people's chat IDs (`ChatBridge.linkUser`). The existing Matrix stack stays deployed beside NEOS, never through it.
- **Room answers need a reply to the card.** A bare "yes" in the room is treated as a new ask. This is deliberate: the answer must bind to the fingerprint of the card the person replied to.
- **Approver policy**: any person in the company may answer a card. *Decision needed:* roles per ability, four-eyes (the requester cannot approve their own), or amount thresholds.
- **Dead-letter replay**: parked events are kept and audited; a replay tool is Phase 6.
- **Doors to real providers** (email, GST portal) for production.
