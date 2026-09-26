import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECISIONS } from '@neop/contracts';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { GatewayError } from './gateway.ts';
import { Platform, PlatformError } from './platform.ts';

const DESK_HTML = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'desk.html'), 'utf8');

const PLATFORM_ENDPOINTS = ['tasks.open', 'inbox.deliver', 'proposals.resolve', 'proposals.execute', 'outbox.read', 'outbox.ack', 'switchboard.changed', 'tasks.cancel', 'tasks.result', 'manifest'];

export function platformApp(p: Platform): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof PlatformError || err instanceof GatewayError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    p.log('error', { e: String(err), stack: (err as Error).stack });
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });

  app.get('/', (c) => c.html(DESK_HTML));
  app.get('/.well-known/jwks.json', (c) => c.json(p.gateway.jwks()));
  app.get('/.well-known/registry-jwks.json', (c) => c.json(p.registry.jwks()));
  app.get('/live', (c) => c.json({ ok: true }));
  app.get('/metrics', async (c) => {
    // Closed unless a scrape token is configured (or explicitly opened for local dev): it carries company ids and spend.
    const tok = process.env.NEOS_METRICS_TOKEN;
    if (tok) {
      if (c.req.header('authorization') !== `Bearer ${tok}`) return c.text('unauthorized', 401);
    } else if (process.env.NEOS_METRICS_PUBLIC !== '1') return c.text('not found', 404);
    return c.text(await p.renderMetrics(), 200, { 'content-type': 'text/plain; version=0.0.4' });
  });

  // ── internal: app backends, authenticated with their service secret ──────
  const service = async (c: Context): Promise<string> => {
    const key = await p.authService(c.req.header('authorization'));
    if (!key) throw new PlatformError(401, 'unauthenticated', 'service credentials required');
    return key;
  };
  app.get('/internal/switchboard', async (c) => {
    const key = await service(c);
    await p.assertInstalled(key, c.req.query('company_id') ?? '');
    return c.json(await p.switchboard(c.req.query('company_id') ?? '', key));
  });
  app.post('/internal/grants/execution-token', async (c) => {
    const key = await service(c);
    const b = await c.req.json();
    const out = await p.grantExecutionToken(key, b);
    return out ? c.json(out) : c.json({ error: { code: 'no_grant', message: 'no grant covers this' } }, 404);
  });
  app.post('/internal/borrow/describe', async (c) => {
    const key = await service(c);
    return c.json(await p.borrowDescribe(key, await c.req.json()));
  });
  app.post('/internal/gateway/call', async (c) => {
    const key = await service(c);
    const res = await p.internalCall(key, await c.req.json());
    return c.json({ status: res.status, body: res.body, request_id: res.request_id });
  });
  app.post('/internal/a2a/open', async (c) => {
    const key = await service(c);
    return c.json(await p.openA2ATask(key, await c.req.json()));
  });
  // Registry: an app publishes its own skills; hosts fetch what their company pinned, and artifacts by hash.
  app.post('/internal/registry/publish', async (c) => {
    const key = await service(c);
    const b = await c.req.json();
    return c.json(await p.registry.submit(`app:${key}`, { kind: 'skill', key: b.key, version: b.version, owner_app: key, body: b.body, requires: b.requires ?? [] }));
  });
  app.get('/internal/registry/entries', async (c) => {
    const key = await service(c);
    await p.assertInstalled(key, c.req.query('company_id') ?? '');
    return c.json({ entries: await p.registry.forHost(key, c.req.query('company_id') ?? '') });
  });
  app.get('/internal/registry/artifacts/:hash', async (c) => {
    await service(c);
    const bytes = await p.registry.artifact(c.req.param('hash'));
    if (!bytes) throw new PlatformError(404, 'not_found', 'no such artifact');
    return c.json({ hash: c.req.param('hash'), base64: bytes.toString('base64') });
  });
  app.post('/internal/llm/session', async (c) => {
    const key = await service(c);
    const b = await c.req.json();
    return c.json(await p.llmSession(key, b));
  });
  app.post('/internal/vault/lend', async (c) => {
    const key = await service(c);
    const b = await c.req.json();
    return c.json({ secret: await p.lend(key, b.company_id, b.door), ttl_s: 60 });
  });

  // ── the NEOS app and desk, authenticated as a person ────────────────────
  const user = async (c: Context) => {
    const u = await p.authUser(c.req.header('authorization'));
    if (!u) throw new PlatformError(401, 'unauthenticated', 'sign in required');
    return u;
  };

  app.get('/api/me', async (c) => c.json(await user(c)));

  app.get('/api/apps', async (c) => {
    await user(c);
    const r = await p.db.query("select key, manifest->>'name' as name, manifest->>'description' as description from neos.apps where status = 'active' order by key");
    return c.json({ apps: r.rows });
  });

  // Steps 1–6: stored in the conversation → NeuralChat picks an installed app → task row → tasks.open. Never blocks on the job.
  app.post('/api/ask', async (c) => {
    const u = await user(c);
    const b = await c.req.json().catch(() => ({}));
    if (typeof b.text !== 'string' || !b.text.trim()) throw new PlatformError(400, 'bad_request', 'text required');
    return c.json(await p.ask(u, b.text, { app: typeof b.app === 'string' ? b.app : undefined, conversation_id: typeof b.conversation_id === 'string' ? b.conversation_id : undefined }));
  });

  // (5a) What NeuralChat sees: installed apps, what each can do, which need a yes.
  app.get('/api/registry', async (c) => {
    const u = await user(c);
    return c.json({ apps: await p.registryContext(u.company_id) });
  });

  app.post('/api/installs/:app', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    await p.installApp(u.company_id, c.req.param('app'), u.id);
    return c.json({ ok: true });
  });

  app.get('/api/conversations/:id', async (c) => {
    const u = await user(c);
    return c.json(await p.conversation(u, c.req.param('id')));
  });

  // (9) The answer, pushed: server-sent events for one conversation (R15).
  // EventSource cannot send headers: the client first gets a 5-minute token for one conversation
  // (never the person's long-lived credential in a URL, where proxies log it).
  app.post('/api/conversations/:id/stream-token', async (c) => {
    const u = await user(c);
    await p.conversation(u, c.req.param('id'));
    const token = await p.gateway.sign({ conversation_id: c.req.param('id'), company_id: u.company_id }, 'neos-stream', `user:${u.id}`, 300);
    return c.json({ token, expires_in: 300 });
  });

  app.get('/api/conversations/:id/events', async (c) => {
    const st = c.req.query('st');
    let u: { id: string; company_id: string };
    if (st) {
      const { jwtVerify, createLocalJWKSet } = await import('jose');
      try {
        const { payload } = await jwtVerify(st, createLocalJWKSet(p.gateway.jwks() as any), { issuer: 'neos-gateway', audience: 'neos-stream', algorithms: ['EdDSA'] });
        if (payload.conversation_id !== c.req.param('id')) throw new Error('wrong conversation');
        u = { id: String(payload.sub).slice(5), company_id: String(payload.company_id) };
      } catch {
        throw new PlatformError(401, 'unauthenticated', 'stream token invalid or expired');
      }
    } else {
      u = await user(c);
    }
    await p.conversation(u, c.req.param('id')); // ownership check
    let last = Number(c.req.query('after') ?? c.req.header('last-event-id') ?? 0);
    return streamSSE(c, async (stream) => {
      const until = Date.now() + 10 * 60_000;
      while (!stream.aborted && Date.now() < until) {
        const rows = (
          await p.db.query('select id, author, kind, body, task_id, at from neos.conversation_messages where conversation_id = $1 and id > $2 order by id limit 100', [
            c.req.param('id'),
            last,
          ])
        ).rows;
        for (const m of rows) {
          last = Number(m.id);
          await stream.writeSSE({ id: String(m.id), event: m.kind, data: JSON.stringify(m) });
        }
        if (!rows.length) await stream.writeSSE({ event: 'ping', data: '{}' });
        await stream.sleep(rows.length ? 50 : 1000);
      }
    });
  });

  app.get('/api/dead-letters', async (c) => {
    const u = await user(c);
    if (u.role === 'member') throw new PlatformError(403, 'denied', 'admins only');
    return c.json({ dead_letters: await p.deadLetters(u.company_id) });
  });
  app.post('/api/dead-letters/:app/:id/replay', async (c) => {
    const u = await user(c);
    if (u.role === 'member') throw new PlatformError(403, 'denied', 'admins only');
    await p.replayDeadLetter(u.company_id, c.req.param('app'), Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  // Platform operators rotate the gateway signing key (R10).
  app.post('/api/ops/keys/rotate', async (c) => {
    const u = await user(c);
    if (u.role !== 'operator') throw new PlatformError(403, 'denied', 'operators only');
    // Publish now; start signing only after every app's JWKS cache (≤ 60 s) has refreshed.
    const k = await p.gateway.keys.rotate();
    const b = await c.req.json().catch(() => ({}));
    const delay = Math.max(0, Number(b.activate_after_ms ?? 120_000));
    setTimeout(() => void p.gateway.keys.activate().catch((e) => p.log('key activation failed', { e: String(e) })), delay).unref?.();
    await p.gateway.audit({ company_id: null, actor: `user:${u.id}`, action: 'gateway.key_published', outcome: k.kid, detail: { activate_after_ms: delay } });
    return c.json({ next: k.kid, activates_in_ms: delay });
  });

  app.post('/api/tasks/:id/cancel', async (c) => {
    const u = await user(c);
    const b = await c.req.json().catch(() => ({}));
    return c.json(await p.cancelTask(u, c.req.param('id'), typeof b.reason === 'string' ? b.reason : undefined));
  });

  app.get('/api/tasks', async (c) => {
    const u = await user(c);
    const r = await p.db.query('select * from neos.tasks where company_id = $1 order by created_at desc limit 50', [u.company_id]);
    return c.json({ tasks: r.rows });
  });

  app.get('/api/tasks/:id', async (c) => {
    const u = await user(c);
    const t = await p.db.query('select * from neos.tasks where id = $1 and company_id = $2', [c.req.param('id'), u.company_id]);
    if (!t.rows[0]) throw new PlatformError(404, 'not_found', 'no such task');
    const msgs = await p.db.query('select author, kind, body, task_id, at from neos.conversation_messages where task_id = $1 order by id', [t.rows[0].id]);
    const act = t.rows[0].job_id
      ? await p.db.query('select seq, kind, summary, at from neos.activity where job_id = $1 and company_id = $2 order by seq', [t.rows[0].job_id, u.company_id])
      : { rows: [] };
    return c.json({ task: t.rows[0], messages: msgs.rows, activity: act.rows });
  });

  app.get('/api/desk', async (c) => {
    const u = await user(c);
    const r = await p.db.query(
      `select id, app_key, proposal_id, job_id, task_id, ability_key, args, card, fingerprint, expires_at, status, decision, proof, last_error, created_at
         from neos.approvals where company_id = $1 order by (status = 'PENDING') desc, created_at desc limit 100`,
      [u.company_id],
    );
    return c.json({ cards: r.rows });
  });

  app.post('/api/desk/:id/answer', async (c) => {
    const u = await user(c);
    const b = await c.req.json().catch(() => ({}));
    if (!DECISIONS.includes(b.decision)) throw new PlatformError(400, 'bad_request', `decision must be one of ${DECISIONS.join(', ')}`);
    if (typeof b.fingerprint_seen !== 'string') throw new PlatformError(400, 'bad_request', 'fingerprint_seen required: a yes binds to what you saw');
    if (b.decision === 'change' && (typeof b.feedback !== 'string' || !b.feedback.trim())) throw new PlatformError(400, 'bad_request', 'say what to change');
    await p.answer(c.req.param('id'), u, b);
    return c.json({ ok: true });
  });

  app.get('/api/switchboards/:app', async (c) => {
    const u = await user(c);
    return c.json(await p.switchboard(u.company_id, c.req.param('app')));
  });
  app.put('/api/switchboards/:app', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    const b = await c.req.json();
    return c.json({ version: await p.setSwitchboard(u.company_id, c.req.param('app'), u.id, b) });
  });

  // A company admin configures a door's provider credentials (Resend, GSP …). Write-only:
  // the platform never returns a secret; apps borrow it per call through the vault.
  app.put('/api/vault/:door', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    const door = c.req.param('door');
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(door)) throw new PlatformError(400, 'bad_request', 'door name');
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b !== 'object' || typeof b.provider !== 'string') throw new PlatformError(400, 'bad_request', 'a secret object with a provider is required');
    await p.setVaultSecret(u.company_id, door, b);
    await p.gateway.audit({ company_id: u.company_id, actor: `user:${u.id}`, action: 'vault.set', ability_key: door, outcome: b.provider });
    return c.json({ ok: true, door, provider: b.provider });
  });
  app.get('/api/vault', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    const r = await p.db.query('select door, updated_at from neos.vault_secrets where company_id = $1 order by door', [u.company_id]);
    return c.json({ doors: r.rows }); // names and dates only
  });

  app.post('/api/acl', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    await p.grantAcl(u, await c.req.json());
    return c.json({ ok: true });
  });
  app.delete('/api/acl', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    await p.revokeAcl(u, await c.req.json());
    return c.json({ ok: true });
  });

  app.post('/api/registry/packages', async (c) => {
    const u = await user(c);
    if (u.role !== 'operator') throw new PlatformError(403, 'denied', 'operators only');
    const b = await c.req.json();
    return c.json(await p.registry.submit(`user:${u.id}`, { kind: 'package', key: b.bundle?.manifest?.key, version: b.bundle?.manifest?.version, bundle: b.bundle }));
  });
  app.get('/api/registry/reviews', async (c) => {
    const u = await user(c);
    if (u.role !== 'operator') throw new PlatformError(403, 'denied', 'operators only');
    const r = await p.db.query("select * from neos.registry_reviews where status = 'PENDING' order by created_at");
    return c.json({ reviews: r.rows });
  });
  app.post('/api/registry/reviews/:id/answer', async (c) => {
    const u = await user(c);
    return c.json(await p.registry.review(u, c.req.param('id'), await c.req.json()));
  });
  app.post('/api/registry/installs', async (c) => {
    const u = await user(c);
    return c.json(await p.registry.install(u, await c.req.json()));
  });
  app.post('/api/registry/deprecate', async (c) => {
    const u = await user(c);
    const b = await c.req.json();
    await p.registry.deprecate(u, b.key, b.version);
    return c.json({ ok: true });
  });
  app.post('/api/registry/retire', async (c) => {
    const u = await user(c);
    const b = await c.req.json();
    await p.registry.retire(u, b.key, b.version);
    return c.json({ ok: true });
  });

  app.post('/api/grants', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    const b = await c.req.json();
    const id = await p.createGrant({ company_id: u.company_id, app_key: b.app_key, ability_key: b.ability_key, limits: b.limits ?? {}, expires_at: new Date(b.expires_at), created_by: u.id });
    return c.json({ id });
  });
  app.delete('/api/grants/:id', async (c) => {
    const u = await user(c);
    await p.db.query(`update neos.grants set status = 'REVOKED' where id = $1 and company_id = $2`, [c.req.param('id'), u.company_id]);
    return c.json({ ok: true });
  });

  // Reads for blocks (home tile, desk list): through the gateway, as the person.
  app.post('/api/apps/:app/read/:ability', async (c) => {
    const u = await user(c);
    if (PLATFORM_ENDPOINTS.includes(c.req.param('ability'))) throw new PlatformError(403, 'denied', 'that is not a read');
    const res = await p.gateway.call({
      caller: `user:${u.id}`,
      app: c.req.param('app'),
      endpoint: c.req.param('ability'),
      company_id: u.company_id,
      body: await c.req.json().catch(() => ({})),
      idem_key: `read:${crypto.randomUUID()}`,
    });
    return c.json(res.body, res.status as 200);
  });

  return app;
}
