# ADR 0003 · Matrix later (D3)

Status: **Proposed — implemented as the plan recommends; confirm in architecture review.**
Date: 2026-09-25

## Decision
The pilot's front door is the NEOS app (platform `/api/ask` → `tasks.open`). `inbox.deliver` is implemented and signed so Phase 3 only adds the appservice.

## Why
Rooms add identities and a second inbound path; the pilot does not need them. B4 is already enforced for the room path.
