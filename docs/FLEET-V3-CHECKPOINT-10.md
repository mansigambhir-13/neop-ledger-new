# Fleet V3 rebuild — tenth verified implementation checkpoint

Date: 2026-10-01. Branch: rebuild/fleet-v3. Starting commit: 9a6be519a7de8d928745b55ff08076db390381e4.

Worktree: /Users/mansi.gambhir/Documents/NEOPS_NEW/.claude/worktrees/fleet-v3-rebuild.

## Outcome and limits

Pay, Buy and Renew now preserve immutable creating-job provenance for newly prepared internal drafts. The record binds the exact draft hash to its original linked/represented human when known; a machine-only job is explicitly nonhuman with a NULL human. Historical drafts receive no guessed origin. This completes a bounded provenance prerequisite, not the business-approval state machine, original-proposer separation in approval decisions, elevated entitlements or provider execution.

The other fifteen apps retain their prior internal-draft behavior. Shared template t021 makes the opt-in capture trigger available, but only these three app migrations attach it. No new business ability, external effect or production-ready flag is added. The root integrate/v3 and separate Ledger release checkout were not altered by this run. Ledger/Wage application code is unchanged; five Ledger migration expectations and Grant's bundle count account for the new shared migration.

## Implemented

- Shared t021 checks a transaction-local creating-job reference set by the backend, active install/company/job, then resolves on_behalf_of or the human requester from platform-maintained identity mirrors. Caller/model actor fields are not accepted. Revoked/unknown/conflicting roles and malformed identities refuse the insert. Represented people without Matrix links use the existing acted_for fallback.
- App-specific forward 004 migrations create company-isolated draft_origins tables with immutable draft/job/hash/human/basis/timestamp evidence and company/draft foreign keys. App INSERT/UPDATE/DELETE is denied; owner UPDATE/DELETE also meets the immutable-history guard. Direct EXECUTE on the capture function is not granted to app/runner/Desk. The schema owner is non-BYPASSRLS and the function has a fixed search path.
- Origin, draft and receipt commit together. Job/person/install locks retain the attribution snapshot until commit. Replay and cancellation cannot relabel the creator. Raw app-role draft inserts without creating-job context are refused, and transaction-local context does not leak to later writes.
- Provenance is kept in a separate private table instead of adding personal IDs to business snapshots, public reads, receipts or model outputs. Manifest privacy tags identify its subject and draft/job/hash linkage. This does not implement erasure or establish a lawful retention policy.
- Manifest versions advance from 0.2.0 to 0.3.0 and prepare abilities from 1.0.0 to 1.1.0. Checkpoint 9's three protected internal-write ability versions remain 1.1.0. Dependencies, applied migrations, existing domain hashes and read contracts are unchanged.

The gate's authenticated job context and the platform's identity mirror remain trust boundaries. This is not protection against a compromised backend credential or privileged database owner. It does not prove live role propagation or predicate locking against concurrent privileged insertion of new identity aliases. Origin rendering in a business decision card/UI remains future work.

## Verification

| Check | Result |
| --- | --- |
| Final complete regression | 172 files; 1540 passed; 0 failed; 2 existing conditional skips; 373.27 seconds |
| Finance/origin/migration subset | 17 files; 197 passed; 0 failed/skipped; 37.00 seconds |
| New origin tests | 19 per app, 57 total; included in the full count |
| New populated upgrade tests | 3/3 passed; included in the full count |
| TypeScript | PASS |
| Final catalog rerun | 6 passed; overlaps the full count |
| Evidence/readiness consistency | PASS; all eighteen explicitly incomplete |
| Pinned source snapshots | 108/108 verified |
| Completion gate | Expected exit 1; zero production-ready apps |

The 60 new tests are included in 1540, not additive; the targeted subset overlaps the full run. The two existing conditional skips concern real S3 and PostgreSQL dump/restore prerequisites, not accepted fleet storage/recovery evidence. Runtime/test/migration sources were frozen for the final full run; subsequent edits record documentation and evidence only. No image build or packaged-job replay was performed as new progress.

