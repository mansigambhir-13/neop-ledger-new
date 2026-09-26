-- 010_room_rebind.sql · an app can move to a new room without losing the old room's history:
-- the old room is retired (its messages keep their foreign key), one room per app per company is active.
alter table neos.rooms add column status text not null default 'active' check (status in ('active', 'retired'));
alter table neos.rooms drop constraint rooms_company_id_app_key_kind_key;
create unique index rooms_one_active on neos.rooms (company_id, app_key, kind) where status = 'active';
