-- t008 · template upgrade stream. Expand-only: states are "a real enum with a CHECK on allowed
-- transitions" (WP v3 §11 value classes). A status column may only move along the lifecycle the
-- template's code walks; any other UPDATE is refused by the database, whoever sends it.
--
-- The allowed sets are the code's, not a guess:
--   proposals · packages/neop-template/src/domain/proposals.ts NEXT
--     PROPOSED  → APPROVED | REJECTED | SUPERSEDED | EXPIRED | WITHDRAWN   (resolve · runner expiry · cancel)
--     APPROVED  → EXECUTING | WITHDRAWN                                    (execute · withdraw after a yes · cancel)
--     EXECUTING → DONE | FAILED | UNKNOWN                                  (execute finish)
--     UNKNOWN   → DONE | FAILED                                            (runner reconcile)
--   jobs · runner.ts / gate.ts / tasks.cancel.ts
--     RECEIVED  → RUNNING (claim) | CANCELLED (cancel) | EXPIRED (a timer job that missed its window)
--     RUNNING   → WAITING (proposal · question · timer · a2a) | DONE | FAILED (finish · runner) | CANCELLED
--     WAITING   → RUNNING (claim, a wait is ready) | CANCELLED
--   waits · book.ts / runner.ts / gate.ts / tasks.cancel.ts / waits.answer.ts
--     pending   → ready (answered · executed · expired · timer) | consumed (a2a not opened · cancel)
--     ready     → consumed (the woken session took it · cancel)
-- An UPDATE that leaves the status as it is (claims, proofs, heartbeats) is always allowed.

create function {{schema}}.legal_transition(tbl text, from_status text, to_status text) returns boolean
language sql immutable as $$
  select from_status = to_status or exists (
    select 1 from (values
      ('proposals', 'PROPOSED', 'APPROVED'), ('proposals', 'PROPOSED', 'REJECTED'), ('proposals', 'PROPOSED', 'SUPERSEDED'),
      ('proposals', 'PROPOSED', 'EXPIRED'), ('proposals', 'PROPOSED', 'WITHDRAWN'),
      ('proposals', 'APPROVED', 'EXECUTING'), ('proposals', 'APPROVED', 'WITHDRAWN'),
      ('proposals', 'EXECUTING', 'DONE'), ('proposals', 'EXECUTING', 'FAILED'), ('proposals', 'EXECUTING', 'UNKNOWN'),
      ('proposals', 'UNKNOWN', 'DONE'), ('proposals', 'UNKNOWN', 'FAILED'),
      ('jobs', 'RECEIVED', 'RUNNING'), ('jobs', 'RECEIVED', 'CANCELLED'), ('jobs', 'RECEIVED', 'EXPIRED'),
      ('jobs', 'RUNNING', 'WAITING'), ('jobs', 'RUNNING', 'DONE'), ('jobs', 'RUNNING', 'FAILED'), ('jobs', 'RUNNING', 'CANCELLED'),
      ('jobs', 'WAITING', 'RUNNING'), ('jobs', 'WAITING', 'CANCELLED'),
      ('waits', 'pending', 'ready'), ('waits', 'pending', 'consumed'),
      ('waits', 'ready', 'consumed')
    ) as t (tbl, from_status, to_status)
    where t.tbl = legal_transition.tbl and t.from_status = legal_transition.from_status and t.to_status = legal_transition.to_status)
$$;

create function {{schema}}.refuse_illegal_transition() returns trigger
language plpgsql as $$
begin
  if not {{schema}}.legal_transition(tg_table_name, old.status, new.status) then
    raise exception 'illegal transition: %.status % → % (row %)', tg_table_name, old.status, new.status, old.id
      using errcode = 'check_violation', hint = 'the status may only move along its lifecycle (t008_transitions.sql)';
  end if;
  return new;
end $$;

create trigger jobs_status_transition before update of status on {{schema}}.jobs
  for each row when (old.status is distinct from new.status) execute function {{schema}}.refuse_illegal_transition();
create trigger proposals_status_transition before update of status on {{schema}}.proposals
  for each row when (old.status is distinct from new.status) execute function {{schema}}.refuse_illegal_transition();
create trigger waits_status_transition before update of status on {{schema}}.waits
  for each row when (old.status is distinct from new.status) execute function {{schema}}.refuse_illegal_transition();
