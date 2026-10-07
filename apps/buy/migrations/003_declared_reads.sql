-- Data-only NEOS blocks and assistant use identical, reviewed, tenant-scoped reads.
create function {{schema}}.read_drafts(p jsonb,kind text) returns jsonb language plpgsql stable set search_path=pg_catalog,pg_temp as $$
declare c uuid:=nullif(current_setting('neos.company_id',true),'')::uuid; rows_ jsonb; ability_ text;
 limit_ integer:=coalesce((p->>'limit')::integer,1000); offset_ integer:=coalesce((p->>'offset')::integer,0); next_ integer:=null;
begin
 if limit_<1 or limit_>1000 or offset_<0 or offset_>1000000 then raise exception 'invalid pagination'; end if;
 ability_:=case kind when 'settings' then 'buy.settings.get' when 'vendors' then 'buy.vendors.list' when 'orders' then 'buy.orders.list' else null end;
 if ability_ is null then raise exception 'undeclared read'; end if;
 if exists(select 1 from {{schema}}.switchboard where company_id=c and line=ability_ and (floor='off' or setting='off')) then raise exception 'switched_off' using errcode='42501'; end if;
 if kind='settings' then
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows_ from (select currency,review_limit_minor from {{schema}}.settings where company_id=c) x;
 elsif kind='vendors' then
  select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') into rows_ from (select id,source_id,name,category,version from {{schema}}.vendors where company_id=c order by id limit limit_+1 offset offset_) x;
 else
  select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') into rows_ from (select id,source_id,vendor_id,amount_minor,currency,description,review_limit_minor,requires_elevated_approval,input_hash,status,created_at,cancelled_at,false as external_completed from {{schema}}.orders where company_id=c order by id limit limit_+1 offset offset_) x;
 end if;
 if jsonb_array_length(rows_)>limit_ then rows_:=rows_-limit_; next_:=offset_+limit_; end if;
 return jsonb_build_object('generatedAt',now(),'empty',jsonb_array_length(rows_)=0,'next_offset',next_,'rows',rows_,
 'sources',jsonb_build_object('entries',jsonb_array_length(rows_),'basis',ability_,'entry_ids',coalesce((select jsonb_agg(r->>'id') from jsonb_array_elements(rows_) r where r?'id'),'[]')));
end $$;
revoke all on function {{schema}}.read_drafts(jsonb,text) from public;
grant execute on function {{schema}}.read_drafts(jsonb,text) to {{schema}}_app,{{schema}}_runner;
create function {{schema}}.read_settings(p jsonb) returns jsonb language sql stable as $$ select {{schema}}.read_drafts(p,'settings') $$;
revoke all on function {{schema}}.read_settings(jsonb) from public;
grant execute on function {{schema}}.read_settings(jsonb) to {{schema}}_app,{{schema}}_runner;
create function {{schema}}.read_vendors(p jsonb) returns jsonb language sql stable as $$ select {{schema}}.read_drafts(p,'vendors') $$;
revoke all on function {{schema}}.read_vendors(jsonb) from public;
grant execute on function {{schema}}.read_vendors(jsonb) to {{schema}}_app,{{schema}}_runner;
create function {{schema}}.read_orders(p jsonb) returns jsonb language sql stable as $$ select {{schema}}.read_drafts(p,'orders') $$;
revoke all on function {{schema}}.read_orders(jsonb) from public;
grant execute on function {{schema}}.read_orders(jsonb) to {{schema}}_app,{{schema}}_runner;
insert into {{schema}}.declared_reads(ability,fn) values ('buy.settings.get','read_settings'),('buy.vendors.list','read_vendors'),('buy.orders.list','read_orders');
