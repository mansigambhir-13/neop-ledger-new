-- 013_task_attachments.sql · files a person attaches to an ask (documents door). Held on the task only
-- until the app acknowledges it, so a retried tasks.open carries them; cleared after, so the platform
-- does not keep the bytes. Expand-only.
alter table neos.tasks add column attachments jsonb;
