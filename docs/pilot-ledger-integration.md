# Pilot · Ledger on the NEOS platform

Status: 26 September 2026. This is the Phase 0 deliverable named in the technical plan (`docs/source/NEOP-End-to-End-Technical-Plan.html`, Build plan, phase 0). It sets out how the new Ledger (this repo) runs inside the NEOS platform that exists today, and what that platform needs to adopt from the plan. Nothing here asks for a second product UI. People use the NEOS app. The desk in this repo is a test harness.

Read against:

| Repo | Commit | What it is |
| --- | --- | --- |
| `neos-service-platform-api` | `98a6832` | Platform backend: descriptor registry, installs, capability gateway, NeuralChat tasks, My Desk (read-only) |
| `neos-app-platform` | `9ef707c` | The NEOS app (Next.js): the product UI people sign in to |
| this repo | `main` | The NEOP template, Ledger, and the plan's platform pieces (gateway module, approvals, switchboards, vault, registry, bridge) |

## 1. Where the platform is today

- **Installing a NEOP.** `pnpm neop:register --descriptor … --schema … --source-revision <sha> --customer-id … --actor-user-id …` registers a descriptor. A descriptor is a list of capabilities `{id, method, scope, humanGate, requestSchema, responseSchema}`, and every schema must be closed. Registration creates the installation disabled, then enables it. Where the NEOP lives comes only from operator config (`NEOP_STATIC_BINDINGS_JSON`: loopback origin, audience `neop:<key>`, signing key). *(src/neops/neop-registration.ts, neop-descriptor.ts, neop-bindings.ts)*
- **Calling a NEOP.** The browser prepares an operation, then invokes it (`POST /api/v1/neops/operations` → `…/:id/invoke`). The gateway then calls `POST /capabilities/<id>` on the NEOP. The call carries a 90 s EdDSA token:
  - iss `platform`, sub `svc:gateway`, aud `neop:<key>`;
  - claims `cust, inst, act, scope[], cap, op, mth, pth, req = sha256(body)`;
  - headers `Contract-Version`, `X-Customer-Id` and `Idempotency-Key: neop:<op>`.

  The reply must be exactly `{result, events}`. The result is validated against the descriptor with strict Ajv. A capability with `humanGate: true` is never dispatched. *(neop-gateway.ts, neop-jws.ts)*
- **The product UI.** Ledger is a hand-written React page in the NEOS app. It calls the old 14 `neos.v1` capabilities. The in-app Ledger chat is turned off, because `ledger.chat` could close books or decide payments. The "Approve payment" button is disabled. *(components/neops/ledger-app.tsx; docs/work-orders/LEDGER-067.md)*
- **Approvals.** My Desk is read-only. A worker polls `ledger.payables` every five minutes and lists open invoices; "Nothing is approved from this inbox." The semantics the platform wants are specified in its own `docs/MY-DESK-APPROVALS-BACKEND-HANDOFF.md` but not yet built: expiry, consent to the exact proposal, idempotency, and decision kept separate from execution. The plan's proposals provide exactly these.
- **NeuralChat.** A turn can delegate to a `ReasoningTask` with statuses `queued · running · waiting_on_neop · needs_input · confirmation · completed · failed · cancelled`. It resumes on `confirm | correct | answer`. An external compute worker calls NEOPs through the same gateway.

## 2. How the new Ledger plugs in now: the `neop.v1` bridge

Ledger speaks the platform's gateway contract today, from the same L3 listener and with the same rules as the plan. The bridge is in `packages/neop-template/src/l3/neos-v1.ts` and is tested in `apps/ledger/tests/neos-v1.test.ts`.

- **Descriptor.** `tsx scripts/neos-v1-descriptor.ts ledger` writes `apps/ledger/neos-v1/descriptor.json` and `contract.json`. They are generated from the manifest and CI checks them for drift. The platform's own `acceptDescriptorPackage` accepts them unmodified: 20 capabilities, with one (`ledger.proposal.decide`) non-dispatchable.

| Capability | Scope | What it does |
| --- | --- | --- |
| 17 reads, e.g. `ledger.report.pnl`, `ledger.report.trial-balance`, `ledger.documents.list`, `ledger.home.summary`, `ledger.close.checklist` | `ledger.read` | The manifest's reads (`_` becomes `-`). The switchboard applies (a read switched off is refused). Results carry `generatedAt` and `sources`. |
| `ledger.ask` | `ledger.ask` | A person's request becomes a job. Returns `task_id`, `job_id` and "On it". Emits `job.opened`. A retried operation opens the same job. |
| `ledger.job` | `ledger.read` | Where a job stands: status, summary, and the proposals it waits on (fingerprint, expiry). |
| `ledger.proposal.decide` | `proposal.decide` (humanGate) | Declared so the platform shows the gate. Never dispatched. Refused if called anyway. |

- **No write is a capability.** The old contract let the platform call `ledger.close`, `ledger.configure`, `ledger.import`, `ledger.reconcile` and `ledger.reopen` directly. Under the plan, a change to the books is always a job. The assistant proposes, the gate decides, and a person says yes to the exact card. So the new Ledger registers under contract `neop.v1`, not `neos.v1`. The platform's fixed 14-capability check (`LEDGER_V1_CAPABILITIES`) applies only to `neos.v1`, so both can exist side by side during the move.
- **What the bridge verifies on every call:**
  - the signature against the platform's public key (`NEOS_V1_PUBLIC_KEY[_FILE]`);
  - issuer, subject, audience and age (≤ 125 s);
  - `cap`, `mth` and `pth` equal this call;
  - `req` equals the SHA-256 of the exact body bytes;
  - `scope` holds the capability's scope;
  - `Contract-Version` and `Idempotency-Key`;
  - `X-Customer-Id` equals `cust`;
  - the jti is burned (single use).

  The platform customer maps to a Ledger company only through an explicit map (`NEOS_V1_CUSTOMERS`, JSON). An unmapped customer is refused. Error bodies use only the platform's safe codes.
