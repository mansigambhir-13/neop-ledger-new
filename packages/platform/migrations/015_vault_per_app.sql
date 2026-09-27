-- 015_vault_per_app.sql · WP §12 "credentials for the doors: the secret store, per (app, company)".
-- A door credential was keyed (company_id, door): two apps with a door of the same name shared
-- one key. Now (company_id, app_key, door), where app_key '*' is the company-wide credential every
-- row written before this change becomes — so nothing breaks: an app borrows its own credential
-- when one exists, else the company-wide one, and never another app's.
--
-- Expand: the column, with a default that makes every existing row company-wide, backfilled
-- explicitly, and the new unique key. No row, column or value is dropped. The old key constraint
-- (company_id, door) is a uniqueness rule, not data; it must give way to the new one or a second
-- app could never hold its own row. The platform is the only writer and its code ships with its
-- migrations (scripts/migrate.ts runs before the platform starts), so no writer still relies on it.
alter table neos.vault_secrets add column app_key text not null default '*'
  check (app_key = '*' or app_key ~ '^[a-z][a-z0-9_]{0,40}$');
update neos.vault_secrets set app_key = '*' where app_key is distinct from '*';
create unique index vault_secrets_app_door_uq on neos.vault_secrets (company_id, app_key, door);
alter table neos.vault_secrets drop constraint vault_secrets_pkey;
alter table neos.vault_secrets add constraint vault_secrets_pkey primary key using index vault_secrets_app_door_uq;
