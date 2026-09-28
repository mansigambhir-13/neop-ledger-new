-- 017_bridge_never_approves.sql · v3 §5/§8/§16: only a person can say yes; the reasoning agent never approves.
-- 016 let an admin make one bridge's go-ahead a person's yes (may_approve). That is withdrawn: nothing approves on
-- a person's behalf. A person approves on the desk, or with their own answer in their own DM / room.
--
-- Forward-only, nothing dropped: the column stays (016 ran; its data is history), every grant is revoked — each one
-- recorded in the audit trail first — and a check makes a grant unrepresentable from now on. The check is added
-- NOT VALID and then validated, so the scan runs without holding a write-blocking lock longer than it must.
insert into neos.audit (company_id, actor, app_key, action, outcome, detail)
  select company_id, 'migration:017', app_key, 'chat.bridge_approve_revoked', 'revoked',
         jsonb_build_object('matrix_id', matrix_id, 'acts_for', acts_for)
    from neos.chat_allowlist where may_approve;
update neos.chat_allowlist set may_approve = false where may_approve;
alter table neos.chat_allowlist add constraint chat_allowlist_bridge_never_approves check (may_approve = false) not valid;
alter table neos.chat_allowlist validate constraint chat_allowlist_bridge_never_approves;
