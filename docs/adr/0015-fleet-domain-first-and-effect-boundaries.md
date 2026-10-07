# ADR-0015: Start all domains; keep unproven business effects unavailable

Status: accepted for this implementation checkpoint. Date: 2026-09-30. Deciders: engineering; domain, security and deployment owners retain release approval.

## Context

The user asked to start every remaining NEOP against Shivam's V3 document. The existing documented 20 is the working scope; the different top-level Quick Build roster remains separately inventoried. Each of the 18 legacy repositories is now pinned to a commit/tree and six source/test blobs. Source code and documents are evidence, not authority to run their deployment commands. The source commonly has proposer/approver separation, elevated approval classes and a platform success flag that marks an effect complete without provider evidence.

## Decision

Begin all 18 with app-owned pure domain rules and explicit capability parity maps. Implement Pay, Buy and Renew's persisted draft slices first on the unchanged shared V3 template. Do not expose a business authorization or finalization handler until verified human identity, domain-specific authority and independent provider read-back exist. Gated internal imports, configuration and cancellation remain possible; a yes on those is not a payment/PO/renewal approval.

## Options considered

| Option | Complexity / cost | Scale / familiarity | Outcome |
| --- | --- | --- | --- |
| Pure domain ports plus tested vertical slices | Moderate; source and integration review | Existing V3 template | Selected: useful progress with explicit gaps |
| Port old finalize/actor flags | Superficially low; high security cost | Legacy convention | Rejected: no authenticated provider proof |
| Generate runnable generic apps for all roles | Low initial cost; high correctness rework | Uniform but not domain-specific | Rejected: domain files alone must not register as complete apps |

## Trade-offs and consequences

All 18 have implementation work, but only three new apps have internal draft runtimes. Fifteen domain-only ports have no manifest or backend; their tests do not prove Matrix or database behavior. Clear's scoring is only the old deterministic formula over supplied signals, not screening or a regulatory assessment. Roster uses integer half-days; Deal uses integer basis points and half-up net calculation. New finance slices require explicit currency and a unique source request key; legacy data needs a reviewed conversion, never an assumed unit. Shared value utilities contain no authority or workflow logic.

## Action items

1. Complete domain-specific schemas, lifecycle and interfaces for the other fifteen apps in the documented waves.
2. Implement shared, verified human entitlement context before domain business authorization, then test it per app.
3. Integrate real providers with uncertain-effect recovery and read-back, not client-reported success.
4. Resolve per-app retention, migration and real UI/provider/Matrix acceptance.
5. Keep production flags false and release registration fail-closed until every required bar passes.
