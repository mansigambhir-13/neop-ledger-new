# Ledger — pinned template alignment

Pin: `neos-neop-template@94db804f94403c15ad1279e6d30dcecc7c078b82` (`0.8.16`).
Status: assessed conflict; **0/12 alignment gates verified**; not production ready.

Ledger is the broad existing V3 reference, with 44 abilities, 33 blocks and an email door. It is not an upstream-template app: its manifest is not generated from `src/app.mjs`, it has no standalone frontend process, and its migration/runtime lineage differs. Acceptance accounting is stale and live statutory, mailbox, provider and NEOS UI evidence remains open.

Adoption follows `docs/TEMPLATE-ALIGNMENT-PLAN.md`. Direct template sync is prohibited. Preserve existing bookkeeping behavior, provider uncertainty handling, model-proxy isolation and all applied migrations until behavioral equivalence is proved.
