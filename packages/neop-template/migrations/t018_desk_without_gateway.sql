-- t018 · template upgrade stream. Expand-only. V3-MIGRATION-PLAN S9 "delete the gateway": what the platform still
-- asked of an app through the gateway (L3 tasks.cancel, schedules.list, jobs.transcript, and block reads) becomes one
-- SECURITY DEFINER function each, on the app's own rows, under the caller's company (row-level security is forced on
-- the owner too). The desk (neos_desk) gets EXECUTE on them and nothing on the tables underneath (v3 §11).
--   · cancel_job(job | task id, user:<id>, reason) — a person stops a job: open proposals withdrawn (an EXECUTING one
--     cannot be recalled and is reported as such), waits consumed, the claim dropped, the job CANCELLED along its legal
--     transitions (t008), a step + mirror, proposal.resolved and task.failed in the outbox (the presence mirror turns it
--     into the typed `done` in the task's thread). Idempotent on a job that has ended. The same rules the L3 route had.
--   · list_schedules() — the company's schedules (the desk sets them through set_schedule, t010).
--   · job_transcript(job | task id) — a job's raw assistant transcripts (WP §12), for an admin's audit. Never a model's.
--   · declared_reads + block_read(ability, args) — the NEOS UI's screens (blocks) read an app ability only through SQL
--     the app declared in its own migration file (v3 §11 "heavy reads are declared views … real SQL, reviewed once"):
--     block_read runs <schema>.<fn>(args) for a row of declared_reads and refuses anything else. The app's read
--     handler calls the same function, so the block and the assistant see the same answer.

-- ── cancel ─────────────────────────────────────────────────────────────────
create function {{schema}}.cancel_job(p_job uuid, p_by text, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  j {{schema}}.jobs%rowtype;
  p record;
  executing integer := 0;
  summary text;
  res jsonb;
  n integer;
  why text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_job is null then raise exception 'bad_request: a job (or its task id) is required' using errcode = '22023'; end if;
  if p_by is null or p_by !~ '^user:.+' or length(p_by) > 200 then
    raise exception 'bad_request: only a person (user:<id>) stops a job' using errcode = '22023';
  end if;
  if why is not null and length(why) > 2000 then raise exception 'bad_request: the reason is too long' using errcode = '22023'; end if;
  select * into j from {{schema}}.jobs where id = p_job or task_id = p_job order by (id = p_job) desc limit 1 for update;
  if not found then raise exception 'not_found: no job for that task' using errcode = 'P0002'; end if;
  if j.status in ('DONE', 'FAILED', 'EXPIRED', 'CANCELLED') then
    return jsonb_build_object('job_id', j.id, 'status', j.status, 'idempotent', true);
  end if;
  for p in select id, status from {{schema}}.proposals where job_id = j.id and status in ('PROPOSED', 'APPROVED', 'EXECUTING') order by created_at for update loop
    if p.status = 'EXECUTING' then
      executing := executing + 1;
      continue;
    end if;
    update {{schema}}.proposals set status = 'WITHDRAWN', updated_at = now() where id = p.id;
    insert into {{schema}}.proposal_events (company_id, proposal_id, event, actor) values (j.company_id, p.id, 'withdrawn:cancelled', p_by);
    insert into {{schema}}.outbox (company_id, event_type, payload, dedupe_key)
    values (j.company_id, 'proposal.resolved', jsonb_build_object('proposal_id', p.id, 'job_id', j.id, 'decision', 'withdraw', 'status', 'WITHDRAWN'), 'resolved:' || p.id || ':cancel')
    on conflict (dedupe_key) do nothing;
  end loop;
  update {{schema}}.waits set status = 'consumed', outcome = coalesce(outcome, 'CANCELLED'), ready_at = coalesce(ready_at, now())
   where job_id = j.id and status <> 'consumed';
  summary := 'Stopped by ' || p_by || coalesce(': ' || why, '') || '.'
             || case when executing > 0 then ' ' || executing || ' approved action was already being carried out and could not be recalled.' else '' end;
  res := jsonb_build_object('outcome', 'cancelled', 'summary', summary, 'changed', '[]'::jsonb, 'could_not', '[]'::jsonb, 'sources', '[]'::jsonb);
  select coalesce(max(seq), 0) + 1 into n from {{schema}}.steps where job_id = j.id;
  insert into {{schema}}.steps (company_id, job_id, seq, kind, summary) values (j.company_id, j.id, n, 'system', left(summary, 2000));
  insert into {{schema}}.outbox (company_id, event_type, payload, dedupe_key)
  values (j.company_id, 'step.mirror', jsonb_build_object('job_id', j.id, 'seq', n, 'kind', 'system', 'summary', left(summary, 500)), 'step:' || j.id || ':' || n)
  on conflict (dedupe_key) do nothing;
  update {{schema}}.jobs set status = 'CANCELLED', result = res, claimed_by = null, claimed_until = null, updated_at = now() where id = j.id;
  insert into {{schema}}.outbox (company_id, event_type, payload, dedupe_key)
  values (j.company_id, 'task.failed', jsonb_build_object('job_id', j.id, 'task_id', j.task_id, 'result', res), 'finish:' || j.id)
  on conflict (dedupe_key) do nothing;
  return jsonb_build_object('job_id', j.id, 'status', 'CANCELLED', 'idempotent', false, 'executing', executing);
end $$;
revoke all on function {{schema}}.cancel_job(uuid, text, text) from public;
grant execute on function {{schema}}.cancel_job(uuid, text, text) to {{schema}}_app, {{schema}}_runner;

-- ── schedules and transcripts, read ───────────────────────────────────────────
create function {{schema}}.list_schedules()
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  if nullif(current_setting('neos.company_id', true), '') is null then
    raise exception 'bad_request: no company in this session' using errcode = '22023';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at, s.id) from {{schema}}.schedules s), '[]'::jsonb);
