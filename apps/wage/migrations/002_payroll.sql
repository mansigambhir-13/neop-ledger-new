-- First V3 Wage schema. Money is bounded integer minor units, time is integer minutes.
create table {{schema}}.settings (
  company_id uuid primary key,
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  deductions jsonb not null default '[]' check(jsonb_typeof(deductions)='array')
);
create table {{schema}}.employees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  source_id text not null check(length(source_id) between 1 and 64),
  name text not null check(length(trim(name)) between 1 and 200),
  comp_type text not null check(comp_type in ('salary','hourly')),
  rate_minor bigint not null check(rate_minor between 0 and 1000000000000),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  status text not null check(status in ('active','terminated')),
  unique(company_id,id), unique(company_id,source_id)
);
create table {{schema}}.timesheets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  period text not null check(period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  employee_id uuid not null,
  minutes integer not null check(minutes between 0 and 60000),
  unique(company_id,period,employee_id),
  foreign key(company_id,employee_id) references {{schema}}.employees(company_id,id)
);
create table {{schema}}.pay_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  period text not null check(period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  headcount integer not null check(headcount > 0),
  gross_minor bigint not null check(gross_minor between 0 and 1000000000000),
  deductions_minor bigint not null check(deductions_minor between 0 and gross_minor),
  net_minor bigint not null check(net_minor = gross_minor - deductions_minor),
  input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
  input_snapshot jsonb not null check(jsonb_typeof(input_snapshot)='object'),
  status text not null default 'prepared' check(status in ('prepared','released','superseded')),
  reference text not null,
  prepared_at timestamptz not null default now(),
  transition_ref text,
  transitioned_at timestamptz,
  unique(company_id,id), unique(company_id,reference),
  check((status='prepared' and transition_ref is null and transitioned_at is null) or
        (status<>'prepared' and transition_ref is not null and transitioned_at is not null))
);
create unique index one_current_run on {{schema}}.pay_runs(company_id,period) where status <> 'superseded';
create table {{schema}}.payslips (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  run_id uuid not null,
  employee_id uuid not null,
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  gross_minor bigint not null check(gross_minor between 0 and 1000000000000),
  deductions_minor bigint not null check(deductions_minor between 0 and gross_minor),
  net_minor bigint not null check(net_minor = gross_minor - deductions_minor),
  minutes integer check(minutes between 0 and 60000),
  deduction_capped boolean not null,
  unique(company_id,run_id,employee_id),
  foreign key(company_id,run_id) references {{schema}}.pay_runs(company_id,id),
  foreign key(company_id,employee_id) references {{schema}}.employees(company_id,id)
);
create table {{schema}}.write_receipts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  reference text not null,
  request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
  result jsonb not null,
  recorded_at timestamptz not null default now(),
  unique(company_id,reference)
);
create function {{schema}}.immutable_payroll_record() returns trigger language plpgsql as $$
begin raise exception 'payroll records are immutable; use a new revision'; end $$;
create trigger immutable_receipt before update or delete on {{schema}}.write_receipts for each row execute function {{schema}}.immutable_payroll_record();
create trigger immutable_payslip before update or delete on {{schema}}.payslips for each row execute function {{schema}}.immutable_payroll_record();
create function {{schema}}.payroll_transition() returns trigger language plpgsql as $$
begin
  if TG_OP='DELETE' then raise exception 'payroll runs cannot be deleted'; end if;
  if old.status <> 'prepared' or new.status not in ('released','superseded') or
     (to_jsonb(new) - array['status','transition_ref','transitioned_at']) is distinct from
     (to_jsonb(old) - array['status','transition_ref','transitioned_at']) then
    raise exception 'invalid payroll transition or mutation of approved content';
  end if;
  return new;
end $$;
create trigger checked_run_transition before update or delete on {{schema}}.pay_runs for each row execute function {{schema}}.payroll_transition();
do $$ declare t text; begin
  foreach t in array array['settings','employees','timesheets','pay_runs','payslips','write_receipts'] loop
    execute format('alter table {{schema}}.%I enable row level security',t);
    execute format('alter table {{schema}}.%I force row level security',t);
    execute format('create policy company_isolation on {{schema}}.%I using(company_id=nullif(current_setting(''neos.company_id'',true),'''')::uuid) with check(company_id=nullif(current_setting(''neos.company_id'',true),'''')::uuid)',t);
  end loop;
end $$;
