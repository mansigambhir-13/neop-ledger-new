# Wage — V3 first vertical slice

Status: implemented for local verification; **not production-ready**.

Preserved from Quick Build and its linked Wage repository: salary/hourly pay, reviewed percentage/fixed deductions rounded together and capped at gross, employee status, explicit timesheet inputs, pay-cycle controls and human-reviewed release. Strengthened: integer minor units/minutes, no missing-hours-as-zero, no mixed-currency totals, immutable snapshots, atomic receipts, duplicate-period prevention and stale-input rejection.

Removed legacy execution authority: no HTTP capability gateway, actor-supplied approval, platform finalize/reconcile route or model-driven approval. V3 Matrix and the app's own runner handle the job and proposal lifecycle.

Implemented abilities and schemas are in `manifest.json`. Tests run with `pnpm exec vitest run apps/wage/tests`. Generate a review-only DBA bundle with `pnpm exec tsx scripts/dba-bundle.ts wage`; this does not connect to a database. Explicit `NEOS_APPS=wage` adds it to the existing operator migration command; no app is migrated by default and no deployment was performed.

Release currently means **internal authorization, not payment**. Live bank payments, per-employee disbursement reconciliation, statutory filing, payslip delivery, complete UI acceptance and production artifacts remain outstanding. See `../../docs/FLEET-V3-REBUILD-PLAN.md`.
