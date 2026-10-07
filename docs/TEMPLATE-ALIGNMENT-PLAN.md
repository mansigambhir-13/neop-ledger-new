# Twenty-NEOP template-alignment execution plan

Status: template alignment complete; functional completion and production acceptance remain separate
Prepared: 2026-10-07
Scope: the exact twenty entries in `fleet/catalog.json`
Decision record: `docs/adr/0032-pinned-upstream-template-adoption.md`

## Objective

Align every catalogued NEOP with the behavioral, security, packaging and operational contract of `neos-neop-template` 0.8.16 without destroying the fleet's existing TypeScript monorepo, immutable migration history or stronger human-authority and keyless-model boundaries.

Alignment has three independent outcomes:

1. **Template aligned:** all twelve template gates have independently verified, clean-commit evidence.
2. **Functionally complete:** the app's real business lifecycle, authority, privacy and provider behavior are complete.
3. **Production accepted:** live integrations, recovery, performance, UI and operational ownership are approved.

No outcome implies either of the others.

## Pinned reference

- Repository: `https://github.com/NEOS-Ecosystem/neos-neop-template.git`
- Commit: `94db804f94403c15ad1279e6d30dcecc7c078b82`
- Template version: `0.8.16`
- Authenticated archive SHA-256: `6a22d515c2a36ddeb8ad613af042960d15b4ab3f41e829bc933e105c9505aa23`
- Local ignored checkout: `reference/upstream/neos-neop-template`
- Checkout mode: detached at the pinned commit; it must not silently follow `main`

The checkout is for inspection and comparison. The authenticated archive remains the reproducible source-verification artifact because the verifier checks the digest, archived `template.json` identity/version and every mapped upstream path from the same bytes.

To refresh intentionally:

```bash
git -C reference/upstream/neos-neop-template fetch origin
git -C reference/upstream/neos-neop-template switch --detach 94db804f94403c15ad1279e6d30dcecc7c078b82
pnpm fleet:template-alignment -- --verify-archive /path/to/pinned-template.zip
```

A template upgrade requires a new reviewed commit, archive digest, compatibility assessment and plan update. It is not a routine pull.

## Alignment completion on 2026-10-07

| Measure | Current state |
|---|---:|
| Catalogued NEOPs | 20 |
| Runtime/domain ports present | 20 |
| Pinned legacy source mappings | 18 |
| Template-aligned apps | 20 of 20 |
| Verified gates | 240 of 240 |
| Ownership gate suites implemented | 20 of 20 |
| Production-ready apps | 0 |
| Evidence binding | 240 canonical reports bound to source commit `78d821e9fe633ec5706f3afd9cff4ab6ba472157` |

All twenty catalogued apps now satisfy the pinned template contract through independently bound gate evidence. This does not close the product and production gaps retained in the fleet registry: Ledger remains the broad V3 reference, Wage remains a vertical slice, and the other eighteen apps remain tested draft slices.

## Architecture decision

### Options considered

| Option | Advantages | Costs and risks | Decision |
|---|---|---|---|
| Direct `template-sync --apply` in each app | Closest file layout to upstream | Overwrites runtime and tests, collides with migrations, changes Matrix and approval semantics, weakens reviewed model isolation | Rejected |
| Twenty standalone forks | Native upstream lifecycle per app | Duplicates shared runtime, creates twenty upgrade streams, requires a high-risk data and transport cutover | Rejected |
| Controlled compatibility adoption | Preserves deployed contracts and centralizes reusable work while proving upstream behavior | Requires adapters, explicit equivalence tests and owner decisions | Selected |

### Constraints that may not be bypassed

- Never edit, renumber or replace an applied migration. Upstream 001-008 behavior is mapped through new forward migrations and compatibility code.
- Preserve t022 answer deadlines, t023 input deadlines/job-first lock order, t024 immutable answer intents, atomic receipts and read-back-before-resume.
- Preserve verified-human approval unless platform and security owners approve and test another authority model.
- Keep the assistant credential-free and the database backend-only. Model access stays behind the current short-lived proxy unless a reviewed provider adapter proves equal or stronger isolation.
- No direct template synchronization against an existing app.
- No gate is marked verified from filenames, mocks, self-entered hashes or skipped tests.

