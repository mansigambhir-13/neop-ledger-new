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
