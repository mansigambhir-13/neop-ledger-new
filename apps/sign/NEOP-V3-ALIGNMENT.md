# Sign — pinned template alignment

Pin: `neos-neop-template@94db804f94403c15ad1279e6d30dcecc7c078b82` (`0.8.16`).
Status: partial; **1/12 alignment gates verified**; `full_parity=false`.
Verified gate: `ownership` (report-bound evidence at the clean source commit recorded in the fleet registry).

Sign is an internal contract draft slice. It lacks a template frontend/source lifecycle, document/signer authority, signature provider, envelope reconciliation and production acceptance.

Adoption must bind the exact document and signer set, reject version drift and distinguish sent, declined, expired, uncertain and completed states.
