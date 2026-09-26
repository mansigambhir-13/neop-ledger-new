# ADR 0001 · Schema per app (D1)

Status: **Proposed — implemented as the plan recommends; confirm in architecture review.**
Date: 2026-09-25

## Decision
One Postgres schema per app (`ledger`), not prefixed tables in one schema. Three roles per family: `<app>_migrator` (DDL, migration runner only), `<app>_app` (DML, forced RLS), `<app>_runner` (BYPASSRLS, standard tables only). Platform uses schema `neos`.

## Why
Grants enforce the family boundary; stays out of Supabase's exposed `public`. `pgkit` creates the roles; the tenant lint refuses any business table without `company_id NOT NULL` + forced RLS + a policy.
