# Sign V3 implementation checkpoint

Working roster: documented twenty. Governing document: NEOP-WHOLE-PICTURE-v3.md. Not production-ready and not full legacy parity.

## Implemented scope

5 closed abilities on the shared V3 template. App-specific SQL columns, company RLS, composite source-record foreign keys, immutable source snapshots, per-company unique business source keys and atomic checksum-bound receipts. Imports (sign.counterparties.import) and cancellation require human approval. Preparation only creates an internal draft; review flags never authorize an effect.

## Evidence and open work

See docs/FLEET-V3-CHECKPOINT-3.md for executed test results. Local tests are not live provider/Matrix/model/UI acceptance. SOURCE-PARITY.json maps every pinned source capability; ACCEPTANCE.json records every V3 requirement without certifying it.

Complete business lifecycle, authenticated proposer/approver separation, elevated entitlements, provider idempotency/read-back, corrections/supersession, full source entity fields and deliverables, legacy-data conversion, retention/erasure, backups, per-app images/network tests and release acceptance remain. Deployment remains team-owned.

## Standalone runtime checkpoint

Fixed-app backend and keyless-assistant entrypoints are now available under scripts/. Configuration and real child-process tests cover startup, schema mismatch, unauthorized ingress and shutdown. See docs/FLEET-V3-RUNTIME.md and docs/FLEET-V3-CHECKPOINT-4.md. This does not complete provider actions, business authorization, images/network policy, source parity or live acceptance.

## Assistant artifact checkpoint

Assistant-only contexts and all eighteen non-root/read-only Linux ARM64 images are locally tested, including dependency inspection, credential-injection refusal, isolated network canaries and a mock-model wire-protocol session. See docs/FLEET-V3-AGENT-PACKAGING.md and docs/FLEET-V3-CHECKPOINT-5.md. These are packaging fixtures, not complete persisted business jobs or production-network certification. Backend images, complete workflows and live acceptance remain open.

## Persisted process-job checkpoint

Five lifecycle scenarios now pass through this app's shipped backend and assistant as separate processes: typed ingress/empty reads, fingerprint-bound import with waiting-backend crash recovery, app-specific draft preparation and authority-field refusal, rejection with a fresh worker, and cancellation/replay receipts. See docs/FLEET-V3-CHECKPOINT-6.md. The model and Matrix services remain local fixtures. This adds verification, not new business abilities, backend images, source parity or live acceptance.

Checkpoint 7 adds a locally built/tested own-app Linux ARM64 backend image with the lock-pinned Deno sandbox, no model SDK, boot/role/schema-drift checks and permission-denial probes. See docs/FLEET-V3-CHECKPOINT-7.md. This does not add business capabilities, full source parity, complete two-image jobs or production acceptance. All readiness flags remain false.

Checkpoint 8 runs the same five persisted internal-draft scenarios through both exact Linux ARM64 images, with fixture Matrix/model transports, waiting-backend crash recovery and worker replacement. All five pass for this app, along with initial network canaries. See docs/FLEET-V3-CHECKPOINT-8.md and docs/FLEET-V3-PACKAGED-JOBS.md. Business authorization, provider execution, source parity, broader recovery and production acceptance remain incomplete.