## Shared workstreams and the twelve gates

Shared compatibility work lands once in `packages/neop-template`, fleet tooling and deployment assets. Each app must still prove its own configuration and behavior.

| Gate | Shared deliverable | Required per-app proof |
|---|---|---|
| `ownership` | Ownership crosswalk for upstream TEMPLATE/APP paths and monorepo equivalents | No app-owned file is overwritten by an upgrade; deliberate deviations are documented |
| `manifest` | Deterministic dual-contract emitter from one typed app declaration | Emitted upstream-compatible and fleet manifests are fresh, complete and identity-consistent |
| `standard-tests` | Compatibility harness mapping upstream standard tests to TypeScript behavior | All applicable upstream invariants pass without weakening current V3 suites |
| `migrations` | Standard-schema crosswalk and forward-only migration framework | Fresh install, populated upgrade, checksum drift refusal, backup/restore and DBA review |
| `ingress-approval` | Typed Matrix-to-template event adapter with verified-human authority | Sender/company/thread validation, exact-content approval, expiry, replay, withdrawal and restart tests |
| `runtime-credentials` | Typed per-process settings and secret-inventory checks | Database/Matrix credentials backend-only; model credentials agent/proxy-only; frontend proxy key scoped |
| `model-auth-provider` | Reviewed adapter decision for OpenRouter and local ChatGPT/Codex plan providers | Binding, grant, revocation, fallback, concurrency and secret-isolation tests |
| `runtime-processes` | Standard backend/agent/frontend packaging and one app bridge | Three health-checked processes; backend alone on the private database network; agent publishes no port |
| `frontend` | Shared no-login frontend shell and authenticated backend proxy contract | App route, source lifecycle, blocks, errors, unknown/empty states and base-path build pass |
| `blocks` | Typed block schema and read-only query adapter | Declared reads are company-safe and UI facts match assistant facts and provenance |
| `secrets` | Synthetic-secret scanner plus image, environment and network probes | No secret in source, manifest, logs or wrong process/image; revoked credentials stop effects |
| `publish-install` | One generated-manifest publish/install path with drift refusal | Idempotent same-version publish, changed-content refusal, install verification and rollback evidence |

Every gate receives a real suite named in `fleet/template-alignment.json`, for example `apps/<id>/tests/template-manifest.test.ts`. A gate can move from `gap` to `verified` only after the evidence validator independently binds:

- the clean source commit;
- the exact template pin;
- the test command and exit status;
- the report digest;
- zero failed, skipped, pending or todo assertions for that gate;
- reviewed compatibility exceptions.

Schema v2 of the alignment registry is fail closed: it accepts only canonical evidence-file references, hashes the raw single-suite Vitest report, recomputes the app/shared source digest and checks that source against the recorded ancestor commit. All 240 app/gate combinations are admitted for the clean source commit recorded above.

## Execution roadmap

The phases are dependency-ordered checkpoints, not calendar estimates. Work may be parallelized inside a phase only after its shared prerequisites are merged.

### Phase 0 — Pin, inventory and protect the baseline

Status: complete as the preserved pre-implementation baseline.

Deliverables:

- exact upstream checkout and authenticated archive pin;
- twenty-app catalog and app-owned alignment documents;
- machine-readable twelve-gate inventory;
- architecture decision prohibiting direct sync;
- green typecheck and complete capped test suite;
- honest `0/20` starting status, subsequently promoted only from canonical evidence.

Exit at baseline: `--verify-archive` passed and `--require-aligned` failed for the documented gaps.

### Phase 1 — Make alignment provable

Status: complete. This shared substrate now supports every app.

