-- Opt-in execution-time guard for internal writes. Existing answer_proposal is unchanged.
-- Call in the SAME transaction as the app write and its receipt; this function never performs the effect.
create function {{schema}}.check_human_authority(p_job uuid, p_reference text, p_ability text, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
 co uuid := nullif(current_setting('neos.company_id', true), '')::uuid;
 p {{schema}}.proposals%rowtype;
 j {{schema}}.jobs%rowtype;
 e record;
 person record;
 requested text;
 pol jsonb;
 role_seen text;
 requester_seen boolean := false;
 approver_seen boolean := false;
 board_version integer;
begin
 if co is null or p_job is null or p_reference is null or p_ability is null or p_args is null then
  raise exception 'authority_required: a company-scoped approved job is required' using errcode='42501';
 end if;
 -- Same company lock used by board_version_for, including insertion/deletion of policy rows.
 -- Do not row-lock switchboard: its trigger takes this lock AFTER its row lock.
 perform pg_advisory_xact_lock(hashtext('{{schema}}.switchboard'), hashtext(co::text));
 perform 1 from {{schema}}.installs where company_id=co and status='active' for share;
 if not found then raise exception 'authority_install: app is not active' using errcode='42501'; end if;
 select * into p from {{schema}}.proposals
  where company_id=co and job_id=p_job and idempotency_key=p_reference and ability_key=p_ability for share;
 if not found or p.status<>'EXECUTING' or p.approved_via is distinct from 'person'
    or p.args is distinct from p_args or p.decided_by is null or p.decided_by !~ '^user:[0-9a-fA-F-]{36}$' then
  raise exception 'authority_required: executing exact-content human approval is required' using errcode='42501';
 end if;
 select actor,fingerprint_seen into e from {{schema}}.proposal_events
  where company_id=co and proposal_id=p.id and event='answered:yes' order by id desc limit 1;
 if not found or e.actor is distinct from p.decided_by or e.fingerprint_seen is distinct from p.fingerprint then
  raise exception 'authority_evidence: approving actor or fingerprint does not match' using errcode='42501';
 end if;
 select * into j from {{schema}}.jobs where company_id=co and id=p_job for share;
 requested := coalesce(j.on_behalf_of, j.requester);
 if not found or j.status not in ('WAITING','RUNNING') or requested is null or requested !~ '^user:[0-9a-fA-F-]{36}$' then
  raise exception 'authority_requester: no human requester is on record' using errcode='42501';
 end if;
 -- Linked people are platform-maintained; the app cannot invent them. A room link does not require
 -- chat_person (that flag only controls DMs). Lock aliases in stable order until the record commit.
 for person in select * from {{schema}}.people
  where company_id=co and ('user:'||user_id) in (requested,p.decided_by) order by matrix_id for share loop
  if person.role is null or person.role not in ('admin','member') then
   raise exception 'authority_identity: unknown or revoked human role' using errcode='42501';
  end if;
  if 'user:'||person.user_id=requested then requester_seen:=true; end if;
  if 'user:'||person.user_id=p.decided_by then
   if role_seen is not null and role_seen<>person.role then
    raise exception 'authority_identity: conflicting linked roles' using errcode='42501';
   end if;
   approver_seen:=true; role_seen:=person.role;
  end if;
 end loop;
 if not requester_seen or not approver_seen then
  raise exception 'authority_identity: requester or approver is no longer linked' using errcode='42501';
 end if;
 select approvers into pol from {{schema}}.switchboard where company_id=co and line=p_ability and approvers is not null;
 if pol is null then select approvers into pol from {{schema}}.switchboard where company_id=co and line='*'; end if;
 pol:=coalesce(pol,'{}'::jsonb);
 if jsonb_typeof(pol)<>'object' or (pol-array['roles','four_eyes'])<>'{}'::jsonb
  or (pol ? 'four_eyes' and jsonb_typeof(pol->'four_eyes')<>'boolean')
  or (pol ? 'roles' and jsonb_typeof(pol->'roles')<>'array') then
  raise exception 'authority_policy: malformed approver policy' using errcode='42501';
 end if;
 if pol ? 'roles' then
  if exists(select 1 from jsonb_array_elements(pol->'roles') r where r not in ('"admin"'::jsonb,'"member"'::jsonb)) then
   raise exception 'authority_policy: unknown approver role' using errcode='42501';
  end if;
  if jsonb_array_length(pol->'roles')>0 and not (pol->'roles' ? role_seen) then
   raise exception 'authority_role: approver no longer meets the company policy' using errcode='42501';
  end if;
 end if;
 if coalesce((pol->>'four_eyes')::boolean,false) and requested=p.decided_by then
  raise exception 'authority_four_eyes: requester cannot approve their own change' using errcode='42501';
 end if;
 if exists(select 1 from {{schema}}.switchboard where company_id=co and line=p_ability and setting='off') then
  raise exception 'authority_switched_off: write was disabled' using errcode='42501';
 end if;
 select greatest(coalesce((select max(version) from {{schema}}.switchboard where company_id=co),0),
                 coalesce((select max(version) from {{schema}}.switchboard_history where company_id=co),0)) into board_version;
 -- All potentially blocking authority locks must be acquired before checking the wall clock.
 if p.expires_at<=clock_timestamp() then raise exception 'authority_expired: approval expired' using errcode='42501'; end if;
 -- Identities already live in the proposal/job; receipts retain a reference, not another personal-data copy.
 return jsonb_build_object('proposal_id',p.id,'fingerprint',p.fingerprint,'ability_version',p.ability_version,
  'approver_role',role_seen,'policy',pol,'board_version',board_version);
end $$;
revoke all on function {{schema}}.check_human_authority(uuid,text,text,jsonb) from public;
grant execute on function {{schema}}.check_human_authority(uuid,text,text,jsonb) to {{schema}}_app;
