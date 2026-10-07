-- 025_gateway_gone.sql · v3 S9 "delete the gateway" (V3-MIGRATION-PLAN S9; WP v3 §1 "no chat bridge, no gateway, no
-- platform API", §8 "what the room replaces", §11).
-- contract: drop what the gateway, the chat bridge, the vault, the a2a road, the outbox consumer and the run-time registry installer kept, which no code reads or writes any more; expanded by 017_bridge_never_approves.sql, 020_approvals_frozen.sql, 021_open_questions.sql, 022_registry_pins.sql, 023_neuralchat_matrix.sql
-- (each moved its table's work into the apps' own schemas or into Matrix and froze the table; S1–S8 shipped the code
-- that reads the new shape, and S9's code reads none of these).
--
-- What each dropped table was, and where its job went:
--   gateway_ledger, gateway_keys          the gateway's idempotency ledger and signing keys → each app's `operations`
--                                         (event_id dedupe on the way in); no platform token reaches an app any more
--   acl                                   who may call whom → the bus room's membership + each borrower's `uses` line
--   approvals                             (frozen by 020) → <app>.proposals + answer_proposal()
--   switchboards, grants                  (frozen by S1) → <app>.switchboard, <app>.grants
--   questions                             the bridge's projection (021) → <app>.waits, neos.v_questions
--   activity                              the bridge's/consumer's step and a2a lines → <app>.steps, neos.v_activity
--   vault_secrets                         (unread since S8) → the door secret store, per (app, company)
--   rooms, room_events, room_messages,    the platform chat bridge → each NEOP's own presence (<app>.inbound_events,
--   chat_accounts, chat_dms,              outbound_events, presence_dms, presence_accounts)
--   chat_client_events
--   outbox_cursors, outbox_dead_letters   the platform's outbox consumer → each app's presence mirror
--   app_notifications                     switchboard.changed pushes → NOTIFY 'board:<company>' in the app's schema
--   registry_installs, package_migrations (frozen by S7) → packages installed at build time (packages.lock.json)
--   apps.l3_url                           the gateway's address for each app → none: the platform never calls an app
-- Kept: chat_allowlist (the desk's "who may talk to this app in Matrix", written through to <app>.people), audit,
-- tasks, conversations, installs, users, companies, registry_*, llm_*, neuralchat_*.
--
-- BACKUP FIRST (this file, before any drop): every dropped table is copied whole, and the dropped column with its key,
-- into schema neos_s9_archive (owned by the platform's migrator; no other role may read it). Nothing in it is read by
-- code; it is there so that a question about the old records can still be answered, and so that sealed vault rows can
-- still be exported (scripts/v3/export-door-secrets.ts reads the archive when the table is gone). The DBA drops the
-- schema once the pre-S9 backups have aged out (RUNBOOK "v3 S9: the archive schema").
-- REFUSED (nothing is dropped, nothing copied) while the S2 drain has not run: a RECORDED/RESOLVED approval in the old
-- table would be a person's answer never carried to the app's row (scripts/migrate.ts from the S2–S8 release drains it).

do $$
begin
  if to_regclass('neos.approvals') is not null
     and exists (select 1 from neos.approvals where status in ('RECORDED', 'RESOLVED')) then
    raise exception 'refused: % approval(s) answered on the old desk were never handed to their app (run the S2 drain, scripts/v3/drain-approvals.ts from the S2–S8 release, then migrate again)',
      (select count(*) from neos.approvals where status in ('RECORDED', 'RESOLVED'))
      using errcode = '55000';
  end if;
end $$;

create schema neos_s9_archive;
revoke all on schema neos_s9_archive from public;
comment on schema neos_s9_archive is 'v3 S9 (025): the tables the gateway, the chat bridge, the vault, the a2a road, the outbox consumer and the run-time registry installer kept, copied whole before they were dropped. Read by no code. Drop once the pre-S9 backups have aged out.';

do $$
declare t text;
begin
  foreach t in array array['gateway_ledger', 'gateway_keys', 'acl', 'approvals', 'switchboards', 'grants', 'questions', 'activity',
                           'vault_secrets', 'rooms', 'room_events', 'room_messages', 'chat_accounts', 'chat_dms', 'chat_client_events',
                           'outbox_cursors', 'outbox_dead_letters', 'app_notifications', 'registry_installs', 'package_migrations'] loop
    if to_regclass('neos.' || t) is not null then
      execute format('create table neos_s9_archive.%I as table neos.%I', t, t);
    end if;
  end loop;
end $$;
create table neos_s9_archive.apps_l3_url as select key, l3_url from neos.apps;

-- The copies are the migrator's alone.
do $$
declare r record;
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'neos_s9_archive' and c.relkind = 'r' loop
    execute format('revoke all on neos_s9_archive.%I from public', r.relname);
  end loop;
end $$;

-- Children before parents (room_messages / room_events → rooms, approvals; chat_client_events → chat_accounts, questions).
drop table if exists neos.chat_client_events;
drop table if exists neos.chat_dms;
drop table if exists neos.chat_accounts;
drop table if exists neos.room_messages;
drop table if exists neos.room_events;
drop table if exists neos.rooms;
drop table if exists neos.questions;
drop table if exists neos.approvals;
drop table if exists neos.activity;
drop table if exists neos.acl;
drop table if exists neos.gateway_ledger;
drop table if exists neos.gateway_keys;
drop table if exists neos.switchboards;
drop table if exists neos.grants;
drop table if exists neos.vault_secrets;
drop table if exists neos.outbox_cursors;
drop table if exists neos.outbox_dead_letters;
drop table if exists neos.app_notifications;
drop table if exists neos.package_migrations;
drop table if exists neos.registry_installs;
alter table neos.apps drop column l3_url;

-- ── one audit trail (WP v3 §8): what every app carried out, from its own `operations` ─────────────────────────────────
-- Built like 018/020/021: one SECURITY DEFINER function per app (dynamic SQL, no catalog dependency on any app's table),
-- a union view over every registered app rebuilt by neos.refresh_desk_operations() at registerApp and after every
-- platform migration. Only neos_desk reads it (the platform with SET LOCAL ROLE neos_desk).
create function neos.desk_operations(app text)
  returns table (app_key text, id bigint, company_id uuid, job_id uuid, caller text, ability_key text, idempotency_key text,
                 outcome text, reason text, request_checksum text, result_checksum text, at timestamptz)
  language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  if app is null or app !~ '^[a-z][a-z0-9_]{0,40}$' or not exists (select 1 from neos.apps a where a.key = app)
     or to_regclass(format('%I.operations', app)) is null then
    return;
  end if;
  if exists (select 1 from pg_attribute where attrelid = format('%I.operations', app)::regclass and attname = 'reason' and not attisdropped) then
    return query execute format(
      'select %L::text, o.id, o.company_id, o.job_id, o.caller, o.ability_key, o.idempotency_key, o.outcome, o.reason,
              o.request_checksum, o.result_checksum, o.at from %I.operations o', app, app);
  else
    return query execute format(
      'select %L::text, o.id, o.company_id, o.job_id, o.caller, o.ability_key, o.idempotency_key, o.outcome, null::text,
              null::text, null::text, o.at from %I.operations o', app, app);
  end if;
end $$;

create function neos.refresh_desk_operations() returns integer
  language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  keys text[];
  ops text;
begin
  perform pg_advisory_xact_lock(hashtext('neos.refresh_desk_operations'));
  select coalesce(array_agg(key order by key), '{}') into keys
    from neos.apps where status <> 'platform' and key ~ '^[a-z][a-z0-9_]{0,40}$';
  if cardinality(keys) = 0 then
    ops := 'select * from neos.desk_operations(null) where false';
  else
    select string_agg(format('select * from neos.desk_operations(%L)', k), ' union all ') into ops from unnest(keys) k;
  end if;
  drop view if exists neos.v_operations;
  execute 'create view neos.v_operations as ' || ops;
  grant select on neos.v_operations to neos_desk;
  return cardinality(keys);
end $$;

revoke all on function neos.desk_operations(text), neos.refresh_desk_operations() from public;
grant execute on function neos.desk_operations(text) to neos_desk;
grant execute on function neos.refresh_desk_operations() to neos_app;
select neos.refresh_desk_operations();
