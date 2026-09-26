-- 002_flow.sql · closes the gaps against the platform user flow.
--   (2)  Conversations: a thread per person; the ask is stored before routing.
--   (5a) Registry installs: which company has which app.
--   (A)/(7.x)/(9) Chat bridge: rooms, per-company app identities, room audit,
--        room mirrors and cards (outbound queue), answers from a room.

alter table neos.companies add column slug text;
update neos.companies set slug = lower(regexp_replace(name, '[^a-zA-Z0-9]+', '', 'g')) where slug is null;
alter table neos.companies alter column slug set not null;
create unique index companies_slug_uq on neos.companies (slug);

alter table neos.users add column matrix_user_id text unique;

-- (5a) An app does nothing for a company that has not installed it.
create table neos.installs (
  company_id    uuid not null references neos.companies (id),
  app_key       text not null references neos.apps (key),
  status        text not null default 'active' check (status in ('active', 'suspended', 'removed')),
  installed_by  uuid references neos.users (id),
  installed_at  timestamptz not null default now(),
  primary key (company_id, app_key)
);

-- (2) What was said, and what came back.
create table neos.conversations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references neos.companies (id),
  user_id     uuid not null references neos.users (id),
  created_at  timestamptz not null default now()
);
alter table neos.conversation_messages add column conversation_id uuid references neos.conversations (id);
alter table neos.conversation_messages add column kind text not null default 'message'
  check (kind in ('message', 'handoff', 'ack', 'waiting', 'card', 'result', 'notice'));
create index conversation_messages_conv_ix on neos.conversation_messages (conversation_id, id);

alter table neos.tasks add column conversation_id uuid references neos.conversations (id);
alter table neos.tasks add column origin text not null default 'app' check (origin in ('app', 'room'));
alter table neos.tasks add column room_id text;
alter table neos.tasks drop constraint tasks_status_check;
alter table neos.tasks add constraint tasks_status_check
  check (status in ('OPEN', 'ACKNOWLEDGED', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED'));

-- (A) AgentSpace rooms. One app room per company and app (#ledger-acme); the
-- app speaks in it as one chat user per company (@neop_ledger_acme).
create table neos.rooms (
  room_id     text primary key,
  company_id  uuid not null references neos.companies (id),
  app_key     text not null references neos.apps (key),
  bot_user    text not null,
  kind        text not null default 'app' check (kind in ('app')),
  created_at  timestamptz not null default now(),
  unique (company_id, app_key, kind)
);

-- Audit trail of the bridge, and the map from a card as shown to what it binds.
create table neos.room_events (
  event_id          text primary key,
  room_id           text not null,
  direction         text not null check (direction in ('inbound', 'outbound')),
  sender            text not null,
  user_id           uuid references neos.users (id),
  task_id           uuid references neos.tasks (id),
  approval_id       uuid references neos.approvals (id),
  fingerprint_shown text,
  outcome           text not null,
  body              text,
  at                timestamptz not null default now()
);
create index room_events_approval_ix on neos.room_events (approval_id) where approval_id is not null;

-- Outbound room messages: the room is a mirror, written from typed outbox
-- events and delivered by the bridge's sender loop, each exactly once per key.
create table neos.room_messages (
  id                bigint generated always as identity primary key,
  room_id           text not null references neos.rooms (room_id),
  dedupe_key        text not null,
  kind              text not null check (kind in ('ack', 'step', 'card', 'answer', 'result', 'notice')),
  body              text not null,
  approval_id       uuid references neos.approvals (id),
  fingerprint_shown text,
  status            text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  event_id          text,
  attempts          integer not null default 0,
  last_error        text,
  created_at        timestamptz not null default now(),
  unique (room_id, dedupe_key)
);
create index room_messages_pending_ix on neos.room_messages (status, id) where status = 'pending';

-- An outbox event the platform could not apply is parked here (and audited),
-- never silently dropped and never allowed to stall every later event.
create table neos.outbox_dead_letters (
  app_key     text not null references neos.apps (key),
  event_id    bigint not null,
  company_id  uuid,
  event_type  text not null,
  payload     jsonb not null,
  error       text not null,
  at          timestamptz not null default now(),
  replayed_at timestamptz,
  primary key (app_key, event_id)
);

-- Existing registrations keep working: every existing company gets every registered app.
insert into neos.installs (company_id, app_key)
  select c.id, a.key from neos.companies c cross join neos.apps a on conflict do nothing;
