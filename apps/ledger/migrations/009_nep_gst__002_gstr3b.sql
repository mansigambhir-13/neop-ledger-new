-- 009_nep_gst__002_gstr3b.sql · installed by `neos install` from nep-gst@2.0.0 (migrations/002_gstr3b.sql; artifact sha256:ebb7f64fe51584354404c146b25fb316d98f81f42aa04a492d177a84242c5b24).
-- The package's own SQL, applied once with the host's migrations. A book where the pre-v3 runtime installer already
-- ran it (schema_migrations row 'nep-gst@<version>/002_gstr3b.sql') keeps what it has: the SQL is skipped there.
-- Its tables are the package's: the package role writes them (granted after migrating), the host role only reads them.
do $neos_install$
begin
  if exists (select 1 from {{schema}}.schema_migrations where name like 'nep-gst@%/002_gstr3b.sql') then return; end if;
  execute $neos_pkg$
-- 2.0.0: the return is the GSTN GSTR-3B document built from the books, saved on
-- the portal before it is filed. Figures stay in minor units beside the document.
alter table {{schema}}.nep_gst_returns
  add column gstin            text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  add column ret_period       text check (ret_period is null or ret_period ~ '^(0[1-9]|1[0-2])[0-9]{4}$'),
  add column taxable_minor    bigint check (taxable_minor is null or taxable_minor >= 0),
  add column payload          jsonb,
  add column payload_sha256   text,
  add column split_basis      text,
  add column sources          jsonb,
  add column gsp_ref          text,
  add column gsp_status       text;
alter table {{schema}}.nep_gst_returns drop constraint nep_gst_returns_status_check;
alter table {{schema}}.nep_gst_returns add constraint nep_gst_returns_status_check
  check (status in ('draft', 'saved', 'filed', 'superseded'));
-- One filed GSTR-3B per company and month.
create unique index nep_gst_returns_one_filed on {{schema}}.nep_gst_returns (company_id, period) where status = 'filed';
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
