# Ledger console · designed from the NEOP plan, not from the old app

The old Ledger console was a bookkeeping app with an operator skin: pages of
numbers, buttons that did things. A NEOP is different in kind — *one app, one
subject, one assistant you can talk to, and a book it cannot lie to* (Whole
Picture v2, top). The console therefore puts the NEOP's own concepts first and
the subject (books) second. The visual language (the NEOS "na-" tokens) is
kept; the information architecture is new.

## What is new in a NEOP, and where the console shows it

| Plan concept (source) | What a person must be able to see or do | Console surface |
| --- | --- | --- |
| **The job is the unit** (WP §3, §7, §15) | Ask, hear "on it" at once, watch the steps, see it wait, resume and report: what it did, what changed, what it could not do | **Ask bar** on every page · **Today → Working now** live job cards with the lifecycle stepper · **Jobs** page with each job's timeline |
| **Gate + switchboard, three settings** (WP §4; plan "Switchboard, gate and policy") | For every line: the app's floor, what the company set, what is in force today; tighten, never loosen; off = not shown and refused | **Switchboard** page: the three-column board, grouped by own abilities / package abilities / doors; version stamp |
| **Company rules as data** (plan: time_window, destination, amount_cap, recipient_cap, require_person) | Add and remove rules the gate checks on every call | **Switchboard → Company rules** |
| **Model spend caps** (plan finding: per-job / per-day LLM cap) | See today's spend against the cap; change the caps | **Switchboard → Assistant budget** · spend shown per job |
| **Proposals: exact content, fingerprint, expiry** (WP §5) | See exactly what would happen, the fingerprint the yes binds to, and the clock | **Approval card**: fingerprint chip, countdown, "exact details you are approving" |
| **"Change this first" supersedes; withdraw** (WP §5) | Send feedback; the old card becomes superseded and a new one appears | Card actions **Change first** / **Decline**; superseded cards shown in history |
| **The approval trail** (WP §5 "what the book holds for one approval") | ASKED → WAITING → ANSWERED (who, when, fingerprint seen) → DONE verified / DROPPED → RESUMED → REPORTED | **Approvals → History** and the job timeline |
| **Execution outcome honesty** (plan 7.7: DONE / DROPPED / FAILED / UNKNOWN; reconciliation) | Know when something *may* have happened and is being checked | Outcome pills incl. **Checking (unknown)** |
| **Standing yeses (grants)** (WP §5; plan gate order step 7) | "Always do this within these limits": ability, cap, expiry; withdraw any time; self-suspends | **Standing yeses** page · **Approve & always allow…** on a card |
| **Same answer from anywhere** (WP §5) | A yes in the room or on the desk is the same entry | Chat shows cards inline with the same Approve / Change / Decline |
| **Doors and the key vault** (WP §2, §12) | Which doors exist, which are connected, which abilities use them; keys write-only, lent per call; off = no key | **Connections** page |
| **Registry, skills, packages** (WP §10; plan "Registry") | Browse what can be added, what it offers and requires, signed versions; install with a requirement review; skills greyed out when a requirement is off | **Packages & skills** page |
| **Other apps asking Ledger** (WP §9, §10: borrowing, ACL) | Which apps may ask Ledger for what; grant and revoke; their tasks appear as jobs with the asking app as requester | **Apps** page |
| **One audit trail** (WP §8) | Every effectful call: who, what, outcome, when — one list | **Audit** page, exportable |
| **Honesty: where facts came from** (WP §16; honesty.test) | Every figure shows its basis and when it was generated | Source line under every KPI and report |
| **Keyless assistant, two containers** (WP §13) | Trust, stated plainly | Trust strip on Today: switchboard version, ask-first count, standing yeses, doors connected, spend today |

## Information architecture

- **Work** — *Today* (ask, waiting on you, working now, books pulse, trust strip) · *Jobs* · *Approvals*
- **Books** (the subject) — Transactions · Reconcile · Money · Close · Reports · Tax · Accounts · Coding rules
- **Govern** — Switchboard (+ company rules, assistant budget, who may approve) · Standing yeses · Connections · Packages & skills · Apps · Audit · Team

Every change to the books is still an ask: forms produce a precise request, the
assistant proposes, the gate decides, a person answers. Only governance
(switchboard, rules, grants, doors, installs, permissions) is changed directly
by an admin, because those are the platform's rows, not the app's book.

## Checked against the decisions

- The console is a BFF + static UI in its own container; it reaches only the
  platform's person-facing API (ADR: one gateway; the browser never holds a
  credential).
- It never reads an app's tables: job timelines come from the platform's task
  store, activity mirror, approvals and LLM usage rows (WP §6: nobody writes
  in another's book).
- Governance writes go to the platform (switchboards, grants, acl, vault,
  registry installs), which versions and audits them.
