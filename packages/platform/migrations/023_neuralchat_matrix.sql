-- 023_neuralchat_matrix.sql · v3 S5 "NeuralChat speaks Matrix" (WP v3 §1 steps 3–8, §7, §8, §12).
-- When an app runs with NEOP presence (S4) and NeuralChat has a Matrix identity at the company (@neuralchat_<co> on the
-- appservice road, or a configured client account), a person's ask reaches the app ONLY as a typed neos.neop.task
-- posted by that identity in the app's room/DM, rooted in a thread; the app's typed note / ask / propose / done come
-- back in that thread and are read into the conversation and this task store. The gateway (tasks.open, inbox.deliver)
-- is not used for such a task; the outbox consumer does not drive its status (S9 removes the gateway road).
--
--   neos.tasks.road             'gateway' (every task until now) | 'matrix'
--   neos.tasks.matrix_*         where the task was posted, as whom, the transaction id (a resend is the same event) and
--                               the event id the homeserver gave it (the thread root); delivered_at once it was posted
--   neos.neuralchat_events      every event NeuralChat read from a thread, once per event_id (Matrix redelivers)
--   neos.neuralchat_rooms       the client road's 1:1 room with each app account (one per NeuralChat account and app)
--   neos.neuralchat_accounts    the client road's /sync cursor per NeuralChat account
--   conversation_messages.kind  + 'step': the app's note for a step, read from the thread ("· …")
--
-- Expand only: new columns with defaults, new tables, one more allowed conversation kind; no existing row changes meaning.

alter table neos.tasks add column road text not null default 'gateway' check (road in ('gateway', 'matrix'));
alter table neos.tasks add column matrix_room text;
alter table neos.tasks add column matrix_account text;
alter table neos.tasks add column matrix_txn text;
alter table neos.tasks add column matrix_event_id text;
alter table neos.tasks add column delivered_at timestamptz;
create index tasks_matrix_root_ix on neos.tasks (matrix_room, matrix_event_id) where road = 'matrix';
create index tasks_matrix_open_ix on neos.tasks (status) where road = 'matrix' and status = 'OPEN';

create table neos.neuralchat_events (
  event_id    text primary key,
  company_id  uuid references neos.companies (id),
  task_id     uuid references neos.tasks (id),
  room_id     text not null,
  sender      text not null,
  type        text not null,
  outcome     text not null default 'received',
  detail      jsonb,
  at          timestamptz not null default now()
);
create index neuralchat_events_task_ix on neos.neuralchat_events (task_id, at);

create table neos.neuralchat_rooms (
  company_id  uuid not null references neos.companies (id),
  app_key     text not null references neos.apps (key),
  account     text not null check (account ~ '^@[^:]+:.+$'),
  peer        text not null check (peer ~ '^@[^:]+:.+$'),
  room_id     text not null,
  created_at  timestamptz not null default now(),
  primary key (company_id, app_key, account)
);

create table neos.neuralchat_accounts (
  account         text primary key check (account ~ '^@[^:]+:.+$'),
  company_id      uuid not null references neos.companies (id),
  next_batch      text,
  stopped_reason  text,
  updated_at      timestamptz not null default now()
);

alter table neos.conversation_messages drop constraint conversation_messages_kind_check;
alter table neos.conversation_messages add constraint conversation_messages_kind_check
  check (kind in ('message', 'handoff', 'ack', 'waiting', 'card', 'result', 'notice', 'step'));
