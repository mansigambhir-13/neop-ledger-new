Current implementation checkpoint: FLEET-V3-CHECKPOINT-18.md. Final complete regression: 3,637 passed, zero failed, two existing conditional skips across 314 files (784.27 seconds), including all 205 new question-binding/context/contract cases. TypeScript and 108 pinned source hashes pass; completion remains refused. Earlier evidence and unresolved intermittent diagnostics below are preserved as history.

## Eighteenth checkpoint — expected peer-question identity and persisted context

2026-10-05: a2a.answer v2 requires the caller's exact expected question ID and rechecks it under company/job/thread locks. Fresh assistant bundles restore bounded, scoped pending peer context after human input/restart; opaque IDs stay escaped untrusted data. This is not immutable answer-content binding, retry wait reuse or crash-safe delivery. Eleven new cases per app plus seven shared contract tests are included in the final complete run. The first full run had 3,636 passes, one deterministic legacy scripted-caller failure and two skips; an instrumented reproduction recorded null-regex failures across five attempts. Updating that caller to the v2 context/arguments preserved its success assertions, then 42 focused tests and the definitive complete rerun passed. Earlier fixture/Unicode diagnostics and the 644-pass targeted run remain separately scoped evidence. See checkpoint 18 and ADR-0030 for hashes, cleanup, breaking-contract rollout coordination and remaining intent/business/provider/parity/privacy/live-acceptance work. Older intermittent failures remain unexplained; all eighteen are incomplete.

## Seventeenth checkpoint — bounded outbound answer finalization

2026-10-05: prepare and finalize a2a.answer with current job/session ownership checks, preserve a newer question and unclaimed/late wakes, and report send failure as unconfirmed. Twelve synthetic cases per app use seeded state, a real gate/local runner claim, fake transports and fresh-assistant follow-on recovery; no shipping domain borrowing/provider/source-parity change. Five runtime assertions were reproduced across two selected runs before their corresponding fixes. Fixture corrections distinguish database DONE from API COMPLETED and wait for the asynchronous mirror; failed reports remain retained. Final targeted result: 264 passes, overlapping the full run. See checkpoint 17 and ADR-0029 for hashes, cleanup and remaining durable intent/content-bound retry/crash gaps. All eighteen remain incomplete; older intermittent failures are not claimed repaired.

## Sixteenth checkpoint — atomic incoming bus questions

2026-10-05: question receipt/thread/wait/step/outbox updates now commit together, with retryable failures and durable accepted peer wait identity after an answer. Twelve seeded cases per app cover rollback, restart, duplicate and cancellation/result contention, tenant/sender/thread validation, subsequent questions and polling after LISTEN loss. A synthetic tasks.open target exists only in the in-memory fixture; no shipping business borrowing/provider/source-parity capability changes. All eighteen remain fifteen partial/three pending groups, not production-ready. See checkpoint 16 and ADR-0028 for the five pre-fix runtime failures, corrected fixture, test-only TypeScript fix, interrupted full attempt, definitive frozen-source full run and cleanup. Outbound re-answer finalization, input/other ingress, live deadlines, historical repair and real acceptance remain separate gaps. Older unexplained intermittent failures are not claimed repaired.

## Fifteenth checkpoint — atomic terminal bus results

2026-10-05: fix reproduced partial receipt/thread/wait commits, competing duplicate results and post-cancellation result-history writes. Result receipts, waits, operations, steps/outbox and thread transitions commit together; retryable failures return HTTP 503. Sixteen seeded-receiver cases per app cover rollback, restart/redelivery, concurrent replies, cancellation ordering, sender/thread/company isolation and lost-LISTEN polling. No business ability, migration, provider or source-parity capability is added. See checkpoint 15 and ADR-0027 for retained failed reproductions/fixture corrections, full-run hashes, coordinated rollout cautions and remaining generic-ingress/deadline/legacy-repair gaps. The 308-test fleet-targeted run overlaps the final full run and preceded final source freeze; it is not additional final-source acceptance.

## Ninth checkpoint — transaction-time internal human authority

2026-10-01: Pay/Buy/Renew internal settings/import/cancel writes gain exact human identity/content/current policy checks inside their receipt transaction, standing-grant refusal, commit-time identity/policy locks and expiry-after-lock-wait refusal. Final full regression: 1480 passed, zero failed, two existing conditional skips across 168 files in 542.85 seconds. The 57 new authority/migration tests are included; the final targeted 57-test run and six-test catalog rerun overlap that count. TypeScript, all 108 pinned source hashes and readiness/evidence consistency pass. See FLEET-V3-CHECKPOINT-9.md for the earlier fixture/type failures and historical pre-final-fix run. This is not business authorization, complete workflows or live acceptance. Prior images/results are historical after shared source changes; refreshed artifacts are required before release. No app is production-ready.

