-- 003_budgets.sql · monthly budgets per expense account (Phase 4: Marketing
-- borrows ledger.budget.remaining). Money in minor units; one row per account,
-- month and currency.
create table {{schema}}.budgets (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  account_id    uuid not null,
  month         date not null check (extract(day from month) = 1),
  currency      char(3) not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor  bigint not null check (amount_minor >= 0),
  unique (company_id, account_id, month, currency),
  foreign key (company_id, account_id) references {{schema}}.accounts (company_id, id)
);
alter table {{schema}}.budgets enable row level security;
alter table {{schema}}.budgets force row level security;
create policy company_isolation on {{schema}}.budgets
  using (company_id = nullif(current_setting('neos.company_id', true), '')::uuid)
  with check (company_id = nullif(current_setting('neos.company_id', true), '')::uuid);
