-- 020_approvals_frozen.sql · v3 S2 "the runner carries out the yes" (WP v3 §5–§7).
-- A person's answer now goes straight to the app's own proposal row through <app>.answer_proposal() (the platform
-- calls it as neos_desk); the app's runner carries a yes out. The platform keeps no approval state of its own:
--   · neos.approvals is FROZEN as a legacy copy: the platform's role may still read it (to map an old card id to its
--     proposal) but never write it. Nothing reads it to decide. A RECORDED/RESOLVED row left at deploy time is
--     re-answered through the function by scripts/v3/drain-approvals.ts (also run by scripts/migrate.ts).
--   · A card's id is its proposal id: room_events / room_messages / chat_client_events.approval_id no longer
--     reference neos.approvals, and every legacy approval id in them is rewritten to its proposal id (the card
--     a person replies to in a room keeps working across the deploy).
--   · neos.v_desk_cards: every registered app's person-facing proposals (not the ones a standing yes carried out),
--     in the shape the desk has always shown (PENDING, RESOLVED — a yes being carried out —, EXECUTED, FAILED,
--     UNKNOWN, CLOSED, EXPIRED), built like v_pending_approvals (018): a SECURITY DEFINER function per app, no
--     catalog dependency on app tables, rebuilt by neos.refresh_desk_cards() at every registerApp and after every
--     platform migration. neos_desk and the platform's role (neos_app) may read it.

-- ── card ids are proposal ids ─────────────────────────────────────────────
do $$
declare r record;
begin
  for r in
    select c.conrelid::regclass as tbl, c.conname
      from pg_constraint c
     where c.contype = 'f' and c.confrelid = 'neos.approvals'::regclass
       and c.conrelid in ('neos.room_events'::regclass, 'neos.room_messages'::regclass, 'neos.chat_client_events'::regclass)
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

update neos.room_events e set approval_id = a.proposal_id from neos.approvals a where e.approval_id = a.id;
update neos.room_messages m set approval_id = a.proposal_id from neos.approvals a where m.approval_id = a.id;
update neos.chat_client_events e set approval_id = a.proposal_id from neos.approvals a where e.approval_id = a.id;
-- A typed card already sent is keyed by its card id: keep the key in step, so it is not posted a second time.
update neos.room_events e set outcome = 'typed:propose:' || a.proposal_id from neos.approvals a where e.outcome = 'typed:propose:' || a.id;
update neos.chat_client_events e set outcome = 'typed:propose:' || a.proposal_id from neos.approvals a where e.outcome = 'typed:propose:' || a.id;

comment on column neos.room_events.approval_id is 'the card shown: the app''s proposal id (v3 S2, 020)';
comment on column neos.room_messages.approval_id is 'the card shown: the app''s proposal id (v3 S2, 020)';
comment on column neos.chat_client_events.approval_id is 'the card shown: the app''s proposal id (v3 S2, 020)';

-- ── neos.approvals is a frozen legacy copy ────────────────────────────────
revoke insert, update, delete on neos.approvals from neos_app;
comment on table neos.approvals is 'FROZEN legacy copy (v3 S2, 020): answers go to <app>.answer_proposal(); read only to map an old card id';

-- ── the desk's cards ──────────────────────────────────────────────────────
create function neos.desk_cards(app text)
  returns table (app_key text, id uuid, company_id uuid, proposal_id uuid, job_id uuid, task_id uuid, ability_key text,
                 ability_version text, args jsonb, card jsonb, fingerprint text, expires_at timestamptz, status text,
                 decision text, feedback text, decided_by uuid, decided_at timestamptz, fingerprint_seen text, proof jsonb,
                 last_error text, created_at timestamptz, updated_at timestamptz, proposal_status text)
  language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  if app is null or app !~ '^[a-z][a-z0-9_]{0,40}$' or not exists (select 1 from neos.apps a where a.key = app)
     or to_regclass(format('%I.proposals', app)) is null or to_regclass(format('%I.jobs', app)) is null then
    return;
  end if;
  return query execute format(
    $q$select %L::text, p.id, p.company_id, p.id, p.job_id, j.task_id, p.ability_key, p.ability_version, p.args, p.card,
              p.fingerprint, p.expires_at,
              case p.status when 'PROPOSED' then 'PENDING' when 'APPROVED' then 'RESOLVED' when 'EXECUTING' then 'RESOLVED'
                            when 'DONE' then 'EXECUTED' when 'FAILED' then 'FAILED' when 'UNKNOWN' then 'UNKNOWN'
                            when 'EXPIRED' then 'EXPIRED' else 'CLOSED' end,
              case p.status when 'REJECTED' then 'no' when 'SUPERSEDED' then 'change' when 'WITHDRAWN' then 'withdraw'
                            when 'PROPOSED' then null when 'EXPIRED' then null else 'yes' end,
              p.feedback,
              case when p.decided_by ~ '^user:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                   then substr(p.decided_by, 6)::uuid end,
              p.answered_at,
              case when p.answered_at is not null then p.fingerprint end,
              p.proof,
              case when p.status in ('FAILED', 'UNKNOWN') then p.proof->>'error'
                   when p.status = 'WITHDRAWN' and p.approved_via = 'person' then 'withdrawn after a yes, before it was carried out'
                   when p.status = 'WITHDRAWN' then 'withdrawn by the app' end,
              p.created_at, p.updated_at, p.status
         from %I.proposals p join %I.jobs j on j.id = p.job_id
        where p.approved_via is distinct from 'grant'$q$, app, app, app);
end $$;

create function neos.refresh_desk_cards() returns integer
  language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  keys text[];
  cards text;
begin
  perform pg_advisory_xact_lock(hashtext('neos.refresh_desk_cards'));
  select coalesce(array_agg(key order by key), '{}') into keys
    from neos.apps where status <> 'platform' and key ~ '^[a-z][a-z0-9_]{0,40}$';
  if cardinality(keys) = 0 then
    cards := 'select * from neos.desk_cards(null) where false';
  else
    select string_agg(format('select * from neos.desk_cards(%L)', k), ' union all ') into cards from unnest(keys) k;
  end if;
  drop view if exists neos.v_desk_cards;
  execute 'create view neos.v_desk_cards as ' || cards;
  grant select on neos.v_desk_cards to neos_desk, neos_app;
  return cardinality(keys);
end $$;

revoke all on function neos.desk_cards(text), neos.refresh_desk_cards() from public;
grant execute on function neos.desk_cards(text) to neos_desk, neos_app;
grant execute on function neos.refresh_desk_cards() to neos_app;
select neos.refresh_desk_cards();