# Fleet V3 — first execution checkpoint

Date: 2026-09-30. Branch: `rebuild/fleet-v3`. Base: `25279c1`.

## Scope actually delivered

Sanitized local Quick Build source copy; content-hashed provenance; provisional twenty-app catalogue; source-specific work packages for eighteen queued apps; preserved Ledger baseline; first Wage V3 vertical slice with eleven closed abilities. No deployment, production database mutation, payment, filing, email or live-provider call was performed.

## Verification results

| Check | Result |
| --- | --- |
| `pnpm typecheck` | PASS |
| `pnpm exec vitest run --reporter=dot` | 97 files passed; 643 tests passed, 2 conditional tests skipped; 140.20 seconds |
| `pnpm exec vitest run scripts/fleet/tests --reporter=dot` | 1 file; 4 tests passed |
| Wage subset | 3 files; 34 tests passed (included in the 643 above) |
| `pnpm exec tsx scripts/dba-bundle.ts wage --out …` | Generated a review-only 19-migration bundle; no DB connection |
| `pnpm exec tsx scripts/conformance.ts wage` | Expected refusal: sixteen required release suites are not yet supplied; no attestation generated |
| `pnpm fleet:status --require-complete` | Expected exit 1: provisional roster, eighteen queued apps, incomplete Wage certification |
| `git diff --check` | PASS |
| Gitleaks v8.28.0 on the exact staged patch | PASS; approximately 162.61 KB scanned, no leaks found |

The two conditional tests require S3 object storage and PostgreSQL dump/restore tooling. Their historical Ledger evidence does not certify Wage or this fleet build. The 643-test full run preceded addition of the four inventory tests; those were then run separately. Total distinct passing assertions: 647.

## First full-run failure and diagnosis

The first fresh-checkout run passed 618 tests and failed 25 across six existing Ledger package/GST suites. The initial offline installation had used `--ignore-scripts`, so the pinned Deno package was present but its executable was missing. The failures explicitly included `deno binary not found; set NEOP_DENO_PATH`, with downstream install/GST assertions failing for the same missing sandbox.

Ran the pinned Deno 2.9.6 `install.cjs` to link its already-cached native binary and verified `deno --version`. No host fallback, sandbox disablement, test suppression or application workaround was added. Re-ran the complete suite: 643 passed, zero failures, two conditional skips. For a new checkout, install approved dependency hooks or explicitly run this pinned postinstall before the suite; do not use an incomplete `--ignore-scripts` environment as a release bar.

## What Wage tests prove

- Exact salary/hourly arithmetic, half-up rounding, caps, safe bounds and explicit missing-time refusal.
- Blank install, validated manifests, read honesty, company isolation and tighten-only switches.
- Matrix-driven jobs, gate-created proposals, fingerprint rejection, durable backend restart, runner execution and immutable receipt read-back.
- Release never claims paid; stale inputs fail at effect time; released runs cannot reopen; superseded revisions retain prior payslips.
- Invalid timesheet batches roll back atomically; repeated preparation cannot duplicate a period; history mutations and cross-schema reads are denied.
- Reapplying this initial migration set to populated disposable Wage data makes no changes. This is not a rehearsal of a legacy production-data migration.
- Reviewed desk SQL and assistant reads return the same persisted payroll data.

## What is not proven or implemented

Full seventeen-suite per-app release attestation; all real sender/injection/network/chaos bars for Wage; live Matrix and model/provider acceptance; bank payments; statutory calculations/returns; payslip delivery; complete legacy parity; legal retention/erasure; production images/appservice/secret provisioning; actual NEOS UI acceptance. The other eighteen app work packages are not implemented. Do not register this fleet as production-ready.

See `FLEET-V3-REBUILD-PLAN.md` and `adr/0014-fleet-v3-rebuild.md` for the source hierarchy, phased scope, decisions and remaining gates.

## Fourth checkpoint — standalone runtimes

2026-10-01: all eighteen remaining apps have fixed backend/assistant entrypoints. Full regression: 1294 passed, 0 failed, 2 conditional skips across 160 files. Final configuration/process rerun: 117 passing tests. See FLEET-V3-CHECKPOINT-4.md for scope and timing; previous sections above describe historical checkpoints, not current fleet completion. No app is production-certified.

