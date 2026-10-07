# Twenty-NEOP V3 rebuild — execution plan

Updated 2026-10-05. Status: **started, not fleet-complete or production-ready**.

## Source and authority

- User-requested source: Quick Build. Sanitized local copy: `reference/quickbuild/`; content hashes and omissions: `reference/quickbuild-provenance.json`. The original was not modified.
- Governing architecture: `NEOP-WHOLE-PICTURE-v3.md` and the completed Ledger release `25279c1`. `docs/source/` V2/HTML plans are background where compatible, not authority to reintroduce the gateway.
- Branch: `rebuild/fleet-v3`; local checkout: `/Users/mansi.gambhir/Documents/NEOPS_NEW/.claude/worktrees/fleet-v3-rebuild`. Root checkout and Ledger release branch remain untouched.
- `fleet/catalog.json` is the machine-readable inventory. The documented 20 is now the working scope following the user's request to start all remaining NEOPs. This is an explicit scope assumption; the different top-level Quick Build roster remains separately inventoried.

## Work waves

| Wave | NEOPs | Domain acceptance focus |
| --- | --- | --- |
| 0 | Ledger | Preserve the completed V3 baseline and regression suite; do not rewrite it |
| 1 | Wage | Exact gross-to-net, explicit timesheets, immutable runs, stale-input refusal, approval-bound internal release |
| 2 | Pay, Renew, Buy | Invoice/renewal/PO source parity, duplicate commitments, provider payment receipts and limits |
| 3 | Deal, Quote, Sign, Vet | Discount/version binding, signature and onboarding evidence, expiry and supersession |
| 4 | Clear, Grant, Guard, Asset | Reviewed screening data, scoped access/security/provisioning actions, no automated adverse decisions |
| 5 | Hire, Roster, Shift, Sync | Offer/leave/change/export state machines, personal data, escalation and recovery |
| 6 | Reach, Post, Desk | Approved audiences/content/refunds, delivery proofs, suppression, retries and limits |

These are implementation waves, not promised completion dates. All eighteen remaining repositories are pinned in fleet/source-lock.json. Every remaining app now has a pure domain port and a capability parity map. All eighteen now have internal draft runtime definitions with domain-specific SQL and local integration tests. This is not full business workflow parity or production certification; see the third checkpoint for executed evidence.

## Mandatory implementation contract for each app

1. Source parity matrix: every business capability mapped to a V3 ability, explicit retirement, or reviewed build-time package. Preserve deterministic source calculations; do not port unsafe approval routes.
2. Pure domain code separated from SQL and providers. Integer base units plus currency, integer time units, explicit nulls, checked states and app-generated UUIDs.
3. Own schema and restricted roles; company RLS and composite foreign keys. Immutable effect evidence, personal-data tags and an actual retention/erasure design.
4. The existing template owns Matrix typed events, sender validation, switchboard, proposals, waits, exact-content approvals, restart claims, door journaling and model isolation. Do not fork these per app.
5. Backend-only provider adapters, per-company credentials, provider idempotency and independent read-back. Unimplemented/uncertified effects stay absent or fail closed. Never mark a payment completed from a local status update.
6. Data-only NEOS blocks backed by reviewed SQL; closed input/output contracts; scoped assistant skills. No runtime-loaded code or instructions imported from documents.
7. Separate backend and assistant artifacts, schema-drift refusal, per-app DBA bundle, observability and recovery runbook. No deployment is performed here.

## Evidence gates (per app, not inherited from Ledger)

Contract; exact-content proposal; switchboard; restart/resume; prompt injection; sender-class enforcement; honest empty/null/source results; populated migration and rollback rehearsal; schema/tenant isolation. Add domain arithmetic/state tests, concurrent/replayed writes, stale approvals, malformed batches, unexpected provider outcomes and desk/assistant read parity. Then real Matrix/provider/UI acceptance and operational owner approval before release registration.

## What is implemented in this first slice

Wage has eleven closed abilities, a pure salary/hourly calculator, company-scoped repositories, transactional write receipts, immutable runs/payslips, reviewed SQL reads, basic data-only blocks and the shared Matrix/gate/runner integration. Settings, employee imports, timesheets, release and reopen are ask-first. Preparing a run is internal and idempotent. Release binds the exact input hash/currency/net total, rechecks current source inputs and records **released, not paid**. A released period cannot be reopened through this build.

## Still required for Wage

