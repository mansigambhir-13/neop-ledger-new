import {sqlIdent} from '@neop/pgkit';
// SOURCE DOCUMENTS KEPT (WP §11). A file a person attaches is stored — bytes in the document
// store under `<schema>/<company_id>/<sha256>`, a row in `<schema>.documents_files` naming it —
// before the documents door extracts its text. A write based on it can carry the sha256
// (`source_document`), and a person can download the original from this backend's own files
// listener (files/listener.ts) with a short-lived signed link. The assistant sees text and ids,
// never the bytes; the platform never fetches them (v3 S9).

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from '@neop/pgkit';
import type { Core } from '../../core.ts';
import { createDocumentStore, documentKey, documentStoreConfigFromEnv, type DocumentStore } from './store.ts';
import { DocumentError, uploadBytes, type DocumentUpload } from './index.ts';

const stores = new WeakMap<Core, DocumentStore>();

/** The store this backend keeps files in (its config's, else the environment's). */
export function storeFor(core: Core): DocumentStore {
  let s = stores.get(core);
  if (!s) {
    s = createDocumentStore(core.cfg.documents ?? documentStoreConfigFromEnv());
    stores.set(core, s);
  }
  return s;
}

export interface KeptFile {
  sha256: string;
  filename: string;
  content_type: string;
  bytes: number;
  store: 'local' | 's3';
  store_key: string;
}

/**
 * Store each upload's bytes (before any extraction). An upload whose base64 does not decode is
 * not stored (null): its fact will say it could not be read.
 */
export async function keepUploads(core: Core, companyId: string, uploads: DocumentUpload[]): Promise<(KeptFile | null)[]> {
  const store = storeFor(core);
  const out: (KeptFile | null)[] = [];
  for (const u of uploads) {
    let bytes: Buffer;
    try {
      bytes = uploadBytes(u);
    } catch (e) {
      if (e instanceof DocumentError) {
        out.push(null);
        continue;
      }
      throw e;
    }
    if (!bytes.length) {
      out.push(null);
      continue;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = documentKey(core.key, companyId, sha256);
    const content_type = String(u.content_type || 'application/octet-stream').toLowerCase().slice(0, 200);
    await store.put(key, bytes, content_type);
    out.push({ sha256, filename: String(u.filename || 'document').slice(0, 200), content_type, bytes: bytes.length, store: store.kind, store_key: key });
  }
  return out;
}

/** The row that links a stored file to the job it came in with (company-scoped transaction). */
export async function recordFile(db: PoolClient, schema: string, companyId: string, jobId: string | null, f: KeptFile): Promise<void> {
  await db.query(
    `insert into ${sqlIdent(schema)}.documents_files (company_id, sha256, filename, content_type, bytes, store, store_key, job_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing`,
    [companyId, f.sha256, f.filename, f.content_type, f.bytes, f.store, f.store_key, jobId],
  );
}

export interface FileMeta {
  sha256: string;
  filename: string;
  content_type: string;
  bytes: number;
  store: 'local' | 's3';
  store_key: string;
  stored_at: string;
  job_ids: string[];
}

/** A stored file of this company (RLS scopes the read), or null. */
export async function fileMeta(db: PoolClient, schema: string, sha256: string): Promise<FileMeta | null> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  const r = await db.query<FileMeta & { stored_at: Date }>(
    `select sha256, (array_agg(filename order by stored_at))[1] as filename, (array_agg(content_type order by stored_at))[1] as content_type,
            max(bytes)::int as bytes, (array_agg(store order by stored_at))[1] as store, (array_agg(store_key order by stored_at))[1] as store_key,
            min(stored_at) as stored_at, coalesce(array_agg(job_id order by stored_at) filter (where job_id is not null), '{}') as job_ids
       from ${sqlIdent(schema)}.documents_files where sha256 = $1 group by sha256`,
    [sha256],
  );
  const row = r.rows[0];
  return row ? { ...row, stored_at: new Date(row.stored_at).toISOString() } : null;
}

// ── short-lived download links ─────────────────────────────────────────────
// The link is signed by the backend that stores the file (a key derived from its job-token
// secret, which never leaves it) and checked by that same backend's files listener when a
// person's browser follows it. It names one company, one file and an expiry.

const linkKeys = new Map<string, Buffer>();
const publicBases = new Map<string, string>();

/**
 * Called by startBackend: the key this app's links are signed and checked with, and where a person's browser reaches
 * this backend's files listener (NEOP_FILES_PUBLIC_URL; unset, a link carries its path only).
 */
export function registerDocumentLinkKey(schema: string, secret: string, publicUrl?: string | null): void {
  linkKeys.set(schema, createHmac('sha256', secret).update('neop-documents-link-v1').digest());
  if (publicUrl) publicBases.set(schema, publicUrl.replace(/\/$/, ''));
  else publicBases.delete(schema);
}

export const DOCUMENT_LINK_TTL_S = 600;

const linkMac = (key: Buffer, schema: string, companyId: string, sha256: string, exp: number) =>
  createHmac('sha256', key).update(`${schema}:${companyId.toLowerCase()}:${sha256}:${exp}`).digest('base64url');

/**
 * `/files/<company>/<sha256>?exp=…&sig=…` on this backend's files listener (and the full `url` when its public address
 * is configured) — for a person of that company to download the original within DOCUMENT_LINK_TTL_S.
 */
export function documentLink(schema: string, companyId: string, sha256: string, now = Date.now()): { path: string; url: string | null; expires_at: string } | null {
  const key = linkKeys.get(schema);
  if (!key) return null;
  const exp = Math.floor(now / 1000) + DOCUMENT_LINK_TTL_S;
  const path = `/files/${companyId.toLowerCase()}/${sha256}?exp=${exp}&sig=${linkMac(key, schema, companyId, sha256, exp)}`;
  const base = publicBases.get(schema);
  return { path, url: base ? `${base}${path}` : null, expires_at: new Date(exp * 1000).toISOString() };
}

export function verifyDocumentLink(schema: string, companyId: string, sha256: string, exp: unknown, sig: unknown, now = Date.now()): 'ok' | 'expired' | 'bad' {
  const key = linkKeys.get(schema);
  const e = Number(exp);
  if (!key || !Number.isInteger(e) || typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return 'bad';
  const want = Buffer.from(linkMac(key, schema, companyId, sha256, e));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return 'bad';
  return e * 1000 < now ? 'expired' : 'ok';
}
