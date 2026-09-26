-- t004 · timers (WP §7: "a scheduled time arriving → the job starts") and the
-- rolling summary (plan: older steps "as a rolling summary written to steps").

-- A `summary` step carries the rolling summary of steps older than the last 20.
alter table {{schema}}.steps drop constraint steps_kind_check;
alter table {{schema}}.steps add constraint steps_kind_check check (kind in
  ('received', 'resume', 'note', 'ability', 'refused', 'proposal', 'card', 'report', 'failed', 'system', 'summary'));

-- A timer job not started by run_by is EXPIRED rather than run stale (e.g. after an outage).
alter table {{schema}}.jobs add column run_by timestamptz;

-- Schedules: set by the platform on a person's behalf (L3 schedules.set); the runner opens
-- one source='timer' job per (schedule, slot), in the company's time zone, on database time.
create table {{schema}}.schedules (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null,
  ask          text not null check (length(ask) between 1 and 8000),
  requester    text not null check (requester ~ '^(user|app):.+'),
  rule         jsonb not null check (
                 rule->>'every' in ('day', 'week', 'month')
                 and rule->>'at' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                 and (rule->>'every' <> 'week' or (rule->>'weekday')::int between 1 and 7)
                 and (rule->>'every' <> 'month' or (rule->>'day')::int between 1 and 31)),
  time_zone    text not null,
  enabled      boolean not null default true,
  next_run_at  timestamptz,
  last_run_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index schedules_due_ix on {{schema}}.schedules (next_run_at) where enabled;
alter table {{schema}}.schedules enable row level security;
alter table {{schema}}.schedules force row level security;
create policy company_isolation on {{schema}}.schedules
  using (company_id = nullif(current_setting('neos.company_id', true), '')::uuid)
  with check (company_id = nullif(current_setting('neos.company_id', true), '')::uuid);
grant select, update on {{schema}}.schedules to {{schema}}_runner;
-- Switched off, never deleted: the book keeps what was scheduled.
revoke delete on {{schema}}.schedules from {{schema}}_app;

-- The first slot strictly after `after`, in the local wall time of `tz`. A month
-- day past the month's end runs on its last day.
create function {{schema}}.next_run(rule jsonb, tz text, after timestamptz) returns timestamptz
language plpgsql stable as $$
declare
  at_t time := (rule->>'at')::time;
  local_after timestamp := after at time zone tz;
  d date;
  i int;
begin
  for i in 0..62 loop
    d := local_after::date + i;
    if (d + at_t) > local_after and (
         rule->>'every' = 'day'
      or (rule->>'every' = 'week' and extract(isodow from d)::int = (rule->>'weekday')::int)
      or (rule->>'every' = 'month' and extract(day from d)::int = least((rule->>'day')::int,
            extract(day from (date_trunc('month', d) + interval '1 month - 1 day'))::int))
    ) then
      return (d + at_t) at time zone tz;
    end if;
  end loop;
  return null;
end $$;
