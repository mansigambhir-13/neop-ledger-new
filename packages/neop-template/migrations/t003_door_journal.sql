-- t003 · the door journal (ship readiness). Before a door calls a provider it
-- writes what it is about to send; after, the provider's id. A crash between
-- the two is recovered by re-sending the identical payload under the same
-- idempotency key (providers return the original result, not a second send),
-- so read-back can always answer "did it happen?".
create table {{schema}}.door_journal (
  company_id       uuid not null,
  door             text not null,
  idempotency_key  text not null,
  provider         text not null,
  payload          jsonb not null,
  provider_ref     text,
  status           text not null default 'sending' check (status in ('sending', 'accepted', 'rejected')),
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (company_id, door, idempotency_key)
);
alter table {{schema}}.door_journal enable row level security;
alter table {{schema}}.door_journal force row level security;
create policy company_isolation on {{schema}}.door_journal
  using (company_id = nullif(current_setting('neos.company_id', true), '')::uuid)
  with check (company_id = nullif(current_setting('neos.company_id', true), '')::uuid);
revoke delete on {{schema}}.door_journal from {{schema}}_app;
