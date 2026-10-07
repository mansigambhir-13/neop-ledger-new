# Final local release verification — 30 September 2026

Runtime/image source commit: `500c547ae705daa473cbb7bae2439238ccc24a4a`
Initial attestation packaging commit: `9e8388507fe9fead542de5816a2606eeee3148e2`
Branch: `s9-delete-gateway`

These results cover the runtime code supplied to the deployment team. A subsequent Compose-only correction removed Synapse's inherited optional profile; 26 focused topology/schema tests, a real Docker Compose render, and ordinary teardown passed after that correction. The final source commit is recorded in `deploy/attestations/ledger.json`. Production deployment and environment acceptance remain with that team.

## Results

| Check | Result |
| --- | --- |
| Full regression | 94/94 files; 609 passed; zero failed; two conditional integrations skipped |
| TypeScript | PASS |
| Conformance attestation | PASS; zero failed; registrable; bound to the source commit above |
| Secret-history scan | PASS; 81 commits scanned with gitleaks v8.28.0 |
| Production container builds | PASS; platform, migrate, Ledger backend/agent, LLM proxy, backup and egress proxy |
| Fresh PostgreSQL 17 migrations | PASS through safe platform 024 and app/package migrations; destructive 025 not applied |
| Appservice lifecycle correction | PASS; Synapse included in default Compose lifecycle; 26 focused tests and actual teardown passed |
| Local Matrix stack startup | PASS; PostgreSQL, PgBouncer, Synapse, platform, backend, agent, LLM proxy, egress proxy and backup |
| Package sandbox executable | PASS; Deno 2.9.6 runs in the backend image |
| Missing production credentials | PASS; production image refuses migration without its admin connection |
| Live container network policy | PASS; 37 required probes; optional development web harness omitted |

The two default-suite skips require real S3 and PostgreSQL client integration inputs. They were exercised separately earlier in the release work and are recorded in `V3-PRODUCTION-READINESS-PLAN.md`; they were not rerun as part of this final container pass.

The history scanner's three exact exceptions are documented in `.gitleaksignore`: a public package-registry signature and two occurrences of a synthetic export-test key. New findings remain failures.

Network probes verified private database/gate/agent boundaries, backend access to Synapse, allowed provider connectivity through the proxy, rejection of an unlisted host, and lack of direct internet access where forbidden. HTTP 404 from an allowed provider proves connectivity only; no real model request or mail was sent.

## GitHub-hosted CI

[Run 36670584083](https://github.com/NEOS-Ecosystem/neos-neop-ledger-new/actions/runs/36670584083) was blocked before any job steps ran. GitHub reported failed account payments or a spending limit requiring adjustment. This is an organisation billing/runner limitation, not a failed code assertion.

Local verification above covers the available regression, compiler, conformance, secret-scan, image and runtime-network gates. A green GitHub-hosted run is still unverified. After the organisation restores Actions capacity, rerun CI for the release branch. No billing setting was changed.

## Local image identities

Built from the committed release on Linux/ARM64. These are local verification artifacts, not images published to a registry or certified for a different production architecture.

| Image | Digest | Platform |
| --- | --- | --- |
| platform | `sha256:49608cdb4e82712b858e5b1186839e3bcd33fca08914ff71851082c14d226a88` | linux/arm64 |
| migrate | `sha256:c2c541dbb436ba6f802f312b4059e69198b47892ee9302fde6eb7244a00852d7` | linux/arm64 |
| ledger-backend | `sha256:e61cdfee15b3e4a2d6d3a5d478c31fc305c59e680c5deabdf0cd5043d3eecafc` | linux/arm64 |
| ledger-agent | `sha256:af7ecae41e7bfc28462bb5359deb95be3feb886ce7b8934a766b6de23b2d882d` | linux/arm64 |
| llm-proxy | `sha256:b20c674f5f2c7c9e162bfabb899e12e4cdc62d38eb72f1df07d3561bf535c45a` | linux/arm64 |
| backup | `sha256:4fbb3cab05f0b30bbcd91e66cb18098be477bcd385ef4724df9d15f112c3e936` | linux/arm64 |
| egress-proxy | `sha256:e6ee01308049219d47d90ed202fbc93dcc6e3a3c397d9ead686b3d86f866730c` | linux/arm64 |

The disposable test project was `neop-release-ci-01a0e77e`. It used newly generated credentials and no published ports. Its containers, volumes and temporary credentials were removed after the checks; local image tags remain available. Existing user deployments were not changed.
