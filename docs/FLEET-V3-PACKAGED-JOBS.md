# Packaged fleet jobs — local synthetic rehearsal

The opt-in driver in `scripts/fleet/testing/packaged-jobs.ts` runs the same five persisted internal-draft scenarios per app as the host-process suite. The backend and assistant both execute from their exact locally tested Linux ARM64 images. Matrix and upstream-model services remain scripted local fixtures. This is not live acceptance, complete business functionality or a deployment recipe.

## Preconditions

- Pinned workspace dependencies and a local Docker runtime with Linux ARM64 support.
- Retained verified assistant and backend contexts from checkpoints 5 and 7. Their artifact hashes must match the committed evidence; original packaged files and the lockfile must still match the checkout.
- All 36 exact app image IDs in that evidence must exist locally. The digest-pinned Node/PostgreSQL fixture images must already be cached. The driver uses `--pull=never`.
- Host loopback fixtures must be reachable through Docker's `host.docker.internal` mapping. This was rehearsed on the local Docker Desktop environment, not every Linux/Docker installation.
- A new output-report path. Do not supply real credentials or replace fixture transports with live services.

From the repository root, after setting the paths to those retained contexts:

```sh
FLEET_JOB_RUNTIME=docker \
FLEET_AGENT_CONTEXT=/absolute/path/to/verified-agent-context \
FLEET_BACKEND_CONTEXT=/absolute/path/to/verified-backend-context \
FLEET_DOCKER_REPORT=/absolute/path/to/new-fixture-report.json \
pnpm exec vitest run scripts/fleet/tests/runtime-jobs.test.ts \
  --maxWorkers=1 --reporter=dot --reporter=json \
  --outputFile.json=/absolute/path/to/new-test-report.json
```

Preflight is read-only and runs before timed lifecycle hooks; inventory hashing is not job startup. No fixture resource is allocated unless preflight succeeds. The driver owns a new temporary database regardless of ordinary local test DB settings. It accepts only its own database URL and explicit loopback HTTP transport endpoints.

Without `FLEET_JOB_RUNTIME`, the suite retains its host-process mode. A selected-app run can use Vitest's `-t '^asset '` filter; excluded cases are not evidence of success for other apps. Full Docker and host runs are separate execution modes of the same assertions, not 180 distinct tests.

## Evidence and cleanup

The Vitest report is the authority for assertions. The fixture report separately records source-binding counts, exact image IDs, app-level network probes, container start/stop identities and cleanup. A fixture report with `cleanupSucceeded=true` is not a successful test report. Check both.

All created containers/networks have a per-run random ownership label. Normal teardown removes those resources, including only synthetic tmpfs database data and fixture credentials; that disposable state is not recoverable. Tested images and reports remain. On interrupted execution, inspect the report/prefix and exact owned resources before cleanup; never prune unrelated Docker state. No host data volume is mounted.

This fixture proves only the recorded internal-draft scenarios and six initial connectivity canaries per app. It does not certify production egress/metadata/host policy, all crash windows, business approver eligibility, live providers, legacy data conversion or UI behavior. See ADR-0021, the latest checkpoint, per-app ACCEPTANCE.json and SOURCE-PARITY.json before drawing readiness conclusions.
