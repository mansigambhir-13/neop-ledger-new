-- Both assistants and NEOS blocks read the same reviewed SQL, with explicit tenant predicates and RLS.
create function {{schema}}.read_payroll(p jsonb, kind text) returns jsonb
language plpgsql stable set search_path=pg_catalog,pg_temp as $$
declare rows_ jsonb; ability_ text; company_ uuid := nullif(current_setting('neos.company_id',true),'')::uuid;
begin
  ability_ := case kind when 'settings' then 'wage.settings.get' when 'employees' then 'wage.employees.list'
    when 'timesheets' then 'wage.timesheets.list' when 'runs' then 'wage.payroll.list' when 'payslips' then 'wage.payslips.list' else null end;
  if ability_ is null then raise exception 'undeclared payroll read'; end if;
  if exists(select 1 from {{schema}}.switchboard where company_id=company_ and line=ability_ and (floor='off' or setting='off')) then
    raise exception 'switched_off: %', ability_ using errcode='42501';
  end if;
  if kind='settings' then
    select coalesce(jsonb_agg(jsonb_build_object('currency',currency,'deductions',deductions)),'[]') into rows_ from {{schema}}.settings where company_id=company_;
  elsif kind='employees' then
    select coalesce(jsonb_agg(to_jsonb(x) order by source_id),'[]') into rows_ from
      (select id,source_id,name,comp_type,rate_minor,currency,status from {{schema}}.employees where company_id=company_) x;
  elsif kind='timesheets' then
    select coalesce(jsonb_agg(to_jsonb(x) order by employee_id),'[]') into rows_ from
      (select id,period,employee_id,minutes from {{schema}}.timesheets where company_id=company_ and period=p->>'period') x;
  elsif kind='runs' then
    select coalesce(jsonb_agg(to_jsonb(x) order by prepared_at,id),'[]') into rows_ from
      (select id,period,currency,headcount,gross_minor,deductions_minor,net_minor,input_hash,status,prepared_at,transitioned_at,false as paid
       from {{schema}}.pay_runs where company_id=company_ and (p->>'period' is null or period=p->>'period')) x;
  elsif kind='payslips' then
    select coalesce(jsonb_agg(to_jsonb(x) order by employee_id),'[]') into rows_ from
      (select id,run_id,employee_id,currency,gross_minor,deductions_minor,net_minor,minutes,deduction_capped
       from {{schema}}.payslips where company_id=company_ and run_id=(p->>'run_id')::uuid) x;
  end if;
  return jsonb_build_object('generatedAt',now(),'empty',jsonb_array_length(rows_)=0,
    'sources',jsonb_build_object('entries',jsonb_array_length(rows_),'basis',ability_,'entry_ids',coalesce((select jsonb_agg(v->>'id') from jsonb_array_elements(rows_) v where v ? 'id'),'[]')),
    'rows',rows_);
end $$;
revoke all on function {{schema}}.read_payroll(jsonb,text) from public;
grant execute on function {{schema}}.read_payroll(jsonb,text) to {{schema}}_app,{{schema}}_runner;
create function {{schema}}.read_settings(p jsonb) returns jsonb language sql stable as $$ select {{schema}}.read_payroll(p,'settings') $$;
create function {{schema}}.read_employees(p jsonb) returns jsonb language sql stable as $$ select {{schema}}.read_payroll(p,'employees') $$;
create function {{schema}}.read_timesheets(p jsonb) returns jsonb language sql stable as $$ select {{schema}}.read_payroll(p,'timesheets') $$;
create function {{schema}}.read_runs(p jsonb) returns jsonb language sql stable as $$ select {{schema}}.read_payroll(p,'runs') $$;
create function {{schema}}.read_payslips(p jsonb) returns jsonb language sql stable as $$ select {{schema}}.read_payroll(p,'payslips') $$;
revoke all on function {{schema}}.read_settings(jsonb),{{schema}}.read_employees(jsonb),{{schema}}.read_timesheets(jsonb),{{schema}}.read_runs(jsonb),{{schema}}.read_payslips(jsonb) from public;
grant execute on function {{schema}}.read_settings(jsonb),{{schema}}.read_employees(jsonb),{{schema}}.read_timesheets(jsonb),{{schema}}.read_runs(jsonb),{{schema}}.read_payslips(jsonb) to {{schema}}_app,{{schema}}_runner;
insert into {{schema}}.declared_reads(ability,fn) values
 ('wage.settings.get','read_settings'),('wage.employees.list','read_employees'),('wage.timesheets.list','read_timesheets'),('wage.payroll.list','read_runs'),('wage.payslips.list','read_payslips');
