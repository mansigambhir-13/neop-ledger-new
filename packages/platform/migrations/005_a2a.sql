-- 005_a2a.sql · app-to-app tasks (Phase 4, R3). A task asked by an app carries
-- the chain of apps that led to it; its result is delivered back to the host
-- job by a signed tasks.result call, tracked here until acknowledged.
alter table neos.tasks add column lineage jsonb not null default '[]'::jsonb;
alter table neos.tasks add column host_job_id uuid;
alter table neos.tasks add column result_delivered_at timestamptz;
create index tasks_a2a_results_ix on neos.tasks (status) where requester like 'app:%' and result_delivered_at is null;
