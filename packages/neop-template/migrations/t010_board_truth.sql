-- t010 · template upgrade stream. Expand-only.
-- WP v3 §4 "one table, one truth", §5 standing yeses, §11 the nine standard tables: the switchboard, the
-- installs and the grants stop being read-only mirrors of the platform (t009) and become the truth, here in
-- the app's own schema.
--   · <schema>.switchboard — one row per (company, line). `setting` is now the COMPANY's own switch (t009
--     wrote the effective one; an effective value is never looser than the switch it came from, so the old
--     rows stay safe until the backfill, scripts/v3/backfill-boards.ts, replaces them). The company row
--     `line = '*'` (kind 'company') carries the company's rules, caps (the model budget) and default
--     approver policy; a write line carries its own approver policy in `approvers`. Every change bumps the
--     company's board version (one version per transaction), is kept in switchboard_history and NOTIFYs
--     'board:<company>' on the runner's channel. A tighten-only trigger refuses what the platform refused
--     (setSwitchboard): a setting looser than the manifest floor, an ask-first read, a door or skill line
--     that is not on/off, an approver policy on anything but a write. Only the app's own roles (runner,
--     migrator) may loosen a floor — a new manifest can; the desk cannot.
--   · <schema>.installs — company name and time zone (the gate decides with them), Matrix identity, rooms,
--     agent senders, who installed it; status gains 'removed' (uninstalled) and 'suspended'.
--   · <schema>.grants — limits, expiry, status, why it was suspended, who wrote it; grant_uses records each
--     use (the per-month limit is summed from it). A grant suspends itself when something approved under it
--     ends FAILED or UNKNOWN (a trigger on proposals, whoever wrote the outcome).
--   · SECURITY DEFINER create_grant / revoke_grant / suspend_grant / set_schedule: the desk writes grants and
--     schedules only through them (defaults 6), under its caller's company (row-level security).
--   · neos_desk (v3 §11): DML on switchboard and installs, EXECUTE answer_proposal / create_grant /
--     revoke_grant / set_schedule, SELECT on the grant and board history — granted here when the role exists
--     (pgkit applyDeskGrants repeats it idempotently for a schema migrated before the platform made the role).
--     The app role only reads all of this; the runner may set an install's status and suspend a grant.

-- ── switchboard ──────────────────────────────────────────────────────────
alter table {{schema}}.switchboard add column approvers jsonb check (approvers is null or jsonb_typeof(approvers) = 'object');
alter table {{schema}}.switchboard add column updated_by text check (updated_by is null or length(updated_by) between 1 and 200);
alter table {{schema}}.switchboard drop constraint switchboard_kind_check;
alter table {{schema}}.switchboard add constraint switchboard_kind_check check (kind in ('read', 'write', 'borrowed', 'skill', 'door', 'company'));

create table {{schema}}.switchboard_history (
  id          bigint generated always as identity primary key,
  company_id  uuid not null,
  version     integer not null check (version >= 0),
  line        text not null,
  op          text not null check (op in ('insert', 'update', 'delete')),
  before      jsonb,
  after       jsonb,
  changed_by  text,
  txid        bigint not null default txid_current(),
  at          timestamptz not null default now()
);
create index switchboard_history_company_ix on {{schema}}.switchboard_history (company_id, version);

-- 'on' < 'ask_first' < 'off': the stricter, the higher.
create function {{schema}}.setting_rank(s text) returns integer
language sql immutable as $$ select case s when 'on' then 0 when 'ask_first' then 1 when 'off' then 2 end $$;

-- The board version a change in this transaction lands on: the one this transaction already took for the
-- company, else one past the highest seen (or `given`, when a backfill carries the platform's higher one).
-- Runs as the owner; row-level security is forced on it too, so it scopes itself to the row's company
-- (a caller scoped to another company is refused).
create function {{schema}}.board_version_for(p_company uuid, p_given integer) returns integer
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  cur text := nullif(current_setting('neos.company_id', true), '');
  v integer;
begin
  if cur is null then
    perform set_config('neos.company_id', p_company::text, true);
  elsif cur::uuid <> p_company then
    raise exception 'company_mismatch: this session acts for another company' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('{{schema}}.switchboard'), hashtext(p_company::text));
  select h.version into v from {{schema}}.switchboard_history h
   where h.company_id = p_company and h.txid = txid_current() order by h.id desc limit 1;
  if v is null then
    v := greatest(coalesce((select max(h.version) from {{schema}}.switchboard_history h where h.company_id = p_company), 0),
                  coalesce((select max(s.version) from {{schema}}.switchboard s where s.company_id = p_company), 0)) + 1;
    if p_given is not null and p_given > v then v := p_given; end if;
  end if;
  return v;
