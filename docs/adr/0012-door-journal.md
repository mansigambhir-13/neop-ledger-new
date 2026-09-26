# ADR 0012 · Door journal and bounded send recovery

Status: **Proposed — implemented; confirm in architecture review.**
Date: 2026-09-26

## Decision
Every door call writes its exact payload to `door_journal` (company-scoped, RLS) before calling the provider, and the provider's id after. Retries always send the journaled payload under the same idempotency key.

If the provider's answer was lost, read-back recovers by re-sending the identical payload under the same key. The provider returns the original result, or performs the send once. This is allowed only within a recovery window (`NEOP_DOOR_RECOVERY_MS`, default 10 minutes, well inside providers' idempotency windows). Past it, the entry is closed as not sent, so an approved message never goes out late.

## Why
Providers such as Resend have no "look up by idempotency key". Without the journal, a crash between "provider accepted" and "we recorded the id" leaves the outcome UNKNOWN forever.

## Trade-off
One extra row per effect. Recovery is bounded in time by design: a person approved "send now", not "send whenever".
