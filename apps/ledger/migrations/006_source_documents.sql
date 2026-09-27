-- 006_source_documents.sql · a bill remembers the file it was read from (WP §11: files are kept
-- in object storage under the schema name; the row keeps the id). Nullable: bills recorded by
-- hand, and every bill before this change, have none. The id is the sha256 in the template's
-- documents_files (t006); ledger.bill.record checks it names a file this company attached.
alter table {{schema}}.documents add column source_document text
  check (source_document is null or source_document ~ '^[0-9a-f]{64}$');
create index documents_source_document_ix on {{schema}}.documents (company_id, source_document) where source_document is not null;