- Source parity beyond this slice: legacy deliverable downloads, per-employee disbursement records, approved corrections/off-cycle runs, and explicit handling of payroll periods other than monthly.
- Provider-specific bank payout, status reconciliation, payslip delivery and statutory packages. No live payout, filing or email is implemented or certified.
- Reviewed jurisdiction/rate sources, payroll expert acceptance, rounding policy and currencies' unit metadata. Deduction rules here are supplied inputs, not tax advice or a statutory engine.
- Personal-data retention/erasure policy: immutable salary records cannot simply be nulled/deleted by generic erasure. Resolve legal retention, restricted access and eventual purge without invalidating evidence.
- Full real Matrix, provider, UI, load/chaos and per-app release conformance attestation. The first slice's tests do not establish all of these.
- Per-app production build/compose/appservice and secret provisioning manifests; team-owned deployment remains out of scope.

## Completion reporting

Report verified implementation separately from queued work. Do not call all twenty rebuilt because they have work-package files, and do not call Wage production-ready because deterministic tests pass. Record exact test counts and failures in `docs/FLEET-V3-VERIFICATION.md`.

## Second implementation checkpoint

ADR-0015 records the domain-first execution and unavailable-effect boundary. fleet/requirements.json maps the V3 document to eighteen acceptance groups, and each app has ACCEPTANCE.json. apps/*/SOURCE-PARITY.json records captured core capabilities, catalog-only differences, replacements, partial ports and missing work. Configuration/import/cancellation approval in the three finance draft slices is not business authorization. No provider effect or production rollout is enabled.

## Third implementation checkpoint

ADR-0016 records the fifteen new app-specific review runtimes, Asset business/identity table separation, schema identifier quoting and strict pre-coercion assistant arguments. Pay/Buy/Renew gain rejection, forged-authority and stale-hash regressions. All eighteen are exercised together; release registration and provider effects remain unavailable. This checkpoint's test result is docs/FLEET-V3-CHECKPOINT-3.md; checkpoint reports preserve historical evidence.

## Fourth implementation checkpoint

ADR-0017 adds fixed-app standalone backend/assistant entrypoints for all eighteen, shared fail-closed startup configuration, secret-injection checks and real child-process smoke tests. See docs/FLEET-V3-RUNTIME.md for the commands and limitations and docs/FLEET-V3-CHECKPOINT-4.md for executed results. Container images/network certification, complete business jobs across separate processes and live acceptance remain outstanding. No production-ready flag is enabled.

## Fifth implementation checkpoint

ADR-0018 adds explicit assistant-only artifact contexts and a local image/isolation rehearsal for every remaining NEOP. See docs/FLEET-V3-AGENT-PACKAGING.md and docs/FLEET-V3-CHECKPOINT-5.md. Non-root/read-only Linux ARM64 images, dependency/filesystem inspection, accidental credential refusal, local gate/model versus database/peer canaries and a fixture SDK session are covered. Backend-only images, appservice/secret/production network manifests, complete persisted multi-process business jobs, provenance/security review and live acceptance remain outstanding. The domain/source-parity gaps in checkpoint 3 are unchanged. No production-ready flag is enabled.

## Sixth implementation checkpoint

ADR-0019 adds persisted internal-draft jobs through actual standalone backend/assistant child processes and the signed/metered model-proxy path for all eighteen apps. Ninety new tests cover typed ingress, exact human import/cancellation decisions, waiting-backend SIGKILL recovery, fresh-worker rejection, app-specific draft reads and replay receipts. Matrix and upstream-model services are fixtures. See docs/FLEET-V3-CHECKPOINT-6.md. No business capability, backend image or production-ready flag is added; source parity and domain-policy gaps remain open. Next: backend artifacts with a reviewed Linux sandbox runtime, packaged-job rehearsal and broader active-session/effect recovery.

## Seventh implementation checkpoint

ADR-0020 adds explicit backend-only contexts and locally built/tested Linux ARM64 images for all eighteen, including lock-pinned Deno archive verification and actual sandbox permission-denial probes. Each image ships its own domain, no model SDK/worker, and passes boot/role/health, schema-drift/provider-key refusal and shutdown checks. See FLEET-V3-BACKEND-PACKAGING.md and FLEET-V3-CHECKPOINT-7.md. The existing assistant images and host-process jobs remain separately scoped evidence. Next: complete persisted jobs across both packaged processes with fixture transports, followed by broader recovery and the still-open business authority/provider/source-parity work. No app is production-ready.

## Eighth implementation checkpoint

ADR-0021 runs the same ninety persisted internal-draft assertions through both exact Linux ARM64 images with synthetic Matrix/model transports. All eighteen pass, including waiting-backend crash recovery, fresh-worker rejection, exact decisions/replay and narrow network canaries. See FLEET-V3-PACKAGED-JOBS.md and FLEET-V3-CHECKPOINT-8.md. No new business ability or readiness flag is added. Next: business-authorization identity/entitlement/policy enforcement starting with Pay/Buy/Renew, then the remaining state machines/provider contracts/source parity; broader active-session/in-flight/concurrent/outage recovery and release/data-safety work remain required. Deployment and real-environment acceptance stay team-owned.

## Ninth implementation checkpoint

ADR-0022 adds execution-time human authority checks for Pay/Buy/Renew internal settings/import/cancel writes. Exact person-approved proposal content, linked identities, current configured roles/four-eyes, switch-off and expiry are checked inside the atomic receipt transaction; standing grants cannot replace a person. This is not payment/PO/renewal authorization. See FLEET-V3-CHECKPOINT-9.md. Next: bind immutable original draft proposers and implement domain authorization states with reviewed entitlements; other fifteen apps still need opt-in authority guards. Shared source changes mean checkpoint 5/7/8 images/results are historical: refresh artifacts before release. Business/provider/source parity, data/privacy/recovery and team-owned live acceptance remain incomplete.

## Tenth implementation checkpoint

ADR-0023 captures immutable original draft provenance for Pay/Buy/Renew from validated creating jobs, not model fields. Human links/representation are resolved at insertion; nonhuman requests are explicit and historical drafts stay unattributed. Draft/origin/receipt writes are atomic and identity/job locks persist until commit. See FLEET-V3-CHECKPOINT-10.md. Next: business authorization states and original-proposer separation using this record and reviewed elevated-role/limit policy. Do not infer missing historical identities or enable dispatch. Other fifteen apps still need opt-in authority/provenance coverage; source parity, providers, privacy/recovery and live acceptance remain incomplete.

## Eleventh implementation checkpoint

ADR-0024 extends the existing internal-write authority and authenticated draft-origin safeguards to Clear, Reach, Desk, Hire, Deal, Grant, Shift, Sync, Post, Roster, Quote, Sign, Guard, Vet and Asset. Each keeps its own domain fixtures, schema, reads and forward-only 004 migration. The populated upgrade does not guess historical humans. All eighteen now opt in; business authorization, original-proposer separation in decisions, elevated entitlements and provider dispatch remain unavailable. See FLEET-V3-CHECKPOINT-11.md for executed evidence. Next: source-parity lifecycle and decision-context work with reviewed policies. If business-policy choices remain unavailable, continue safe local expiry/supersession/recovery and provider-contract tests without enabling effects. Current-source artifact and DBA-bundle refresh plus real environment acceptance remain required; no readiness flag is enabled.

## Twelfth implementation checkpoint

ADR-0025 addresses late proposal answers that cross a database lock wait. Shared forward-only t022 checks wall-clock expiry after the proposal lock and immediately before a fresh answer returns; a late decision rolls back its history, steps, outbox and wait changes atomically. Replay and deadline-exempt withdrawal retain their existing semantics. All eighteen receive internal-import waiting-lifecycle tests; four representative populated V3 books exercise the forward replacement and preserved privileges. See FLEET-V3-CHECKPOINT-12.md for executed results and failure/fix history. This does not add a business decision, provider dispatch or source-parity capability. Next: domain lifecycle/decision-context work with reviewed approver roles, amount/currency limits, self-approval and historical/nonhuman policy; while those choices are unavailable, continue safe local wait/input/recovery and provider-contract work. Broader state machines, source parity, privacy/legacy conversion, refreshed artifacts and live acceptance remain open.

## Thirteenth implementation checkpoint

ADR-0026 adds forward-only t023 for input-question deadlines and job-before-question locking, plus matching runner input-expiry ordering. All eighteen gain synthetic input lifecycle, cancellation, expiry contention, concurrent-pass and restart coverage; four populated synthetic V3 upgrades preserve history and privileges. See FLEET-V3-CHECKPOINT-13.md for executed results, failed reproductions and limits. These are sourced answers, not business approvals or new provider/source-parity capabilities. Review a coordinated migration/worker upgrade; old-worker rolling compatibility is not certified. Checkpoint 14 confirms the clean complete isolated baseline after the export-fixture correction and adds six timer recovery tests per app; see FLEET-V3-CHECKPOINT-14.md for exact run scopes, retained intermittent failures and limits. Runtime semantics are unchanged. The next safe slice while business policies remain unanswered is dependency/a2a waiting, cancellation, late/duplicate results and recovery, inspecting coverage and reproducing defects before fixes. Domain lifecycles, approver roles/limits/self-approval/historical policy, providers, source parity, privacy/legacy conversion, refreshed release artifacts and real acceptance remain open.

## Fifteenth implementation checkpoint

ADR-0027 makes terminal bus result receipt/thread/wait/operation/step/outbox changes atomic and returns retryable HTTP failures when that transaction fails. It serializes competing replies and rechecks cancellation under job-first locks. Sixteen synthetic receiver scenarios run under each of the eighteen schemas; existing Ledger/Marketing bus tests retain the local hand-off/question/borrowed-call paths. See FLEET-V3-CHECKPOINT-15.md for exact verification and diagnostic history. No new domain capability, migration or provider is added. Next: reproduce a2a deadline and late-result handling, question/re-answer atomicity and generic dependency wait support. Historic partial receipts require an audited recovery design. Do not treat this as a general durable inbox or mixed-version certification; quiesce old receivers for coordinated release, keep t023/worker coordination, and refresh current-source artifacts. Business policy/source parity/privacy/legacy conversion and real acceptance remain incomplete.

## Sixteenth implementation checkpoint

ADR-0028 extends the atomic receiver to incoming task questions and retains accepted peer wait identity after an answer. Twelve synthetic cases per app cover rollback/restart, duplicate contention, cancellation/result ordering, scoped identity rejection, later distinct questions and lost-LISTEN polling. Final complete regression: 3,216 passed, zero failed, two existing conditional skips across 295 files; the 216 new cases are included. Shipping manifests/domain/provider capabilities and source parity are unchanged. See FLEET-V3-CHECKPOINT-16.md for exact evidence and the test-only fixture/TypeScript corrections and interrupted-run history. Next: reproduce outbound a2a.answer wait/send/finalization and concurrent-new-question or live-job deadline gaps; review mixed-wait expiry. Historical receipt recovery, retention-safe identity, complete business policies/workflows, provider/source parity, privacy/legacy conversion, refreshed artifacts and real acceptance remain open. Keep old question/result receivers quiesced for coordinated rollout and preserve t023/worker coordination; mixed-version compatibility is not certified.

## Seventeenth implementation checkpoint

ADR-0029 fixes bounded outbound answer finalization: recheck job/session ownership around preparation and finalization, preserve newer questions and waits not claimed by that session, and report transport failures as uncertain rather than proof of non-delivery. Twelve synthetic cases run under each of eighteen schemas. Final complete regression: 3,432 passed, zero failed, two existing skips across 313 files; 216 new cases included. See FLEET-V3-CHECKPOINT-17.md for reproduced failures and fixture-correction history. No domain/provider, migration or source-parity capability changes. Next: content-bound expected-question/answer intent, idempotent wait reuse and audited recovery across send/finalization failures; a model warning is not enforcement. Existing deadline/mixed-wait/other-ingress, business-policy/source-parity/provider/privacy/legacy and live acceptance gaps remain. Drain old senders/receivers, preserve t023/worker coordination and refresh artifacts before release; no mixed-version certification or deployment.

## Eighteenth implementation checkpoint

ADR-0030 binds a2a.answer v2 to the caller's explicit expected peer question ID under job/thread locks and restores scoped pending peer context for fresh assistants after human input/restart. Eleven new synthetic cases per app and seven shared contract cases cover the new boundary; checkpoint 18 records exact run scopes and retained fixture/Unicode diagnostics. This is not immutable content binding, idempotent wait reuse or crash-safe delivery. Next reproduce changed-content retries and duplicate prepared waits, then design a tenant/job/thread/question/content-bound intent without guessing historical content or enabling effects. Complete workflows, owner-approved authority policies, providers, source parity, privacy/legacy conversion and live acceptance remain open. Drain old assistant sessions/senders for the breaking tool contract, refresh backend/assistant artifacts together, and preserve question/result-receiver and t023/input-expiry-worker coordination. Mixed-version certification and deployment remain out of scope.

## Nineteenth implementation checkpoint

ADR-0031 and forward-only t024 add immutable outgoing task-answer content/routing identity and an atomically prepared, reusable return wait. Explicit exact retries and fresh assistants use persisted answers; changed content/routes and unbound historical threads are refused. An uncertain send retains its wait for a result or exact retry. Checkpoint 19 records reproduced defects, privilege/fixture corrections and exact regression evidence. This is not automatic replay, a single-sender lease or independently certified exactly-once transport. Historical protocol-0 threads require audited owner-approved recovery; do not bulk-promote them. The new stored payload may contain personal data: subject discovery, retention/erasure and replay-window policy remain required. Next reproduce peer deadlines/late results and mixed-wait expiry locking, or implement reviewed semantic human-input provenance. Business authorization policies, full workflows, providers, source parity, legacy conversion, DBA/restore review and live acceptance remain open. Drain old senders/sessions, coordinate t024 with refreshed artifacts and retain earlier receiver/t023 coordination; no mixed-version certification, push or deployment.