Origin tests exercise real job/gate/runner/app transactions with synthetic Matrix/model transports. Positive human attribution follows the real task path. The machine-only classification test deliberately alters synthetic job metadata to test the no-human case; it is not live autonomous-agent transport acceptance. Negative fixtures cover missing/foreign/inactive jobs, removed/revoked/conflicting identities, malformed human attribution and forged model fields. Tests also cover permission/RLS/immutable history, cancellation by another person, replay after identity changes, held job/person locks, raw SQL refusal, context reset and induced pre-commit rollback of all three records.

Migration tests apply t021 plus app 004 to populated pre-change synthetic V3 books, verify old jobs/settings/parties/drafts/receipts are byte-for-byte equivalent as JSON, retain no origin row for historical drafts, refuse app-side fabricated backfill, preserve legacy cancellation and reapply empty. They do not certify legacy conversion, production-data restore, backup recovery, privacy or DBA approval. The existing six-way concurrent replay tests now obtain a real creating-job context and verify one matching origin, rather than manufacturing a no-job handler context.

Initial typecheck caught an unknown-error narrowing issue in the extended definite-error branch; the error access was corrected. Selected Pay tests passed 31/31 and the selected Buy/Renew/migration tests passed 40/40 before review added the raw-insert/rollback cases. No test failure was skipped and no timeout/assertion was weakened. Architecture and testing-strategy skills guided the shared trigger and layered tests; code-review added permission/atomicity checks and subject/job indexes. ADR-0023 records the proposed design and required owners.

Machine-readable results, raw-report hashes and changed source bindings are in docs/evidence/FLEET-V3-CHECKPOINT-10-ORIGINS.json. Raw reports remain under `/Users/mansi.gambhir/Documents/Codex/2026-09-28/lo/work/`: `fleet-v3-checkpoint-10-tests.json` and `fleet-origins-10-targeted.json`. Only owned disposable synthetic databases/template copies were removed by fixture cleanup; that temporary state is not recoverable. No user or production data was removed. The staged secret scan and local commit are recorded in the handoff.

## Remaining work and next step

1. Implement business-authorization states and original-proposer separation using immutable origins, with rejection/revocation/supersession/replay checks. Company elevated roles, limits and treatment of nonhuman/historical requests require explicit owner-reviewed policy; do not invent permission or backfill identity. Provider dispatch remains absent.
2. The other fifteen still need opt-in authority/provenance coverage. All eighteen still need full domain/source entity/scenario/deliverable parity; provider idempotency, independent read-back and uncertain-outcome handling; broader recovery/load/chaos; and honest real UI acceptance.
3. Review legacy conversion, restore/recovery, immutable-history retention/erasure/export and origin-table access policy with DBA/privacy/domain owners. Origin rows and their job foreign key add retention constraints; generic erase cannot silently bypass them.
4. Refresh both runtime artifacts and reviewed DBA bundles before release, then rerun packaged acceptance. Checkpoint 5/7/8 images and pre-t021 bundles are historical and do not certify these sources. Production network/storage/secrets/appservice provisioning, other architecture targets, security/license/SBOM/provenance review remain open.
5. Team-owned evidence still required: real Matrix/model/mailbox/connected doors/object storage/NEOS UI, provider sandbox credentials/contracts, operational ownership and DBA/domain-owner sign-off. These do not block all local work; continue other safe implementation while policy/environment decisions are outstanding. Deployment stays with the user's team.

Acceptance counts do not change: Pay/Buy/Renew have fourteen partial and four pending groups; the other fifteen have thirteen partial and five pending. All eighteen have eighteen unfulfilled groups and production_ready=false. Source-parity business-authorization mappings remain pending. Do not send a fleet-complete notification or pause hourly work yet.
