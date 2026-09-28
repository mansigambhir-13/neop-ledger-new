-- t012 · template upgrade stream. Expand-only.
-- WP v3 §8 / §13 · V3 migration stage S4 "Presence: the NEOP is on Matrix itself". The NEOP's own backend
-- speaks in Matrix (src/presence: the appservice push road and the ordinary-account /sync road), turns what
-- arrives into jobs, answers and decisions in this schema (runner/inbound.ts) and mirrors what the book says
-- back into the rooms (runner/mirror.ts). What that needs to remember lives here, per company:
--   · inbound_events — every Matrix event this app acted on, once: event_id is the dedupe key (Matrix
--     redelivers). What it became (job, answer, decision), and the one reply it is owed on the client road.
--   · outbound_events — what this app said where: the key is the transaction id, so nothing is sent twice
--     (a resend reuses it and the homeserver returns the same event). Cards and questions shown in a room
--     keep their proposal / wait and the fingerprint shown, so an answer binds to what the person saw.
--   · presence_accounts — the client road's /sync cursor per account (a restart never re-reads history).
--   · presence_dms — the 1:1 room recorded per (account, peer) on the client road.
--   · presence_mirror — how far the mirror has read this company's outbox.
--   · people — who a Matrix id is at this company (a linked person: user id, name, role; whether the
--     person may DM this app on the client road). Written through by the platform (as neos_desk) whenever
--     a person is linked, the allowlist changes or the app is installed — the app never reads schema neos.
--   · installs.agent_acts_for — for each allowed agent sender (installs.agent_senders, t010), the person
--     it relays for; installs.company_slug — the company's short name (a typed task may name it).

alter table {{schema}}.installs add column agent_acts_for jsonb not null default '{}'::jsonb
  check (jsonb_typeof(agent_acts_for) = 'object');
-- The company's short name (a typed task may name its company by it, v3 §8 `company`).
alter table {{schema}}.installs add column company_slug text check (company_slug is null or company_slug ~ '^[a-z0-9][a-z0-9-]{0,62}$');

create table {{schema}}.people (
  company_id   uuid not null,
  matrix_id    text not null check (matrix_id ~ '^@[^:\s]+:\S+$' and length(matrix_id) <= 255),
  user_id      text not null check (user_id ~ '^[0-9a-fA-F-]{36}$'),
  name         text check (name is null or length(name) <= 200),
  role         text check (role is null or length(role) <= 40),
  -- On the app's chat allowlist as a person (the client road's DMs); a room needs only the link.
  chat_person  boolean not null default false,
  updated_at   timestamptz not null default now(),
  primary key (company_id, matrix_id)
);
create index people_user_ix on {{schema}}.people (company_id, user_id);

create table {{schema}}.inbound_events (
  event_id          text primary key check (length(event_id) between 1 and 255),
  company_id        uuid not null,
  account           text not null,
  room_id           text not null,
  road              text not null check (road in ('appservice', 'client')),
  sender            text not null,
  sender_class      text check (sender_class in ('person', 'agent', 'neop')),
  person_id         text,
  type              text not null,
  outcome           text not null default 'received',
  job_id            uuid,
  proposal_id       uuid,
  wait_id           uuid,
  fingerprint_shown text,
  typed_task_id     text,
  detail            jsonb,
  reply_status      text not null default 'none' check (reply_status in ('none', 'waiting', 'sending', 'sent')),
  reply_due_at      timestamptz,
  reply_text        text,
  reply_event_id    text,
  replied_at        timestamptz,
  at                timestamptz not null default now()
);
create index inbound_events_room_ix on {{schema}}.inbound_events (account, room_id, at);
create index inbound_events_job_ix on {{schema}}.inbound_events (job_id) where job_id is not null;
create index inbound_events_owed_ix on {{schema}}.inbound_events (account, reply_status) where reply_status in ('waiting', 'sending');

create table {{schema}}.outbound_events (
  id                bigint generated always as identity primary key,
  company_id        uuid not null,
  account           text not null,
  room_id           text not null,
  key               text not null check (length(key) between 1 and 255),
  event_id          text,
  kind              text not null,
  job_id            uuid,
  proposal_id       uuid,
  wait_id           uuid,
  fingerprint_shown text,
  at                timestamptz not null default now(),
  unique (account, room_id, key)
);
create index outbound_events_event_ix on {{schema}}.outbound_events (event_id);
create index outbound_events_proposal_ix on {{schema}}.outbound_events (proposal_id) where proposal_id is not null;
create index outbound_events_wait_ix on {{schema}}.outbound_events (wait_id) where wait_id is not null;

create table {{schema}}.presence_accounts (
  account         text primary key,
  company_id      uuid not null,
  road            text not null check (road in ('appservice', 'client')),
  next_batch      text,
  stopped_reason  text,
  updated_at      timestamptz not null default now()
);

create table {{schema}}.presence_dms (
  company_id   uuid not null,
  account      text not null,
  peer         text not null,
  room_id      text not null,
  recorded_at  timestamptz not null default now(),
  primary key (account, peer)
);
create index presence_dms_room_ix on {{schema}}.presence_dms (account, room_id);

create table {{schema}}.presence_mirror (
  company_id  uuid primary key,
  cursor      bigint not null default 0,
  updated_at  timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['people', 'inbound_events', 'outbound_events', 'presence_accounts', 'presence_dms', 'presence_mirror'] loop
    execute format('alter table {{schema}}.%I enable row level security', t);
    execute format('alter table {{schema}}.%I force row level security', t);
    execute format(
      'create policy company_isolation on {{schema}}.%I using (company_id = nullif(current_setting(''neos.company_id'', true), '''')::uuid) with check (company_id = nullif(current_setting(''neos.company_id'', true), '''')::uuid)',
      t);
  end loop;
end $$;

-- The runner (presence runs with it) keeps the road's own records; it only reads who people are.
grant select, insert, update on {{schema}}.inbound_events, {{schema}}.outbound_events, {{schema}}.presence_accounts,
  {{schema}}.presence_dms, {{schema}}.presence_mirror to {{schema}}_runner;
grant delete on {{schema}}.presence_dms to {{schema}}_runner;
grant select on {{schema}}.people to {{schema}}_runner, {{schema}}_app;
revoke all on {{schema}}.inbound_events, {{schema}}.outbound_events, {{schema}}.presence_accounts,
  {{schema}}.presence_dms, {{schema}}.presence_mirror from {{schema}}_app;
revoke insert, update, delete on {{schema}}.people from {{schema}}_app, {{schema}}_runner;
-- The desk (the platform's write-through) keeps people current, when the platform has made its role.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'neos_desk') then
    grant select, insert, update, delete on {{schema}}.people to neos_desk;
  end if;
end $$;