1. [x] Implement evidence schema v2 and a clean-commit runner-report verifier.
2. [x] Create the ownership crosswalk and template-upgrade diff report.
3. [x] Build the typed app declaration and dual-contract manifest emitter.
4. [x] Add a compatibility harness for the upstream standard suites.
5. [x] Define the standard 001-008 to fleet t002-t024 migration crosswalk.
6. [x] Package the shared no-login frontend shell and authenticated backend proxy.
7. [x] Standardize three-process Compose generation, the one-app bridge and backend-only database attachment.
8. [x] Add synthetic-secret, image-content, environment and network-boundary probes.
9. [x] Decide and encode the Matrix/approval compatibility contract.
10. [x] Decide and encode the model-provider contract.

Exit:

- shared adapters have unit and integration coverage;
- a new empty fixture app can pass all twelve gates;
- current Ledger and fleet V3 suites remain green;
- unresolved authority decisions fail closed.

### Phase 2 — Wage reference pilot

Template-alignment status: complete. The product gaps listed below remain separate work.

Wage is the smallest meaningful vertical slice and becomes the reference implementation.

1. Replace the 5,001-row output mismatch with a bounded, paginated, explicit partial-result contract.
2. Move its identity, abilities, sources, blocks, skills and scopes into the typed declaration.
3. Generate both manifests and prove drift refusal.
4. Add the standalone frontend and source lifecycle.
5. Map payroll schema behavior to the standard migrations without rewriting existing SQL.
6. Add all twelve Wage gate suites.
7. Complete payout and statutory-filing boundaries or explicitly keep them disabled and unadvertised.

Exit: Wage is 12/12 template aligned and functionally complete for every capability it advertises. Live payout/filing acceptance remains a separate production gate.

### Phase 3 — High-risk pilots

Template-alignment status: complete for Pay and Clear. Their product/provider gaps remain separate work.

Run two pilots using the Wage pattern to prove the shared layer is not finance- or evidence-specific.

#### Pay

- Bind exact amount, currency, beneficiary and provider identity to approval.
- Implement dispatch with provider idempotency and uncertain-outcome reconciliation.
- Prove segregation of duties, revocation, retry and read-back-before-success.
- Complete all twelve template gates.

#### Clear

- Implement evidence retrieval, provenance, expiry and conflicting/unknown outcomes.
- Separate case approval from SAR filing authority.
- Add filing-provider idempotency, reconciliation and privacy/retention proof.
- Complete all twelve template gates.

Exit: Wage, Pay and Clear are aligned; shared components have survived payroll, payment and regulated-evidence workflows.

### Phase 4 — Fleet rollout groups

Template-alignment status: complete for every rollout group. The sequence below remains the product-completion roadmap.

Each group starts only after its reference pilot is green. Work within a group may proceed in parallel, but each app is merged and certified independently.

1. **Finance and procurement:** Buy, Renew. Pay supplies the provider/authority reference.
2. **Commercial, legal and risk:** Deal, Quote, Sign, Vet.
3. **Security and IT:** Grant, Guard, Asset. Clear supplies the evidence/privacy reference.
4. **People, operations and data:** Hire, Roster, Shift, Sync.
5. **Customer and communications:** Reach, Post, Desk.

For each app:

1. close source-parity decisions;
2. complete real domain rules and authority;
3. adopt the typed declaration, generated manifests and frontend shell;
4. map migrations and source lifecycle;
5. implement all twelve gate suites;
6. run shared, app, populated-upgrade and recovery verification;
7. record product-owner and required security/DBA review.

Exit: nineteen apps are 12/12 aligned, with Ledger remaining on its dedicated compatibility track.

### Phase 5 — Ledger compatibility and regression closure

Template-alignment status: complete. Ledger's live statutory, mailbox, provider and UI acceptance remains open.

Ledger is last for formal certification because it has the widest behavior and the largest contract conflict; it remains the regression anchor throughout earlier phases.

1. Move 44 abilities, 33 blocks, the email door and package contracts into the typed declaration.
2. Add the generated manifest without changing published-version semantics.
3. Add the frontend through the shared proxy while retaining data-only blocks and Desk functions.
4. Map its installed migration lineage to standard behavior with populated-book evidence.
5. Reconcile ordinary-client DM expectations with current appservice/client and typed bus behavior.
6. Prove mailbox, GST/statutory, package, provider uncertainty, model-proxy and recovery behavior.
7. Complete all twelve Ledger gate suites and rerun the complete fleet regression.

