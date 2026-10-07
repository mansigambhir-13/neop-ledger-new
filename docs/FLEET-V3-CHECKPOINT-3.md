# Fleet V3 rebuild — third verified implementation checkpoint

Date: 2026-09-30. Branch: rebuild/fleet-v3. Starting commit: 618e38afe4e819a5d00a7d1b382a6c803401f42c.

Worktree: /Users/mansi.gambhir/Documents/NEOPS_NEW/.claude/worktrees/fleet-v3-rebuild.
Root integrate/v3 and the existing Ledger release checkout were not changed. The code checkpoint is local; no push or deployment was performed.

## Outcome

**All eighteen remaining NEOPs now have working, locally tested internal-draft runtime slices. They are not complete business workflows or production-ready products.** The previous fifteen domain-only apps now include manifests, typed SQL tables, repositories, handlers, data-only blocks, assistant fill-ins and real PostgreSQL integration tests. Pay, Buy and Renew retain their existing slices and gain additional negative tests. Across these eighteen apps there are 108 declared abilities. Ledger and Wage business code is unchanged; shared template/SQL improvements are covered by their regression suites.

The documented twenty remains the explicit working roster, not confirmation of the alternative top-level Quick Build roster. Desk here is the support NEOP, not the platform My Desk UI.

## Per-app scope

| App | Persisted internal review scope | Still unavailable |
| --- | --- | --- |
| Pay | Payee/payment drafts; integer money, currency, wire review | Payment authorization and disbursement |
| Buy | Vendor/PO drafts; amount review limits | PO authorization and placement |
| Renew | Vendor/renewal drafts; term and amount review | Renewal authorization and execution |
| Deal | Opportunity/quote drafts; integer discount basis points and net calculation | Quote approval and sending |
| Quote | Account/deal quote drafts; exceptional-band review | Commercial approval and issuing |
| Sign | Counterparty/contract drafts; risk classification | Signature/contract execution |
| Vet | Supplier/onboarding drafts; tier classification | Vendor approval and activation |
| Clear | Subject assessments from supplied evidence; explicit unknown signals | Live watchlist screening, case decisions, clearance and SAR filing |
| Grant | Requestor/access drafts; system and access-level review | Access approval and provisioning |
| Guard | Asset/incident response drafts; severity review | Response authorization and execution |
| Asset | Separate assignee/request records; asset-band review | Asset approval and provisioning |
| Hire | Candidate/offer drafts; integer salary and review limits | Offer authorization and sending |
| Roster | Employee/leave drafts; integer half-days and unpaid review | Leave approval, balance checks and booking |
| Shift | Service/change drafts; risk review | Change authorization and application |
| Sync | Dataset/export drafts; destination and sensitivity | Export authorization and delivery |
| Reach | Audience/campaign drafts; channel, content and recipient counts | Consent/suppression resolution, approval and dispatch |
| Post | Channel/content drafts; audience classification | Content approval and publication |
| Desk | Ticket/refund drafts; integer amount and review limits | Refund authorization and issuance |

Master imports are minimal reviewed source-reference records (UUID, unique source key, name/category and version), not full legacy entity field parity. Review flags are warnings, never entitlement checks. A human yes to import/configuration/cancellation changes internal records only. No supplied actor or success flag can finalize a business effect.

## Shared safety and correctness work

- Each app owns its schema and forced company RLS. Master references use composite company/id foreign keys. Drafts and source snapshots are immutable except the checked draft-to-cancelled transition. The unique business source key cannot be reused after cancellation.
- Company-serialized writes bind transactional receipts to an ability and canonical request checksum. Concurrent retries read the same persisted result; conflicting reuse is refused. Cancellation cards bind the stored content hash and domain details.
- Reviewed SQL reads serve the assistant and data-only UI blocks, with explicit nulls/empty state, timestamps, provenance, bounded pagination and switchboard enforcement.
- Grant exposed PostgreSQL's reserved-name issue. Shared SQL paths now quote schema identifiers while keeping app IDs, role suffixes, notification channels and object keys raw. Role search paths are tested via current_schema() and unqualified reads. No previously shipped migration file was edited.
- The pinned assistant harness coerced string false into boolean false. Strict validation now checks original model arguments before coercion and clones values. A bounded cache holds compiled contracts only, never job data, avoiding repeated validator setup on session heartbeats.
- Asset's legacy people name collided with the template identity table. Its business subjects are assignees; import tests verify that authenticated identities remain unchanged. A catalog test protects template-owned authority tables.

