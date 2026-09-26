-- 003_hardening.sql · rotation, approver policy, retention (R8, R10, R11, R12).

-- Service secrets rotate with an overlap window: current or previous is accepted.
alter table neos.apps add column previous_service_secret_hash text;
alter table neos.apps add column secret_rotated_at timestamptz;

-- Approver policy per ability (R8): { "*": {roles, four_eyes}, "<ability>": {...} }.
alter table neos.switchboards add column approvals jsonb not null default '{}'::jsonb;

-- Who can operate the platform itself (dead-letter replay, key rotation).
alter table neos.users drop constraint users_role_check;
alter table neos.users add constraint users_role_check check (role in ('admin', 'member', 'operator'));

-- Retention bookkeeping.
create index gateway_ledger_created_ix on neos.gateway_ledger (created_at);
