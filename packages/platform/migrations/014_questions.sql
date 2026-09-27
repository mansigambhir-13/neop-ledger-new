-- 014_questions.sql · a job's question to a person (WP §8 `ask` / `answer`), built from the app's outbox
-- (question.asked / .answered / .expired) like the desk's cards. The platform never answers for anyone:
-- a person's answer (desk, conversation, their own DM) or a bridge's relayed one goes to the app's
-- waits.answer through the gateway; the app's wait is the truth, this row is its projection. Expand-only.

create table neos.questions (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references neos.companies (id),
  app_key        text not null references neos.apps (key),
  task_id        uuid references neos.tasks (id),
  -- The task a person started the chain from (itself, or the root of an a2a chain): where the question is shown.
  root_task_id   uuid references neos.tasks (id),
  job_id         uuid not null,
  wait_id        uuid not null,
  text           text not null,
  why            text not null,
  fields         jsonb not null,
  due_at         timestamptz not null,
  -- The person it is put to (the requester, or the person an a2a chain started from); null if nobody is on record.
  asked_of       uuid references neos.users (id),
  status         text not null default 'OPEN' check (status in ('OPEN', 'ANSWERED', 'EXPIRED', 'STALE')),
  answers        jsonb,
  answered_by    text,
  answered_via   text check (answered_via in ('desk', 'conversation', 'chat', 'bridge', 'reasoning_agent', 'app')),
  answered_at    timestamptz,
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (app_key, wait_id),
  check (status <> 'ANSWERED' or (answers is not null and answered_by is not null))
);
create index questions_open_ix on neos.questions (company_id, status) where status = 'OPEN';
create index questions_root_ix on neos.questions (root_task_id) where status = 'OPEN';

-- A task waiting on a person's answer says so.
alter table neos.tasks drop constraint tasks_status_check;
alter table neos.tasks add constraint tasks_status_check
  check (status in ('OPEN', 'ACKNOWLEDGED', 'WAITING', 'NEEDS_INPUT', 'COMPLETED', 'FAILED', 'CANCELLED'));

-- A follow-up in the same conversation continues the earlier job (sent to the app as parent_job_id).
alter table neos.tasks add column parent_job_id uuid;

-- The Matrix client road: a question notice shown in a DM, so a reply to it answers that question.
alter table neos.chat_client_events add column question_id uuid references neos.questions (id);
