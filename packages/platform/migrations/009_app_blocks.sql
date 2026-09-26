-- 009_app_blocks.sql · an app's screens as data (WP §13 blocks/), validated at registration
-- and drawn by the one renderer on the desk. Never JavaScript.
alter table neos.apps add column blocks jsonb not null default '{}'::jsonb;
