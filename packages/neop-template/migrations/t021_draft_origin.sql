-- Opt-in AFTER INSERT trigger for app-owned draft tables and their draft_origins table.
-- The backend sets this transaction-local job reference; no caller-supplied person is accepted.
create function {{schema}}.capture_draft_origin() returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
 co uuid:=nullif(current_setting('neos.company_id',true),'')::uuid;
 job uuid:=nullif(current_setting('neos.draft_origin_job',true),'')::uuid;
 j {{schema}}.jobs%rowtype;
 human text;
 person record;
 role_seen text;
 origin_basis text:='nonhuman';
begin
 if TG_OP<>'INSERT' or co is null or new.company_id is distinct from co or job is null then
  raise exception 'origin_required: a company-scoped creating job is required' using errcode='42501';
 end if;
 perform 1 from {{schema}}.installs where company_id=co and status='active' for share;
 if not found then raise exception 'origin_install: app is not active' using errcode='42501'; end if;
 select * into j from {{schema}}.jobs where company_id=co and id=job for share;
 if not found or j.status not in ('RUNNING','WAITING') then
  raise exception 'origin_job: creating job is missing, foreign or inactive' using errcode='42501';
 end if;
 human:=coalesce(j.on_behalf_of,case when j.requester like 'user:%' then j.requester end);
 if human is not null then
  if human !~ '^user:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
   raise exception 'origin_identity: malformed human identity' using errcode='42501';
  end if;
  for person in select role from {{schema}}.people where company_id=co and user_id=substring(human from 6) order by matrix_id for share loop
   if person.role is null or person.role not in ('admin','member') or (role_seen is not null and role_seen<>person.role) then
    raise exception 'origin_identity: unknown, revoked or conflicting linked roles' using errcode='42501';
   end if;
   role_seen:=person.role; origin_basis:='linked_human';
  end loop;
  -- Same fallback as the presence identity path: represented people need not own a Matrix ID.
  if role_seen is null then
   select role into role_seen from {{schema}}.acted_for where company_id=co and user_id=substring(human from 6) for share;
   if role_seen is null or role_seen not in ('admin','member') then
    raise exception 'origin_identity: human is not currently linked or represented' using errcode='42501';
   end if;
   origin_basis:='represented_human';
  end if;
 end if;
 insert into {{schema}}.draft_origins(draft_id,company_id,job_id,proposer_user_id,basis,input_hash)
 values(new.id,co,job,case when human is null then null else substring(human from 6)::uuid end,origin_basis,new.input_hash);
 return new;
end $$;
revoke all on function {{schema}}.capture_draft_origin() from public;
