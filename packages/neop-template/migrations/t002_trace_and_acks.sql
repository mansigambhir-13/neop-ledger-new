-- t002 · template upgrade stream (R2): tracing and outbox acknowledgement.
alter table {{schema}}.jobs add column trace_id text;
alter table {{schema}}.operations add column trace_id text;

-- The cursor the platform has committed (R11). Acked events older than the
-- retention window may be pruned; nothing is deleted before it is acked.
create table {{schema}}.outbox_acked (
  id          integer primary key default 1 check (id = 1),
  cursor      bigint not null default 0,
  acked_at    timestamptz not null default now()
);
insert into {{schema}}.outbox_acked (id, cursor) values (1, 0);
grant select, insert, update on {{schema}}.outbox_acked to {{schema}}_runner;
revoke all on {{schema}}.outbox_acked from {{schema}}_app;
