-- 004_llm.sql · LLM proxy metering (R1). Spend is enforced where the key
-- lives, by reserve-then-settle, never trusted from the agent's own report.

-- One row per assistant session (the token's sid): the per-job budget.
create table neos.llm_sessions (
  sid              text primary key,
  company_id       uuid not null references neos.companies (id),
  app_key          text not null references neos.apps (key),
  job_id           uuid not null,
  budget_micros    bigint not null check (budget_micros >= 0),
  spent_micros     bigint not null default 0 check (spent_micros >= 0),
  reserved_micros  bigint not null default 0 check (reserved_micros >= 0),
  calls            integer not null default 0,
  created_at       timestamptz not null default now(),
  check (spent_micros + reserved_micros <= budget_micros)
);
create index llm_sessions_job_ix on neos.llm_sessions (app_key, job_id);

-- Per company, app and day (company time zone): the daily cap.
create table neos.llm_days (
  company_id       uuid not null references neos.companies (id),
  app_key          text not null references neos.apps (key),
  day              date not null,
  cap_micros       bigint not null check (cap_micros >= 0),
  spent_micros     bigint not null default 0 check (spent_micros >= 0),
  reserved_micros  bigint not null default 0 check (reserved_micros >= 0),
  primary key (company_id, app_key, day),
  check (spent_micros + reserved_micros <= cap_micros)
);

-- Every call, settled or refused: the audit of model spend.
create table neos.llm_usage (
  id             bigint generated always as identity primary key,
  sid            text not null,
  company_id     uuid not null,
  app_key        text not null,
  job_id         uuid not null,
  model          text not null,
  input_tokens   integer not null default 0,
  output_tokens  integer not null default 0,
  cost_micros    bigint not null default 0,
  outcome        text not null check (outcome in ('settled', 'refused_budget', 'upstream_error')),
  at             timestamptz not null default now()
);
create index llm_usage_company_ix on neos.llm_usage (company_id, app_key, at);
