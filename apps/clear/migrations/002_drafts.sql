-- Clear: internal draft records only. No external-success or business-approval state.
create table {{schema}}.settings(company_id uuid primary key,case_score bigint not null check(case_score between 0 and 100),sar_score bigint not null check(sar_score between 0 and 100));
create table {{schema}}.subjects (
 id uuid primary key,company_id uuid not null,source_id text not null check(source_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
 name text not null check(length(trim(name)) between 1 and 200),category text check(length(trim(category)) between 1 and 120),
 version integer not null default 1 check(version>0),unique(company_id,id),unique(company_id,source_id)
);
create table {{schema}}.assessments(
 id uuid primary key,company_id uuid not null,
 source_id text not null check(length(source_id)<=64 and length(trim(source_id))>=1 and source_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
 subject_id uuid not null,
 sanctions boolean,
 pep boolean,
 adverse boolean,
 evidence_reference text not null check(length(evidence_reference)<=500 and length(trim(evidence_reference))>=1),
 requires_elevated_approval boolean,
 score bigint check(score between 0 and 100),
 rating text check(rating in ('low','medium','high')),
 case_draft boolean,
 sar_draft boolean,
 assessment_status text not null check(assessment_status in ('needs_evidence','review_only')),
 input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),source_snapshot jsonb not null check(jsonb_typeof(source_snapshot)='object'),
 reference text not null,status text not null default 'draft' check(status in ('draft','cancelled')),
 created_at timestamptz not null default now(),cancelled_at timestamptz,cancel_ref text,
 unique(company_id,id),unique(company_id,source_id),unique(company_id,reference),
 foreign key(company_id,subject_id) references {{schema}}.subjects(company_id,id),
 check((status='draft' and cancelled_at is null and cancel_ref is null) or (status='cancelled' and cancelled_at is not null and cancel_ref is not null))
);
create table {{schema}}.write_receipts (
 id uuid primary key,company_id uuid not null,reference text not null,request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 result jsonb not null,recorded_at timestamptz not null default now(),unique(company_id,reference)
);
create function {{schema}}.immutable_receipt() returns trigger language plpgsql as $$ begin raise exception 'immutable transaction receipt'; end $$;
create trigger receipt_immutable before update or delete on {{schema}}.write_receipts for each row execute function {{schema}}.immutable_receipt();
create function {{schema}}.checked_draft_transition() returns trigger language plpgsql as $$ begin
 if TG_OP='DELETE' then raise exception 'draft history cannot be deleted'; end if;
 if old.status<>'draft' or new.status<>'cancelled' or
 (to_jsonb(new)-array['status','cancelled_at','cancel_ref']) is distinct from (to_jsonb(old)-array['status','cancelled_at','cancel_ref']) then
 raise exception 'immutable draft or invalid transition'; end if; return new;
end $$;
create trigger draft_immutable before update or delete on {{schema}}.assessments for each row execute function {{schema}}.checked_draft_transition();
do $$ declare t text; begin foreach t in array array['settings','subjects','assessments','write_receipts'] loop
 execute format('alter table {{schema}}.%I enable row level security',t);
 execute format('alter table {{schema}}.%I force row level security',t);
 execute format('create policy company_isolation on {{schema}}.%I using(company_id=nullif(current_setting(''neos.company_id'',true),'''')::uuid) with check(company_id=nullif(current_setting(''neos.company_id'',true),'''')::uuid)',t);
end loop; end $$;
