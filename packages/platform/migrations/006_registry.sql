-- 006_registry.sql · Phase 5: skills, packages, versions, signatures, installs.
-- Data lives in rows; code lives in a content-addressed artifact, fetched by
-- hash and verified before it runs (R5). A published entry carries the
-- platform's co-signature, given only after a person reviewed its diff (S7).

create table neos.registry_artifacts (
  hash        text primary key check (hash like 'sha256:%'),
  bytes       bytea not null,
  size        integer not null,
  created_at  timestamptz not null default now()
);

create table neos.registry_entries (
  key            text not null check (key ~ '^[a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)?$'),
  version        text not null check (version ~ '^\d+\.\d+\.\d+$'),
  kind           text not null check (kind in ('skill', 'package')),
  owner_app      text references neos.apps (key),
  published_by   text not null,
  requires       jsonb not null default '[]'::jsonb,
  offers         jsonb not null default '[]'::jsonb,
  body           text,
  artifact_hash  text references neos.registry_artifacts (hash),
  content_hash   text not null check (content_hash like 'sha256:%'),
  platform_sig   text,
  status         text not null default 'pending_review'
                 check (status in ('pending_review', 'published', 'rejected', 'deprecated', 'retired')),
  deprecated_at  timestamptz,
  created_at     timestamptz not null default now(),
  published_at   timestamptz,
  primary key (key, version),
  check (status <> 'published' or platform_sig is not null),
  check ((kind = 'skill') = (body is not null)),
  check ((kind = 'package') = (artifact_hash is not null))
);

-- A person reviews exactly this diff; the yes binds to the content hash.
create table neos.registry_reviews (
  id                uuid primary key default gen_random_uuid(),
  key               text not null,
  version           text not null,
  diff              text not null,
  fingerprint       text not null,
  status            text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  decided_by        uuid references neos.users (id),
  fingerprint_seen  text,
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  foreign key (key, version) references neos.registry_entries (key, version)
);

create table neos.registry_installs (
  company_id      uuid not null references neos.companies (id),
  host_app        text not null references neos.apps (key),
  entry_key       text not null,
  pinned_version  text not null,
  status          text not null default 'active' check (status in ('pending_migration', 'active', 'disabled')),
  granted_by      uuid references neos.users (id),
  installed_at    timestamptz not null default now(),
  primary key (company_id, host_app, entry_key),
  foreign key (entry_key, pinned_version) references neos.registry_entries (key, version)
);

-- Package migrations are applied once per host app and version by the migration runner.
create table neos.package_migrations (
  host_app     text not null references neos.apps (key),
  entry_key    text not null,
  version      text not null,
  applied_at   timestamptz not null default now(),
  primary key (host_app, entry_key, version)
);
