# ADR 0008 · Grants on the platform (D8)

Status: **Proposed — implemented as the plan recommends; confirm in architecture review.**
Date: 2026-09-25

## Decision
Standing yeses live in `neos.grants`. The gate asks the platform for an execution token under a grant; the platform checks limits, mints the token, records usage, and suspends the grant on a FAILED/UNKNOWN outcome.

## Why
The gateway must see grants to mint execution tokens (S3).
