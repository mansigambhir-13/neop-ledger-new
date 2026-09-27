-- t006 · source documents kept (WP §11: "files go to object storage keyed under the schema
-- name; the row keeps the id"). The bytes of a file a person attached live in the document
-- store under <schema>/<company_id>/<sha256>; this row links that id to its name, type, size,
-- where and when it was stored, and the job it arrived with. A write based on the file cites the
-- sha256 (e.g. a bill's source_document). Rows are history: the app role cannot change or delete
-- them; only the DBA's company-scoped uninstall does.
create table {{schema}}.documents_files (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  filename      text not null check (length(filename) between 1 and 200),
  content_type  text not null check (length(content_type) between 1 and 200),
  bytes         bigint not null check (bytes > 0),
  store         text not null check (store in ('local', 's3')),
  store_key     text not null check (store_key = '{{schema}}/' || company_id::text || '/' || sha256),
  stored_at     timestamptz not null default now(),
  job_id        uuid references {{schema}}.jobs (id),
  unique nulls not distinct (company_id, sha256, job_id)
);
create index documents_files_sha_ix on {{schema}}.documents_files (company_id, sha256);
alter table {{schema}}.documents_files enable row level security;
alter table {{schema}}.documents_files force row level security;
create policy company_isolation on {{schema}}.documents_files
  using (company_id = nullif(current_setting('neos.company_id', true), '')::uuid)
  with check (company_id = nullif(current_setting('neos.company_id', true), '')::uuid);
revoke update, delete on {{schema}}.documents_files from {{schema}}_app;
