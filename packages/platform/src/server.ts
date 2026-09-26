import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECISIONS, strictest, type Manifest, type Setting } from '@neop/contracts';
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

  app.get('/api/me', async (c) => {
    const u = await user(c);
    const co = (await p.db.query('select name, slug, time_zone from neos.companies where id = $1', [u.company_id])).rows[0];
    return c.json({ ...u, company: co ?? null });
  });

  // The company's people (the Team view). Tokens are never returned: only a hash is stored.
  app.get('/api/users', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    const r = await p.db.query('select id, name, email, role, created_at from neos.users where company_id = $1 order by created_at', [u.company_id]);
    return c.json({ users: r.rows });
  });

  app.get('/api/apps', async (c) => {
    await user(c);
    const r = await p.db.query("select key, manifest->>'name' as name, manifest->>'description' as description from neos.apps where status = 'active' order by key");
    return c.json({ apps: r.rows });
  });

  // What an installed app can do, with each ability's safety floor and the company's
  // current setting (including abilities switched off), for the controls screen.
  app.get('/api/apps/:app/abilities', async (c) => {
    const u = await user(c);
    const key = c.req.param('app');
    await p.assertInstalled(key, u.company_id);
    const r = await p.db.query<{ manifest: Manifest }>("select manifest from neos.apps where key = $1 and status = 'active'", [key]);
    if (!r.rows[0]) throw new PlatformError(404, 'not_found', 'no such app');
    const m = r.rows[0].manifest;
    const sb = await p.switchboard(u.company_id, key);
    const forced = new Set((sb.rules ?? []).filter((x: any) => x?.type === 'require_person').flatMap((x: any) => x.abilities ?? []));
    const inForce = (a: { key: string; kind: string; floor: Setting }) => {
      const s = strictest(a.floor, sb.settings?.[a.key]);
      return s === 'on' && a.kind === 'write' && forced.has(a.key) ? 'ask_first' : s;
    };
    const pkg = await p.packageAbilities(key, u.company_id);
    const doors = [...(await p.declaredDoors(key, u.company_id))];
    return c.json({
      switchboard_version: sb.version,
      abilities: [
        ...m.abilities.map((a) => ({
          key: a.key,
          title: a.title,
          description: a.description,
          kind: a.kind,
          floor: a.floor,
          company: sb.settings?.[a.key] ?? null,
          setting: inForce(a),
          forced_by_rule: forced.has(a.key),
          from: 'own',
          effects: a.effects ?? {},
          doors: a.doors ?? [],
        })),
        ...pkg.map((a) => ({
          key: a.key,
          title: a.key,
          description: `From the ${a.package} package (v${a.package_version})${a.install_status === 'pending_migration' ? ' — waiting for its migration to run' : ''}.`,
          kind: a.kind,
          floor: a.floor,
          company: sb.settings?.[a.key] ?? null,
          setting: inForce(a),
          forced_by_rule: forced.has(a.key),
          from: a.package,
          effects: {},
          doors: [],
        })),
      ],
      doors: doors.map((d) => ({ key: d, declared_by: (m.doors ?? []).some((x) => x.key === d) ? 'own' : 'package', scopes: (m.doors ?? []).find((x) => x.key === d)?.scopes ?? [] })),
    });
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
    const r = await p.db.query(
      `select t.*,
              (select coalesce(sum(cost_micros), 0)::bigint from neos.llm_usage l where l.job_id = t.job_id) as cost_micros,
              (select count(*)::int from neos.approvals a where a.job_id = t.job_id and a.status = 'PENDING') as pending_approvals,
              (select count(*)::int from neos.activity v where v.job_id = t.job_id and v.company_id = t.company_id) as steps
         from neos.tasks t where t.company_id = $1 order by t.created_at desc limit $2`,
      [u.company_id, Math.min(Number(c.req.query('limit') ?? 50) || 50, 200)],
    );
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
    const job = t.rows[0].job_id;
    const approvals = job
      ? await p.db.query(
          `select a.id, a.proposal_id, a.ability_key, a.args, a.card, a.fingerprint, a.expires_at, a.status, a.decision, a.feedback, a.decided_at, a.fingerprint_seen, a.proof, a.last_error, a.created_at, du.name as decided_by_name
             from neos.approvals a left join neos.users du on du.id = a.decided_by where a.job_id = $1 and a.company_id = $2 order by a.created_at`,
          [job, u.company_id],
        )
      : { rows: [] };
    const cost = job
      ? await p.db.query(`select coalesce(sum(cost_micros), 0)::bigint as micros, count(*)::int as calls, coalesce(sum(input_tokens + output_tokens), 0)::bigint as tokens from neos.llm_usage where job_id = $1 and company_id = $2`, [job, u.company_id])
      : { rows: [{ micros: 0, calls: 0, tokens: 0 }] };
    const grants = job
      ? await p.db.query(`select at, ability_key, detail from neos.audit where action = 'grant.used' and company_id = $1 and detail->>'job_id' = $2 order by at`, [u.company_id, job])
      : { rows: [] };
    const c0 = cost.rows[0];
    return c.json({ task: t.rows[0], messages: msgs.rows, activity: act.rows, approvals: approvals.rows, grant_uses: grants.rows, cost: { usd: Number(c0.micros) / 1e6, calls: c0.calls, tokens: Number(c0.tokens) } });
  });

  app.get('/api/desk', async (c) => {
    const u = await user(c);
    const r = await p.db.query(
      `select a.id, a.app_key, a.proposal_id, a.job_id, a.task_id, a.ability_key, a.args, a.card, a.fingerprint, a.expires_at, a.status, a.decision, a.feedback,
              a.decided_at, a.fingerprint_seen, du.name as decided_by_name, a.proof, a.last_error, a.created_at, t.ask as task_ask, t.requester as task_requester
         from neos.approvals a left join neos.users du on du.id = a.decided_by left join neos.tasks t on t.id = a.task_id
        where a.company_id = $1 order by (a.status = 'PENDING') desc, a.created_at desc limit 200`,
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

  // Standing yeses (WP §5): "always do this within these limits". Admins create and withdraw
  // them; everyone can see them and what they have been used for this month.
  app.get('/api/grants', async (c) => {
    const u = await user(c);
    const r = await p.db.query(
      `select g.id, g.app_key, g.ability_key, g.limits, g.status, g.expires_at, g.created_at, g.suspended_reason,
              cu.name as created_by_name,
              (select count(*)::int from neos.audit a where a.action = 'grant.used' and a.detail->>'grant_id' = g.id::text) as uses,
              (select coalesce(sum((a.detail->>'amount_minor')::bigint), 0)::bigint from neos.audit a
                where a.action = 'grant.used' and a.detail->>'grant_id' = g.id::text and a.at >= date_trunc('month', now())) as used_this_month_minor,
              (select max(a.at) from neos.audit a where a.action = 'grant.used' and a.detail->>'grant_id' = g.id::text) as last_used_at
         from neos.grants g left join neos.users cu on cu.id = g.created_by
        where g.company_id = $1 order by (g.status = 'ACTIVE') desc, g.created_at desc`,
      [u.company_id],
    );
    return c.json({ grants: r.rows.map((g) => ({ ...g, used_this_month_minor: Number(g.used_this_month_minor), expired: new Date(g.expires_at) <= new Date() })) });
  });
  app.post('/api/grants', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    const b = await c.req.json().catch(() => ({}));
    const appRow = (await p.db.query<{ manifest: Manifest }>('select manifest from neos.apps where key = $1', [b.app_key])).rows[0];
    if (!appRow) throw new PlatformError(404, 'not_found', 'no such app');
    await p.assertInstalled(b.app_key, u.company_id);
    const a = appRow.manifest.abilities.find((x) => x.key === b.ability_key);
    if (!a || a.kind !== 'write') throw new PlatformError(422, 'not_grantable', 'a standing yes covers one write ability of the app');
    const L = b.limits ?? {};
    for (const k of ['per_call_minor', 'per_month_minor']) {
      if (L[k] !== undefined && !(Number.isInteger(L[k]) && L[k] > 0)) throw new PlatformError(422, 'bad_limits', `${k} must be a positive whole number of minor units`);
    }
    if ((L.per_call_minor !== undefined || L.per_month_minor !== undefined) && !/^[A-Z]{3}$/.test(String(L.currency ?? ''))) {
      throw new PlatformError(422, 'bad_limits', 'an amount limit needs a currency');
    }
    if (a.effects?.money && L.per_call_minor === undefined && L.per_month_minor === undefined) {
      throw new PlatformError(422, 'bad_limits', 'a standing yes for money needs an amount limit');
    }
    if (L.recipients_allow !== undefined && (!Array.isArray(L.recipients_allow) || !L.recipients_allow.every((x: unknown) => typeof x === 'string' && /@/.test(x as string)))) {
      throw new PlatformError(422, 'bad_limits', 'recipients_allow must list email addresses');
    }
    const exp = new Date(b.expires_at);
    if (!(exp.getTime() > Date.now()) || exp.getTime() > Date.now() + 366 * 864e5) throw new PlatformError(422, 'bad_expiry', 'a standing yes must expire within a year');
    const limits = Object.fromEntries(['per_call_minor', 'per_month_minor', 'currency', 'recipients_allow'].filter((k) => L[k] !== undefined).map((k) => [k, L[k]]));
    const id = await p.createGrant({ company_id: u.company_id, app_key: b.app_key, ability_key: b.ability_key, limits, expires_at: exp, created_by: u.id });
    await p.gateway.audit({ company_id: u.company_id, actor: `user:${u.id}`, app_key: b.app_key, action: 'grant.created', ability_key: b.ability_key, outcome: id, detail: { limits, expires_at: exp.toISOString() } });
    return c.json({ id });
  });
  app.delete('/api/grants/:id', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    const r = await p.db.query(`update neos.grants set status = 'REVOKED' where id = $1 and company_id = $2 and status <> 'REVOKED' returning app_key, ability_key`, [c.req.param('id'), u.company_id]);
    if (!r.rows[0]) throw new PlatformError(404, 'not_found', 'no such standing yes');
    await p.gateway.audit({ company_id: u.company_id, actor: `user:${u.id}`, app_key: r.rows[0].app_key, action: 'grant.revoked', ability_key: r.rows[0].ability_key, outcome: c.req.param('id') });
    return c.json({ ok: true });
  });

  // Which other apps may ask an app for what (borrowing and tasks, WP §9–10).
  app.get('/api/acl', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    const r = await p.db.query(
      `select a.caller_app, a.target_app, a.ability_key, a.granted_at, gu.name as granted_by_name
         from neos.acl a left join neos.users gu on gu.id::text = a.granted_by::text
        where a.company_id = $1 and ($2::text is null or a.target_app = $2 or a.caller_app = $2) order by a.granted_at desc`,
      [u.company_id, c.req.query('app') ?? null],
    );
    const apps = await p.db.query(`select a.key, a.manifest->>'name' as name from neos.installs i join neos.apps a on a.key = i.app_key where i.company_id = $1 and i.status = 'active' order by a.key`, [u.company_id]);
    return c.json({ acl: r.rows, installed_apps: apps.rows });
  });

  // One audit trail (WP §8): every effectful call and every governance change, newest first.
  app.get('/api/audit', async (c) => {
    const u = await user(c);
    if (u.role !== 'admin') throw new PlatformError(403, 'denied', 'admins only');
    const q = c.req.query();
    const limit = Math.min(Math.max(Number(q.limit ?? 100) || 100, 1), 500);
    const r = await p.db.query(
      `select id, at, actor, app_key, action, ability_key, idem_key, request_id, outcome, detail from neos.audit
        where company_id = $1
          and ($2::text is null or app_key = $2) and ($3::text is null or action like $3 || '%')
          and ($4::text is null or actor = $4) and ($5::bigint is null or id < $5)
        order by id desc limit $6`,
      [u.company_id, q.app ?? null, q.action ?? null, q.actor ?? null, q.before ?? null, limit],
    );
    const actors = [...new Set(r.rows.map((x) => x.actor).filter((a: string) => a?.startsWith('user:')).map((a: string) => a.slice(5)))];
    const names = actors.length ? (await p.db.query('select id, name from neos.users where id = any($1::uuid[])', [actors])).rows : [];
    const byId = new Map(names.map((n) => [String(n.id), n.name]));
    return c.json({ rows: r.rows.map((x) => ({ ...x, id: Number(x.id), actor_name: x.actor?.startsWith('user:') ? (byId.get(x.actor.slice(5)) ?? null) : null })), next_before: r.rows.length === limit ? Number(r.rows.at(-1).id) : null });
  });

  // The registry as a person sees it (WP §10): what can be added, what it offers and needs,
  // signed versions, and what this company has pinned.
  app.get('/api/registry/catalog', async (c) => {
    const u = await user(c);
    const entries = await p.db.query(
      `select key, version, kind, owner_app, offers, requires, status, platform_sig is not null as signed, content_hash, published_at, deprecated_at
         from neos.registry_entries where status in ('published', 'deprecated') order by key, published_at desc nulls last`,
    );
    const installs = await p.db.query('select host_app, entry_key, pinned_version, status, installed_at from neos.registry_installs where company_id = $1', [u.company_id]);
    const byKey = new Map<string, any>();
    for (const e of entries.rows) {
      const cur = byKey.get(e.key);
      if (!cur) byKey.set(e.key, { ...e, versions: [e.version] });
      else cur.versions.push(e.version);
    }
    return c.json({
      entries: [...byKey.values()].map((e) => {
        const inst = installs.rows.filter((i) => i.entry_key === e.key);
        return { ...e, latest: e.version, installs: inst, update_available: inst.some((i) => i.pinned_version !== e.version) };
      }),
    });
  });

  // Every switchboard version (WP §4: "change the list and the next call behaves differently").
  app.get('/api/switchboards/:app/history', async (c) => {
    const u = await user(c);
    const r = await p.db.query(
      `select s.version, s.updated_at, s.settings, s.rules, s.budget, s.approvals, uu.name as updated_by_name
         from neos.switchboards s left join neos.users uu on uu.id::text = s.updated_by::text
        where s.company_id = $1 and s.app_key = $2 order by s.version desc limit 50`,
      [u.company_id, c.req.param('app')],
    );
    return c.json({ versions: r.rows });
  });

  // What the assistant has cost: today (company time zone) and this month, against the caps.
  app.get('/api/usage/:app', async (c) => {
    const u = await user(c);
    const sb = await p.switchboard(u.company_id, c.req.param('app'));
    const tz = sb.company.time_zone;
    const r = await p.db.query(
      `select coalesce(sum(cost_micros) filter (where (at at time zone $3)::date = (now() at time zone $3)::date), 0)::bigint as today,
              coalesce(sum(cost_micros) filter (where date_trunc('month', at at time zone $3) = date_trunc('month', now() at time zone $3)), 0)::bigint as month,
              count(*) filter (where outcome = 'refused_budget' and (at at time zone $3)::date = (now() at time zone $3)::date)::int as refused_today,
              coalesce(sum(input_tokens + output_tokens) filter (where (at at time zone $3)::date = (now() at time zone $3)::date), 0)::bigint as tokens_today
         from neos.llm_usage where company_id = $1 and app_key = $2`,
      [u.company_id, c.req.param('app'), tz],
    );
    const x = r.rows[0];
    return c.json({
      today_usd: Number(x.today) / 1e6,
      month_usd: Number(x.month) / 1e6,
      tokens_today: Number(x.tokens_today),
      refused_today: x.refused_today,
      per_job_cap_usd: Number(sb.budget?.per_job_usd ?? 5),
      per_day_cap_usd: Number(sb.budget?.per_day_usd ?? 50),
    });
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
