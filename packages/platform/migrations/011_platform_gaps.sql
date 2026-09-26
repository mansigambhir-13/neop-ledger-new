-- 011_platform_gaps.sql · what the audit found missing in the platform.

-- A card whose execution ended FAILED or UNKNOWN shows that, not "executed" (reconcile settles UNKNOWN later).
alter table neos.approvals drop constraint approvals_status_check;
alter table neos.approvals add constraint approvals_status_check
  check (status in ('PENDING', 'RECORDED', 'RESOLVED', 'EXECUTED', 'FAILED', 'UNKNOWN', 'CLOSED', 'EXPIRED', 'REFUSED'));

-- NeuralChat records how it chose the app (explicit, model, keyword fallback) and why.
alter table neos.tasks add column routed_by text check (routed_by in ('explicit', 'model', 'keyword'));
alter table neos.tasks add column route_reason text;

-- a2a results: a 404 is retried with backoff for a bounded window, then given up visibly.
alter table neos.tasks add column result_attempts integer not null default 0;
alter table neos.tasks add column result_next_at timestamptz;
alter table neos.tasks add column result_first_try_at timestamptz;
alter table neos.tasks add column result_failed_at timestamptz;

-- Desk activity feed (C6): a2a hand-offs are mirrored here too; they have no step seq.
alter table neos.activity alter column seq drop not null;
alter table neos.activity add column dedupe_key text;
create unique index activity_dedupe_ix on neos.activity (app_key, dedupe_key) where dedupe_key is not null;
create index activity_company_ix on neos.activity (company_id, at desc);

-- switchboard.changed pushes, retried with backoff until the app answers.
create table neos.app_notifications (
  company_id       uuid not null references neos.companies (id),
  app_key          text not null references neos.apps (key),
  version          integer not null,
  idem_key         text not null,
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_error       text,
  created_at       timestamptz not null default now(),
  primary key (company_id, app_key)
);

-- Registration: the conformance attestation the app was registered on, and its registry author key.
-- 'platform' marks rows the platform itself owns (NeuralChat's model budget); never routed to.
alter table neos.apps add column conformance jsonb;
alter table neos.apps add column author_key jsonb;
alter table neos.apps drop constraint apps_status_check;
alter table neos.apps add constraint apps_status_check check (status in ('active', 'suspended', 'platform'));

-- Gateway key rotation, durable: a restart inside the window still activates the key on time.
create table neos.gateway_keys (
  kid           text primary key,
  state         text not null check (state in ('next', 'active', 'previous', 'retired')),
  published_at  timestamptz not null default now(),
  activate_at   timestamptz,
  activated_at  timestamptz,
  retired_at    timestamptz
);

-- Registry: the author's signature over the content hash, verified before review.
alter table neos.registry_entries add column author_key jsonb;
alter table neos.registry_entries add column author_sig text;

-- Installs that failed their package self-test, and the pin to go back to.
alter table neos.registry_installs drop constraint registry_installs_status_check;
alter table neos.registry_installs add constraint registry_installs_status_check
  check (status in ('pending_migration', 'active', 'disabled', 'failed'));
alter table neos.registry_installs add column previous_version text;
alter table neos.registry_installs add column last_error text;