## Fifth checkpoint — assistant artifacts

2026-10-01: assistant-only context packaging and a Docker image/isolation fixture for all eighteen apps. Final full regression: 1307 passed, 0 failed, 2 existing conditional skips across 161 files. The 13 packaging tests are included in that count, not additional passes. See FLEET-V3-CHECKPOINT-5.md for image results, failure/fix history and limits. Backend images, complete business lifecycles and production acceptance remain incomplete.

## Sixth checkpoint — persisted process jobs

2026-10-01: five multi-process internal-draft lifecycle scenarios for every remaining app, including waiting-state crash/restart and approval/replay proof. Full regression: 1397 passed, 0 failed, 2 existing conditional skips across 162 files. The 90 new tests and 15-test targeted subset are included in that total, not additive. See FLEET-V3-CHECKPOINT-6.md for failure/fix history, exact scope and evidence. No production-ready flag or new business ability is added. Backend images and broader recovery/live acceptance remain open.

## Seventh checkpoint — backend artifacts

2026-10-01: backend-only contexts, lock-pinned Linux Deno and all eighteen own-app Linux ARM64 backend images pass local startup/role/sandbox/refusal/shutdown checks. Full regression: 1413 passed, 0 failed, 2 existing conditional skips across 163 files, 428.98 seconds. The 16 new backend policy tests are included in the total; targeted packaging/catalog reruns overlap it. See FLEET-V3-CHECKPOINT-7.md and its per-image evidence for exact scope and three earlier fixture/build failures. Complete jobs across both images, broader recovery, business/provider/source-parity work and production acceptance remain open. No production-ready flag is enabled.

## Eighth checkpoint — persisted jobs through both images

2026-10-01: 90/90 existing internal-draft lifecycle scenarios pass against all eighteen exact backend/assistant image pairs in 366.44 seconds; 18/18 initial six-probe network checks and all owned fixture cleanup pass. Ordinary full regression: 1423 passed, 0 failed, 2 existing conditional skips across 164 files, 398.17 seconds. The ten new policy/cleanup tests are included in that total; the ninety Docker executions are a separate mode of existing assertions, not extra distinct tests. See FLEET-V3-CHECKPOINT-8.md for evidence and the earlier preflight hook timeout. Business approval/provider/source parity, broader recovery and real acceptance remain incomplete. All production-ready flags remain false.

## Tenth checkpoint — immutable creating-job provenance

2026-10-01: Pay/Buy/Renew now capture immutable creating-job, original human/nonhuman basis and exact draft-hash provenance for new drafts. Final full regression: 1540 passed, zero failed, two existing conditional skips across 172 files in 373.27 seconds. The 60 new tests are included; the 197-test finance subset overlaps this total. TypeScript and all 108 pinned source hashes pass; completion gate still refuses readiness. See FLEET-V3-CHECKPOINT-10.md for scope and evidence. Business authorization, source parity, providers, privacy/legacy policy and production acceptance remain incomplete.

## Eleventh checkpoint — fleet internal authority and origins

2026-10-01: the remaining fifteen apps opt into execution-time internal-write authority and immutable authenticated draft origins, completing that prerequisite across eighteen. Full regression: 2110 passed, zero failed, two existing conditional skips across 203 files in 466.58 seconds. The 570 new tests comprise 270 authority, 285 origin and 15 populated forward upgrades, included in the total; the 273-test focused run overlaps it. TypeScript, all-eighteen guard/version/privacy/provider inventory and 108 pinned source hashes pass. Completion still refuses: all eighteen remain fourteen partial/four pending groups, not certified. See FLEET-V3-CHECKPOINT-11.md. No business approval, provider dispatch, refreshed image acceptance or live production acceptance is implied.

## Twelfth checkpoint — proposal deadlines and waiting lifecycles

2026-10-01: forward-only shared t022 rejects yes/no/change that cross proposal or later job locks after the deadline, atomically rolling back answer evidence. All eighteen receive internal-import supersession, withdrawal, expiry/restart and competing-executor tests. Four representative populated synthetic books retain history and privileges on upgrade. Final complete regression: 2330 passed, zero failed, two existing conditional skips across 222 files in 580.51 seconds. The 220 new tests are included, not additive. The first full run had one existing Ledger bridge-refusal message failure (2329 passed); the unchanged file passed in isolation and the same complete suite then passed. Root cause remains unconfirmed and the failure report is retained, not declared fixed. TypeScript, 6/6 catalog checks, 108 source hashes, deadline-only SQL and readiness/provider audits pass; zero owned upgrade fixture databases remain. See FLEET-V3-CHECKPOINT-12.md for reproduction and test-fixture correction history. All eighteen remain fifteen partial/three pending groups, with eighteen unfulfilled groups and no production readiness. Business decisions, provider/source parity, privacy/recovery, refreshed artifacts and live acceptance remain open.