end $$;
revoke all on function {{schema}}.board_version_for(uuid, integer) from public;

-- A DBA's exact restore or company purge (pgkit importCompany / purgeCompany): `neos.restore = on`, honoured only
-- when the login is a superuser (the admin link) — anyone may set the variable; only the DBA's link counts.
create function {{schema}}.dba_restore() returns boolean
language sql stable set search_path = pg_catalog, pg_temp as $$
  select coalesce(current_setting('neos.restore', true), '') = 'on'
     and coalesce((select r.rolsuper from pg_roles r where r.rolname = session_user), false)
$$;

-- Tighten-only (mirrors the platform's setSwitchboard exactly). Runs as the caller, so it knows who asks.
create function {{schema}}.switchboard_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  app_side boolean := current_user in ('{{schema}}_runner', '{{schema}}_migrator');
  given integer;
begin
  -- A DBA's exact restore (pgkit importCompany) puts rows back as they were dumped.
  if {{schema}}.dba_restore() then
    return new;
  end if;
  if new.line = '*' then
    new.kind := 'company';
    new.floor := null;
    new.setting := 'on';
    if new.rules is not null and jsonb_typeof(new.rules) <> 'array' then
      raise exception 'bad_rule: rules must be a list' using errcode = '23514';
    end if;
    if new.caps is not null and jsonb_typeof(new.caps) <> 'object' then
      raise exception 'bad_budget: caps must be an object' using errcode = '23514';
    end if;
  else
    if new.kind = 'company' then
      raise exception 'bad_line: only the company row (*) is kind company' using errcode = '23514';
    end if;
    if tg_op = 'UPDATE' and not app_side then
      -- The floor and kind are the app's (its manifest): the desk may never loosen a floor or recast a line.
      if new.kind is distinct from old.kind and old.kind is not null then
        raise exception 'bad_line: %: its kind is the app''s, not the company''s', new.line using errcode = '23514';
      end if;
      if old.floor is not null and (new.floor is null or {{schema}}.setting_rank(new.floor) < {{schema}}.setting_rank(old.floor)) then
        raise exception 'cannot_loosen: %: the app''s floor is %; only the app can change it', new.line, old.floor using errcode = '23514';
      end if;
    end if;
    if new.line like 'door:%' then
      new.kind := 'door';
      if new.setting not in ('on', 'off') then
        raise exception 'bad_setting: %: a door line is on or off', new.line using errcode = '23514';
      end if;
      if new.floor is not null and new.floor not in ('on', 'off') then
        raise exception 'bad_setting: %: a door''s floor is on or off', new.line using errcode = '23514';
      end if;
    elsif new.line like 'skill:%' then
      new.kind := 'skill';
      if new.setting not in ('on', 'off') then
        raise exception 'bad_setting: %: a skill line is on or off', new.line using errcode = '23514';
      end if;
    elsif new.kind = 'read' and new.setting = 'ask_first' then
      raise exception 'read_cannot_ask_first: % is a read: it can be on or off, not ask-first', new.line using errcode = '23514';
    end if;
    if new.floor is not null and {{schema}}.setting_rank(new.setting) < {{schema}}.setting_rank(new.floor) then
      raise exception 'cannot_loosen: %: the app''s floor is %; a company can only tighten it', new.line, new.floor using errcode = '23514';
    end if;
    if new.approvers is not null and new.kind is distinct from 'write' then
      raise exception 'bad_policy: %: an approver policy belongs to a write', new.line using errcode = '23514';
    end if;
    if new.caps is not null and jsonb_typeof(new.caps) <> 'object' then
      raise exception 'bad_budget: caps must be an object' using errcode = '23514';
    end if;
  end if;
  given := case when tg_op = 'INSERT' then new.version when new.version is distinct from old.version then new.version end;
  new.version := {{schema}}.board_version_for(new.company_id, given);
  new.updated_at := now();
  return new;
end $$;

-- Every change kept and announced. Runs as the owner (the history is not the desk's to write).
create function {{schema}}.switchboard_log() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  co uuid := coalesce(new.company_id, old.company_id);
  v integer;
begin
  -- A DBA's exact restore or company purge (pgkit importCompany / purgeCompany) carries its own history.
  if {{schema}}.dba_restore() then
    return null;
  end if;
  v := case when tg_op = 'DELETE' then {{schema}}.board_version_for(old.company_id, null) else new.version end;
  insert into {{schema}}.switchboard_history (company_id, version, line, op, before, after, changed_by)
  values (co, v, coalesce(new.line, old.line), lower(tg_op),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end,
          left(coalesce(case when tg_op <> 'DELETE' then new.updated_by end, nullif(current_setting('neos.actor', true), ''), session_user::text), 200));
  perform pg_notify('neop_{{schema}}', 'board:' || co::text);
  return null;
end $$;
revoke all on function {{schema}}.switchboard_log() from public;

create trigger switchboard_guard before insert or update on {{schema}}.switchboard
  for each row execute function {{schema}}.switchboard_guard();
create trigger switchboard_log after insert or update or delete on {{schema}}.switchboard
  for each row execute function {{schema}}.switchboard_log();

-- ── installs ─────────────────────────────────────────────────────────────
alter table {{schema}}.installs add column company_name text check (company_name is null or length(company_name) between 1 and 200);
alter table {{schema}}.installs add column time_zone text check (time_zone is null or length(time_zone) between 1 and 64);
alter table {{schema}}.installs add column room_ids text[] not null default '{}';
alter table {{schema}}.installs add column agent_senders text[] not null default '{}';
alter table {{schema}}.installs add column installed_by text check (installed_by is null or length(installed_by) between 1 and 200);
alter table {{schema}}.installs add column installed_at timestamptz;
alter table {{schema}}.installs drop constraint installs_status_check;
alter table {{schema}}.installs add constraint installs_status_check check (status in ('active', 'not_installed', 'removed', 'suspended'));

-- ── grants ───────────────────────────────────────────────────────────────
alter table {{schema}}.grants add column created_by text check (created_by is null or length(created_by) between 1 and 200);
alter table {{schema}}.grants add column created_at timestamptz not null default now();
alter table {{schema}}.grants add column suspended_reason text check (suspended_reason is null or length(suspended_reason) <= 1000);
alter table {{schema}}.grants add column revoked_by text check (revoked_by is null or length(revoked_by) between 1 and 200);

-- One row per use of a standing yes: what it approved, for how much. The per-month limit sums this.
create table {{schema}}.grant_uses (
  id            bigint generated always as identity primary key,
  company_id    uuid not null,
  grant_id      uuid not null,
  proposal_id   uuid not null unique,
  job_id        uuid,
  ability_key   text not null,
  fingerprint   text,
  amount_minor  bigint check (amount_minor is null or amount_minor >= 0),
  currency      text check (currency is null or currency ~ '^[A-Z]{3}$'),
  at            timestamptz not null default now()
);
create index grant_uses_grant_ix on {{schema}}.grant_uses (grant_id, at);

-- A change to the lines, the install or a grant tells the gate to drop its cached board (the poll stays the truth).
create function {{schema}}.board_notify() returns trigger
language plpgsql as $$
begin
  perform pg_notify('neop_{{schema}}', 'board:' || coalesce(new.company_id, old.company_id)::text);
  return null;
end $$;
create trigger installs_notify after insert or update or delete on {{schema}}.installs
  for each row execute function {{schema}}.board_notify();
create trigger grants_notify after insert or update or delete on {{schema}}.grants
  for each row execute function {{schema}}.board_notify();

-- A standing yes suspends itself the moment something approved under it goes wrong (FAILED or UNKNOWN),
-- in the same transaction that wrote the outcome, whoever wrote it.
create function {{schema}}.grant_self_suspend() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if nullif(current_setting('neos.company_id', true), '') is null then
    perform set_config('neos.company_id', new.company_id::text, true);
  end if;
  update {{schema}}.grants
     set status = 'SUSPENDED', suspended_reason = 'execution ' || new.status || ' for proposal ' || new.id::text, updated_at = now()
   where company_id = new.company_id and grant_id = new.grant_id and status = 'ACTIVE';
  if found then
    insert into {{schema}}.proposal_events (company_id, proposal_id, event, actor, detail)
    values (new.company_id, new.id, 'grant_suspended', 'grant:' || new.grant_id::text, jsonb_build_object('grant_id', new.grant_id, 'outcome', new.status));
  end if;
  return null;
end $$;
revoke all on function {{schema}}.grant_self_suspend() from public;
create trigger proposals_grant_self_suspend after update of status on {{schema}}.proposals
  for each row when (new.status in ('FAILED', 'UNKNOWN') and old.status is distinct from new.status and new.approved_via = 'grant' and new.grant_id is not null)
  execute function {{schema}}.grant_self_suspend();

-- ── the desk's functions (SECURITY DEFINER, under the caller's company) ──
-- create_grant(ability, limits, expires_at, user:<id>[, id]) → the grant's id. Limits: per_call_minor /
-- per_month_minor (positive whole minor units, with a currency), currency, recipients_allow (emails).
create function {{schema}}.create_grant(p_ability text, p_limits jsonb, p_expires_at timestamptz, p_by text, p_id uuid default null)
returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  co uuid := nullif(current_setting('neos.company_id', true), '')::uuid;
  gid uuid := coalesce(p_id, gen_random_uuid());
  k text;
  lim jsonb := coalesce(p_limits, '{}'::jsonb);
begin
  if co is null then raise exception 'bad_request: no company in this session' using errcode = '22023'; end if;
  if p_by is null or p_by !~ '^user:.+' then
    raise exception 'bad_request: a standing yes is written by a person (user:<id>)' using errcode = '22023';
  end if;
  if p_ability is null or p_ability !~ '^[a-z][a-z0-9_.]{0,120}$' then
    raise exception 'bad_request: ability' using errcode = '22023';
  end if;
  if jsonb_typeof(lim) <> 'object' then raise exception 'bad_limits: limits must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(lim) loop
    if k not in ('per_call_minor', 'per_month_minor', 'currency', 'recipients_allow') then
      raise exception 'bad_limits: unknown limit %', k using errcode = '22023';
    end if;
  end loop;
  foreach k in array array['per_call_minor', 'per_month_minor'] loop
    if lim ? k and not (jsonb_typeof(lim->k) = 'number' and (lim->>k)::numeric = trunc((lim->>k)::numeric) and (lim->>k)::numeric > 0) then
      raise exception 'bad_limits: % must be a positive whole number of minor units', k using errcode = '22023';
    end if;
  end loop;
  if (lim ? 'per_call_minor' or lim ? 'per_month_minor') and coalesce(lim->>'currency', '') !~ '^[A-Z]{3}$' then
    raise exception 'bad_limits: an amount limit needs a currency' using errcode = '22023';
  end if;
  if lim ? 'recipients_allow' and not (jsonb_typeof(lim->'recipients_allow') = 'array'
       and not exists (select 1 from jsonb_array_elements(lim->'recipients_allow') e where jsonb_typeof(e) <> 'string' or e #>> '{}' !~ '@')) then
    raise exception 'bad_limits: recipients_allow must list email addresses' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '366 days' then
    raise exception 'bad_expiry: a standing yes must expire within a year' using errcode = '22023';
  end if;
  if exists (select 1 from {{schema}}.switchboard s where s.company_id = co and s.line = p_ability and s.kind is distinct from 'write') then
    raise exception 'not_grantable: a standing yes covers one write ability of the app' using errcode = '22023';
  end if;
  insert into {{schema}}.grants (company_id, grant_id, ability_key, limits, expires_at, status, created_by, created_at, updated_at)
  values (co, gid, p_ability, lim, p_expires_at, 'ACTIVE', p_by, now(), now());
  return gid;
end $$;

-- revoke_grant(id, user:<id>) → {status, changed}. Raises not_found (P0002) for a grant this company never had.
create function {{schema}}.revoke_grant(p_id uuid, p_by text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  g {{schema}}.grants%rowtype;
begin
  if p_by is null or p_by !~ '^user:.+' then
    raise exception 'bad_request: a standing yes is withdrawn by a person (user:<id>)' using errcode = '22023';
  end if;
  select * into g from {{schema}}.grants where grant_id = p_id for update;
  if not found then raise exception 'not_found: no such standing yes' using errcode = 'P0002'; end if;
  if g.status = 'REVOKED' then return jsonb_build_object('status', g.status, 'changed', false, 'ability_key', g.ability_key); end if;
  update {{schema}}.grants set status = 'REVOKED', revoked_by = p_by, updated_at = now() where grant_id = p_id and company_id = g.company_id;
  return jsonb_build_object('status', 'REVOKED', 'changed', true, 'ability_key', g.ability_key);
end $$;

-- suspend_grant(id, reason) → true when it was ACTIVE and is now SUSPENDED (the runner's self-suspend).
create function {{schema}}.suspend_grant(p_id uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  update {{schema}}.grants set status = 'SUSPENDED', suspended_reason = left(coalesce(p_reason, 'suspended'), 1000), updated_at = now()
   where grant_id = p_id and status = 'ACTIVE';
  return found;
end $$;

-- import_grant(grant, uses) → true when anything was written. The backfill's one way in (scripts/v3/backfill-boards.ts,
-- the platform at registerApp/installApp): a standing yes the platform held before S1, exactly as it stood
-- (status, expiry and who wrote it kept), and its recorded uses. A grant already here keeps what it has —
-- except a t009 mirror row (no author), which is completed. Idempotent.
create function {{schema}}.import_grant(p_grant jsonb, p_uses jsonb default '[]') returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  co uuid := nullif(current_setting('neos.company_id', true), '')::uuid;
  gid uuid := (p_grant->>'grant_id')::uuid;
  n integer := 0;
  m integer;
begin
  if co is null then raise exception 'bad_request: no company in this session' using errcode = '22023'; end if;
  if gid is null or coalesce(p_grant->>'ability_key', '') = '' or p_grant->>'status' not in ('ACTIVE', 'SUSPENDED', 'REVOKED') then
    raise exception 'bad_request: grant_id, ability_key and status are required' using errcode = '22023';
  end if;
  insert into {{schema}}.grants as g (company_id, grant_id, ability_key, limits, expires_at, status, created_by, created_at, suspended_reason, updated_at)
  values (co, gid, p_grant->>'ability_key', coalesce(p_grant->'limits', '{}'::jsonb), (p_grant->>'expires_at')::timestamptz, p_grant->>'status',
          p_grant->>'created_by', coalesce((p_grant->>'created_at')::timestamptz, now()), p_grant->>'suspended_reason', now())
  on conflict (company_id, grant_id) do update
    set ability_key = excluded.ability_key, limits = excluded.limits, expires_at = excluded.expires_at, status = excluded.status,
        created_by = excluded.created_by, created_at = excluded.created_at, suspended_reason = excluded.suspended_reason, updated_at = now()
    where g.created_by is null;
  get diagnostics n = row_count;
  insert into {{schema}}.grant_uses (company_id, grant_id, proposal_id, job_id, ability_key, fingerprint, amount_minor, currency, at)
  select co, gid, (u->>'proposal_id')::uuid, case when u->>'job_id' ~ '^[0-9a-fA-F-]{36}$' then (u->>'job_id')::uuid end, coalesce(u->>'ability_key', p_grant->>'ability_key'), u->>'fingerprint',
         (u->>'amount_minor')::bigint, u->>'currency', coalesce((u->>'at')::timestamptz, now())
    from jsonb_array_elements(coalesce(p_uses, '[]'::jsonb)) u
   where u->>'proposal_id' ~ '^[0-9a-fA-F-]{36}$'
  on conflict (proposal_id) do nothing;
  get diagnostics m = row_count;
  return n + m > 0;
end $$;

-- set_schedule(id|null, ask, user:<id>|app:<key>, rule, enabled) → the schedule row. The company's time zone
-- comes from its install; the next run is computed in it.
create function {{schema}}.set_schedule(p_id uuid, p_ask text, p_requester text, p_rule jsonb, p_enabled boolean default true)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  co uuid := nullif(current_setting('neos.company_id', true), '')::uuid;
  tz text;
  r {{schema}}.schedules%rowtype;
  en boolean := coalesce(p_enabled, true);
begin
  if co is null then raise exception 'bad_request: no company in this session' using errcode = '22023'; end if;
  select i.time_zone into tz from {{schema}}.installs i where i.company_id = co and i.status = 'active';
  if not found then raise exception 'not_installed: this app is not installed for the company' using errcode = '55000'; end if;
  if tz is null then raise exception 'not_installed: the install has no time zone' using errcode = '55000'; end if;
  if p_id is not null then
    update {{schema}}.schedules
       set ask = p_ask, requester = p_requester, rule = p_rule, time_zone = tz, enabled = en,
           next_run_at = case when en then {{schema}}.next_run(p_rule, tz, now()) end, updated_at = now()
     where id = p_id
    returning * into r;
    if not found then raise exception 'not_found: no such schedule' using errcode = 'P0002'; end if;
  else
    insert into {{schema}}.schedules (company_id, ask, requester, rule, time_zone, enabled, next_run_at)
    values (co, p_ask, p_requester, p_rule, tz, en, case when en then {{schema}}.next_run(p_rule, tz, now()) end)
    returning * into r;
  end if;
  return to_jsonb(r);
end $$;

-- ── who may do what ──────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['switchboard_history', 'grant_uses'] loop
    execute format('alter table {{schema}}.%I enable row level security', t);
    execute format('alter table {{schema}}.%I force row level security', t);
    execute format(
      'create policy company_isolation on {{schema}}.%I using (company_id = nullif(current_setting(''neos.company_id'', true), '''')::uuid) with check (company_id = nullif(current_setting(''neos.company_id'', true), '''')::uuid)',
      t);
  end loop;
end $$;
-- The app role reads the board, the installs and the grants; it records a grant's use, nothing more.
revoke insert, update, delete on {{schema}}.switchboard_history from {{schema}}_app;
grant select on {{schema}}.switchboard_history to {{schema}}_app, {{schema}}_runner;
revoke update, delete on {{schema}}.grant_uses from {{schema}}_app;
grant select, insert on {{schema}}.grant_uses to {{schema}}_app;
grant select on {{schema}}.grant_uses to {{schema}}_runner;
-- The runner no longer copies the platform: it may re-stamp the app's own floors after a new manifest, set an
-- install's status, and suspend a grant (suspend_grant); it writes nothing else here.
revoke insert, update, delete on {{schema}}.switchboard, {{schema}}.installs, {{schema}}.grants from {{schema}}_runner;
grant update (kind, floor, setting, version, updated_at, updated_by) on {{schema}}.switchboard to {{schema}}_runner;
grant update (status, updated_at) on {{schema}}.installs to {{schema}}_runner;
revoke all on function {{schema}}.create_grant(text, jsonb, timestamptz, text, uuid), {{schema}}.revoke_grant(uuid, text),
  {{schema}}.suspend_grant(uuid, text), {{schema}}.set_schedule(uuid, text, text, jsonb, boolean), {{schema}}.import_grant(jsonb, jsonb) from public;
grant execute on function {{schema}}.suspend_grant(uuid, text), {{schema}}.board_version_for(uuid, integer) to {{schema}}_runner;
-- The desk (v3 §11), when the platform has made its role.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'neos_desk') then
    grant usage on schema {{schema}} to neos_desk;
    grant select, insert, update, delete on {{schema}}.switchboard, {{schema}}.installs to neos_desk;
    grant select on {{schema}}.switchboard_history, {{schema}}.grants, {{schema}}.grant_uses to neos_desk;
    grant execute on function {{schema}}.answer_proposal(uuid, text, text, text, text), {{schema}}.create_grant(text, jsonb, timestamptz, text, uuid),
      {{schema}}.revoke_grant(uuid, text), {{schema}}.set_schedule(uuid, text, text, jsonb, boolean),
      {{schema}}.board_version_for(uuid, integer), {{schema}}.import_grant(jsonb, jsonb) to neos_desk;
  end if;
end $$;
