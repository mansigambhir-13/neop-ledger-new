-- 008_nep_gst__001_returns.sql · installed by `neos install` from nep-gst@2.0.0 (migrations/001_returns.sql; artifact sha256:ebb7f64fe51584354404c146b25fb316d98f81f42aa04a492d177a84242c5b24).
-- The package's own SQL, applied once with the host's migrations. A book where the pre-v3 runtime installer already
-- ran it (schema_migrations row 'nep-gst@<version>/001_returns.sql') keeps what it has: the SQL is skipped there.
-- Its tables are the package's: the package role writes them (granted after migrating), the host role only reads them.
do $neos_install$
begin
  if exists (select 1 from {{schema}}.schema_migrations where name like 'nep-gst@%/001_returns.sql') then return; end if;
  execute $neos_pkg$
create table {{schema}}.nep_gst_returns (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null,
  period                text not null check (period ~ '^\d{4}-\d{2}$'),
  currency              char(3) not null,
  output_tax_minor      bigint not null check (output_tax_minor >= 0),
  input_tax_minor       bigint not null check (input_tax_minor >= 0),
  net_payable_minor     bigint not null check (net_payable_minor >= 0),
  credit_carried_minor  bigint not null check (credit_carried_minor >= 0),
  status                text not null default 'draft' check (status in ('draft', 'filed')),
  reference             text not null,
  ack_ref               text,
  created_at            timestamptz not null default now(),
  unique (company_id, reference)
);
alter table {{schema}}.nep_gst_returns enable row level security;
alter table {{schema}}.nep_gst_returns force row level security;
create policy company_isolation on {{schema}}.nep_gst_returns
  using (company_id = nullif(current_setting('neos.company_id', true), '')::uuid)
  with check (company_id = nullif(current_setting('neos.company_id', true), '')::uuid);
$neos_pkg$;
end
$neos_install$;
do $neos_grants$
declare t text;
begin
  foreach t in array array['nep_gst_returns']::text[] loop
    if to_regclass('{{schema}}.' || t) is not null then
      execute format('revoke insert, update, delete on {{schema}}.%I from {{schema}}_app', t);
      execute format('grant select on {{schema}}.%I to {{schema}}_app', t);
    end if;
  end loop;
end
$neos_grants$;