- **Install steps (operator):**
  1. Give Ledger the platform binding's public key and the customer → company map (`NEOS_V1_PUBLIC_KEY_FILE`, `NEOS_V1_CUSTOMERS`).
  2. On the platform, add the binding (`serviceKey: ledger`, `audience: neop:ledger`, `contractVersion: neop.v1`, `origin: http://127.0.0.1:<port>` reaching Ledger's L3).
  3. Run `neop:register` with the two generated files and the source revision.

  The platform requires a loopback origin for bindings. Reach Ledger's L3 through a loopback forward on the platform host (network policy is unchanged: only the platform reaches L3).

## 3. What the platform adopts from the plan

Each row is the plan's decision, what exists in this repo as the reference implementation, and the smallest change in the platform repos that closes it. Until a row is closed there, the piece in this repo runs beside the platform (ADR 0004: the gateway is a module in the platform backend).

| # | Plan | Reference here | Change in the platform |
| --- | --- | --- | --- |
| 1 | **A yes is bound to a fingerprint, expires, and is carried out once** (WP §5, plan 7.7) | `neos.approvals` state machine, `answer()` refuses a stale fingerprint, execution tokens, `/l3/proposals.resolve` + `proposals.execute` | Add the decide route to My Desk (the handoff spec already asks for it). The card and fingerprint come from Ledger's outbox (`proposal.created`); the yes goes to `proposals.resolve`. The disabled "Approve payment" button becomes this. |
| 2 | **Screens are data: `blocks/`, never JavaScript; one renderer on the platform** (WP §8, §13) | `@neop/contracts` blocks validator; Ledger's 31 blocks; the renderer in `packages/platform/src/web/public/app.js` (test harness) | Port the block renderer into `neos-app-platform` behind one static component key (`neop-blocks`). Blocks are data, so they fit its "remote responses never become imports" rule. Reads go through the gateway as `ledger.*` capabilities; a block's only effect is an ask (`ledger.ask`). |
| 3 | **The job is the unit; the room is a mirror** (WP §3, B4) | `tasks.open`, jobs, steps, waits, outbox | NeuralChat delegates to `ledger.ask`. The reasoning worker follows `ledger.job`. A job in WAITING maps to `confirmation` when it waits on a proposal. The answer is given on the desk (row 1), never as "I confirm" text. |
| 4 | **The switchboard: floor, company setting, in force; tighten only** (WP §4) | `neos.switchboards`, the gate, board versions | Surface the board in the NEOS app. Until then the bridge enforces it on every read, and the gate enforces it for the assistant. |
| 5 | **The assistant has no key; spend caps before the call** (S9) | LLM proxy | None for the pilot. The proxy runs beside Ledger. |
| 6 | **Borrowing through the gateway, ACL rows** (WP §9–10) | `neos.acl`, a2a tasks, semver `uses` | Needed only when a second NEOP arrives (plan Phase 4). |
| 7 | **Events** | Ledger's outbox (`job.acknowledged`, `step.added`, `proposal.created`, `task.completed`) | The capability reply carries `job.opened`. The rest reaches the platform from the outbox (`/l3/outbox`) into its `OutboxEvent` table, which feeds the existing SSE stream. |

## 4. The old v1 capabilities, mapped

| Old `neos.v1` | New Ledger |
| --- | --- |
| `ledger.dashboard` | `ledger.home.summary` |
| `ledger.transactions` | `ledger.journal.list`, `ledger.bank.unreconciled` |
| `ledger.trial-balance` | `ledger.report.trial-balance` |
| `ledger.income-statement` | `ledger.report.pnl` |
| `ledger.payables` | `ledger.documents.list` (`kind: bill`), `ledger.report.aging` (`kind: payable`) |
| `ledger.deliverables` | `ledger.close.checklist`, `ledger.periods.status` |
| `ledger.config` | `ledger.accounts.list`, `ledger.coding-rules.list` |
| `ledger.chat` | `ledger.ask` (a job, not a chat that can act) |
| `ledger.close`, `ledger.reopen`, `ledger.reconcile`, `ledger.import`, `ledger.configure` | `ledger.ask`. The assistant proposes `ledger.period.close`, `ledger.period.reopen`, `ledger.bank.categorize`, `ledger.bank.import` or `ledger.coding_rule.add`, and a person approves the exact card. |
| `ledger.proposal.decide` (gated) | `ledger.proposal.decide` (gated), answered on the desk against the fingerprint |

## 5. The test harness

`packages/platform/src/web` is a stand-in for the NEOS app, so a NEOP can be driven end to end in development and CI: ask, watch the job, answer cards, set the switchboard, see blocks drawn. It carries a visible "Test harness" badge. It starts only with the compose profile `test` and refuses `NEOS_ENV=production` (web.test, network.test). It is not a second product UI. The product UI is `neos-app-platform`, which adopts row 2 above.

## 6. Order of work

1. **Now:** install Ledger on the platform through the bridge. Reports and questions work from the NEOS app and NeuralChat; changes open jobs.
2. **Row 1** (My Desk decide): a yes on the platform is carried out once and verified. This is the pilot's acceptance bar.
3. **Row 2** (block renderer) replaces the hand-written Ledger page.
4. **Row 3** (NeuralChat ↔ jobs), then rows 4 and 6 as the second NEOP arrives.
