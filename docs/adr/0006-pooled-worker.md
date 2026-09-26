# ADR 0006 · Fresh session in a pooled worker (D6)

Status: **Proposed — implemented as the plan recommends; confirm in architecture review.**
Date: 2026-09-25

## Decision
The agent container is a pool (default 5) of pi sessions. Each job wake gets a fresh session built from the book; nothing survives in memory.

## Why
Cold start per job is avoided; `resume.test` proves nothing important lives in a session.
