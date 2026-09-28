-- 019_registry_schema.sql · v3 §10 "what can be shared, and with whom, is readable by every NEOP".
-- A read-only `neos_registry` schema of views over what the platform already holds: registered apps, their
-- abilities, doors and `uses` (from neos.apps manifests), and published registry skills and packages (from
-- neos.registry_entries). No secrets, no company data, no approvals. Every app's app/runner role is given SELECT
-- on it when the app registers (neos.grant_registry_read, called by registerApp) — and nothing else in neos.
--
-- Also (v3 §10 "one step in another app's subject"): a task can be a borrowed WRITE handed to its owner, and must
-- remember which ability it carries, so a retried delivery is authorised by the same ACL row a person granted.
--
-- Expand only: a new schema of views, a function, and one nullable column (no backfill: existing tasks are not
-- borrowed writes, so null is their true value).
create schema neos_registry;

create view neos_registry.apps as
  select a.key as app, a.manifest->>'name' as name, a.manifest->>'subject' as subject, a.manifest->>'description' as description,
         a.manifest->>'version' as version, a.contract_version, a.status, a.registered_at
    from neos.apps a;

create view neos_registry.abilities as
  select a.key as app, x->>'key' as ability, x->>'version' as version, x->>'title' as title, x->>'description' as description,
         x->>'kind' as kind, x->>'floor' as floor, coalesce(x->'doors', '[]'::jsonb) as doors, x->'input' as input, x->'output' as output
    from neos.apps a cross join lateral jsonb_array_elements(coalesce(a.manifest->'abilities', '[]'::jsonb)) x;

create view neos_registry.doors as
  select a.key as app, d->>'key' as door, coalesce(d->'scopes', '[]'::jsonb) as scopes, coalesce(d->>'floor', 'on') as floor
    from neos.apps a cross join lateral jsonb_array_elements(coalesce(a.manifest->'doors', '[]'::jsonb)) d;

create view neos_registry.uses as
  select a.key as app, u->>'app' as owner_app, u->>'ability' as ability, u->>'range' as range, u->>'floor' as floor
    from neos.apps a cross join lateral jsonb_array_elements(coalesce(a.manifest->'uses', '[]'::jsonb)) u;

create view neos_registry.skills as
  select e.key, e.version, e.owner_app, e.requires, e.status, e.content_hash, e.published_at, e.deprecated_at
    from neos.registry_entries e where e.kind = 'skill' and e.status in ('published', 'deprecated');

create view neos_registry.packages as
  select e.key, e.version, e.requires, e.offers, e.status, e.content_hash, e.artifact_hash, e.published_at, e.deprecated_at
    from neos.registry_entries e where e.kind = 'package' and e.status in ('published', 'deprecated');

-- The views' owner (this migrator) grants; the platform calls this at registration. Only an app's own family roles.
create function neos.grant_registry_read(app text) returns integer
  language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  r text;
  n integer := 0;
begin
  if app is null or app !~ '^[a-z][a-z0-9_]{0,40}$' or not exists (select 1 from neos.apps a where a.key = app) then
    raise exception 'grant_registry_read: % is not a registered app', app;
  end if;
  foreach r in array array[app || '_app', app || '_runner'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant usage on schema neos_registry to %I', r);
      execute format('grant select on all tables in schema neos_registry to %I', r);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function neos.grant_registry_read(text) from public;
grant execute on function neos.grant_registry_read(text) to neos_app;
grant usage on schema neos_registry to neos_app;
grant select on all tables in schema neos_registry to neos_app;

alter table neos.tasks add column borrowed_ability text check (borrowed_ability is null or borrowed_ability ~ '^[a-z][a-z0-9_.]{0,120}$');