end $$;
revoke all on function {{schema}}.list_schedules() from public;
grant execute on function {{schema}}.list_schedules() to {{schema}}_app, {{schema}}_runner;

create function {{schema}}.job_transcript(p_job uuid)
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  j record;
begin
  if nullif(current_setting('neos.company_id', true), '') is null then
    raise exception 'bad_request: no company in this session' using errcode = '22023';
  end if;
  select id, status into j from {{schema}}.jobs where id = p_job or task_id = p_job order by (id = p_job) desc limit 1;
  if not found then return null; end if;
  return jsonb_build_object('job_id', j.id, 'status', j.status, 'sessions', coalesce((
    select jsonb_agg(jsonb_build_object('session_id', t.session_id, 'reason', t.reason, 'system_prompt', t.system_prompt,
             'messages', t.messages, 'message_count', t.message_count, 'bytes', t.bytes, 'truncated', t.truncated,
             'created_at', t.created_at) order by t.id)
      from {{schema}}.transcripts t where t.job_id = j.id), '[]'::jsonb));
end $$;
revoke all on function {{schema}}.job_transcript(uuid) from public;
grant execute on function {{schema}}.job_transcript(uuid) to {{schema}}_runner;

-- ── declared reads (blocks) ──────────────────────────────────────────────────
-- One row per app read the NEOS UI may render: the ability key and the function in this schema that answers it,
-- `<fn>(args jsonb) returns jsonb`. Written only by the app's own migrations (the migrator owns the table).
create table {{schema}}.declared_reads (
  ability   text primary key check (ability ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  fn        text not null check (fn ~ '^read_[a-z0-9_]{1,50}$'),
  added_at  timestamptz not null default now()
);
grant select on {{schema}}.declared_reads to {{schema}}_app, {{schema}}_runner;

create function {{schema}}.block_read(p_ability text, p_args jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  f text;
  out jsonb;
begin
  if nullif(current_setting('neos.company_id', true), '') is null then
    raise exception 'bad_request: no company in this session' using errcode = '22023';
  end if;
  select d.fn into f from {{schema}}.declared_reads d where d.ability = p_ability;
  if not found then raise exception 'not_declared: % is not a declared read of this app', p_ability using errcode = '42501'; end if;
  if p_args is null or jsonb_typeof(p_args) <> 'object' then raise exception 'bad_request: args must be an object' using errcode = '22023'; end if;
  execute format('select %I.%I($1)', '{{schema}}', f) into out using p_args;
  return out;
end $$;
revoke all on function {{schema}}.block_read(text, jsonb) from public;
grant execute on function {{schema}}.block_read(text, jsonb) to {{schema}}_app, {{schema}}_runner;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'neos_desk') then
    grant execute on function {{schema}}.cancel_job(uuid, text, text), {{schema}}.list_schedules(),
      {{schema}}.job_transcript(uuid), {{schema}}.block_read(text, jsonb) to neos_desk;
  end if;
end $$;
