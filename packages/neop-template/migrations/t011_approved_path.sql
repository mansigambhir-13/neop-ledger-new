-- t011 · template upgrade stream. WP v3 §5–§7 "a yes lands on one row, and the runner carries it out before the
-- assistant wakes" (V3-MIGRATION-PLAN S2).
--   · answer_proposal() gains the approver policy (defaults 5): the company's policy for the write — its own
--     line's `approvers`, else the company row '*' — is checked HERE, not by the platform. `roles`: only a person
--     holding one of them may say yes or "change this first" (the caller passes the person's roles; none passed
--     means none known, and a roles policy then refuses — fail closed). `four_eyes`: the person the job serves
--     (jobs.on_behalf_of, else a person requester) may not approve it; with nobody on record it cannot be
--     satisfied. Anyone may say no or withdraw. A refusal raises 'not_an_approver: …' / 'four_eyes: …'
--     (42501) and records nothing. The old five-argument signature is replaced by one with a sixth, defaulted
--     argument (p_roles), so every existing five-argument call still resolves to it.
--   · A yes still does NOT ready the wait (B2): the runner does, after the effect is terminal.
--   · proposals_approved_notify: a proposal that becomes (or is born) APPROVED hints the runner on its channel
--     ('approved:<id>'). The runner's poll of APPROVED rows is the truth; the hint is latency.
--   · proposals_approved_ix: the runner's poll.
-- Expand-only in effect: no table or row changes; one function replaced, one trigger and one index added.

drop function {{schema}}.answer_proposal(uuid, text, text, text, text);

-- answer_proposal(proposal, fingerprint the person saw, yes|no|change|withdraw, user:<id>, feedback, the person's roles)
-- Runs as the migrator (SECURITY DEFINER) but under the caller's company: row-level security is forced on the
-- owner too, so a caller only ever finds its own company's proposal.
-- Returns {status, idempotent, job_id} — or, when the fingerprint differs, {status, refused: 'fingerprint_mismatch'}
-- with the refusal kept in proposal_events.
-- Raises: 'not_found: …' (P0002) · 'not_open: …' / 'expired: …' (55000) · 'not_an_approver: …' /
-- 'four_eyes: …' (42501) · a bad argument (22023).
create function {{schema}}.answer_proposal(p_id uuid, p_fingerprint text, p_decision text, p_by text,
                                           p_feedback text default null, p_roles text[] default null)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  p {{schema}}.proposals%rowtype;
  target text;
  said text;
  fb text := nullif(p_feedback, '');
  summary text;
  n integer;
  pol jsonb;
  served text;
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

  -- Who may answer (R8, defaults 5): only saying yes (or "change this first") is restricted; anyone may stop it.
  if p_decision in ('yes', 'change') then
    select s.approvers into pol from {{schema}}.switchboard s
     where s.company_id = p.company_id and s.line = p.ability_key and s.approvers is not null;
    if pol is null then
      select s.approvers into pol from {{schema}}.switchboard s
       where s.company_id = p.company_id and s.line = '*' and s.approvers is not null;
    end if;
    pol := coalesce(pol, '{}'::jsonb);
    if jsonb_typeof(pol->'roles') = 'array' and jsonb_array_length(pol->'roles') > 0 then
      if p_roles is null or not exists (
           select 1 from jsonb_array_elements_text(pol->'roles') r(role) where r.role = any (p_roles)) then
        raise exception 'not_an_approver: only % may approve %',
          (select string_agg(r.role, ' or ') from jsonb_array_elements_text(pol->'roles') r(role)), p.ability_key
          using errcode = '42501';
      end if;
    end if;
    if coalesce((pol->>'four_eyes')::boolean, false) then
      select coalesce(j.on_behalf_of, case when j.requester ~ '^user:.+' then j.requester end) into served
        from {{schema}}.jobs j where j.id = p.job_id;
      if served is null then
        raise exception 'four_eyes: nobody on record asked for this; four-eyes cannot be satisfied' using errcode = '42501';
      end if;
      if served = p_by then
        raise exception 'four_eyes: the person who asked cannot also approve this' using errcode = '42501';
      end if;
    end if;
  end if;

  -- The same answer again, against the same card: what was recorded stands.
  if p.fingerprint = p_fingerprint and (p.status = target or (p_decision = 'yes' and p.status in ('APPROVED', 'EXECUTING', 'DONE', 'FAILED', 'UNKNOWN'))) then
    return jsonb_build_object('status', p.status, 'idempotent', true, 'job_id', p.job_id);
  end if;
  -- Open means PROPOSED; a yes may still be withdrawn before the runner starts carrying it out.
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
         approved_via = case when p_decision = 'yes' then 'person' else approved_via end,
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

  -- A yes does not wake the job (B2): the runner carries it out and readies the wait when it is terminal
  -- (proposals_approved_notify hints the runner). Anything else wakes the job now.
  if p_decision <> 'yes' then
    update {{schema}}.waits
       set status = 'ready', ready_at = now(), outcome = target,
           answer = jsonb_build_object('proposal_id', p.id, 'status', target, 'decided_by', p_by, 'feedback', p_feedback)
     where ref_id = p.id and status = 'pending';
    if found then
      perform pg_notify('neop_{{schema}}', 'wait:' || p.job_id::text);
    end if;
  end if;
  return jsonb_build_object('status', target, 'idempotent', false, 'job_id', p.job_id);
end $$;
revoke all on function {{schema}}.answer_proposal(uuid, text, text, text, text, text[]) from public;
grant execute on function {{schema}}.answer_proposal(uuid, text, text, text, text, text[]) to {{schema}}_app, {{schema}}_runner;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'neos_desk') then
    grant execute on function {{schema}}.answer_proposal(uuid, text, text, text, text, text[]) to neos_desk;
  end if;
end $$;

-- ── the runner hears a yes ───────────────────────────────────────────────
create function {{schema}}.notify_approved() returns trigger
language plpgsql as $$
begin
  perform pg_notify('neop_{{schema}}', 'approved:' || new.id::text);
  return null;
end $$;
create trigger proposals_approved_notify after update of status on {{schema}}.proposals
  for each row when (new.status = 'APPROVED' and old.status is distinct from 'APPROVED') execute function {{schema}}.notify_approved();
create trigger proposals_insert_approved_notify after insert on {{schema}}.proposals
  for each row when (new.status = 'APPROVED') execute function {{schema}}.notify_approved();

create index proposals_approved_ix on {{schema}}.proposals (updated_at) where status = 'APPROVED';
