# ADR 0007 · A never-forked template (D7)

Status: **Proposed — implemented as the plan recommends; confirm in architecture review.**
Date: 2026-09-25

## Decision
`packages/neop-template` is the template; apps import it and supply only a manifest, migrations 002+, ability handlers, SYSTEM.md fill-ins, skills and blocks. Existing NEOS-Ecosystem NEOP repos are reference only.

## Why
The template must be upgradeable, never copied. The team decided (25 Sep 2026) to build new NEOPs on this architecture rather than reuse the ~20 existing ones.