2026-10-05: checkpoint 13 adds t023 input-answer wall-clock expiry and consistent job-before-question ordering in answers and input expiry. All 274 new tests passed in a complete isolated run: 2603 passed, one existing secret-export fixture failed, two existing conditional skips across 241 files in 1224.49 seconds. Its inherited admin URL targeted the cluster bootstrap database instead of the pilot; only the subprocess fixture environment changed, and the entire nine-test file then passed (27.00 seconds), plus TypeScript. This is not a claim that 2604 passed in one full run at checkpoint 13. The clean post-correction full rerun was outstanding then and is recorded below in checkpoint 14. Earlier shared-cluster run: 2601 passed, three failed, two skipped; all reports and diagnostic limits are retained. Catalog6, pinned sources108, readiness/provider audits pass; all eighteen remain fifteen partial/three pending groups and incomplete. No image rebuild, push, merge, deployment or live acceptance. The owned isolated database was removed; shared roles and older fixtures were not manually remediated. See FLEET-V3-CHECKPOINT-13.md and its evidence JSON.

## Fourteenth checkpoint — isolated baseline and timer recovery evidence

2026-10-05: an unchanged checkpoint-13 complete baseline passes 2,604 tests with two existing conditional skips across 241 files (449.10 seconds). All eighteen then gain six timer recovery scenarios each. The final complete run passes 2,712 tests, zero failures and two existing conditional skips across 259 files (501.31 seconds); all 108 new cases are included, not additive. The focused 135-test and final catalog6 runs overlap this total. TypeScript, 108 source hashes and the expected incomplete release gate pass. No runtime/migration/provider/source-parity capability changed.

The first baseline attempt had 2,561 passes, five failed tests, three setup-failed suites and 40 reported skips (38 unexecuted due to setup failure plus the two existing conditional skips). A recorded 938-second laptop low-power sleep interrupted that run. One Pay wake-count failure occurred before sleep and remains unexplained; the six affected files passed unchanged, then the complete baseline passed. Reports are retained, assertions/timeouts unchanged, and passing reruns are not claimed as an intermittent-defect fix. The owned fixture was removed after checking zero active pilot sessions; three residual synthetic databases were discarded with its tmpfs. See FLEET-V3-CHECKPOINT-14.md and its evidence JSON for exact boundaries, hashes and remaining work. All eighteen remain incomplete and not production-ready.

## Nineteenth checkpoint — immutable outbound answer intent

2026-10-06: final fresh isolated complete regression passed 4,019 tests, zero failed and two existing conditional skips across 315 files in 1,204.61 seconds. All 382 new cases (21 per app plus four populated synthetic upgrades) are included, not additional passes. Nineteen runtime/migration/test hashes were frozen and verified. TypeScript, catalog6, source108 and the expected incomplete-product refusal pass. Earlier checkpoints 15–18 retain their detailed evidence in their individual checkpoint documents.

The change binds explicit answer retries to immutable tenant/job/thread/question/content/route identity and the same pending live return wait. t024 leaves historical threads unbound and refuses inferred replay. It is not automatic dispatch, a general durable outbox, exactly-once transport or business authorization. No shipping provider/borrowing/source-parity capability is enabled.

Retain all prior outcomes: targeted 1,312 passes; first full 4,013 passes/six migration-inventory failures/two skips; corrected inventories45; second full 4,018 passes/one Ledger bridge-refusal intermittent/two skips; unchanged and diagnostic-focused Ledger10 each. The overnight suspended run had 3,195 passes, 74 failures, 738 collected but unexecuted cases, two conditional skips and twelve uncollected Quote cases. It remains failed evidence, not wholly proven environmental. No runtime fix for the intermittent, assertion weakening or timeout extension is claimed. Both owned tmpfs fixtures and disposable credentials were removed; reports remain. See FLEET-V3-CHECKPOINT-19.md and its evidence JSON. All eighteen remain fifteen partial/three pending groups, production_ready=false and full_parity=false; no push, merge, deployment or live acceptance.
