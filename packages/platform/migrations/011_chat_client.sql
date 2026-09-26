-- 011_chat_client.sql · the Matrix CLIENT road (MATRIX_MODE=client): each company-app install may speak in
-- Matrix as one ordinary account with an operator-issued token and a supervised /sync loop in the platform
-- process. Who may DM that account is an allowlist per install; every DM is recorded; every inbound
-- message is recorded once (event_id) with the one reply it is owed. Nothing here approves anything:
-- a person's yes still goes through platform.answer() against the fingerprint the card showed.

-- Who may DM the app account of a company-app install. A PERSON must also be linked
-- (neos.users.matrix_user_id) and is resolved live; a BRIDGE (the reasoning agent, @neos-platform) relays
-- for a person — `acts_for` is who its asks are opened for when the message names nobody — and never approves.
create table neos.chat_allowlist (
  company_id  uuid not null references neos.companies (id),
  app_key     text not null references neos.apps (key),
  matrix_id   text not null check (matrix_id ~ '^@[^:]+:.+$'),
  kind        text not null check (kind in ('person', 'bridge')),
  acts_for    uuid references neos.users (id),
  added_by    uuid references neos.users (id),
  added_at    timestamptz not null default now(),
  primary key (company_id, app_key, matrix_id),
  check (kind = 'bridge' or acts_for is null)
);

-- The app's own Matrix account per install, and its /sync cursor: a restart resumes where it stopped and
-- never answers a message twice.
create table neos.chat_accounts (
  account         text primary key check (account ~ '^@[^:]+:.+$'),
  company_id      uuid not null references neos.companies (id),
  app_key         text not null references neos.apps (key),
  next_batch      text,
  stopped_reason  text,
  updated_at      timestamptz not null default now(),
  unique (company_id, app_key)
);

-- The 1:1 DM the account keeps with each allowlisted peer (one per peer; a new DM replaces the old record).
create table neos.chat_dms (
  account      text not null references neos.chat_accounts (account),
  peer         text not null,
  room_id      text not null,
  recorded_at  timestamptz not null default now(),
  primary key (account, peer),
  unique (account, room_id)
);

-- Every message in (once per event_id) and every card out. An inbound row owes exactly one reply:
-- reply_status 'waiting' until its task settles or its deadline passes, then 'sending' → 'sent' (the txn id
-- is derived from the event id, so a resend is not posted twice). Message text is not kept here.
create table neos.chat_client_events (
  event_id          text primary key,
  account           text not null references neos.chat_accounts (account),
  room_id           text not null,
  direction         text not null check (direction in ('inbound', 'outbound')),
  sender            text not null,
  sender_kind       text check (sender_kind in ('person', 'bridge')),
  user_id           uuid references neos.users (id),
  task_id           uuid references neos.tasks (id),
  approval_id       uuid references neos.approvals (id),
  fingerprint_shown text,
  outcome           text not null,
  reply_status      text not null default 'none' check (reply_status in ('none', 'waiting', 'sending', 'sent')),
  reply_due_at      timestamptz,
  reply_text        text,
  reply_event_id    text,
  replied_at        timestamptz,
  at                timestamptz not null default now()
);
create index chat_client_events_waiting_ix on neos.chat_client_events (account, reply_status) where reply_status in ('waiting', 'sending');
create index chat_client_events_task_ix on neos.chat_client_events (task_id) where task_id is not null;
