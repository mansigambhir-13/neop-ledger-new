-- t009 · template upgrade stream. Expand-only.
--   · NOTIFY from the database (WP v3 §6): a wait turning ready, or a job arriving, hints the runner on
--     the channel it LISTENs on (neop_<schema>), whoever made the change — the app, the desk's function,
--     or a DBA's hand. The app code notifies too; duplicate hints are harmless. The poll is the truth.
--   · answer_proposal() (WP v3 §6 "one row, one function"): the only path an answer takes into a
--     proposal. Fingerprint, expiry and the legal transition are checked in exactly this one place.
--   · read-only mirrors of the platform's switchboard, installs and grants (WP v3 §11, the nine standard
--     tables). The platform stays the source of truth; the runner writes these when it (re)loads them;
--     the app role may read them.

-- ── NOTIFY ───────────────────────────────────────────────────────────────
create function {{schema}}.notify_runner() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'waits' then
    perform pg_notify('neop_{{schema}}', 'wait:' || new.job_id::text);
  else
    perform pg_notify('neop_{{schema}}', 'job:' || new.id::text);
  end if;
  return null;
end $$;

create trigger waits_ready_notify after update of status on {{schema}}.waits
  for each row when (new.status = 'ready' and old.status is distinct from 'ready') execute function {{schema}}.notify_runner();
create trigger waits_insert_ready_notify after insert on {{schema}}.waits
  for each row when (new.status = 'ready') execute function {{schema}}.notify_runner();
create trigger jobs_insert_notify after insert on {{schema}}.jobs
  for each row execute function {{schema}}.notify_runner();

-- ── answer_proposal ──────────────────────────────────────────────────────
-- answer_proposal(proposal, fingerprint the person saw, yes|no|change|withdraw, user:<id>, feedback)
-- Runs as the migrator (SECURITY DEFINER) but under the caller's company: row-level security is forced
-- on the owner too, so a caller only ever finds its own company's proposal.
-- Returns {status, idempotent, job_id} — status is the proposal's status after the call — or, when the
-- fingerprint differs, {status, refused: 'fingerprint_mismatch'} with the refusal kept in proposal_events.
-- Raises: 'not_found: …' (P0002) · 'not_open: …' / 'expired: …' (55000) · a bad argument (22023).
-- A yes does not wake the job (B2): its wait turns ready when execution is terminal.
create function {{schema}}.answer_proposal(p_id uuid, p_fingerprint text, p_decision text, p_by text, p_feedback text default null)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  p {{schema}}.proposals%rowtype;
  target text;
  said text;
  fb text := nullif(p_feedback, '');
  summary text;
  n integer;
