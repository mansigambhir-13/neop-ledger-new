# ADR 0004 · Gateway as a module (D4)

Status: **Proposed — implemented as the plan recommends; confirm in architecture review.**
Date: 2026-09-25

## Decision
The gateway is a module inside the platform backend (`packages/platform/src/gateway.ts`): EdDSA tokens (60 s, single-use jti) verified by apps against `/.well-known/jwks.json`, ACL, idempotency ledger, audit.

## Why
Same contract as a service, less to run. Extract on an operational reason.