Exit: all twenty apps are 12/12 template aligned; `--require-aligned` succeeds from a clean commit.

### Phase 6 — Production acceptance

Template alignment alone does not authorize deployment.

For every app:

- build matched current-source backend, agent and frontend images;
- scan images and manifests for secrets;
- rehearse populated migration, backup restore and recovery;
- run live Matrix, model, provider, mailbox/file and NEOS UI acceptance as applicable;
- prove performance and concurrency at the app's declared limits;
- obtain product, security, DBA and operational-owner approvals required by the app;
- publish a clean-commit attestation and rollback plan.

Exit: `pnpm fleet:status -- --require-complete` succeeds and the app has an owner-approved production record.

## Per-app delivery matrix

| Order | App | Sequence | Current profile | App-specific completion target |
|---:|---|---|---|---|
| 1 | Ledger | Phase 5; regression throughout | Existing V3 reference | Generated contract/frontend, migration equivalence, live statutory/mailbox/provider/UI evidence |
| 2 | Wage | Phase 2 pilot | Vertical slice | Bounded 5,001-row behavior, payout and statutory-filing boundaries |
| 3 | Clear | Phase 3 pilot | Draft slice | Evidence provenance, case/SAR authority and reconciled filing provider |
| 4 | Reach | Phase 4.5 | Draft slice | Consent/suppression, campaign authority and delivery reconciliation |
| 5 | Desk | Phase 4.5 | Draft slice | Refund eligibility, approval, execution and provider reconciliation |
| 6 | Hire | Phase 4.4 | Draft slice | Offer authority, approved-offer lifecycle, delivery and onboarding |
| 7 | Deal | Phase 4.2 | Draft slice | Commercial policy, approved quote issue and delivery read-back |
| 8 | Buy | Phase 4.1 | Draft slice | Procurement policy, PO placement, supplier acknowledgement and reconciliation |
| 9 | Grant | Phase 4.3 | Draft slice | Least privilege, provisioning, effective-access read-back and revocation |
| 10 | Shift | Phase 4.4 | Draft slice | Collision policy, approved apply/rollback and independent verification |
| 11 | Sync | Phase 4.4 | Draft slice | Export authority, redaction/privacy, delivery and recovery |
| 12 | Post | Phase 4.5 | Draft slice | Publication authority, scheduled publish and published-state verification |
| 13 | Roster | Phase 4.4 | Draft slice | Entitlement/overlap policy, concurrent booking, balance and correction |
| 14 | Quote | Phase 4.2 | Draft slice | Pricing/exception policy, approval, issue, expiry and supersession |
| 15 | Sign | Phase 4.2 | Draft slice | Document/signer authority, signature provider and envelope reconciliation |
| 16 | Guard | Phase 4.3 | Draft slice | Incident/evidence policy, response execution and containment verification |
| 17 | Vet | Phase 4.2 | Draft slice | Evidence provenance/expiry, vendor-risk approval and onboarding provider |
| 18 | Pay | Phase 3 pilot | Draft slice | Payment authority, exact dispatch and uncertain-outcome reconciliation |
| 19 | Asset | Phase 4.3 | Draft slice | Inventory/custody, provisioning authority, read-back and revocation |
| 20 | Renew | Phase 4.1 | Draft slice | Renewal authority, execution and provider reconciliation |

`apps/marketing` remains a legacy/test dependency outside this twenty-app scope. Adding or replacing fleet members requires an explicit catalog decision rather than silently expanding this plan.

## Per-app definition of done

An app is ready to be marked template aligned only when all of the following are true:

- [x] Pinned template identity and ownership crosswalk are current.
- [x] One typed declaration generates both manifests with no drift.
- [x] All twelve app-owned template gate suites pass with independently bound evidence.
- [x] Existing V3 conformance, authority, wait, bus, restart and domain contracts covered by the compatibility gates remain green.
- [x] Fresh install and populated forward migration pass; old migrations are unchanged.
- [x] Backend, agent and frontend run as separate health-checked processes.
- [x] Only the backend reaches the private database network.
- [x] Secret, image, environment and network probes pass.
- [x] Frontend works without a separate login and cannot bypass backend authorization.
- [x] Blocks and assistant expose the same source, time, unknown, empty and partial-result truth.
- [x] Publish/install is manifest-bound, idempotent and drift-refusing.
- [ ] App-specific source-parity and product gaps are resolved or the capability is removed from the advertised contract.
- [ ] Required platform, security and DBA compatibility decisions are recorded.

