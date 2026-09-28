-- t017 · template upgrade stream. Expand-only.
-- Found in the v3 rehearsal (NEOP_PRESENCE=client): a bridge such as NeuralChat relays for a person (its
-- `acts_for`), and that person need not have a Matrix id of their own. `people` (t012) is keyed by Matrix id,
-- so such a person was unknown to the app's presence and a relayed "no" could not be recorded for them.
--   · acted_for — the people a bridge speaks for at this company (user id, name, role), written by the platform's
--     neos_desk write-through with the allowlist. Read only when a job's person has no linked Matrix id.
create table {{schema}}.acted_for (
  company_id  uuid not null,
  user_id     text not null check (user_id ~ '^[0-9a-fA-F-]{36}$'),
  name        text check (name is null or length(name) <= 200),
  role        text check (role is null or length(role) <= 40),
  updated_at  timestamptz not null default now(),
  primary key (company_id, user_id)
);

alter table {{schema}}.acted_for enable row level security;
alter table {{schema}}.acted_for force row level security;
create policy company_isolation on {{schema}}.acted_for
  using (company_id = nullif(current_setting('neos.company_id', true), '')::uuid)
  with check (company_id = nullif(current_setting('neos.company_id', true), '')::uuid);

grant select on {{schema}}.acted_for to {{schema}}_runner, {{schema}}_app;
revoke insert, update, delete on {{schema}}.acted_for from {{schema}}_app, {{schema}}_runner;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'neos_desk') then
    grant select, insert, update, delete on {{schema}}.acted_for to neos_desk;
  end if;
end $$;
