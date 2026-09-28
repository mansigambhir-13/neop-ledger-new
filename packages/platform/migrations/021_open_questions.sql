-- 021_open_questions.sql · v3 S3 "the desk on the database; questions answered through a function" (WP v3 §1, §6, §11).
-- A job's question is the app's own input wait (<app>.waits, kind 'input'); a person's answer goes straight to that row
-- through <app>.answer_wait() (template t013), called as neos_desk. The desk reads the questions the way it reads the
-- cards (020) and the steps (018):
--   · neos.desk_questions(app): every input wait of one registered app, in the shape the desk has always shown
--     (neos.questions' columns): OPEN (pending, not past due, its job still going), ANSWERED, EXPIRED, STALE (closed
--     otherwise — say the job ended first). A question's id is its wait id. SECURITY DEFINER with dynamic SQL, so
--     the views hold no catalog dependency on any app's tables (a missing schema gives no rows).
--   · neos.v_questions (every question) and neos.v_open_questions (the OPEN ones) — union views over every registered
--     app, rebuilt by neos.refresh_desk_questions() at every registerApp and after every platform migration (like 018,
--     020). Only neos_desk may read them; the platform reads them with `SET LOCAL ROLE neos_desk`.
-- neos.questions stays: it is now only the Matrix bridge's and the conversation's projection of question.* events
-- (which DM a question was shown in, and a reply to it) until presence moves into the NEOP (S4/S5); the desk no longer
-- reads it to decide anything, and a new row's id is its wait id, so both name a question the same way.
--
-- Expand only: new functions, views and grants; no table is touched.

create function neos.desk_questions(app text)
  returns table (app_key text, id uuid, company_id uuid, wait_id uuid, job_id uuid, task_id uuid, text text, why text,
                 fields jsonb, due_at timestamptz, status text, answers jsonb, answered_by text, answered_via text,
                 answered_at timestamptz, created_at timestamptz)
  language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  if app is null or app !~ '^[a-z][a-z0-9_]{0,40}$' or not exists (select 1 from neos.apps a where a.key = app)
     or to_regclass(format('%I.waits', app)) is null or to_regclass(format('%I.jobs', app)) is null then
    return;
  end if;
  return query execute format(
    $q$select %L::text, w.id, w.company_id, w.id, w.job_id, j.task_id,
              w.question->>'text', w.question->>'why', coalesce(w.question->'fields', '[]'::jsonb), w.expires_at,
              case when w.status = 'pending' and w.expires_at > now() and j.status not in ('DONE', 'FAILED', 'CANCELLED', 'EXPIRED') then 'OPEN'
                   when w.outcome = 'ANSWERED' then 'ANSWERED'
                   when w.outcome = 'EXPIRED' or (w.status = 'pending' and w.expires_at <= now()) then 'EXPIRED'
                   else 'STALE' end,
              case when w.outcome = 'ANSWERED' then w.answer->'answers' end,
              case when w.outcome = 'ANSWERED' then w.answered_by end,
              case when w.outcome = 'ANSWERED' then w.answer->>'via' end,
              case when w.outcome = 'ANSWERED' then w.ready_at end,
              w.created_at
         from %I.waits w join %I.jobs j on j.id = w.job_id
        where w.kind = 'input' and w.question is not null$q$, app, app, app);
end $$;

create function neos.refresh_desk_questions() returns integer
  language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  keys text[];
  q_all text;
  q_open text;
begin
  perform pg_advisory_xact_lock(hashtext('neos.refresh_desk_questions'));
  select coalesce(array_agg(key order by key), '{}') into keys
    from neos.apps where status <> 'platform' and key ~ '^[a-z][a-z0-9_]{0,40}$';
  if cardinality(keys) = 0 then
    q_all := 'select * from neos.desk_questions(null) where false';
    q_open := q_all;
  else
    select string_agg(format('select * from neos.desk_questions(%L)', k), ' union all '),
           string_agg(format('select * from neos.desk_questions(%L) where status = %L', k, 'OPEN'), ' union all ')
      into q_all, q_open from unnest(keys) k;
  end if;
  drop view if exists neos.v_open_questions;
  drop view if exists neos.v_questions;
  execute 'create view neos.v_questions as ' || q_all;
  execute 'create view neos.v_open_questions as ' || q_open;
  grant select on neos.v_questions, neos.v_open_questions to neos_desk;
  return cardinality(keys);
end $$;

revoke all on function neos.desk_questions(text), neos.refresh_desk_questions() from public;
grant execute on function neos.desk_questions(text) to neos_desk;
grant execute on function neos.refresh_desk_questions() to neos_app;
comment on table neos.questions is 'the Matrix bridge''s and the conversation''s projection of question.* events (v3 S3, 021): the desk reads neos.v_questions / neos.v_open_questions; answers go to <app>.answer_wait()';
select neos.refresh_desk_questions();