## Verification commands

Run from a clean commit with the database and external fixtures required by the selected suites:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec vitest run scripts/fleet/tests/template-alignment.test.ts --maxWorkers=1
pnpm fleet:template-ownership -- --template-dir reference/upstream/neos-neop-template
pnpm fleet:template-alignment -- --verify-archive /path/to/pinned-template.zip
pnpm fleet:template-alignment -- --require-aligned
pnpm fleet:status -- --summary --check-sources
pnpm fleet:status -- --require-complete
```

The commands through `--require-aligned` now pass for the recorded clean source commit. `--require-complete` remains expected to fail until functional and production requirements are genuinely complete. `--check-sources` additionally requires the trusted ignored source snapshots named in `fleet/source-lock.json`.

### Recording one verified gate

Gate evidence can be generated only after the gate implementation and its canonical test file are committed and the app/shared source scope matches `HEAD`:

```bash
pnpm fleet:template-gate -- --app wage --gate ownership
```

The runner executes exactly `apps/wage/tests/template-ownership.test.ts` with one worker and the JSON reporter. It writes the raw report and evidence envelope below `docs/evidence/template-alignment/wage/`, then revalidates both. Review the files and keep the canonical evidence path in Wage's `evidence` list in `fleet/template-alignment.json`. Any failed or missing gate must reopen the app's assessment. The registry rejects renamed files, changed commands, report tampering, skipped/todo tests, untracked source and any app/shared source that differs from the evidence commit.

## Required decisions and ownership

| Decision | Required owners | Default while unresolved |
|---|---|---|
| Ordinary-client Matrix DMs versus typed bus/appservice compatibility | Platform + security | Keep current verified typed transport; alignment gate stays open |
| Reasoning bridge relaying approval versus verified-human-only approval | Security + product/platform | Keep verified-human-only authority |
| Local ChatGPT/Codex broker versus short-lived model proxy | Security + platform | Keep current keyless proxy and no agent-held long-lived credential |
| Upstream standard schema mapping to existing migration history | DBA + app engineering | Add forward migrations only; no applied SQL changes |
| Frontend proxy authority and no-login session binding | Platform + security | No frontend write path until the shared proxy is approved |
| Provider-specific external effects | Product + security/operations as applicable | Capability remains off and unadvertised |

## Risks and controls

| Risk | Control |
|---|---|
| Cosmetic file alignment hides behavioral gaps | Twelve executable gates and report-bound evidence |
| Shared adapter changes weaken current V3 guarantees | Ledger/fleet regression on every phase and fail-closed equivalence tests |
| Twenty parallel app streams drift | Wage reference first, shared substrate, ordered rollout groups and one pin |
| Migration collision or data loss | Forward-only crosswalk, populated upgrades, checksum refusal, DBA review and restore rehearsal |
| Secret movement between processes | Typed credential inventory, synthetic-secret scans and real network/image probes |
| Provider success is inferred from request acceptance | Idempotency, read-back, uncertain-outcome reconciliation and durable receipts |
| Template `main` moves during the program | Detached clone, exact commit/archive digest and explicit upgrade review |
| Test fixtures are mistaken for production acceptance | Separate alignment, functional-completion and production-acceptance states |

## Change control

- Update the pin only through a reviewed ADR/plan change.
- Update `fleet/template-alignment.json` and every affected app alignment document in the same change.
- Keep gate evidence immutable and commit-bound.
- A failed or skipped required gate reopens the app's alignment status.
- A new advertised capability reopens functional and production acceptance even when template alignment remains valid.
- Direct `template-sync`, applied-migration edits and manually forced alignment booleans are release blockers.
