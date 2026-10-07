# Wage — pinned template alignment

Pin: `neos-neop-template@94db804f94403c15ad1279e6d30dcecc7c078b82` (`0.8.16`).
Status: assessed gap; **0/12 alignment gates verified**; not production ready.

Wage is a payroll preparation vertical slice, not a template-native product. It lacks the generated upstream contract, standalone frontend and template source lifecycle. The reproduced 5,001-row list/output mismatch, bank payout, statutory filing and live payroll acceptance remain open.

Use Wage as the first bounded-read/frontend pilot. Preserve exact payroll arithmetic, privacy boundaries, current migration history and existing transport safeguards; do not raise limits or truncate silently.
