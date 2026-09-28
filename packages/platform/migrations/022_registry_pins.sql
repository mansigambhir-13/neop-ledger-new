-- 022_registry_pins.sql · v3 S7 "packages at build time". A NEOP reads what it pinned from the registry schema:
--   neos_registry.skills   + offers, body, platform_sig — a pinned skill-only entry is text, read by the runner at
--                            spawn with the app's own role and checked against the content hash its build pinned
--   neos_registry.packages + owner_app, platform_sig
--   neos_registry.pins     what each registered app's build installed (its manifest's `packages` and
--                          `registry_skills`, written by `neos install`) — v3 §10 "uses: what each app has pinned"
-- neos.registry_installs and neos.package_migrations are no longer read or written (run-time installs are gone);
-- they stay, frozen, until S9 deletes the legacy tables.
--
-- Expand only: views replaced with columns appended (create or replace keeps every existing column and grant),
-- one new view, and the grants the registry schema already gives each app's roles, repeated for the new view.
create or replace view neos_registry.skills as
  select e.key, e.version, e.owner_app, e.requires, e.status, e.content_hash, e.published_at, e.deprecated_at,
         e.offers, e.body, e.platform_sig
    from neos.registry_entries e where e.kind = 'skill' and e.status in ('published', 'deprecated');

create or replace view neos_registry.packages as
  select e.key, e.version, e.requires, e.offers, e.status, e.content_hash, e.artifact_hash, e.published_at, e.deprecated_at,
         e.owner_app, e.platform_sig
    from neos.registry_entries e where e.kind = 'package' and e.status in ('published', 'deprecated');

create view neos_registry.pins as
  select a.key as app, p->>'key' as key, p->>'version' as version, 'package'::text as kind,
         coalesce(p->'requires', '[]'::jsonb) as requires, p->>'content_hash' as content_hash
    from neos.apps a cross join lateral jsonb_array_elements(coalesce(a.manifest->'packages', '[]'::jsonb)) p
  union all
  select a.key, s->>'key', s->>'version', 'skill', coalesce(s->'requires', '[]'::jsonb), s->>'content_hash'
    from neos.apps a cross join lateral jsonb_array_elements(coalesce(a.manifest->'registry_skills', '[]'::jsonb)) s;

grant select on neos_registry.pins to neos_app;
-- Each app's own roles get SELECT on it from neos.grant_registry_read, which migratePlatform runs after every platform
-- migration (and registerApp at every registration).
