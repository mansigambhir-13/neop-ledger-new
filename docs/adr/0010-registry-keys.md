# ADR 0010 · A separate, long-lived registry signing keyring

Status: **Proposed — implemented; confirm in architecture review.**
Date: 2026-09-25

## Decision
Registry co-signatures (published skills and packages) are signed by their own Ed25519 keyring, published at `/.well-known/registry-jwks.json`, separate from the gateway's short-lived token keys.

## Why
Gateway keys rotate and retire within minutes. Signatures on published entries must stay verifiable for as long as a version is pinned. On a registry key rotation, the platform re-signs the published entries.
