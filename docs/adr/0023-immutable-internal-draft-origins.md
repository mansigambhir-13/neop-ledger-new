# ADR-0023: Immutable creating-job origin for internal drafts

Status: Proposed; locally implemented for Pay/Buy/Renew only.
Date: 2026-10-01.
Deciders: platform identity owner, finance-domain owners, DBA and privacy/retention owner; no sign-off implied.

## Context

Checkpoint 9 verifies the person answering an internal-write proposal against the current job requester. That requester may differ from the person who originally caused a business draft. A future authorization state machine needs stable original provenance, not a later job's caller string. V3 sections 5, 9 and 11 require an auditable exact-content book, on-behalf-of identity and explicit unknown/personal data. No owner-approved elevated-role or legacy-attribution policy is available, so no new business approval or external dispatch is enabled here.

## Decision

Shared additive t021 provides an opt-in security-definer AFTER INSERT trigger. Each finance app's 004 creates its own draft_origins table with a composite company/draft foreign key, creating-job reference, nullable proposer UUID, attribution basis, exact input hash and recording timestamp. The backend sets a transaction-local creating-job reference from ExecCtx, derived from the authenticated job path. The model has no actor, origin-job or provenance field in its closed input schema.

The trigger checks active install, company and an active RUNNING/WAITING job, then captures on_behalf_of or a human requester. It uses linked people first and represented-person records only when no link exists, as in the presence identity path. Unknown/revoked/conflicting roles and malformed human identities refuse the insert. A job with no human attribution records basis=nonhuman and NULL proposer; it is not promoted to a human request. Install, job and existing identity rows stay share-locked through commit.

The origin is inserted inside the draft transaction, before the receipt commit. A failure rolls all three back. Direct app INSERT/UPDATE/DELETE on origins is revoked; company-scoped SELECT remains. The existing immutable-history trigger also rejects owner UPDATE/DELETE. PUBLIC execution of the capture function is revoked; app/runner/Desk receive no direct EXECUTE grant. A DBA-created trigger invokes it under its non-BYPASSRLS owner with a fixed pg_catalog/pg_temp search path. The job reference is trusted backend context, not cryptographic proof against a compromised backend/database credential.

Old drafts receive no origin row and remain explicitly unattributed. Existing business snapshots, hashes, receipts and cancellation transitions are untouched. Replay/read-back returns already committed results before checking new context; it never rewrites an origin or creates another effect. Cancellation by another person also preserves the original origin. Origin details are not added to public reads, receipts or model outputs in this slice; an eventual reviewed decision card must bind the relevant original-proposer facts explicitly.

## Options considered

| Option | Benefit | Cost / consequence |
| --- | --- | --- |
| Caller/model-supplied actor | Simple | Untrusted; rejected |
| Later job requester lookup | No schema addition | Can misidentify the original requester; rejected |
| Add personal fields to every draft/snapshot/receipt | Convenient reads | Rewrites contracts and duplicates identity; not chosen |
| Separate immutable origin written by shared trigger | Atomic, limited personal linkage, no guessed history | New table and retention/legacy/UI decisions; chosen |

## Consequences and review

New drafts have a durable original-human reference where one is known. The gate's signed job context and platform-maintained mirrors remain the trust boundary. This does not certify live Matrix role propagation, owner-level database tampering, or predicate locking against concurrent privileged insertion of identity aliases. Known revocation and attribution changes are serialized via row locks; current business approval entitlements are a separate, still-unimplemented check.

The origin manifest tag uses proposer_user_id as the subject and tags draft/job/hash linkage. The immutable table and job foreign key constrain erasure and job deletion; no generic erase workaround or unsupported legal retention policy is added. Human-less and historical origins need explicit domain policy before future authorization. Indexes support company/subject and job lookups. Shared template changes require refreshed artifacts and DBA review bundles; historical image evidence cannot certify these sources.

Architecture/testing-strategy skills guided the shared trigger and layered tests. Code-review checks added raw-insert/context-reset and transaction-rollback tests, and subject/job indexes. Scope is locally testable provenance, not a product/release approval.

## Test plan and action items

- [x] Three real backend/gate/runner suites: linked/represented origins, invalid/foreign/inactive context, role removal/conflict, forged model fields, replay/cancellation, tenant/ACL/immutability and held job/person locks. Machine-only classification uses deliberately seeded synthetic job metadata, not live agent transport acceptance.
- [x] Raw app-role inserts cannot bypass the trigger; transaction-local context does not leak; induced pre-commit database failure rolls draft/origin/receipt back together.
- [x] Three populated forward migrations preserve preexisting rows exactly, leave origins absent, refuse fabricated app-side backfill and reapply cleanly. No production restore or DBA approval is implied.
- [ ] Business authorization transitions and original-proposer separation with reviewed elevated-role/limit policy.
- [ ] Historical/nonhuman attribution policy, retention/erasure/export design and reviewed origin rendering in decision/UI contracts.
- [ ] Other fifteen app opt-ins, refreshed artifacts/bundles and production-environment acceptance.
