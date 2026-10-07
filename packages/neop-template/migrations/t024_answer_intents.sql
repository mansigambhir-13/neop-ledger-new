-- Forward-only. Historical threads stay protocol 0: no content/wait assignment is inferred.
-- Only the new hand-off path explicitly creates protocol 1 threads. Drain old senders before rollout.
alter table {{schema}}.bus_threads add column answer_protocol smallint not null default 0 check (answer_protocol in (0,1));
alter table {{schema}}.jobs add constraint jobs_answer_scope_uq unique (company_id,id);
alter table {{schema}}.bus_threads add constraint bus_threads_answer_scope_uq unique (company_id,job_id,id);
alter table {{schema}}.waits add constraint waits_answer_scope_uq unique (company_id,job_id,id);

create table {{schema}}.bus_answer_intents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  job_id uuid not null,
  thread_id uuid not null,
  question_wait_id text not null check (length(question_wait_id) between 1 and 200),
  return_wait_id uuid not null unique,
  account text not null,
  room_id text not null,
  peer text not null,
  root_event_id text not null,
  answers jsonb not null check (jsonb_typeof(answers)='object'),
  created_at timestamptz not null default now(),
  unique (company_id,job_id,thread_id,question_wait_id),
  foreign key (company_id,job_id) references {{schema}}.jobs(company_id,id),
  foreign key (company_id,job_id,thread_id) references {{schema}}.bus_threads(company_id,job_id,id),
  foreign key (company_id,job_id,return_wait_id) references {{schema}}.waits(company_id,job_id,id)
);
comment on column {{schema}}.bus_answer_intents.answers is 'Untrusted answer payload; may contain personal data. Immutable replay evidence. Subject discovery, retention and erasure require reviewed policy; generic nulling is not safe.';
alter table {{schema}}.bus_answer_intents enable row level security;
alter table {{schema}}.bus_answer_intents force row level security;
create policy company_isolation on {{schema}}.bus_answer_intents
  using (company_id=nullif(current_setting('neos.company_id',true),'')::uuid)
  with check (company_id=nullif(current_setting('neos.company_id',true),'')::uuid);
revoke all on {{schema}}.bus_answer_intents from {{schema}}_app, {{schema}}_runner;
grant select,insert on {{schema}}.bus_answer_intents to {{schema}}_app, {{schema}}_runner;
-- The gate can detect unbound historical keys, without reading the runner's event payload/receipts.
grant select(company_id,key) on {{schema}}.outbound_events to {{schema}}_app;
create index outbound_events_answer_key_ix on {{schema}}.outbound_events(company_id,key);

-- No runtime update/delete grant; guard even owner-driven accidental mutation. No automatic purge.
create function {{schema}}.immutable_bus_answer_intent() returns trigger
language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  raise exception 'immutable_answer_intent: content and replay identity cannot be changed or deleted' using errcode='42501';
end $$;
revoke all on function {{schema}}.immutable_bus_answer_intent() from public;
create trigger immutable_bus_answer_intent before update or delete on {{schema}}.bus_answer_intents
  for each row execute function {{schema}}.immutable_bus_answer_intent();
