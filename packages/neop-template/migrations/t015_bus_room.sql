-- t015 · template upgrade stream. Expand-only.
-- WP v3 §9 "Talking to other NEOPs" and §10 "Borrowing one ability from another app" · V3 migration stage S6.
-- NEOP-to-NEOP work goes over Matrix, in the company's bus room (#neop-bus-<co>), between the apps' own
-- presences (S4) — not through the platform's a2a routing. What that needs to remember lives here, per company:
--   · installs.bus_room_id — the company's bus room (apps only: typed task · ask · answer · done · note).
--   · installs.bus_peers — who else is on the bus, by Matrix id → app key (written by rooms-setup through the
--     platform's neos_desk write-through). A sender not listed here is never acted on in the bus room.
--   · bus_threads — one row per thread this app opened (out: a task it handed over, or an ability it borrowed)
--     or answers (in: a task it took, or a borrowed call it served). The thread root is the correlation; the row
--     keeps the wait the asking job sleeps on, the chain of apps (lineage, depth ≤ 3) and the result.

alter table {{schema}}.installs add column bus_room_id text check (bus_room_id is null or (bus_room_id ~ '^![^:\s]+:\S+$' and length(bus_room_id) <= 255));
alter table {{schema}}.installs add column bus_peers jsonb not null default '{}'::jsonb check (jsonb_typeof(bus_peers) = 'object');

create table {{schema}}.bus_threads (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  direction      text not null check (direction in ('out', 'in')),
  kind           text not null check (kind in ('task', 'call')),
  room_id        text not null,
  -- The task (or call) event: the thread root. Null only while an outgoing event is being sent.
  root_event_id  text unique check (root_event_id is null or length(root_event_id) between 1 and 255),
  peer           text not null check (peer ~ '^@[^:\s]+:\S+$' and length(peer) <= 255),
  peer_app       text not null check (peer_app ~ '^[a-z][a-z0-9_]{0,40}$'),
  -- out: the job that waits; in: the job opened for it (null for a borrowed read: no job, no model).
  job_id         uuid,
  -- out: the wait the job sleeps on now; in (call): the asker's wait id, answered by the typed answer.
  wait_id        text,
  task_id        text check (task_id is null or length(task_id) <= 200),
  ability        text check (ability is null or ability ~ '^[a-z][a-z0-9_.]{0,120}$'),
  args           jsonb,
  lineage        jsonb not null default '[]'::jsonb check (jsonb_typeof(lineage) = 'array'),
  depth          integer not null default 0 check (depth between 0 and 10),
  -- out: the callee's open question (its wait id, the question, due), until this job answers it.
  question       jsonb,
  status         text not null default 'open' check (status in ('sending', 'open', 'done', 'failed', 'refused', 'not_opened')),
  result         jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index bus_threads_job_ix on {{schema}}.bus_threads (job_id) where job_id is not null;
create index bus_threads_task_ix on {{schema}}.bus_threads (company_id, task_id);

alter table {{schema}}.bus_threads enable row level security;
alter table {{schema}}.bus_threads force row level security;
create policy company_isolation on {{schema}}.bus_threads
  using (company_id = nullif(current_setting('neos.company_id', true), '')::uuid)
  with check (company_id = nullif(current_setting('neos.company_id', true), '')::uuid);

-- The gate (app role) opens and answers threads for its jobs; the runner (presence) records what arrives.
grant select, insert, update on {{schema}}.bus_threads to {{schema}}_app, {{schema}}_runner;
