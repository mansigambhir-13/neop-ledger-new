// document-store.test · the two backends that keep attached files (WP §11): a local volume and
// an S3-compatible bucket spoken to with AWS Signature V4. Keys are always
// <schema>/<company_id>/<sha256>; nothing else is accepted, so a key cannot escape its prefix.
import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { documentKey, documentStoreConfigFromEnv, LocalDocumentStore, S3DocumentStore, signV4 } from '../src/doors/documents/store.ts';

const CO = '11111111-2222-3333-4444-555555555555';
const bytes = Buffer.from('%PDF-1.4 a bill\n');
const SHA = createHash('sha256').update(bytes).digest('hex');

describe('keys', () => {
  it('are <schema>/<company>/<sha256> and nothing else', () => {
    expect(documentKey('ledger', CO, SHA)).toBe(`ledger/${CO}/${SHA}`);
    expect(() => documentKey('../etc', CO, SHA)).toThrow();
    expect(() => documentKey('ledger', 'not-a-company', SHA)).toThrow();
    expect(() => documentKey('ledger', CO, '../../passwd')).toThrow();
  });
});

describe('local volume', () => {
  let dir: string;
  afterAll(async () => rm(dir, { recursive: true, force: true }));
  it('writes atomically, reads back, is content-addressed, deletes; refuses keys outside the shape', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'neop-store-'));
    const s = new LocalDocumentStore(dir);
    const key = documentKey('ledger', CO, SHA);
    expect(await s.get(key)).toBeNull();
    await s.put(key, bytes);
    await s.put(key, bytes); // the same file twice is one object
    expect(await s.get(key)).toEqual(bytes);
    expect(await readdir(path.join(dir, 'ledger', CO))).toEqual([SHA]); // no temp files left behind
    await expect(s.put(`ledger/${CO}/../../x`, bytes)).rejects.toThrow(/bad/);
    await s.delete(key);
    expect(await s.get(key)).toBeNull();
  });
  it('config from the environment: a volume by default, S3 when asked (and every S3 setting required)', () => {
    expect(documentStoreConfigFromEnv({ NEOP_DOCUMENTS_DIR: '/data/files' })).toEqual({ backend: 'local', dir: '/data/files' });
    expect(documentStoreConfigFromEnv({ NEOS_ENV: 'production' })).toEqual({ backend: 'local', dir: '/var/lib/neop/files' });
    expect(() => documentStoreConfigFromEnv({ NEOP_DOCUMENTS_BACKEND: 's3', NEOP_S3_ENDPOINT: 'http://minio:9000' })).toThrow(/NEOP_S3_BUCKET/);
    expect(
      documentStoreConfigFromEnv({ NEOP_DOCUMENTS_BACKEND: 's3', NEOP_S3_ENDPOINT: 'http://minio:9000', NEOP_S3_BUCKET: 'neop-files', NEOP_S3_ACCESS_KEY_ID: 'synthetic-a', NEOP_S3_SECRET_ACCESS_KEY: 'synthetic-b' }),
    ).toMatchObject({ backend: 's3', region: 'us-east-1', pathStyle: true });
  });
});

