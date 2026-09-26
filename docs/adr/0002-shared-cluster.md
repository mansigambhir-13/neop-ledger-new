# ADR 0002 · Shared cluster by default (D2)

Status: **Proposed — implemented as the plan recommends; confirm in architecture review.**
Date: 2026-09-25

## Decision
All apps and the platform share one Postgres cluster per customer VM. A dedicated-DB tier exists only where a contract requires it.

## Why
Template code is identical either way; only connection strings change. Per-schema logical export for single-app restore is a Phase 6 item.
