-- Forward-only: existing drafts remain without an origin row. Never infer their original human.
create table {{schema}}.draft_origins (
 draft_id uuid primary key,company_id uuid not null,job_id uuid not null references {{schema}}.jobs(id),
 proposer_user_id uuid,basis text not null check(basis in ('linked_human','represented_human','nonhuman')),
 input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),recorded_at timestamptz not null default clock_timestamp(),
 foreign key(company_id,draft_id) references {{schema}}.quotes(company_id,id),
 check((basis='nonhuman')=(proposer_user_id is null))
);
create index draft_origins_subject_ix on {{schema}}.draft_origins(company_id,proposer_user_id);
create index draft_origins_job_ix on {{schema}}.draft_origins(job_id);
alter table {{schema}}.draft_origins enable row level security;
alter table {{schema}}.draft_origins force row level security;
create policy company_isolation on {{schema}}.draft_origins
 using(company_id=nullif(current_setting('neos.company_id',true),'')::uuid)
 with check(company_id=nullif(current_setting('neos.company_id',true),'')::uuid);
revoke all on {{schema}}.draft_origins from {{schema}}_app,{{schema}}_runner;
grant select on {{schema}}.draft_origins to {{schema}}_app;
-- Reuse the app's immutable-history guard; even owner writes cannot silently rewrite provenance.
create trigger origin_immutable before update or delete on {{schema}}.draft_origins
 for each row execute function {{schema}}.immutable_receipt();
create trigger draft_origin after insert on {{schema}}.quotes
 for each row execute function {{schema}}.capture_draft_origin();
