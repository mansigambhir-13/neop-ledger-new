# Pay — pinned template alignment

Pin: `neos-neop-template@94db804f94403c15ad1279e6d30dcecc7c078b82` (`0.8.16`).
Status: partial; **1/12 alignment gates verified**; `full_parity=false`.
Verified gate: `ownership` (report-bound evidence at the clean source commit recorded in the fleet registry).

Pay is an internal payment draft slice. It lacks a template frontend/source lifecycle, owner-approved eligible/elevated approver policy, payment provider, reconciliation and production acceptance.

Adoption must bind payee, amount, currency and exact draft version, prohibit self/unknown authority according to approved policy, and retain uncertain provider outcomes.
