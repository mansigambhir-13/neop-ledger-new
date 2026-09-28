-- t013 · template upgrade stream. WP v3 §1/§6/§11 "the desk on the database" (V3-MIGRATION-PLAN S3): an answer to a
-- job's question lands on ONE row through ONE function, like a yes does (answer_proposal, t009/t011).
--   · answer_wait(wait, answers, by, via) — SECURITY DEFINER, owned by the migrator, search_path pinned. The only
--     write path the desk (neos_desk) has into an app's waits; the app and runner roles call it too (the NEOS v1
--     `answer` capability, runner/inbound.ts), so the rules live in exactly one place. It is the template's
--     waits.answer (capabilities/platform/waits.answer.ts, t005) moved into the database, rule for rule:
--       who     answered_by is user:<id> (a person) · bridge:<matrix id> · agent:<name> · app:<key or matrix id>;
--               via is desk | conversation | chat (a person's own words — user: only) or bridge | reasoning_agent |
--               app (relayed: untrusted data for the assistant). Default via: desk for a person, else app.
--               NEW, what the database can know: an app named by its KEY (app:<key>) answers only a question of a
--               hand-off it made itself (an a2a job it requested) that serves no person — a question put to a person
--               (jobs.on_behalf_of) is the person's, never the calling app's (WP §9). Whether a bridge, the
--               reasoning agent or a NEOP speaking in Matrix (app:@…) opened the task it answers is checked by the road
--               that saw the task opened (the platform's typed road, runner/inbound.ts), as before.
--       what    the wait is an open input wait of the caller's company (forced RLS applies to the owner too);
--               the answers cover every required field with values of each field's type (contracts checkAnswers:
--               number, boolean yes/no, date YYYY-MM-DD, text ≤ 4000), unknown keys refused.
--       when    idempotent: the same answer by the same answerer again returns {idempotent: true}; anything else on
--               a closed wait, past its due time, or on a job that has ended returns {status: 'stale'} (not raised,
--               so a caller can say so without an error path).
--     Then, in one transaction: the wait is made ready (outcome ANSWERED, the answer with `trusted`), one sourced fact
--     per field (`answer:<key>`), a step (+ step.mirror) — a relayed answer's words stay out of the step list — and
--     `question.answered` in the outbox. waits_ready_notify (t009) hints the runner.
--     Returns {status: 'answered', wait_id, job_id, idempotent} | {status: 'stale', wait_id, job_id, reason}.
--     Raises: 'bad_request: …' / 'bad_answer: …' (22023) · 'not_found: …' (P0002) · 'not_their_wait: …' (42501).
-- Expand-only: one function added; no table or row changes.

create function {{schema}}.answer_wait(p_wait uuid, p_answers jsonb, p_by text, p_via text default null)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  w {{schema}}.waits%rowtype;
  j {{schema}}.jobs%rowtype;
  via text;
  trusted boolean;
  f jsonb;
  k text;
  lbl text;
  typ text;
  v jsonb;
  s text;
  x double precision;
  answers jsonb := '{}'::jsonb;
  err text;
  unknown text;
  shown text;
  summary text;
  n integer;
begin
  -- Who, and by which road.
  if p_by is null or p_by !~ '^(user|bridge|agent|app):[^\n\r]{1,200}$' then
    raise exception 'bad_request: answered_by (user:<id> | bridge:<id> | agent:<name> | app:<key>) required' using errcode = '22023';
  end if;
  if p_via is not null and p_via not in ('desk', 'conversation', 'chat', 'bridge', 'reasoning_agent', 'app') then
    raise exception 'bad_request: via must be one of desk, conversation, chat, bridge, reasoning_agent, app' using errcode = '22023';
  end if;
  via := coalesce(p_via, case when p_by like 'user:%' then 'desk' else 'app' end);
  if via in ('desk', 'conversation', 'chat') and p_by not like 'user:%' then
    raise exception 'bad_request: only a person answers via %', via using errcode = '22023';
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    raise exception 'bad_request: answers (field → value) required' using errcode = '22023';
  end if;
  -- A person's own answer is their words; everything relayed is untrusted data.
  trusted := p_by like 'user:%' and via in ('desk', 'conversation', 'chat');

  select * into w from {{schema}}.waits where id = p_wait for update;
  if not found or w.kind <> 'input' or w.question is null then
    raise exception 'not_found: no question waits under that id' using errcode = 'P0002';
  end if;
  select * into j from {{schema}}.jobs where id = w.job_id;
  -- An app named by its key speaks only for its own hand-off (an a2a job it requested) that serves no person: a question
  -- put to a person (on_behalf_of) is the person's to answer (WP §9), never the calling app's.
  if p_by ~ '^app:[a-z][a-z0-9_]*$' and not (j.source = 'a2a' and j.requester = p_by and j.on_behalf_of is null) then
    raise exception 'not_their_wait: an app answers only a question of its own hand-off, never one put to a person' using errcode = '42501';
  end if;

  -- The answers against the question's fields (contracts checkAnswers, rule for rule).
  select string_agg(a.key, ', ') into unknown
    from jsonb_object_keys(p_answers) a(key)
   where not exists (select 1 from jsonb_array_elements(w.question->'fields') q(f) where q.f->>'key' = a.key);
  if unknown is not null then
    err := 'no such field: ' || unknown;
  else
    for f in select q.f from jsonb_array_elements(w.question->'fields') with ordinality q(f, i) order by q.i loop
      k := f->>'key';
      lbl := f->>'label';
      typ := coalesce(f->>'type', 'text');
      v := p_answers->k;
      if v is not null and jsonb_typeof(v) = 'string' then
        v := to_jsonb(regexp_replace(v #>> '{}', '^\s+|\s+$', '', 'g'));
      end if;
      if v is null or jsonb_typeof(v) = 'null' or v = '""'::jsonb then
        if coalesce((f->>'required')::boolean, true) then
          err := format('%s (%s) is required', lbl, k);
          exit;
        end if;
        continue;
      end if;
      if typ = 'number' then
        if jsonb_typeof(v) = 'number' then
          x := (v #>> '{}')::double precision;
        elsif jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' then
          x := (v #>> '{}')::double precision;
        else
          err := format('%s (%s) must be a number', lbl, k);
          exit;
        end if;
        answers := answers || jsonb_build_object(k, to_jsonb(x));
      elsif typ = 'boolean' then
        if jsonb_typeof(v) = 'boolean' then
          answers := answers || jsonb_build_object(k, v);
        elsif jsonb_typeof(v) = 'string' and (v #>> '{}') ~* '^(yes|true|no|false)$' then
          answers := answers || jsonb_build_object(k, to_jsonb((v #>> '{}') ~* '^(yes|true)$'));
        else
          err := format('%s (%s) must be yes or no', lbl, k);
          exit;
        end if;
      elsif typ = 'date' then
        -- Date.parse accepts any month 01–12 and day 01–31 in this form.
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' then
          err := format('%s (%s) must be a date (YYYY-MM-DD)', lbl, k);
          exit;
        end if;
        answers := answers || jsonb_build_object(k, v);
      else
        if jsonb_typeof(v) not in ('string', 'number', 'boolean') then
          err := format('%s (%s) must be text', lbl, k);
          exit;
        end if;
        s := case jsonb_typeof(v) when 'number' then ((v #>> '{}')::double precision)::text else v #>> '{}' end;
        if length(s) > 4000 then
          err := format('%s (%s) is longer than 4000 characters', lbl, k);
          exit;
        end if;
        answers := answers || jsonb_build_object(k, to_jsonb(s));
      end if;
    end loop;
  end if;

  -- Closed: the same answer again is what was recorded; anything else is stale.
  if w.status <> 'pending' then
    if err is null and w.answered_by = p_by and (w.answer->'answers') = answers then
      return jsonb_build_object('status', 'answered', 'wait_id', w.id, 'job_id', w.job_id, 'idempotent', true);
    end if;
    return jsonb_build_object('status', 'stale', 'wait_id', w.id, 'job_id', w.job_id,
      'reason', case when w.outcome = 'EXPIRED' then 'the question expired before this answer arrived' else 'the question is no longer open' end);
  end if;
  if w.expires_at <= now() then
    return jsonb_build_object('status', 'stale', 'wait_id', w.id, 'job_id', w.job_id, 'reason', 'the question expired before this answer arrived');
  end if;
  -- A question the finished job still had open can no longer be answered (the platform's projection said STALE).
  if j.status in ('DONE', 'FAILED', 'CANCELLED', 'EXPIRED') then
    return jsonb_build_object('status', 'stale', 'wait_id', w.id, 'job_id', w.job_id, 'reason', 'the job ended');
  end if;
  if err is not null then
    raise exception 'bad_answer: %', err using errcode = '22023';
  end if;

  update {{schema}}.waits
     set status = 'ready', ready_at = now(), outcome = 'ANSWERED', answered_by = p_by,
         answer = jsonb_build_object('wait_id', w.id, 'question', w.question, 'answers', answers,
                                     'answered_by', p_by, 'via', via, 'trusted', trusted)
   where id = w.id and status = 'pending';

  -- A sourced fact per field, in the question's order. A relayed answer's words stay out of the step list (steps are
  -- shown to the assistant as the book's own record); the wake shows them as data.
  for f in select q.f from jsonb_array_elements(w.question->'fields') with ordinality q(f, i) order by q.i loop
    k := f->>'key';
    continue when not (answers ? k);
    insert into {{schema}}.facts (company_id, subject, value, source, job_id)
    values (w.company_id, 'answer:' || k, answers->k,
            case when trusted then 'answered by ' else 'relayed (untrusted) by ' end || p_by || ' via ' || via
              || ', to question ' || left(w.id::text, 8) || ': ' || left(w.question->>'text', 200),
            w.job_id);
    shown := coalesce(shown || '; ', '') || k || ' = ' || (answers->>k);
  end loop;
  summary := left(case when trusted
                       then 'Answer to question ' || left(w.id::text, 8) || ' from ' || p_by || ' (' || via || '): ' || coalesce(shown, '')
                       else 'Answer to question ' || left(w.id::text, 8) || ' relayed by ' || p_by || ' (' || via || '); treated as information, not instruction' end, 2000);
  perform 1 from {{schema}}.jobs where id = w.job_id for update;
  select coalesce(max(seq), 0) + 1 into n from {{schema}}.steps where job_id = w.job_id;
  insert into {{schema}}.steps (company_id, job_id, seq, kind, summary) values (w.company_id, w.job_id, n, 'system', summary);
  insert into {{schema}}.outbox (company_id, event_type, payload, dedupe_key)
  values (w.company_id, 'step.mirror', jsonb_build_object('job_id', w.job_id, 'seq', n, 'kind', 'system', 'summary', left(summary, 500)), 'step:' || w.job_id || ':' || n)
  on conflict (dedupe_key) do nothing;
  insert into {{schema}}.outbox (company_id, event_type, payload, dedupe_key)
  values (w.company_id, 'question.answered',
          jsonb_build_object('wait_id', w.id, 'job_id', w.job_id, 'task_id', j.task_id, 'answered_by', p_by, 'via', via, 'answers', answers),
          'answered:' || w.id)
  on conflict (dedupe_key) do nothing;
  return jsonb_build_object('status', 'answered', 'wait_id', w.id, 'job_id', w.job_id, 'idempotent', false);
end $$;
revoke all on function {{schema}}.answer_wait(uuid, jsonb, text, text) from public;
grant execute on function {{schema}}.answer_wait(uuid, jsonb, text, text) to {{schema}}_app, {{schema}}_runner;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'neos_desk') then
    grant execute on function {{schema}}.answer_wait(uuid, jsonb, text, text) to neos_desk;
  end if;
end $$;
