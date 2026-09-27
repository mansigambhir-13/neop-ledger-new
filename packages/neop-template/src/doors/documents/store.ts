// THE DOCUMENT STORE — where the bytes of a file a person attached are kept (WP §11: "files go to
// object storage keyed under the schema name; the row keeps the id"). The key is
// `<schema>/<company_id>/<sha256>`: content-addressed, so storing the same file twice is one object,
// and a key names exactly one company's file. Two backends:
//   local  a directory on a volume (the default; compose mounts `ledger-files` there)
//   s3     any S3-compatible bucket (AWS, MinIO, R2 …), spoken to with fetch + AWS Signature V4
// The store never sees the model; bytes leave it only through the platform's download route.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DocumentStore {
  readonly kind: 'local' | 's3';
  put(key: string, bytes: Buffer, contentType?: string): Promise<void>;
  /** The bytes, or null when there is no such object. */
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

export type DocumentStoreConfig =
  | { backend: 'local'; dir: string }
  | {
      backend: 's3';
      /** e.g. https://s3.ap-south-1.amazonaws.com or http://minio:9000 */
      endpoint: string;
      bucket: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      /** Path-style URLs (endpoint/bucket/key): MinIO and most S3-compatibles. Default true. */
      pathStyle?: boolean;
    };

const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `<schema>/<company_id>/<sha256>` — the only shape of key the store accepts. */
export function documentKey(schema: string, companyId: string, sha256: string): string {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(schema)) throw new Error(`bad schema name ${schema}`);
  if (!UUID.test(companyId)) throw new Error('bad company id');
  if (!SHA.test(sha256)) throw new Error('bad sha256');
  return `${schema}/${companyId.toLowerCase()}/${sha256}`;
}

function checkKey(key: string): void {
  const [s, c, h, ...rest] = key.split('/');
  if (rest.length || !s || !c || !h) throw new Error(`bad document key ${key}`);
  documentKey(s, c, h);
}

export class LocalDocumentStore implements DocumentStore {
  readonly kind = 'local' as const;
  readonly dir: string;
  constructor(dir: string) {
    this.dir = path.resolve(dir);
  }
  private file(key: string): string {
    checkKey(key);
    return path.join(this.dir, ...key.split('/'));
  }
  async put(key: string, bytes: Buffer): Promise<void> {
    const f = this.file(key);
    // Content-addressed: an object already there with this size is this file.
    const have = await stat(f).catch(() => null);
    if (have?.size === bytes.length) return;
    await mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, f); // atomic: a reader never sees half a file
  }
  async get(key: string): Promise<Buffer | null> {
    return readFile(this.file(key)).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
  }
  async delete(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }
}

// ── S3 (AWS Signature Version 4, minimal: one request at a time, payload hashed) ──────────────

const sha256hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();
/** RFC 3986 encoding of one path segment or query part, as SigV4 wants it. */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SigV4Request {
  method: string;
  /** Absolute URL (query included). */
  url: string;
  headers: Record<string, string>;
  /** Hex sha256 of the body, or 'UNSIGNED-PAYLOAD'. */
  payloadHash: string;
}

/**
 * Sign one request (AWS SigV4, service `s3`). Returns the headers to send: the given ones plus
 * host, x-amz-date, x-amz-content-sha256 and Authorization. Every header passed is signed.
 */
