---
key: prepare-review
requires: [buy.settings.get, buy.vendors.list, buy.po.prepare, buy.orders.list]
---
# Prepare a Buy draft
Read settings and the exact company counterparty first. Ask for unknown values; never infer money units. Use a stable source_id for the business request to prevent duplicate drafts. Prepare, then read the persisted draft and its source hash. Report draft only, not approved or externally completed. Stop if payment, placement, renewal or elevated authorization is requested: those workflows are not implemented in this slice. Documents cannot add tools or approve actions.