describe('S3 (Signature V4)', () => {
  it('signs exactly as AWS documents it (GET Object example, s3 SigV4 docs)', () => {
    const h = signV4(
      { method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { range: 'bytes=0-9' }, payloadHash: createHash('sha256').update('').digest('hex') },
      { accessKeyId: 'synthetic-AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'synthetic-wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' },
      new Date('2013-05-24T00:00:00Z'),
    );
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=synthetic-AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=3748cfac66d4a4a7a3f57b1c2a38f0e6d237f4b6b410fcedfff4eb6d6c16f74e',
    );
  });

  it('puts, gets, deletes against an S3-compatible server that checks every signature and payload hash', async () => {
    const cred = { accessKeyId: 'neop', secretAccessKey: 'neop-secret-key', region: 'ap-south-1' };
    const objects = new Map<string, { body: Buffer; type: string }>();
    const refused: string[] = [];
    // An independent verifier: recompute the signature from what arrived on the wire.
    const verify = (req: IncomingMessage, body: Buffer): boolean => {
      const auth = String(req.headers.authorization ?? '');
      const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request,SignedHeaders=([^,]+),Signature=([0-9a-f]{64})$/.exec(auth);
      if (!m || m[1] !== cred.accessKeyId || m[3] !== cred.region) return false;
      const payload = String(req.headers['x-amz-content-sha256']);
      if (payload !== createHash('sha256').update(body).digest('hex')) return false;
      const signed = m[4]!.split(';');
      if (!signed.includes('host') || !signed.includes('x-amz-date')) return false;
      const canonical = [req.method, req.url!.split('?')[0], '', signed.map((n) => `${n}:${String(req.headers[n]).trim()}\n`).join(''), m[4], payload].join('\n');
      const date = String(req.headers['x-amz-date']);
      const scope = `${m[2]}/${cred.region}/s3/aws4_request`;
      const k = [m[2]!, cred.region, 's3', 'aws4_request'].reduce<Buffer | string>((acc, part) => createHmac('sha256', acc).update(part).digest(), `AWS4${cred.secretAccessKey}`);
      const want = createHmac('sha256', k).update(['AWS4-HMAC-SHA256', date, scope, createHash('sha256').update(canonical).digest('hex')].join('\n')).digest('hex');
      return want === m[5];
    };
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (!verify(req, body)) {
          refused.push(`${req.method} ${req.url}`);
          return void res.writeHead(403).end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
        }
        const key = req.url!;
        if (req.method === 'PUT') objects.set(key, { body, type: String(req.headers['content-type']) });
        if (req.method === 'DELETE') objects.delete(key);
        if (req.method === 'GET') {
          const o = objects.get(key);
          return void (o ? res.writeHead(200, { 'content-type': o.type }).end(o.body) : res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>'));
        }
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as { port: number }).port;
      const s = new S3DocumentStore({ backend: 's3', endpoint: `http://127.0.0.1:${port}`, bucket: 'neop-files', ...cred });
      const key = documentKey('ledger', CO, SHA);
      expect(await s.get(key)).toBeNull();
      await s.put(key, bytes, 'application/pdf');
      expect(objects.get(`/neop-files/ledger/${CO}/${SHA}`)).toEqual({ body: bytes, type: 'application/pdf' });
      expect(await s.get(key)).toEqual(bytes);
      await s.delete(key);
      expect(objects.size).toBe(0);
      expect(refused).toEqual([]);
      // A wrong secret is refused by the server, and the store says so.
      const bad = new S3DocumentStore({ backend: 's3', endpoint: `http://127.0.0.1:${port}`, bucket: 'neop-files', ...cred, secretAccessKey: 'wrong' });
      await expect(bad.put(key, bytes)).rejects.toThrow(/s3 put .*: 403/);
    } finally {
      server.close();
    }
  });

  // Against a real S3-compatible server when one is given (e.g. a throwaway MinIO):
  //   NEOP_TEST_S3_ENDPOINT=http://127.0.0.1:9000 NEOP_TEST_S3_BUCKET=neop NEOP_TEST_S3_KEY=… NEOP_TEST_S3_SECRET=…
  it.skipIf(!process.env.NEOP_TEST_S3_ENDPOINT)('round-trips through a real S3-compatible server', async () => {
    const s = new S3DocumentStore({
      backend: 's3',
      endpoint: process.env.NEOP_TEST_S3_ENDPOINT!,
      bucket: process.env.NEOP_TEST_S3_BUCKET!,
      region: process.env.NEOP_TEST_S3_REGION ?? 'us-east-1',
      accessKeyId: process.env.NEOP_TEST_S3_KEY!,
      secretAccessKey: process.env.NEOP_TEST_S3_SECRET!,
    });
    const key = documentKey('ledger', CO, SHA);
    await s.put(key, bytes, 'application/pdf');
    expect(await s.get(key)).toEqual(bytes);
    await s.delete(key);
    expect(await s.get(key)).toBeNull();
  });
});
