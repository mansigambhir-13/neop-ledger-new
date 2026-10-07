# Fleet V3 rebuild — eighth verified implementation checkpoint

Date: 2026-10-01. Branch: rebuild/fleet-v3. Starting commit: 0b5a439a2295fff3a2e438dde167f4d85c804a09.

Worktree: /Users/mansi.gambhir/Documents/NEOPS_NEW/.claude/worktrees/fleet-v3-rebuild.

## Outcome and scope

All eighteen remaining apps now pass their five persisted internal-draft lifecycle scenarios through BOTH actual packaged runtimes. The ninety assertions from checkpoint 6 run unchanged against the exact Linux ARM64 backend and assistant image IDs already tested at checkpoints 7 and 5. This closes the packaged-job integration gap, not the business-functionality or production-acceptance gaps.

No runtime business code, applied migration, dependency version or image was changed. No payment, message delivery, signature, access change, export, filing or production-data operation was performed. No deploy, push or merge occurred. The root checkout, separate Ledger release checkout and Ledger/Wage application code remain untouched.

## Implemented and verified

- Opt-in packaged driver for the existing job suite, with default host-process behavior preserved. It verifies both complete retained artifact inventories, evidence hashes, the current lockfile, 43 original assistant source bindings and 327 backend source bindings, plus exact cached app/platform/image identity before creating fixtures. This is source binding for packaged entries, not signed release provenance or proof that newly added files are included.
- Real backend/assistant images, actual PostgreSQL app/runner roles, gate, proposals, waits, receipts, typed events, SDK sessions and signed/metered model proxy. Matrix and upstream model remain local scripted fixtures; no handler shortcut or successful-job SQL mutation is used.
- New disposable tmpfs database; own labelled containers/networks; non-root, read-only, capability-dropped runtimes; no host data mounts. Each assistant joins only its app's internal network. Fixed-destination TCP relays bridge only fixture model/control traffic. The backend's control network reaches local fixtures; this topology is not production network policy.
- For every app, initial connectivity probes confirm gate/model reachability and refuse backend files, Matrix ingress, direct database IP and the host-published database port. These six canaries do not certify unrestricted host/metadata/general-egress isolation.
- Immutable image/source and loopback URL policy tests; cleanup continues across independent failures. Creation is refused after shutdown begins, and tracked in-flight creations are awaited before cleanup. Test outcomes remain separate from fixture cleanup status.

The five scenarios per app cover: invalid ingress followed by a real empty read/redelivery dedupe; fingerprint-bound import with a waiting-backend SIGKILL and fresh-session read-back; app-specific draft persistence and forged-authority-field refusal; rejection after replacing the assistant; exact cancellation and same/new-event replay dedupe. They do not cover a crash between an external effect and its receipt, nor complete business approval eligibility.

## Verification

| Check | Result |
| --- | --- |
| Complete ordinary regression | 164 files; 1423 passed; 0 failed; 2 existing conditional skips; 398.17 seconds |
| Packaged persisted jobs | 90/90 passed; 18 apps; 0 failed/skipped; 366.44 seconds |
| New policy/cleanup subset | 10/10 passed; included in the ordinary full count |
| Selected Asset packaged rehearsal | 5/5 selected tests passed; 85 cases excluded by name filter, not disabled |
| Exact images used | 36 existing Linux ARM64 images; no rebuild or pull |
| Runtime starts/stops | 72 starts; 18 deliberate backend SIGKILLs; 54 clean exit-zero stops |
| Initial assistant boundary probes | 18/18 passed; six probes per app |
| TypeScript | PASS |
| Pinned source snapshots | 108/108 verified |
| Completion gate | Expected exit 1; zero production-ready apps |
| Fixture cleanup | PASS; independent Docker inventory found zero owned containers/networks |

The ninety Docker scenarios repeat existing assertions in a different runtime mode; do not add them to the 1423 distinct ordinary tests. The two conditional skips concern real S3 and PostgreSQL dump/restore prerequisites, not newly skipped failures or accepted fleet backup/storage evidence. The runtime/test sources were frozen during the final two runs, which ran concurrently; subsequent edits record documentation and evidence only.

Machine-readable results, raw-report hashes, harness/source hashes, exact per-app image IDs, case results and canaries are in docs/evidence/FLEET-V3-CHECKPOINT-8-PACKAGED-JOBS.json. Raw reports are retained under `/Users/mansi.gambhir/Documents/Codex/2026-09-28/lo/work/`: `fleet-v3-checkpoint-8-tests.json`, `fleet-packaged-jobs-8-all-tests.json` and `fleet-packaged-jobs-8-all-fixtures.json`. The complete packaged run prefix was neop-fleet8-2ce3a5d9. Local image IDs are not registry digests or signed attestations.

Only disposable synthetic fixture data and credentials were removed with the containers; that temporary state is not recoverable. No user or production data was removed. Existing tested images, contexts and success/failure reports remain available.

## Failure history and review

Initial typecheck rejected constructor parameter properties under the repository's erasableSyntaxOnly setting; explicit fields/assignments fixed the harness without changing compiler policy. The first selected packaged attempt timed out in read-only artifact preflight inside the 60-second setup hook, before any fixture allocation or passing scenario. Inventory validation now runs before lifecycle hooks; hook/test timeouts and assertions are unchanged. A fresh selected Asset run and the all-eighteen run passed. The failed attempt retained its own reports and left no owned resources.

Architecture and testing-strategy skills guided reuse of the real persistence assertions with isolated synthetic transports. Debugging separated artifact verification from job timing. Code review added cleanup continuation, creation-after-close guards, exact image/source binding and explicit limits on network claims. ADR-0021 and FLEET-V3-PACKAGED-JOBS.md document the design and reproduction preconditions.

## Remaining work and next step

1. Next implementation priority: checkpoint 3's business-authorization gaps, starting with Pay/Buy/Renew. Bind authenticated proposer/approver identities, company entitlements and exact policy/content at execution; refuse self/unknown/ineligible/revoked authority. Keep provider execution absent until reviewed policy and provider contracts exist. Reuse template policy machinery where appropriate; do not add an actor argument or an agent approval route.
2. Complete app-specific state machines, supersession/corrections and full pinned entity/scenario/deliverable parity. Internal import/cancellation decisions are not business authorization. SOURCE-PARITY.json is unchanged by this testing checkpoint.
3. Provider interfaces still need per-company credentials, idempotency, independent read-back and uncertain-outcome reconciliation. Local fixtures can test contracts; live sandbox credentials, provider choices and domain-owner acceptance are separate requirements.
4. Add active-session/in-flight-effect crashes, lease/heartbeat expiry, concurrent runners, transport outages and load/recovery scenarios. This checkpoint proves waiting-state recovery only.
5. Reviewed legacy-data conversion, populated upgrade/restore, privacy/retention/erasure/export rules and DBA approval remain open. Appservice/secret/storage/network manifests, other architecture builds, SBOM/license/vulnerability/provenance review and manifest-bound release attestation also remain open.
6. Real Matrix/model/mailbox/connected-door/storage/NEOS UI and operational acceptance remain team-controlled. Required environments/credentials, reviewed company authority/retention policies and sign-offs are unavailable here. These do not block continued safe local implementation. Deployment stays with the user's team.

All eighteen retain thirteen partial and five pending acceptance groups; every production_ready flag remains false. No full V3 product completion or live acceptance is claimed. The final staged-patch scan and local commit are recorded in the handoff after evidence finalization.
