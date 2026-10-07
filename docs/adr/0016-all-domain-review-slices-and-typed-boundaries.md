# ADR-0016: Integrate every domain review slice; preserve raw evidence and SQL identities

**Status:** Accepted for the implementation checkpoint, not release approval.
**Date:** 2026-09-30
**Deciders:** Engineering implementation; domain, DBA, security and operations owners retain acceptance authority.

## Context

The user requested continued implementation of the remaining eighteen NEOPs. Fifteen had only pure domain ports. Shivam's V3 requires an app-owned schema, closed abilities, a shared gate/runner/Matrix path and an honest record of what actually happened. A runnable definition is not evidence of full workflow parity.

Integration exposed two shared-boundary issues: Grant is a PostgreSQL reserved word, and the pinned assistant harness coerces tool argument primitives before execution. The latter changed a supplied string `"false"` into boolean false in Clear. Asset also inherited a legacy business table name, people, that collides with the template's authenticated identity table.

## Decision

1. Integrate fifteen app-specific review slices with typed SQL columns and source-derived pure rules. Share the existing gate, runner, job and Matrix implementation; do not create generic finalization or provider-success handlers. Pay, Buy and Renew retain their existing internal-draft slices and gain additional negative workflow tests.
2. Quote schema identifiers at SQL boundaries. Keep raw app IDs for manifests, roles, object keys, notification channels and Matrix identities. The migration renderer distinguishes identifier positions from raw identity strings. Existing migration files are not edited.
3. Validate original model tool arguments strictly before the harness can coerce them. Preserve null/false/zero distinctions; backend validation remains authoritative and independent. Clone validated values so the harness cannot mutate the original input.
4. Use Asset assignees for imported business subjects. Only the shared identity path owns people. No asset import grants Matrix membership, human status or approval authority.
5. Keep business authorization, provider effects and release registration unavailable. A cancellation approval concerns an internal draft only. A review flag is not proof of human entitlement.

## Options considered

| Option | Complexity | Consequence |
| --- | --- | --- |
| App-specific persisted review slices on the shared template | Moderate; schema and per-app fixtures need review | Selected: meaningful testable progress without claiming complete business lifecycles |
| Change Grant's public identity or loosen validation | Low initially; breaks naming or evidence semantics | Rejected |
| Reuse the template people table for Asset imports | Superficially simple; mixes data and authority | Rejected |
| Expose legacy decide/finalize handlers now | Low initial port cost; unverified authority and effects | Rejected; separate entitlement/provider work remains required |

## Consequences

All eighteen can be exercised as internal-draft runtimes. Domain-specific columns, constraints, source snapshots and review flags remain app-owned. Master imports are minimal source-reference records, not full legacy entity parity. Drafts are immutable except draft-to-cancelled transitions; source keys cannot be reused. This intentionally leaves correction/supersession, business approval and provider execution unfinished.

Clear assessments record supplied evidence signals and the pinned formula, not live screening, KYC clearance or SAR filing. Unknown signals produce null scores and review flags. Roster half-days, Deal basis points and all money fields retain integer units.

Schema quoting touches the shared SQL paths and therefore requires the entire regression suite, including Ledger and Wage. Strict argument checking can reject previously coerced inputs; the assistant must ask for correct typed values instead of manufacturing them.

## Verification and follow-up

- Per-app domain, contract and PostgreSQL workflow tests; exact yes/no/stale-hash behavior; restart and replay; tenant/FK isolation; unchanged source snapshots and no external handlers.
- Eighteen backends together; all 306 directed cross-schema reads refused; app roles cannot create tables or become neos_desk; declared SQL reads match the assistant surface.
- Explicit regressions for raw boolean/integer/null arguments and quoted SQL schema rendering.
- Complete business lifecycles, authenticated proposer/approver separation and elevated entitlements next; then provider adapters with independent reconciliation.
- Legacy-data conversion, retention/erasure, recoverability, per-app image/network checks and real Matrix/model/UI/provider acceptance remain release gates. Deployment remains team-owned.