ADR-0016 records the architecture decision. The architecture and testing-strategy skills kept app-specific schemas and evidence separate from shared machinery and release certification. Debugging reproduced the identifier, coercion and table-name failures. Code review caught a non-SQL filename quoting change before completion and added stronger identity/search-path regressions.

## Verification

| Check | Result |
| --- | --- |
| Final complete regression suite | 158 files; 1177 passed; 0 failed; 2 conditional skips |
| TypeScript | PASS |
| Staged patch | Secret scan PASS (no findings); whitespace errors corrected before commit |
| Eighteen backends in one database | PASS: all 306 directed cross-schema reads refused; DDL/role escalation denied; correct search paths; declared reads match the UI data path |
| Per-app workflows | Human yes/no, exact fingerprint, restart, stale execution hash, replay/concurrency, rollback, immutable history, foreign-key tenant isolation, switch-off, populated reapplication and forged-authority refusal |
| Clear unknown evidence | PASS: null score/rating/case/SAR/elevated-review flags, not a negative finding |
| Grant DBA bundle | PASS: 19 migrations match the normal migrator; correct app role home and restricted DDL |
| Source provenance | 108/108 pinned source snapshots hash-verified |
| DBA review artifacts | 18 bundles, 19 migrations each; rendered only, no production connection |
| Fleet completion / Grant release attestation | Correctly refused; no production flags or release attestation issued |

The two conditional skips are existing S3 and PostgreSQL dump/restore prerequisite checks. The final suite includes the existing Ledger/Wage baseline. No new failing test was skipped. Local runs use a scripted assistant and fake Matrix homeserver with PostgreSQL, not live provider/model/Matrix or real UI acceptance.

The initial full regression run had 1,170 passes and four failures: a role search-path quoting bug, two SQL/error-format expectations, and a restart timeout. The actual search path and raw error label were fixed, the DBA SQL expectation was updated for deliberate identifier quoting, and the unchanged restart test passed targeted and final reruns. Validator construction was also reduced with a bounded compiled-contract cache. No timeouts or success assertions were relaxed.

## Still required before functional completion and release

1. **Business lifecycles and authority:** verified human proposer/approver separation, elevated entitlement checks, policy-version/content binding, revocation rechecks, rejection/supersession/corrections and app-specific domain prerequisites. Cancellation is not business authorization.
2. **Actual providers:** per-company credentials, exact approved payloads, provider idempotency, independent read-back and uncertain-effect reconciliation. No current slice sends money, messages, signatures, access changes, exports or filings.
3. **Full source parity:** complete entity fields, company rules, dashboards/deliverables and each pinned source scenario. Clear requires a reviewed evidence/matching design, not blind adoption of the old regex screening code.
4. **Data safety:** reviewed legacy-to-V3 conversion, explicit currency/UUID/time-unit mappings, real populated upgrade/restore, retention/erasure/export rules for immutable data and DBA approval. Reapplying a fresh schema is not a legacy migration rehearsal.
5. **Release packaging and acceptance:** per-app backend/assistant entrypoints and images, network policy proof, all required release suites, manifest-bound clean-commit attestation, real Matrix/model/NEOS UI/provider acceptance, load/recovery and owner sign-off. Deployment remains with the user's team.

Every ACCEPTANCE.json remains partial or pending; all production_ready flags remain false. SOURCE-PARITY.json records partial runtime replacements without claiming full parity. A manifest and passing local tests do not establish business authorization, regulatory correctness or go-live approval.

## Reproduce

From the worktree:

- pnpm typecheck
- pnpm exec vitest run --maxWorkers=4
- pnpm fleet:status --summary --check-sources (requires the ignored local source snapshots)
- pnpm fleet:status --summary --require-complete (expected nonzero)
- pnpm exec tsx scripts/conformance.ts grant (expected nonzero until the missing release suites genuinely pass)
- pnpm exec tsx scripts/dba-bundle.ts grant --out grant-review.sql (renders only)

No dependencies were upgraded: the lockfile changes add workspace links only. Legacy snapshots, credentials, node_modules and the local package cache are excluded from Git/build context. No deployment, external provider action, payment, filing or message delivery occurred.
