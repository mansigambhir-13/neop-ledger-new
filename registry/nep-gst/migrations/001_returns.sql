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
