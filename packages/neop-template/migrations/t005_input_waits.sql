-- t005 · template upgrade stream. Expand-only.
--   · input waits (WP §8 `ask`/`answer`, §7, §14): the job asks one structured question and waits on it;
--     a person (or, as untrusted data, a bridge / another app) answers it; unanswered past its due time it
--     wakes the job to say so.
--   · on_behalf_of (WP §9): the person a chain of apps started from, kept on the callee's job.
--   · facts.valid_until: a fact may say until when it holds; the bundle omits it after that.
--   · transcripts (WP §12): the assistant's raw session transcript, kept against the job for audit only.

-- A wait may now be for an answer to a question.
alter table {{schema}}.waits drop constraint waits_kind_check;
alter table {{schema}}.waits add constraint waits_kind_check check (kind in ('proposal', 'timer', 'a2a_task', 'input'));
-- The question asked (input waits): {text, why, fields[{key, label, type?, required?}]}; due = expires_at.
alter table {{schema}}.waits add column question jsonb;
-- Who answered (user:<id> for a person; bridge:<matrix id> or agent:<name> for relayed, untrusted answers).
alter table {{schema}}.waits add column answered_by text;
alter table {{schema}}.waits add constraint waits_input_has_question check (kind <> 'input' or question is not null);

-- The person the work is for, when an app opened the job for them (a2a) — shown, never trusted as a sender.
alter table {{schema}}.jobs add column on_behalf_of text check (on_behalf_of is null or on_behalf_of ~ '^user:.+');

alter table {{schema}}.facts add column valid_until timestamptz;

-- One row per assistant session: model inputs and outputs, tool calls and results, as the worker saw them.
-- Kept for audit; never shown to a model again (the rolling summary in steps is its memory).
create table {{schema}}.transcripts (
  id             bigint generated always as identity primary key,
  company_id     uuid not null,
  job_id         uuid not null references {{schema}}.jobs (id),
  session_id     text not null,
  reason         text not null,
  system_prompt  text not null,
  messages       jsonb not null,
  message_count  integer not null check (message_count >= 0),
  bytes          integer not null check (bytes >= 0),
  truncated      boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (job_id, session_id)
);
create index transcripts_job_ix on {{schema}}.transcripts (job_id);
alter table {{schema}}.transcripts enable row level security;
alter table {{schema}}.transcripts force row level security;
create policy company_isolation on {{schema}}.transcripts
  using (company_id = nullif(current_setting('neos.company_id', true), '')::uuid)
  with check (company_id = nullif(current_setting('neos.company_id', true), '')::uuid);
grant select, insert on {{schema}}.transcripts to {{schema}}_runner;
-- Append-only: an audit record is never rewritten.
revoke update, delete on {{schema}}.transcripts from {{schema}}_app, {{schema}}_runner;
