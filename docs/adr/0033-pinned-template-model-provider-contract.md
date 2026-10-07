# ADR 0033: pinned-template model provider contract

Status: accepted for template compatibility

The pinned template permits direct OpenRouter access and optional interactive ChatGPT/Codex plan adapters. The fleet keeps its stricter existing boundary: assistants are credential-free, runners mint short-lived Ed25519 session tokens, and the shared metering proxy alone holds an upstream credential.

OpenRouter remains supported through the proxy's bearer-auth and model-prefix adapter. Anthropic-compatible upstreams use the same metered endpoint. Interactive consumer-plan credentials are not mounted into an unattended agent or backend; this optional template path is disabled. A missing, revoked, foreign, expired, over-budget or unreachable provider fails closed and is recorded. There is no fallback to a direct provider key.

This is a compatibility substitution, not a weakening: app, company, job and session binding; revocable public-key trust; atomic budget reservation; concurrency control; and keyless agents are retained for all twenty NEOPs.
