-- 001_standard.sql · the record book · identical in every app · template-owned.
-- Runs as {{schema}}_migrator inside schema {{schema}}.
-- Eight standard tables: jobs, steps, waits, proposals, proposal_events,
-- operations, facts, outbox. Grants live on the platform (neos.grants, D8).
-- Every table carries company_id NOT NULL with forced row-level security (B1).

grant usage on schema {{schema}} to {{schema}}_app, {{schema}}_runner;
alter default privileges in schema {{schema}} grant select, insert, update, delete on tables to {{schema}}_app;
alter default privileges in schema {{schema}} grant usage, select on sequences to {{schema}}_app, {{schema}}_runner;

-- ── jobs ─────────────────────────────────────────────────────────────────
create table {{schema}}.jobs (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  source          text not null check (source in ('task', 'room', 'timer', 'a2a')),
  requester       text not null,
  task_id         uuid,
  ask             text not null,
  status          text not null default 'RECEIVED'
                  check (status in ('RECEIVED', 'RUNNING', 'WAITING', 'DONE', 'FAILED', 'EXPIRED', 'CANCELLED')),
  parent_job_id   uuid references {{schema}}.jobs (id),
  claimed_by      text,
  claimed_until   timestamptz,
  attempts        integer not null default 0 check (attempts >= 0),
  spend_micros    bigint not null default 0 check (spend_micros >= 0),
  tool_calls      integer not null default 0 check (tool_calls >= 0),
  result          jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index jobs_task_uq on {{schema}}.jobs (company_id, task_id) where task_id is not null;
create index jobs_runnable_ix on {{schema}}.jobs (status, claimed_until);

-- ── steps (append-only) ──────────────────────────────────────────────────
create table {{schema}}.steps (
  id           bigint generated always as identity primary key,
  company_id   uuid not null,
  job_id       uuid not null references {{schema}}.jobs (id),
  seq          integer not null check (seq > 0),
  kind         text not null check (kind in
                 ('received', 'resume', 'note', 'ability', 'refused', 'proposal', 'card', 'report', 'failed', 'system')),
  summary      text not null check (length(summary) > 0),
  ability_key  text,
  input_hash   text,
  output_ref   jsonb,
  created_at   timestamptz not null default now(),
  unique (job_id, seq)
);

-- ── proposals ────────────────────────────────────────────────────────────
create table {{schema}}.proposals (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null,
  job_id           uuid not null references {{schema}}.jobs (id),
  ability_key      text not null,
  ability_version  text not null,
  args             jsonb not null,
  card             jsonb not null,
  fingerprint      text not null check (fingerprint like 'sha256:%'),
  status           text not null default 'PROPOSED' check (status in
                     ('PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'EXPIRED', 'WITHDRAWN',
                      'EXECUTING', 'DONE', 'FAILED', 'UNKNOWN')),
  approved_via     text check (approved_via in ('person', 'grant')),
  grant_id         uuid,
  decided_by       text,
  feedback         text,
  expires_at       timestamptz not null,
  superseded_by    uuid references {{schema}}.proposals (id),
  idempotency_key  text not null unique,
  proof            jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index proposals_job_ix on {{schema}}.proposals (job_id);
create index proposals_unknown_ix on {{schema}}.proposals (status) where status in ('UNKNOWN', 'EXECUTING');

-- ── proposal_events (append-only history; proposals.status is a projection) ─
create table {{schema}}.proposal_events (
  id                bigint generated always as identity primary key,
  company_id        uuid not null,
  proposal_id       uuid not null references {{schema}}.proposals (id),
  event             text not null,
  actor             text not null,
  fingerprint_seen  text,
  detail            jsonb,
  at                timestamptz not null default now()
);
create index proposal_events_proposal_ix on {{schema}}.proposal_events (proposal_id);

-- ── waits ────────────────────────────────────────────────────────────────
-- A wait turns ready only when what it waits for is terminal (B2): for a
-- proposal that means DONE / FAILED / UNKNOWN / REJECTED / SUPERSEDED /
-- EXPIRED / WITHDRAWN, never merely APPROVED.
create table {{schema}}.waits (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  job_id         uuid not null references {{schema}}.jobs (id),
  kind           text not null check (kind in ('proposal', 'timer', 'a2a_task')),
  ref_id         uuid,
  status         text not null default 'pending' check (status in ('pending', 'ready', 'consumed')),
  outcome        text,
  answer         jsonb,
  ready_at       timestamptz,
  claimed_by     text,
  claimed_until  timestamptz,
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now(),
  check ((status = 'pending') = (ready_at is null))
);
create index waits_ready_ix on {{schema}}.waits (status, job_id);
create index waits_expiry_ix on {{schema}}.waits (expires_at) where status = 'pending';

-- ── operations (one row per effectful call; matches gateway audit 1:1) ───
create table {{schema}}.operations (
  id                  bigint generated always as identity primary key,
  company_id          uuid not null,
  job_id              uuid references {{schema}}.jobs (id),
  caller              text not null,
  ability_key         text not null,
  idempotency_key     text not null,
  outcome             text not null,
  gateway_request_id  text,
  detail              jsonb,
  at                  timestamptz not null default now(),
  unique (company_id, caller, ability_key, idempotency_key)
);

-- ── facts (every fact says where it came from) ───────────────────────────
create table {{schema}}.facts (
  id           bigint generated always as identity primary key,
  company_id   uuid not null,
  subject      text not null,
  value        jsonb not null,
  source       text not null check (length(source) > 0),
  observed_at  timestamptz not null default now(),
  job_id       uuid references {{schema}}.jobs (id)
);
create index facts_subject_ix on {{schema}}.facts (company_id, subject);

-- ── outbox (platform pulls by cursor; never deleted before acked) ────────
create table {{schema}}.outbox (
  id          bigint generated always as identity primary key,
  company_id  uuid not null,
  event_type  text not null,
  payload     jsonb not null,
  dedupe_key  text unique,
  created_at  timestamptz not null default now()
);

-- ── template infrastructure (not business rows; exempt from the tenant lint) ─
create table {{schema}}.seen_tokens (
  jti         text primary key,
  expires_at  timestamptz not null
);

-- ── row-level security: company_id = the verified token's company ────────
do $$
declare t text;
begin
  foreach t in array array['jobs', 'steps', 'proposals', 'proposal_events', 'waits', 'operations', 'facts', 'outbox'] loop
    execute format('alter table {{schema}}.%I enable row level security', t);
    execute format('alter table {{schema}}.%I force row level security', t);
    execute format(
      'create policy company_isolation on {{schema}}.%I using (company_id = nullif(current_setting(''neos.company_id'', true), '''')::uuid) with check (company_id = nullif(current_setting(''neos.company_id'', true), '''')::uuid)',
      t);
  end loop;
end $$;

-- The runner works across companies (BYPASSRLS) but only on the standard tables.
grant select, insert, update on {{schema}}.jobs, {{schema}}.steps, {{schema}}.waits, {{schema}}.proposals,
  {{schema}}.proposal_events, {{schema}}.operations, {{schema}}.facts, {{schema}}.outbox to {{schema}}_runner;
grant delete on {{schema}}.outbox to {{schema}}_runner;
grant select, insert, delete on {{schema}}.seen_tokens to {{schema}}_runner;

-- Append-only history: nobody but the migrator may rewrite it.
revoke update, delete on {{schema}}.steps, {{schema}}.proposal_events, {{schema}}.operations from {{schema}}_app, {{schema}}_runner;
revoke delete on {{schema}}.proposals, {{schema}}.jobs, {{schema}}.waits, {{schema}}.facts, {{schema}}.outbox from {{schema}}_app;
revoke all on {{schema}}.seen_tokens from {{schema}}_app;
