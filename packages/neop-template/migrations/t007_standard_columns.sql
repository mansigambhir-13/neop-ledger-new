-- t007 · template upgrade stream. Expand-only: the standard tables gain the key columns WP v3 §11
-- names ("the nine standard tables"). Every column is nullable: rows written before this file keep
-- NULL (unknown), never a made-up value.

-- jobs: where the ask came from, the board it ran on, and the session's last sign of life.
--   origin                room event id (room) · 'timer' (a schedule) · the task id as text (task / a2a)
--   switchboard_version   the switchboard version the latest session was spawned on
--   switchboard_snapshot  that board as the job saw it (effective settings, rules, budget)
--   heartbeat_at          set by the gate on every session heartbeat
alter table {{schema}}.jobs add column origin text check (origin is null or length(origin) between 1 and 500);
alter table {{schema}}.jobs add column switchboard_version integer check (switchboard_version is null or switchboard_version >= 0);
alter table {{schema}}.jobs add column switchboard_snapshot jsonb;
alter table {{schema}}.jobs add column heartbeat_at timestamptz;

-- proposals: the manifest the card was written against, and when it was answered, carried out and
-- confirmed by read-back.
alter table {{schema}}.proposals add column manifest_version text;
alter table {{schema}}.proposals add column answered_at timestamptz;
alter table {{schema}}.proposals add column executed_at timestamptz;
alter table {{schema}}.proposals add column verified_at timestamptz;

-- operations: sha256 of the RFC 8785 canonical JSON of what was asked and what came back, and why it ran.
alter table {{schema}}.operations add column request_checksum text check (request_checksum is null or request_checksum ~ '^[0-9a-f]{64}$');
alter table {{schema}}.operations add column result_checksum text check (result_checksum is null or result_checksum ~ '^[0-9a-f]{64}$');
alter table {{schema}}.operations add column reason text check (reason is null or length(reason) between 1 and 1000);

-- waits: a job may wait on another piece of work finishing (WP v3 §11 "dependency"); the rest stay.
alter table {{schema}}.waits drop constraint waits_kind_check;
alter table {{schema}}.waits add constraint waits_kind_check check (kind in ('proposal', 'timer', 'a2a_task', 'input', 'dependency'));
