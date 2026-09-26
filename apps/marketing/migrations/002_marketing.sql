-- 002_marketing.sql · Marketing's own tables. Money in minor units; RLS on every row.
create table {{schema}}.campaigns (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  name                 text not null,
  channel              text not null check (channel in ('search', 'social', 'email', 'display')),
  status               text not null default 'planned' check (status in ('planned', 'active', 'done')),
  start_date           date not null,
  end_date             date not null check (end_date >= start_date),
  currency             char(3) not null check (currency ~ '^[A-Z]{3}$'),
  planned_spend_minor  bigint not null default 0 check (planned_spend_minor >= 0),
  ledger_account_code  text not null default '6400',
  unique (company_id, id)
);

create table {{schema}}.posts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  campaign_id   uuid,
  channel       text not null check (channel in ('linkedin', 'instagram', 'x', 'facebook')),
  text          text not null check (length(text) between 1 and 3000),
  status        text not null default 'draft' check (status in ('draft', 'scheduled')),
  scheduled_at  timestamptz,
  reference     text not null,
  external_ref  text,
  created_at    timestamptz not null default now(),
  unique (company_id, reference),
  foreign key (company_id, campaign_id) references {{schema}}.campaigns (company_id, id)
);

create table {{schema}}.spend_commitments (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  campaign_id   uuid not null,
  vendor        text not null,
  currency      char(3) not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor  bigint not null check (amount_minor > 0),
  reference     text not null,
  external_ref  text,
  created_at    timestamptz not null default now(),
  unique (company_id, reference),
  foreign key (company_id, campaign_id) references {{schema}}.campaigns (company_id, id)
);

create table {{schema}}.channel_stats (
  company_id   uuid not null,
  channel      text not null,
  day          date not null,
  impressions  integer not null check (impressions >= 0),
  clicks       integer not null check (clicks >= 0),
  leads        integer not null check (leads >= 0),
  primary key (company_id, channel, day)
);

do $$
declare t text;
begin
  foreach t in array array['campaigns', 'posts', 'spend_commitments', 'channel_stats'] loop
    execute format('alter table {{schema}}.%I enable row level security', t);
    execute format('alter table {{schema}}.%I force row level security', t);
    execute format(
      'create policy company_isolation on {{schema}}.%I using (company_id = nullif(current_setting(''neos.company_id'', true), '''')::uuid) with check (company_id = nullif(current_setting(''neos.company_id'', true), '''')::uuid)',
      t);
  end loop;
end $$;
