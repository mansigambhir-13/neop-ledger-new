-- 004_bookkeeping.sql · Ledger's day-to-day bookkeeping: invoicing and bills,
-- receipts and payments, bank import and reconciliation, coding rules,
-- period locks. Money in minor units; RLS on every row; posted history is
-- corrected by reversal, never edited.

alter table {{schema}}.accounts add column is_active boolean not null default true;
alter table {{schema}}.parties add column gstin text check (gstin is null or gstin ~ '^[0-9A-Z]{15}$');
alter table {{schema}}.documents add column description text;
alter table {{schema}}.documents add column sent_at timestamptz;
alter table {{schema}}.documents add column reminded_at timestamptz;
alter table {{schema}}.documents add column reference text;
create unique index documents_reference_uq on {{schema}}.documents (company_id, reference) where reference is not null;
alter table {{schema}}.parties add column reference text;
create unique index parties_reference_uq on {{schema}}.parties (company_id, reference) where reference is not null;
create unique index parties_name_uq on {{schema}}.parties (company_id, kind, lower(name));
-- A reversal points at what it reverses; an entry can be reversed once.
alter table {{schema}}.journal_entries add column reverses uuid unique;

-- Invoice numbering per company.
create table {{schema}}.doc_counters (
  company_id  uuid not null,
  kind        text not null check (kind in ('invoice')),
  next_no     integer not null default 1 check (next_no > 0),
  primary key (company_id, kind)
);

create table {{schema}}.payments (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null,
  document_id       uuid not null,
  kind              text not null check (kind in ('receipt', 'payment')),
  pay_date          date not null,
  amount_minor      bigint not null check (amount_minor > 0),
  currency          char(3) not null check (currency ~ '^[A-Z]{3}$'),
  bank_account_id   uuid not null,
  reference         text not null,
  entry_id          uuid not null,
  created_at        timestamptz not null default now(),
  unique (company_id, reference)
);

create table {{schema}}.bank_transactions (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  bank_account_id      uuid not null,
  external_id          text not null,
  txn_date             date not null,
  description          text not null,
  amount_minor         bigint not null check (amount_minor <> 0),
  currency             char(3) not null check (currency ~ '^[A-Z]{3}$'),
  status               text not null default 'unmatched' check (status in ('unmatched', 'matched', 'ignored')),
  matched_entry_id     uuid,
  matched_document_id  uuid,
  import_ref           text not null,
  imported_at          timestamptz not null default now(),
  unique (company_id, bank_account_id, external_id)
);
create index bank_transactions_open_ix on {{schema}}.bank_transactions (company_id, status, txn_date);

create table {{schema}}.coding_rules (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  pattern     text not null check (length(pattern) between 2 and 100),
  account_id  uuid not null,
  direction   text not null default 'any' check (direction in ('in', 'out', 'any')),
  priority    integer not null default 100,
  reference   text not null,
  created_at  timestamptz not null default now(),
  unique (company_id, reference)
);

create table {{schema}}.period_locks (
  company_id  uuid not null,
  month       date not null check (extract(day from month) = 1),
  locked_at   timestamptz not null default now(),
  locked_by   text not null,
  reason      text,
  primary key (company_id, month)
);

-- A locked month takes no new entries, whoever posts them.
create function {{schema}}.refuse_locked_period() returns trigger language plpgsql as $$
begin
  if exists (select 1 from {{schema}}.period_locks p
              where p.company_id = new.company_id and p.month = date_trunc('month', new.entry_date)::date) then
    raise exception 'period % is locked; post into an open month or reopen it first', to_char(new.entry_date, 'YYYY-MM');
  end if;
  return new;
end $$;
create trigger journal_entries_period_lock before insert on {{schema}}.journal_entries
  for each row execute function {{schema}}.refuse_locked_period();

do $$
declare t text;
begin
  foreach t in array array['doc_counters', 'payments', 'bank_transactions', 'coding_rules', 'period_locks'] loop
    execute format('alter table {{schema}}.%I enable row level security', t);
    execute format('alter table {{schema}}.%I force row level security', t);
    execute format(
      'create policy company_isolation on {{schema}}.%I using (company_id = nullif(current_setting(''neos.company_id'', true), '''')::uuid) with check (company_id = nullif(current_setting(''neos.company_id'', true), '''')::uuid)',
      t);
  end loop;
end $$;

-- Payments are history; locks may be lifted only by a reopen (which the proposal trail records).
revoke update, delete on {{schema}}.payments from {{schema}}_app;
