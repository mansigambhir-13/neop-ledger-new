# ADR 0009 · Keyless agents behind an LLM proxy

Status: **Proposed — implemented; confirm in architecture review.**
Date: 2026-09-25

## Decision
The agent container holds no model key. Per session, the runner asks the platform for an EdDSA token (`aud: llm-proxy`) carrying the company, app, job, session and budgets from the company's switchboard. The LLM proxy (Anthropic-compatible, streaming) verifies it, reserves the worst-case cost against the job budget and the company-app day cap in one statement, calls upstream with the real key, and settles actual usage from the stream.

## Why
The plan's per-job and per-day caps (S9) and "the model never holds a key" were enforced by trusting the agent's own reports. A hijacked agent could under-report. The proxy moves enforcement to where the key is.

## Trade-off
An extra hop and a component on the critical path. It is stateless apart from Postgres, so run two replicas. Reservations are pessimistic: a call that might fit is refused near the cap.
