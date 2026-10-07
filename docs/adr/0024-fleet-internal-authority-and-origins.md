# ADR-0024: Fleet-wide internal-write authority and draft origins

Status: Proposed; local implementation, not owner or production acceptance.
Date: 2026-10-01.
Deciders: platform identity owner, eighteen domain owners, DBA, privacy owner; approvals outstanding.

## Context

V3 sections 5, 9 and 11 require exact-content human decisions, authenticated on-behalf-of attribution, durable company-scoped books and tagged personal data. Checkpoints 9/10 implement these prerequisites only for Pay, Buy and Renew. The remaining fifteen apps still expose internal settings/import/cancel writes and prepare drafts without those execution-time checks. Their settings and entities differ, and some have no settings table. This is not permission to invent business entitlements or external effects.

## Decision and alternatives

Opt the fifteen apps into the unchanged t020 authority helper and t021 origin trigger. Existing settings/import/cancel handlers require a recorded person-approved proposal, current identity and company policy under locks through commit. Existing receipt replay precedes new-authority checks because it creates no effect. Prepare remains an internal non-external operation but must carry an authenticated creating job. Each app receives a forward-only 004 migration with its own company/draft foreign key and private immutable origin table. Historical rows are not backfilled or rehashed.

Copying finance business rules would invent authority for unrelated domains; introducing another generic workflow framework would not close source parity; leaving fifteen apps unguarded would retain a known inconsistency. Reusing the explicit opt-in guards addresses that bounded inconsistency without changing the business domain. App manifests advance to 0.2.0 and existing write abilities to 1.1.0. No new ability, provider dispatch, standing permission or completed lifecycle is introduced.

## Consequences and limits

All eighteen internal-draft apps share the guard and provenance semantics, not a shared business schema. Agent/model actor fields are not authority. Role changes, policy changes and expiry after a recorded yes can still refuse a not-yet-committed internal write. Known identity/job/policy rows are locked; authenticated backend context and platform-maintained mirrors remain trust boundaries. This is not resistance to compromised backend credentials, privileged alias insertion or owner tampering, nor evidence of live Matrix propagation.

Origins expose no additional personal IDs through public read contracts, receipts or model output. The manifest tags subject and draft/job/hash linkage; retention, erasure, export and job-deletion policies remain unresolved. Original-proposer separation in future business decisions, nonhuman/historical treatment and elevated entitlement rules still need owner review. Historical image and DBA-bundle evidence must be regenerated before release against these sources.

## Test plan and follow-up

- Exercise each app through real local gate/runner/database transactions with synthetic Matrix/model transports, using app-specific domain fixtures and a common internal import ability for authority tests.
- Deny role revocation, removed/unknown identities, tightened policy, late switch-off, expiry while blocked, standing-grant bypass, forged contexts/content and altered yes evidence; preserve receipt replay and lock policy/identity through commit.
- Exercise linked/represented/nonhuman draft origins, invalid contexts, forged model fields, cancellation/replay, ACL/RLS/immutability, raw insert refusal, context reset and atomic rollback with held job/person locks.
- Upgrade fifteen populated synthetic pre-004 books, preserving jobs/drafts/receipts exactly with no invented origin, and verify idempotent reapplication and historical domain cancellation. This is not production restore or DBA approval.
- Run complete regression, TypeScript, pinned-source hashes and the fail-closed completion gate. Passing internal tests must not mark any V3 requirement group fully certified.
- Domain owners: approve business-role/amount/currency/self-approval and historical/nonhuman policies. Privacy/DBA owners: review immutable retention and forward migration. Platform/release owners: refresh artifacts and complete live Matrix/model/UI/provider/recovery acceptance.

Architecture and testing-strategy skills guided the bounded reuse decision and negative/concurrency/migration coverage.
