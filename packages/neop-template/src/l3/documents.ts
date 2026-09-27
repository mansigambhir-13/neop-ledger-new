// L3 · documents.fetch — the bytes of a kept source document, for the platform only, which serves
// them to a signed-in person of that company (GET /api/documents/<app>/<sha256>?exp&sig). The
// call carries a gateway-signed, single-use token naming the company; the link's signature and
// expiry are this backend's own. Nothing here is reachable by the assistant or another app.

import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { Core } from '../core.ts';
import { fileMeta, storeFor, verifyDocumentLink } from '../doors/documents/files.ts';
import { AuthError } from './auth.ts';

export function documentsL3(core: Core): Hono {
  const app = new Hono();
  app.get('/l3/documents.fetch', async (c: Context) => {
    const h = c.req.header('authorization');
    let claims;
    try {
      claims = await core.gatewayAuth.verify(h?.startsWith('Bearer ') ? h.slice(7) : null, { ability: 'documents.fetch', contractVersion: c.req.header('contract-version') ?? null });
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: { code: e.code, message: e.message } }, e.status as 401);
      throw e;
    }
    if (claims.sub !== 'platform') return c.json({ error: { code: 'denied', message: 'only the platform fetches documents, for a person' } }, 403);
    if (!claims.company_id) return c.json({ error: { code: 'customer_mismatch', message: 'token carries no company' } }, 403);
    const sha256 = String(c.req.query('sha256') ?? '');
    const link = verifyDocumentLink(core.key, claims.company_id, sha256, c.req.query('exp'), c.req.query('sig'));
    if (link === 'expired') return c.json({ error: { code: 'link_expired', message: 'this download link has expired; ask for the document again' } }, 410);
    if (link !== 'ok') return c.json({ error: { code: 'bad_link', message: 'not a download link for this company and file' } }, 403);
    const meta = await core.company(claims.company_id, (db) => fileMeta(db, core.key, sha256));
    if (!meta) return c.json({ error: { code: 'not_found', message: 'no such document for this company' } }, 404);
    const bytes = await storeFor(core).get(meta.store_key);
    if (!bytes) return c.json({ error: { code: 'gone', message: 'the stored file is missing' } }, 410);
    if (createHash('sha256').update(bytes).digest('hex') !== meta.sha256) {
      core.log('stored document does not match its id', { sha256: meta.sha256 });
      return c.json({ error: { code: 'corrupt', message: 'the stored file does not match its id' } }, 500);
    }
    return c.json({ sha256: meta.sha256, filename: meta.filename, content_type: meta.content_type, bytes: meta.bytes, content_base64: bytes.toString('base64') });
  });
  return app;
}
