-- 005_inherited.sql · bookkeeping inherited from the earlier Ledger
-- (docs/INHERITED-FROM-SHIV.md): the company's bookkeeping profile — tax regime,
-- aging buckets, cash-forecast horizon and buffer, chase cadence — and a note on
-- bank lines set aside. Money in minor units; RLS on every row.

create table {{schema}}.settings (
  company_id              uuid primary key,
  tax_regime              text not null default 'IN_GST' check (tax_regime in ('IN_GST', 'UK_VAT', 'EU_VAT', 'US_SALES_TAX', 'none')),
  return_frequency        text not null default 'monthly' check (return_frequency in ('monthly', 'quarterly')),
  fiscal_year_start_month integer not null default 4 check (fiscal_year_start_month between 1 and 12),
  -- upper bounds, in days past due, of each overdue bucket: {30,60,90} → current, 1–30, 31–60, 61–90, 90+
  aging_buckets           integer[] not null default '{30,60,90}' check (cardinality(aging_buckets) between 1 and 8 and 0 < all (aging_buckets)),
  forecast_weeks          integer not null default 13 check (forecast_weeks between 1 and 52),
  min_cash_buffer_minor   bigint not null default 0 check (min_cash_buffer_minor >= 0),
  chase_after_days        integer not null default 7 check (chase_after_days between 0 and 365),
  updated_at              timestamptz not null default now(),
  updated_by              text not null default 'system'
);
alter table {{schema}}.settings enable row level security;
alter table {{schema}}.settings force row level security;
create policy company_isolation on {{schema}}.settings
  using (company_id = nullif(current_setting('neos.company_id', true), '')::uuid)
  with check (company_id = nullif(current_setting('neos.company_id', true), '')::uuid);

-- Why a bank line was set aside (status 'ignored'), in the words of whoever approved it.
alter table {{schema}}.bank_transactions add column note text check (note is null or length(note) <= 500);
