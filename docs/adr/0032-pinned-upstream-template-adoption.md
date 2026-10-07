# ADR-0032: Adopt the pinned upstream template through a compatibility boundary

Status: accepted for alignment planning; runtime adoption remains gated.
Date: 2026-10-06.
Deciders: app engineering; platform/security owners must approve ingress and approval changes; DBA owns migration approval.

## Context

The reviewed upstream is `NEOS-Ecosystem/neos-neop-template` at commit `94db804f94403c15ad1279e6d30dcecc7c078b82`. Its `template.json` declares version `0.8.16`. The source was acquired as an authenticated commit archive with SHA-256 `6a22d515c2a36ddeb8ad613af042960d15b4ab3f41e829bc933e105c9505aa23`.

The upstream assumes one standalone JavaScript repository per NEOP, template-owned files replaced by `template-sync`, a generated manifest, three processes including a standalone frontend, ordinary-client Matrix DMs, and its own numbered standard migrations. This fleet is a TypeScript monorepo with shared packages, appservice/client Matrix support, bus-era correlation, and an immutable forward migration stream through t024.

Version 0.8.15 adds a local ChatGPT/Codex plan-provider, loopback broker, OS-user account binding, grants, revocation and controlled fallback. Version 0.8.16 consolidates each app's runtime services onto one app bridge while leaving the private customer database network backend-only. These are security and operational behaviors, not cosmetic changes, and are tracked by the model-auth/provider and runtime-process gates.

Direct synchronization would overwrite runtime code and tests, cannot import the fleet's app identity shape, and would collide with applied migration history. Folder similarity is not behavioral equivalence.

## Decision

Use **controlled compatibility adoption**.

1. Pin the exact upstream repository, commit, version and archive digest in `fleet/template-alignment.json`; inspect those same verified ZIP bytes for the archived `template.json` identity/version and every mapped gate path before accepting or changing that pin.
2. Treat its behavior and security invariants as requirements to map, not authority to execute its scripts.
3. Do not run `new-neop` or `template-sync --apply` against this monorepo or any existing app directory.
4. Derive alignment only from verified per-app gate evidence. Registry schema v2 reads canonical evidence files, hashes raw single-suite runner reports, recomputes the app/shared source digest and requires that source to match the recorded ancestor commit. A stored boolean, expected filename, self-entered count or passing mock is never enough.
5. Preserve all applied migrations. Any schema compatibility work is a new forward migration with populated-upgrade evidence.
6. Preserve the fleet's t022 answer deadlines, t023 input deadlines/job-first lock order, t024 immutable answer intents, atomic receipts, and backend/assistant isolation until reviewed tests prove an upstream-equivalent guarantee.
7. Keep three claims independent: template aligned, functionally complete, and production accepted.

## Contract conflicts requiring owner decisions

- Upstream uses 1:1 ordinary-client Matrix DMs and `neos.neop.done`; the governing fleet specification uses typed bus/appservice roads and newer result/question/answer semantics.
- Upstream permits an allowlisted reasoning bridge to relay approval on a person's behalf; the fleet currently requires verified human authority.
- Upstream supports its local ChatGPT/Codex broker and also puts a model credential in the agent process; the fleet uses short-lived sessions behind a separate model proxy. Alignment requires a reviewed compatibility decision and tests for account binding, grant/revocation, fallback and secret isolation; it does not authorize copying the upstream auth flow.
- Upstream requires a frontend and authenticated `/api/v1` proxy; the fleet currently exposes data-only blocks and has no per-app frontend process.
- The two manifest shapes, publish/install contracts, standard migration layouts and test harnesses differ materially.

These are threat-model and platform-contract decisions, not mechanical migrations. Until resolved, affected alignment gates remain unverified.

## Consequences

- The first checkpoint changes no runtime semantics or applied migration. Its evidence schema and runner establish how later gates may be proved without granting any gate by themselves.
- Each catalogued app has an app-owned alignment document and starts with zero verified gates.
- Marketing remains outside the documented twenty and is reported separately.
- Subsequent work proceeds through a dual-contract manifest adapter, frontend pilot, behavioral test mapping, source lifecycle, reviewed provider contracts and forward schema compatibility.
- The release evidence validator must fail closed before any alignment checkpoint is described as releasable.
