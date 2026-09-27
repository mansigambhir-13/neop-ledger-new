-- 016_bridge_approve.sql · a BRIDGE's go-ahead, opt-in per bridge (Shivam's review, option 2).
-- NeuralChat (the reasoning agent) asks its user in its own chat and, only in a run resumed by the user's own
-- answer accepting that exact change, sends Ledger a free-text go-ahead. An admin may let one allowlisted bridge
-- carry that go-ahead as the yes of the person it relays for (acts_for) — under the same fingerprint and expiry
-- rules as a person's yes, through the same platform.answer() and approver policy. Default: no bridge may.
--
-- Expand only: one column with a default, backfilled explicitly; nothing is dropped or rewritten. The check makes
-- a may-approve row that is not a bridge relaying for a named person unrepresentable.
alter table neos.chat_allowlist add column may_approve boolean not null default false;
update neos.chat_allowlist set may_approve = false where may_approve is distinct from false;
alter table neos.chat_allowlist add constraint chat_allowlist_may_approve_check
  check (not may_approve or (kind = 'bridge' and acts_for is not null));