begin
  if p_decision is null or p_decision not in ('yes', 'no', 'change', 'withdraw') then
    raise exception 'bad_request: decision must be yes, no, change or withdraw' using errcode = '22023';
  end if;
  if p_by is null or p_by !~ '^user:.+' then
    raise exception 'bad_request: decided_by must be a person (user:<id>)' using errcode = '22023';
  end if;
  if p_decision = 'change' and coalesce(btrim(p_feedback), '') = '' then
    raise exception 'bad_request: a change needs feedback' using errcode = '22023';
  end if;

  select * into p from {{schema}}.proposals where id = p_id for update;
  if not found then
    raise exception 'not_found: no such proposal' using errcode = 'P0002';
  end if;
  target := case p_decision when 'yes' then 'APPROVED' when 'no' then 'REJECTED' when 'change' then 'SUPERSEDED' else 'WITHDRAWN' end;

  -- The same answer again, against the same card: what was recorded stands.
  if p.fingerprint = p_fingerprint and (p.status = target or (p_decision = 'yes' and p.status in ('APPROVED', 'EXECUTING', 'DONE', 'FAILED', 'UNKNOWN'))) then
    return jsonb_build_object('status', p.status, 'idempotent', true, 'job_id', p.job_id);
  end if;
  -- Open means PROPOSED; a yes may still be withdrawn before it is carried out.
  if not (p.status = 'PROPOSED' or (p_decision = 'withdraw' and p.status = 'APPROVED'))
     or not {{schema}}.legal_transition('proposals', p.status, target) then
    raise exception 'not_open: proposal is %', p.status using errcode = '55000';
  end if;
  if p_fingerprint is distinct from p.fingerprint then
    insert into {{schema}}.proposal_events (company_id, proposal_id, event, actor, fingerprint_seen)
    values (p.company_id, p.id, 'answer_refused:fingerprint', p_by, p_fingerprint);
    return jsonb_build_object('status', p.status, 'idempotent', false, 'job_id', p.job_id, 'refused', 'fingerprint_mismatch');
  end if;
  if p.expires_at <= now() and p_decision <> 'withdraw' then
    raise exception 'expired: the proposal expired before this answer arrived' using errcode = '55000';
  end if;

  update {{schema}}.proposals
     set status = target, decided_by = p_by, feedback = p_feedback,
         approved_via = case when p_decision = 'yes' then 'person' end,
         answered_at = now(), updated_at = now()
   where id = p.id;
  insert into {{schema}}.proposal_events (company_id, proposal_id, event, actor, fingerprint_seen, detail)
  values (p.company_id, p.id, 'answered:' || p_decision, p_by, p_fingerprint,
          case when fb is not null then jsonb_build_object('feedback', fb) end);

  -- A step for the job (seq serialised on the job row) and its mirror, then the platform's event.
  said := case p_decision when 'yes' then 'yes' when 'no' then 'no' when 'change' then 'change this first' else 'withdrawn' end;
  summary := left('Answer on proposal ' || left(p.id::text, 8) || ': ' || said || ' (' || p_by || ')'
                  || case when fb is not null then ' — "' || fb || '"' else '' end, 2000);
  perform 1 from {{schema}}.jobs where id = p.job_id for update;
  select coalesce(max(seq), 0) + 1 into n from {{schema}}.steps where job_id = p.job_id;
  insert into {{schema}}.steps (company_id, job_id, seq, kind, summary) values (p.company_id, p.job_id, n, 'system', summary);
  insert into {{schema}}.outbox (company_id, event_type, payload, dedupe_key)
  values (p.company_id, 'step.mirror', jsonb_build_object('job_id', p.job_id, 'seq', n, 'kind', 'system', 'summary', left(summary, 500)), 'step:' || p.job_id || ':' || n)
  on conflict (dedupe_key) do nothing;
  insert into {{schema}}.outbox (company_id, event_type, payload, dedupe_key)
  values (p.company_id, 'proposal.resolved', jsonb_build_object('proposal_id', p.id, 'job_id', p.job_id, 'decision', p_decision, 'status', target), 'resolved:' || p.id || ':' || p_decision)
  on conflict (dedupe_key) do nothing;

  if p_decision <> 'yes' then
    update {{schema}}.waits
       set status = 'ready', ready_at = now(), outcome = target,
           answer = jsonb_build_object('proposal_id', p.id, 'status', target, 'decided_by', p_by, 'feedback', p_feedback)
     where ref_id = p.id and status = 'pending';
    -- (waits_ready_notify hints the runner as well; a duplicate hint is harmless)
    if found then
      perform pg_notify('neop_{{schema}}', 'wait:' || p.job_id::text);
    end if;
  end if;
  return jsonb_build_object('status', target, 'idempotent', false, 'job_id', p.job_id);
end $$;
revoke all on function {{schema}}.answer_proposal(uuid, text, text, text, text) from public;
grant execute on function {{schema}}.answer_proposal(uuid, text, text, text, text) to {{schema}}_app, {{schema}}_runner;

-- ── read-only mirrors of the platform (source of truth: the platform) ─────
-- One row per line in force for a company: the effective setting the gate applies (min of the app's
-- floor and the company's switch), the company's rules and caps, and the board version it came from.
create table {{schema}}.switchboard (
  company_id  uuid not null,
  line        text not null check (length(line) between 1 and 200),
  kind        text check (kind in ('read', 'write', 'borrowed', 'skill')),
  floor       text check (floor in ('on', 'ask_first', 'off')),
  setting     text not null check (setting in ('on', 'ask_first', 'off')),
  caps        jsonb,
  rules       jsonb,
  version     integer not null check (version >= 0),
  updated_at  timestamptz not null default now(),
  primary key (company_id, line)
);
-- Whether the company has this app installed, as the platform last said.
create table {{schema}}.installs (
  company_id   uuid primary key,
  status       text not null check (status in ('active', 'not_installed')),
  matrix_user  text,
  updated_at   timestamptz not null default now()
);
-- Standing yeses this app has been told about (a grant lookup that came back with one).
create table {{schema}}.grants (
  company_id   uuid not null,
  grant_id     uuid not null,
  ability_key  text not null,
  limits       jsonb,
  expires_at   timestamptz,
  status       text not null check (status in ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  updated_at   timestamptz not null default now(),
  primary key (company_id, grant_id)
);
do $$
declare t text;
begin
  foreach t in array array['switchboard', 'installs', 'grants'] loop
    execute format('alter table {{schema}}.%I enable row level security', t);
    execute format('alter table {{schema}}.%I force row level security', t);
    execute format(
      'create policy company_isolation on {{schema}}.%I using (company_id = nullif(current_setting(''neos.company_id'', true), '''')::uuid) with check (company_id = nullif(current_setting(''neos.company_id'', true), '''')::uuid)',
      t);
    -- Read-only to the app; the runner keeps them in step with the platform.
    execute format('revoke insert, update, delete on {{schema}}.%I from {{schema}}_app', t);
    execute format('grant select on {{schema}}.%I to {{schema}}_app', t);
    execute format('grant select, insert, update, delete on {{schema}}.%I to {{schema}}_runner', t);
  end loop;
end $$;
