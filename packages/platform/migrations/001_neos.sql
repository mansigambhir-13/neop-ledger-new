-- 001_neos.sql · the platform's own tables · runs as neos_migrator in schema neos.
-- The platform never reads an app's tables (S4): desk cards, task completions
-- and the audit are built from app outbox events pulled through the gateway.

grant usage on schema neos to neos_app;
alter default privileges in schema neos grant select, insert, update, delete on tables to neos_app;
alter default privileges in schema neos grant usage, select on sequences to neos_app;

create table neos.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  time_zone   text not null default 'Asia/Kolkata',
  created_at  timestamptz not null default now()
);

-- Pilot identity: a dev bearer token per user. Real sign-in replaces this.
create table neos.users (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references neos.companies (id),
  name        text not null,
  email       text not null,
  role        text not null check (role in ('admin', 'member')),
  dev_token   text unique,
  created_at  timestamptz not null default now()
);

create table neos.apps (
  key                  text primary key,
  l3_url               text not null,
  manifest             jsonb not null,
  contract_version     text not null,
  service_secret_hash  text not null,
  status               text not null default 'active' check (status in ('active', 'suspended')),
  registered_at        timestamptz not null default now()
);

-- One row per thing asked; the final result is typed, never scraped from a room.
create table neos.tasks (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references neos.companies (id),
  app_key            text not null references neos.apps (key),
  requester          text not null,
  ask                text not null,
  status             text not null default 'OPEN'
                     check (status in ('OPEN', 'ACKNOWLEDGED', 'WAITING', 'COMPLETED', 'FAILED')),
  job_id             uuid,
  parent_task_id     uuid references neos.tasks (id),
  open_attempts      integer not null default 0,
  next_attempt_at    timestamptz not null default now(),
  last_error         text,
  result             jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index tasks_open_ix on neos.tasks (status, next_attempt_at) where status = 'OPEN';

create table neos.conversation_messages (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references neos.companies (id),
  task_id     uuid references neos.tasks (id),
  author      text not null,
  body        text not null,
  at          timestamptz not null default now()
);

-- The recorded yes (B3). A state machine driven by a retrying worker:
--   PENDING   card on the desk, nobody has answered
--   RECORDED  a person answered against the fingerprint they saw
--   RESOLVED  the app accepted the answer (proposals.resolve)
--   EXECUTED  the app carried it out and returned terminal proof
--   CLOSED    a no / change / withdraw was accepted; nothing to carry out
--   EXPIRED   the app expired the proposal before anyone answered
--   REFUSED   the app refused the answer (e.g. fingerprint mismatch, already expired)
create table neos.approvals (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references neos.companies (id),
  app_key           text not null references neos.apps (key),
  proposal_id       uuid not null,
  job_id            uuid not null,
  task_id           uuid,
  ability_key       text not null,
  ability_version   text not null,
  args              jsonb not null,
  card              jsonb not null,
  fingerprint       text not null,
  expires_at        timestamptz not null,
  status            text not null default 'PENDING'
                    check (status in ('PENDING', 'RECORDED', 'RESOLVED', 'EXECUTED', 'CLOSED', 'EXPIRED', 'REFUSED')),
  decision          text check (decision in ('yes', 'no', 'change', 'withdraw')),
  feedback          text,
  decided_by        uuid references neos.users (id),
  decided_at        timestamptz,
  fingerprint_seen  text,
  attempts          integer not null default 0,
  next_attempt_at   timestamptz,
  last_error        text,
  proof             jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (app_key, proposal_id),
  check (status = 'PENDING' or status = 'EXPIRED' or decision is not null)
);
create index approvals_work_ix on neos.approvals (status, next_attempt_at) where status in ('RECORDED', 'RESOLVED');

-- Standing yeses (D8). The gateway reads these to mint execution tokens.
create table neos.grants (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references neos.companies (id),
  app_key      text not null references neos.apps (key),
  ability_key  text not null,
  limits       jsonb not null default '{}'::jsonb,
  status       text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  expires_at   timestamptz not null,
  created_by   uuid not null references neos.users (id),
  created_at   timestamptz not null default now(),
  suspended_reason text
);

-- Versioned per company and app. The latest version is in force.
create table neos.switchboards (
  company_id  uuid not null references neos.companies (id),
  app_key     text not null references neos.apps (key),
  version     integer not null check (version > 0),
  settings    jsonb not null default '{}'::jsonb,
  rules       jsonb not null default '[]'::jsonb,
  budget      jsonb not null default '{}'::jsonb,
  updated_by  uuid references neos.users (id),
  updated_at  timestamptz not null default now(),
  primary key (company_id, app_key, version)
);

-- Who may call what (a2a, borrowing).
create table neos.acl (
  caller_app   text not null references neos.apps (key),
  target_app   text not null references neos.apps (key),
  ability_key  text not null,
  company_id   uuid not null references neos.companies (id),
  granted_by   uuid not null references neos.users (id),
  granted_at   timestamptz not null default now(),
  primary key (caller_app, target_app, ability_key, company_id)
);

-- Gateway idempotency ledger: same key from the same caller to the same app → same answer.
create table neos.gateway_ledger (
  caller        text not null,
  target_app    text not null,
  idem_key      text not null,
  endpoint      text not null,
  request_hash  text not null,
  request_id    uuid not null,
  status        integer,
  response      jsonb,
  created_at    timestamptz not null default now(),
  primary key (caller, target_app, idem_key)
);

create table neos.audit (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  company_id   uuid,
  actor        text not null,
  app_key      text,
  action       text not null,
  ability_key  text,
  idem_key     text,
  request_id   uuid,
  outcome      text,
  detail       jsonb
);

create table neos.outbox_cursors (
  app_key     text primary key references neos.apps (key),
  cursor      bigint not null default 0,
  updated_at  timestamptz not null default now()
);

-- Desk activity feed: step mirrors (replaces the #neop-bus room, C6).
create table neos.activity (
  id          bigint generated always as identity primary key,
  company_id  uuid not null,
  app_key     text not null,
  job_id      uuid not null,
  seq         integer not null,
  kind        text not null,
  summary     text not null,
  at          timestamptz not null default now(),
  unique (app_key, job_id, seq)
);

-- Pilot key vault: door credentials per company, lent per call, never to an assistant.
create table neos.vault_secrets (
  company_id  uuid not null references neos.companies (id),
  door        text not null,
  secret      jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (company_id, door)
);

revoke update, delete on neos.audit from neos_app;
