# ADR-0014: Rebuild the fleet on the completed V3 template

Status: accepted for the first Wage slice; roster selection provisional.
Scope note: ADR-0015 supersedes the roster pause after the user's 2026-09-30 request to start all remaining apps. The documented twenty is an explicit working assumption, not a claim that the alternate roster was confirmed.
Date: 2026-09-30. Deciders: app engineering; payroll/product owners approve business acceptance.

## Context

Quick Build contains a documented twenty-app catalogue but nineteen top-level implementations with a substantially different roster. Its payroll manifest and separately published Wage source use older HTTP/gateway/platform-finalization contracts. NEOPS_NEW/docs/source contains historical V2 material; the user previously selected Shivam's V3 whole-picture document. The completed Ledger release at 25279c1 is the engineering baseline; the root integrate/v3 checkout is older and must not be overwritten.

## Decision

Create rebuild/fleet-v3 as an isolated worktree inside NEOPS_NEW. Keep a sanitized, ignored Quick Build source snapshot with tracked provenance. Preserve business requirements, not legacy runtime authority. Apps share the existing template and own only their domain, repositories, closed manifest, migrations, blocks and skills. Build one verified vertical slice at a time; queued work packages must never register as functional apps.

## Options considered

| Option | Complexity | Cost | Scale | Familiarity |
| --- | --- | --- | --- | --- |
| Port domain behavior onto V3 (selected) | Medium per domain | Regression and provider certification work | Independent backends and schema roles | Proven Ledger template |
| Wrap old HTTP runtime | Low initially, high security debt | Duplicate approval/identity systems | Two conflicting execution paths | Legacy team familiarity |
| Generate twenty generic CRUD shells | Low initially | High rework and false completion risk | Common shape without domain correctness | Superficially uniform |

The selected approach keeps one security model and makes domain gaps visible. It is slower than manufacturing twenty manifests, but it preserves approval and accounting semantics rather than merely preserving method names.

## Consequences and actions

- No production deployment in this task. The deployment team owns rollout and environment approval.
- Wage initially authorizes payroll internally only. Bank disbursement, statutory returns and employee delivery remain unimplemented, not simulated successes.
- V3 owns identity and approvals; arbitrary actor fields, old reconcile/finalize routes, live prompt mutation and permissive host fallbacks are not carried forward.
- Each app needs its own source parity review, domain tests, provider acceptance, migration evidence and conformance attestation. Ledger's attestation cannot attest the fleet.
- Confirm which roster the user means before expanding beyond the common Wage app; retain the alternative inventory explicitly.