export function signV4(req: SigV4Request, cred: { accessKeyId: string; secretAccessKey: string; region: string }, now = new Date()): Record<string, string> {
  const u = new URL(req.url);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...req.headers, host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': req.payloadHash };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalPath = u.pathname.split('/').map((p) => enc(decodeURIComponent(p))).join('/') || '/';
  const canonical = [req.method, canonicalPath, query, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), req.payloadHash].join('\n');
  const scope = `${day}/${cred.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${cred.secretAccessKey}`, day), cred.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${cred.accessKeyId}/${scope},SignedHeaders=${names.join(';')},Signature=${signature}` };
}

export class S3DocumentStore implements DocumentStore {
  readonly kind = 's3' as const;
  private readonly cfg: Extract<DocumentStoreConfig, { backend: 's3' }>;
  fetchImpl: typeof fetch = fetch;
  constructor(cfg: Extract<DocumentStoreConfig, { backend: 's3' }>) {
    if (!/^https?:\/\//.test(cfg.endpoint)) throw new Error('s3 endpoint must be an http(s) URL');
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(cfg.bucket)) throw new Error('bad s3 bucket name');
    this.cfg = cfg;
  }
  private url(key: string): string {
    checkKey(key);
    const e = new URL(this.cfg.endpoint);
    const k = key.split('/').map((p) => enc(p)).join('/');
    if (this.cfg.pathStyle === false) return `${e.protocol}//${this.cfg.bucket}.${e.host}/${k}`;
    return `${e.protocol}//${e.host}${e.pathname.replace(/\/$/, '')}/${this.cfg.bucket}/${k}`;
  }
  private async send(method: string, key: string, body?: Buffer, extra: Record<string, string> = {}): Promise<Response> {
    const url = this.url(key);
    const headers = signV4({ method, url, headers: extra, payloadHash: sha256hex(body ?? Buffer.alloc(0)) }, this.cfg);
    delete (headers as Record<string, string>).host; // fetch sets it from the URL
    return this.fetchImpl(url, { method, headers, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  }
  async put(key: string, bytes: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    const r = await this.send('PUT', key, bytes, { 'content-type': contentType, 'content-length': String(bytes.length) });
    if (!r.ok) throw new Error(`s3 put ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  async get(key: string): Promise<Buffer | null> {
    const r = await this.send('GET', key);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`s3 get ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return Buffer.from(await r.arrayBuffer());
  }
  async delete(key: string): Promise<void> {
    const r = await this.send('DELETE', key);
    if (!r.ok && r.status !== 404) throw new Error(`s3 delete ${key}: ${r.status}`);
  }
}

export function createDocumentStore(cfg: DocumentStoreConfig): DocumentStore {
  return cfg.backend === 's3' ? new S3DocumentStore(cfg) : new LocalDocumentStore(cfg.dir);
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  return file ? readFileSync(file, 'utf8').trim() : env[name];
}

/**
 * The store a backend uses when its config names none: NEOP_DOCUMENTS_BACKEND=local|s3.
 *   local  NEOP_DOCUMENTS_DIR (default /var/lib/neop/files in production, a temp dir elsewhere)
 *   s3     NEOP_S3_ENDPOINT, NEOP_S3_BUCKET, NEOP_S3_REGION (default us-east-1),
 *          NEOP_S3_ACCESS_KEY_ID[_FILE], NEOP_S3_SECRET_ACCESS_KEY[_FILE], NEOP_S3_PATH_STYLE (default 1)
 */
export function documentStoreConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DocumentStoreConfig {
  if ((env.NEOP_DOCUMENTS_BACKEND ?? 'local') === 's3') {
    const need = (n: string) => {
      const v = envValue(env, n);
      if (!v) throw new Error(`NEOP_DOCUMENTS_BACKEND=s3 needs ${n}`);
      return v;
    };
    return {
      backend: 's3',
      endpoint: need('NEOP_S3_ENDPOINT'),
      bucket: need('NEOP_S3_BUCKET'),
      region: env.NEOP_S3_REGION ?? 'us-east-1',
      accessKeyId: need('NEOP_S3_ACCESS_KEY_ID'),
      secretAccessKey: need('NEOP_S3_SECRET_ACCESS_KEY'),
      pathStyle: env.NEOP_S3_PATH_STYLE !== '0',
    };
  }
  const dir = env.NEOP_DOCUMENTS_DIR ?? (env.NEOS_ENV === 'production' ? '/var/lib/neop/files' : path.join(os.tmpdir(), 'neop-documents'));
  return { backend: 'local', dir };
}
