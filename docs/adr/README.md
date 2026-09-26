# Architecture decisions — review pack

All ADRs are **Proposed** and implemented as described; the code and tests are the
evidence. Accepting one means the team commits to it. Rejecting one means opening a
change, and the listed tests say what would move.

| ADR | Decision | Evidence | Reviewer |
| --- | --- | --- | --- |
| 0001 | Schema per app, three roles, forced RLS | migration.test, tenant.test | ☐ |
| 0002 | Shared cluster per customer VM | deploy/compose.pilot.yml | ☐ |
| 0003 | Matrix after the pilot (bridge built, tested on a fake homeserver) | rooms.test | ☐ |
| 0004 | Gateway as a platform module | inbound-auth, a2a, load tests | ☐ |
| 0005 | Package sandbox: Deno subprocess, no permissions | registry.test | ☐ |
| 0006 | Fresh session in a pooled worker | resume.test, chaos | ☐ |
| 0007 | Never-forked template; old NEOPs are reference only | conformance suite | ☐ |
| 0008 | Grants on the platform | proposal.test | ☐ |
| 0009 | Keyless agents behind an LLM proxy | llm-proxy.test | ☐ |
| 0010 | Separate long-lived registry signing keys | registry.test | ☐ |
| 0011 | Template migration stream | migration.test | ☐ |
| 0012 | Door journal and bounded send recovery | providers.test | ☐ |

To accept one, change its status line to `Accepted — <name>, <date>` and tick the row.
