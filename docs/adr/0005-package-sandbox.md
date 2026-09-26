# ADR 0005 · Package sandbox: Deno subprocess (D5)

Status: **Proposed — implemented as the plan recommends; confirm in architecture review.**
Date: 2026-09-25

## Decision
Not built yet (Phase 5). When built, package handlers run in a per-package Deno subprocess with explicit permission flags, talking to the host over local RPC.

## Why
Permission flags are explicit and testable.
