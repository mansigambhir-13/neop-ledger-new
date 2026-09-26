-- 002_ledger.sql · Ledger's own tables · app-team-owned.
-- Money: integer minor units (paise) with an ISO currency; never floats.
-- Every entry balances (checked at commit). Every row carries company_id + RLS.

create table {{schema}}.accounts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  code        text not null check (code ~ '^[0-9A-Za-z.-]{1,20}$'),
  name        text not null,
  type        text not null check (type in ('asset', 'liability', 'equity', 'income', 'expense')),
  subtype     text not null check (subtype in
                ('cash', 'bank', 'receivable', 'inventory', 'fixed_asset', 'tax_input', 'other_asset',
                 'payable', 'tax_output', 'loan', 'other_liability',
                 'equity', 'retained_earnings',
                 'revenue', 'other_income',
                 'cogs', 'opex', 'other_expense')),
  created_at  timestamptz not null default now(),
  unique (company_id, code),
  unique (company_id, id)
);

create table {{schema}}.journal_entries (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  entry_date  date not null,
  memo        text not null check (length(memo) > 0),
  reference   text not null,
  currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
  source      text not null check (source in ('seed', 'import', 'manual', 'assistant')),
  job_id      uuid,
  created_at  timestamptz not null default now(),
  unique (company_id, reference),
  unique (company_id, id)
);
create index journal_entries_date_ix on {{schema}}.journal_entries (company_id, entry_date);

create table {{schema}}.journal_lines (
  id            bigint generated always as identity primary key,
  company_id    uuid not null,
  entry_id      uuid not null,
  account_id    uuid not null,
  debit_minor   bigint not null default 0 check (debit_minor >= 0),
  credit_minor  bigint not null default 0 check (credit_minor >= 0),
  check ((debit_minor = 0) <> (credit_minor = 0)),
  foreign key (company_id, entry_id) references {{schema}}.journal_entries (company_id, id),
  foreign key (company_id, account_id) references {{schema}}.accounts (company_id, id)
);
create index journal_lines_entry_ix on {{schema}}.journal_lines (entry_id);
create index journal_lines_account_ix on {{schema}}.journal_lines (company_id, account_id);

create function {{schema}}.check_entry_balanced() returns trigger language plpgsql as $$
declare d bigint; c bigint; n int;
begin
  select coalesce(sum(debit_minor), 0), coalesce(sum(credit_minor), 0), count(*)
    into d, c, n from {{schema}}.journal_lines where entry_id = new.entry_id;
  if n < 2 or d <> c then
    raise exception 'journal entry % does not balance (debits %, credits %, lines %)', new.entry_id, d, c, n;
  end if;
  return null;
end $$;
create constraint trigger journal_balanced after insert or update on {{schema}}.journal_lines
  deferrable initially deferred for each row execute function {{schema}}.check_entry_balanced();

create table {{schema}}.parties (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  kind        text not null check (kind in ('customer', 'vendor')),
  name        text not null,
  email       text,
  unique (company_id, id)
);

create table {{schema}}.documents (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null,
  kind         text not null check (kind in ('invoice', 'bill')),
  party_id     uuid not null,
  number       text not null,
  issue_date   date not null,
  due_date     date not null check (due_date >= issue_date),
  currency     char(3) not null check (currency ~ '^[A-Z]{3}$'),
  net_minor    bigint not null check (net_minor >= 0),
  tax_minor    bigint not null default 0 check (tax_minor >= 0),
  total_minor  bigint not null check (total_minor = net_minor + tax_minor),
  paid_minor   bigint not null default 0 check (paid_minor >= 0 and paid_minor <= total_minor),
  status       text not null default 'open' check (status in ('open', 'paid', 'void')),
  entry_id     uuid,
  unique (company_id, kind, number),
  foreign key (company_id, party_id) references {{schema}}.parties (company_id, id)
);

do $$
declare t text;
begin
  foreach t in array array['accounts', 'journal_entries', 'journal_lines', 'parties', 'documents'] loop
    execute format('alter table {{schema}}.%I enable row level security', t);
    execute format('alter table {{schema}}.%I force row level security', t);
    execute format(
      'create policy company_isolation on {{schema}}.%I using (company_id = nullif(current_setting(''neos.company_id'', true), '''')::uuid) with check (company_id = nullif(current_setting(''neos.company_id'', true), '''')::uuid)',
      t);
  end loop;
end $$;

-- Posted entries are history: correct with a reversing entry, never an edit.
revoke update, delete on {{schema}}.journal_entries, {{schema}}.journal_lines from {{schema}}_app;
