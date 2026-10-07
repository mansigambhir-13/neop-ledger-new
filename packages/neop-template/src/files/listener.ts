// THE FILES LISTENER · v3 S9. The backend's only HTTP surface besides the appservice push (presence/appservice.ts):
//   GET /files/<company>/<sha256>?exp&sig   a kept source document (WP §11), for a person's browser, with the signed,
//                                            short-lived link the app's own read handed out (ledger.document.get). The
//                                            link names one company, one file and an expiry, signed and checked by
//                                            this backend alone (doors/documents/files.ts); nothing else opens it.
//   GET /live · GET /ready                   liveness, and "can I reach my database" for the orchestrator.
//   GET /metrics                             Prometheus, behind NEOP_METRICS_TOKEN (closed without one, unless
//                                            NEOP_METRICS_PUBLIC=1 for local dev).
// The platform never calls any of this (there is no platform→app API): the desk reads the app on the database, and
// NeuralChat reaches it only as a typed Matrix event. The assistant cannot reach this listener (it is not on the
// agent's network, and it holds no link).

import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { Core } from '../core.ts';
import { fileMeta, storeFor, verifyDocumentLink } from '../doors/documents/files.ts';
import { renderBackendMetrics } from './metrics.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function filesApp(core: Core): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    core.log('files listener error', { error: (err as Error).message });
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });

  app.get('/live', (c) => c.json({ ok: true }));
  app.get('/ready', async (c) => {
    try {
      await Promise.all([core.appPool.query('select 1'), core.runnerPool.query('select 1')]);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });
  app.get('/metrics', async (c) => {
    const tok = process.env.NEOP_METRICS_TOKEN;
    if (tok) {
      if (c.req.header('authorization') !== `Bearer ${tok}`) return c.text('unauthorized', 401);
    } else if (process.env.NEOP_METRICS_PUBLIC !== '1') return c.text('not found', 404);
    return c.text(await renderBackendMetrics(core), 200, { 'content-type': 'text/plain; version=0.0.4' });
  });

  app.get('/files/:company/:sha256', async (c) => {
    const company = c.req.param('company');
    const sha256 = c.req.param('sha256');
    if (!UUID.test(company) || !/^[0-9a-f]{64}$/.test(sha256)) return c.json({ error: { code: 'bad_request', message: 'a company id and a sha256 are required' } }, 400);
    const link = verifyDocumentLink(core.key, company, sha256, c.req.query('exp'), c.req.query('sig'));
    if (link === 'expired') return c.json({ error: { code: 'link_expired', message: 'this download link has expired; ask for the document again' } }, 410);
    if (link !== 'ok') return c.json({ error: { code: 'bad_link', message: 'not a download link for this company and file' } }, 403);
    const meta = await core.company(company, (db) => fileMeta(db, core.key, sha256));
    if (!meta) return c.json({ error: { code: 'not_found', message: 'no such document for this company' } }, 404);
    const bytes = await storeFor(core).get(meta.store_key);
    if (!bytes) return c.json({ error: { code: 'gone', message: 'the stored file is missing' } }, 410);
    if (createHash('sha256').update(bytes).digest('hex') !== meta.sha256) {
      core.log('stored document does not match its id', { sha256: meta.sha256 });
      return c.json({ error: { code: 'corrupt', message: 'the stored file does not match its id' } }, 500);
    }
    core.metrics.inc('neop_documents_downloaded_total', 'Kept documents downloaded with a signed link', { app: core.key });
    const name = String(meta.filename).replace(/[\r\n"\\]/g, '_');
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': /^[\w.+-]+\/[\w.+-]+$/.test(meta.content_type) ? meta.content_type : 'application/octet-stream',
        'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  });

  return app;
}
