# ADR 0011 · The template upgrades through its own migration stream

Status: **Proposed — implemented; confirm in architecture review.**
Date: 2026-09-25

## Decision
Template migrations are `001_standard.sql`, `t002_*.sql`, `t003_*.sql` …; app migrations are `002_*.sql` onward. Both streams are forward-only, checksummed and tracked in the same `schema_migrations`; a name in both streams is refused.

## Why
"Every app takes the template upgrade" needs a way to change the standard tables without taking a number from any app's stream.
