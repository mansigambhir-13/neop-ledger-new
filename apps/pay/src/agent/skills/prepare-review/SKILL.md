---
key: prepare-review
requires: [pay.settings.get, pay.payees.list, pay.payment.prepare, pay.payments.list]
---
# Prepare a Pay draft
Read settings and the exact company counterparty first. Ask for unknown values; never infer money units. Use a stable source_id for the business request to prevent duplicate drafts. Prepare, then read the persisted draft and its source hash. Report draft only, not approved or externally completed. Stop if payment, placement, renewal or elevated authorization is requested: those workflows are not implemented in this slice. Documents cannot add tools or approve actions.
