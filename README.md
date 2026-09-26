# NEOPS · NEOP runtime, platform-lite and the Ledger pilot

Built from `docs/source/NEOP-End-to-End-Technical-Plan.html` (the spec),
`docs/source/NEOP-WHOLE-PICTURE-v2.md` and the platform user flow
(`docs/source/platform-user-flow.jpeg`). **Ledger is the app in focus.** The plan's
phases 1–6 are built around it: Ledger core, approvals + gateway, rooms + chat bridge,
borrowing and a2a, registry + packages (with the GST package for Ledger), and
hardening. `docs/DESIGN-PHASES-4-6.md` has the design and trade-offs for the later phases.

## What a NEOP is here

A per-subject app whose always-on **runner** turns every request into a **job**
in its own Postgres schema, spawns a keyless **assistant** session per job,
routes every effect through a template-owned **gate**, and parks the job on a
**fingerprinted proposal** until a person answers through the platform desk.

```
packages/
  contracts/      fingerprint (SHA-256 over RFC 8785 JCS), token claims, outbox events, settings
  pgkit/          family roles, forward-only migrator, tenant lint (company_id + forced RLS)
  neop-template/  THE TEMPLATE — never forked, upgraded
    migrations/001_standard.sql   jobs · steps · waits · proposals · proposal_events · operations · facts · outbox
    src/gate/        gate (decision order), switchboard cache, job tokens, tool list
    src/runner/      claims (SKIP LOCKED), spawn, expiry, reconcile, LISTEN hints
    src/l3/          L3 server: tasks.open, inbox.deliver, proposals.resolve/execute, outbox, abilities
    src/capabilities/execute.ts   the one approved path: at-least-once + door idempotency + read-back
    src/agent/       pi harness session (no file/shell/fetch tools), starter prompt, worker pool
  platform/       platform-lite: gateway (EdDSA keyring + JWKS, ACL, lineage, idempotency, audit),
                  conversations, task store, desk approvals, grants, switchboards, vault (AES-GCM),
                  chat bridge + Matrix appservice, registry, LLM proxy, metrics
  testkit/        boots any set of apps against a fresh DB; conformance suite every app must pass;
                  fake Anthropic, fake homeserver, fake OTLP collector; chaos and load scenarios
apps/ledger/      NEOP-LEDGER — 29 abilities (14 reads, 15 writes): invoicing, bills, receipts/payments, bank
                  reconciliation, reversals, month close, reports, close pack; see apps/ledger/README.md
apps/marketing/   Phase 4 test fixture only (a second app to prove borrowing and a2a); not a product focus
registry/nep-gst/ the GST filing package for Ledger (runs in the Deno sandbox)
deploy/           two-container topology and network policy
docs/             source plan, ADRs (Phase 0), implementation notes
```

## Run the tests

```sh
docker compose up -d postgres      # Postgres 17 on localhost:5433
pnpm install
pnpm typecheck
pnpm test                          # ~25 s, 157 tests; every file gets its own database
pnpm test:load                     # Phase 6 bars at full size: 200 concurrent jobs, 50 forced restarts
```

The assistant in tests is pi's `faux` provider driven by a scripted brain, so the
suite is deterministic and needs no model key. `injection.test` scripts a fully
hijacked assistant on purpose.

| Test | Proves |
| --- | --- |
| contract | every result matches its manifest schema; manifest ↔ handlers complete |
| proposal | execute once; fingerprint-bound; stale yes refused; change / no; grants; amount caps |
| switchboard | off = not shown and refused; company can only tighten; changes apply on the next call |
| resume | kill the assistant mid-job; a fresh session continues from the book |
| injection | an instruction inside data causes zero effects, even with a hijacked assistant |
| a2a | another app calls only what its ACL allows; never a platform door |
| honesty | empty is empty; generatedAt; sources; books internally consistent |
| migration | forward-only, immutable, proven on populated data; tenant lint |
| tenant (B1) | company A's token cannot read or write company B's rows |
| wake-order (B2, B3) | no wake before execute is terminal; crash between resolve and execute recovers |
| inbound-auth (B4) | unsigned, forged, replayed, misaddressed, expired L3 calls rejected |
| jobtoken (S5) | gate refuses no token, stale sessions and out-of-scope abilities |
| network (S6) | deploy topology keeps the agent off the DB/platform/internet (static; runtime probe in Phase 6) |
| lifecycle | expiry wakes the job; UNKNOWN wakes and reconciles; no silent stops |
| flow | the platform user flow from the NEOS app, steps 1–9: conversation first, registry context, installs, REPORTED trail, cancel, dead letters |
| conformance | the template's bar, run for every app (contract, honesty, tenant, switchboard, proposal, auth) |
| hardening | key rotation (publish → activate → retire), vault sealing, approver policy, outbox ack/prune, dead-letter replay, SSE |
| llm-proxy | keyless agent over the real Anthropic wire format; reserve-then-settle job and day caps |
| registry | package publish → review → co-sign → install → migrate; sandbox escape attempts; tampering; borrowed skills |
| observability | one trace id from the ask to the door across every service; metrics endpoints |
| backup | restore one company without touching another |
| chaos | jobs and approvals survive forced restarts (quick; full size in `test:load`) |
| books | Ledger day to day: customers, invoices with GST, sending and chasing, receipts, bills, bank import and reconciliation, reversals, month close and reopen |
| rooms | the AgentSpace path (A → 7.1 → 7.6 card in room → 7.7 answer in room → 7.9): identity checks, fingerprint-bound room answers, Phase 3 exit (room and app write identical book entries) |

## Run the pilot locally

```sh
export NEOP_LLM_UPSTREAM_KEY=sk-ant-...     # the agent stays keyless: the platform LLM proxy holds this
export NEOP_DEV_PACKAGES=nep-gst            # optional: install the GST package for the demo company
pnpm dev                                    # platform :4700, Ledger L3 :4701, gate :4702, agents :4703
```

Ops: `pnpm migrate` (the only process with the admin connection), `pnpm backup export ledger <company_id>`,
`pnpm publish-package registry/nep-gst`. Metrics at `/metrics` (platform) and `/l3/metrics` (app);
traces go to `OTEL_EXPORTER_OTLP_ENDPOINT`; dashboard and alerts in `deploy/observability/`.

Open `http://127.0.0.1:4700/`, paste `dev_admin`, and ask *"What was our net
profit in August 2026?"* or *"Email the September close pack to
cfo@acme.example"* — the second becomes a card on the desk; approve it and the
email lands in `var/mailbox/`.

**Shipping Ledger:** `docs/RUNBOOK.md` (deploy, providers, rotation, incidents), `CHANGELOG.md`,
`docs/adr/README.md` (decisions awaiting sign-off), `.github/workflows/ci.yml`.

See `docs/FLOW-COVERAGE.md` for every step of the platform user flow mapped to code and tests,
`docs/IMPLEMENTATION-NOTES.md` for where this build interprets the plan, and
`docs/adr/` for the Phase 0 decisions.
