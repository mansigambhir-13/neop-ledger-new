-- 018_desk_union_views.sql · v3 §11 "one database, one schema per NEOP; the desk reads union views".
-- `neos_desk` (NOLOGIN; created by migratePlatform — the migrator cannot create roles) reads two views and nothing else:
--   neos.v_pending_approvals  every registered app's proposals still waiting for a person (status PROPOSED)
--   neos.v_activity           every registered app's job steps
-- Schemas vary per app, so the views are (re)built by neos.refresh_desk_views() from neos.apps whenever an app
-- registers. Each app's branch reads its schema through a SECURITY DEFINER function with dynamic SQL, so the views
-- hold no catalog dependency on any app's tables: an app schema restored from a dump (pg_restore --clean), or
-- living on its own cluster (D2), never blocks or breaks them — a missing schema simply contributes no rows.
-- migratePlatform hands these functions to the admin role after migrating (they must read every app schema).
--
-- Expand only: new functions, views and grants; no table is touched.

create function neos.desk_pending(app text)
  returns table (app_key text, company_id uuid, proposal_id uuid, job_id uuid, task_id uuid, ability_key text,
                 ability_version text, fingerprint text, card jsonb, expires_at timestamptz, created_at timestamptz)
  language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  if app is null or app !~ '^[a-z][a-z0-9_]{0,40}$' or not exists (select 1 from neos.apps a where a.key = app)
     or to_regclass(format('%I.proposals', app)) is null or to_regclass(format('%I.jobs', app)) is null then
    return;
  end if;
  return query execute format(
    'select %L::text, p.company_id, p.id, p.job_id, j.task_id, p.ability_key, p.ability_version, p.fingerprint, p.card, p.expires_at, p.created_at
       from %I.proposals p join %I.jobs j on j.id = p.job_id where p.status = ''PROPOSED''', app, app, app);
end $$;

create function neos.desk_activity(app text)
  returns table (app_key text, company_id uuid, job_id uuid, task_id uuid, seq integer, kind text, summary text,
                 ability_key text, job_status text, created_at timestamptz)
  language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  if app is null or app !~ '^[a-z][a-z0-9_]{0,40}$' or not exists (select 1 from neos.apps a where a.key = app)
     or to_regclass(format('%I.steps', app)) is null or to_regclass(format('%I.jobs', app)) is null then
    return;
  end if;
  return query execute format(
    'select %L::text, s.company_id, s.job_id, j.task_id, s.seq, s.kind, s.summary, s.ability_key, j.status, s.created_at
       from %I.steps s join %I.jobs j on j.id = s.job_id', app, app, app);
end $$;

create function neos.refresh_desk_views() returns integer
  language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  keys text[];
  pending text;
  activity text;
begin
  perform pg_advisory_xact_lock(hashtext('neos.refresh_desk_views'));
  select coalesce(array_agg(key order by key), '{}') into keys
    from neos.apps where status <> 'platform' and key ~ '^[a-z][a-z0-9_]{0,40}$';
  if cardinality(keys) = 0 then
    pending := 'select * from neos.desk_pending(null) where false';
    activity := 'select * from neos.desk_activity(null) where false';
  else
    select string_agg(format('select * from neos.desk_pending(%L)', k), ' union all '),
           string_agg(format('select * from neos.desk_activity(%L)', k), ' union all ')
      into pending, activity from unnest(keys) k;
  end if;
  drop view if exists neos.v_pending_approvals;
  drop view if exists neos.v_activity;
  execute 'create view neos.v_pending_approvals as ' || pending;
  execute 'create view neos.v_activity as ' || activity;
  grant select on neos.v_pending_approvals, neos.v_activity to neos_desk;
  return cardinality(keys);
end $$;

revoke all on function neos.desk_pending(text), neos.desk_activity(text), neos.refresh_desk_views() from public;
grant execute on function neos.desk_pending(text), neos.desk_activity(text) to neos_desk;
grant execute on function neos.refresh_desk_views() to neos_app;
grant usage on schema neos to neos_desk;
select neos.refresh_desk_views();
