// L3 · the app's private HTTP surface. Only the gateway reaches it (network
// policy), and every call carries a gateway-signed, single-use token (B4).

import type { GatewayClaims } from '@neop/contracts';
import { Hono, type Context } from 'hono';
import { ExecError, executeProposal } from '../capabilities/execute.ts';
import { cancelJob } from '../capabilities/platform/tasks.cancel.ts';
import { openJob, requesterMatches, validateOpen } from '../capabilities/platform/tasks.open.ts';
import { readOutbox } from '../capabilities/platform/outbox.read.ts';
import { resolveProposal, validateResolve } from '../capabilities/platform/proposals.resolve.ts';
import type { Core } from '../core.ts';
import { renderBackendMetrics } from './metrics.ts';
import { AuthError } from './auth.ts';

function bearer(c: Context): string | null {
  const h = c.req.header('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

export function l3App(core: Core): Hono {
  const app = new Hono();

  const authed = async (c: Context, ability: string, needCompany = true): Promise<GatewayClaims> => {
    const claims = await core.gatewayAuth.verify(bearer(c), { ability, contractVersion: c.req.header('contract-version') ?? null });
    if (needCompany && !claims.company_id) throw new AuthError(403, 'customer_mismatch', 'token carries no company');
    if (claims.company_id && claims.sb_version) {
      // A token minted after a switchboard change forces a refetch before the call.
      const cur = await core.board.get(claims.company_id).catch(() => null);
      if (cur && cur.version < claims.sb_version) core.board.invalidate(claims.company_id);
    }
    return claims;
  };

  app.onError((err, c) => {
    if (err instanceof AuthError || err instanceof ExecError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    }
    core.log('l3 error', { error: (err as Error).message });
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });

  // One span per L3 call, continuing the gateway's trace (R13).
  app.use('/l3/*', async (c, next) => {
    if (c.req.path === '/l3/live' || c.req.path === '/l3/ready') return next();
    const endpoint = c.req.path.replace('/l3/', '');
    const span = core.tracer.start(`l3 ${endpoint.startsWith('abilities/') ? 'ability' : endpoint}`, c.req.header('traceparent') ?? null, { 'neop.app': core.key, 'neop.endpoint': endpoint });
    c.set('trace' as never, span.header() as never);
    const t0 = process.hrtime.bigint();
    try {
      await next();
      span.set('http.status', c.res.status).end(c.res.status >= 500 ? 'error' : 'ok');
    } catch (e) {
      span.end('error', String(e));
      throw e;
    } finally {
      if (endpoint === 'tasks.open' || endpoint === 'inbox.deliver') {
        core.metrics.observe('neop_job_ack_seconds', 'Time to acknowledge a new job (inbound → job + ack)', Number(process.hrtime.bigint() - t0) / 1e9, { app: core.key });
      }
    }
  });
  const trace = (c: Context): string | null => (c.get('trace' as never) as unknown as string) ?? null;

  app.get('/l3/live', (c) => c.json({ ok: true }));
  app.get('/l3/metrics', async (c) => {
    const tok = process.env.NEOP_METRICS_TOKEN;
    if (tok) {
      if (c.req.header('authorization') !== `Bearer ${tok}`) return c.text('unauthorized', 401);
    } else if (process.env.NEOP_METRICS_PUBLIC !== '1') return c.text('not found', 404);
    return c.text(await renderBackendMetrics(core), 200, { 'content-type': 'text/plain; version=0.0.4' });
  });
  app.get('/l3/ready', async (c) => {
    try {
      await Promise.all([core.appPool.query('select 1'), core.runnerPool.query('select 1')]);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  app.get('/l3/manifest', async (c) => {
    await authed(c, 'manifest', false);
    return c.json(core.manifest);
  });

  app.post('/l3/tasks.open', async (c) => {
    const claims = await authed(c, 'tasks.open');
    const body = await c.req.json().catch(() => null);
    const bad = validateOpen(body);
    if (bad) return c.json({ error: { code: 'bad_request', message: bad } }, 400);
    if (claims.sub.startsWith('user:')) return c.json({ error: { code: 'denied', message: 'people ask through the platform, not by opening jobs' } }, 403);
    if (!requesterMatches(claims, body.requester)) return c.json({ error: { code: 'denied', message: 'caller cannot speak for that requester' } }, 403);
    const source = claims.sub.startsWith('app:') ? 'a2a' : 'task';
    return c.json(await openJob(core, claims.company_id!, { ...body, source, trace: trace(c) }));
  });

  // Phase 3 path, live now: the appservice turns a room event into a signed call.
  app.post('/l3/inbox.deliver', async (c) => {
    const claims = await authed(c, 'inbox.deliver');
    if (claims.sub !== 'platform') return c.json({ error: { code: 'denied', message: 'only the platform appservice delivers room messages' } }, 403);
    const b = await c.req.json().catch(() => null);
    // The bridge has already mapped the room sender to a person and opened a task row for it.
    const bad = validateOpen(b ? { task_id: b.task_id, ask: b.text, requester: b.sender } : null);
    if (bad || typeof b.event_id !== 'string' || !String(b.sender).startsWith('user:')) {
      return c.json({ error: { code: 'bad_request', message: bad ?? 'event_id and a person sender (user:<id>) required' } }, 400);
    }
    return c.json(await openJob(core, claims.company_id!, { task_id: b.task_id, ask: b.text, requester: b.sender, source: 'room', trace: trace(c) }));
  });

  app.post('/l3/tasks.cancel', async (c) => {
    const claims = await authed(c, 'tasks.cancel');
    if (claims.sub !== 'platform') return c.json({ error: { code: 'denied', message: 'only the platform cancels on a person\'s behalf' } }, 403);
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b.task_id !== 'string' || typeof b.by !== 'string' || !b.by.startsWith('user:')) {
      return c.json({ error: { code: 'bad_request', message: 'task_id and by (user:<id>) required' } }, 400);
    }
    return c.json(await cancelJob(core, claims.company_id!, b));
  });

  app.post('/l3/proposals.resolve', async (c) => {
    const claims = await authed(c, 'proposals.resolve');
    if (claims.sub !== 'platform') return c.json({ error: { code: 'denied', message: 'only the platform records answers' } }, 403);
    const body = await c.req.json().catch(() => null);
    const bad = validateResolve(body);
    if (bad) return c.json({ error: { code: 'bad_request', message: bad } }, 400);
    return c.json(await resolveProposal(core, claims.company_id!, body));
  });

  app.post('/l3/proposals.execute', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.proposal_id !== 'string') return c.json({ error: { code: 'bad_request', message: 'proposal_id required' } }, 400);
    const tok = bearer(c);
    const pre = await core.gatewayAuth.verify(tok, { ability: 'proposals.execute', contractVersion: c.req.header('contract-version') ?? null });
    if (!pre.exec || !pre.company_id || pre.proposal_id !== body.proposal_id || !pre.fingerprint) {
      return c.json({ error: { code: 'not_execution_token', message: 'an execution token bound to this proposal is required' } }, 403);
    }
    const proof = await executeProposal(core, pre.company_id, body.proposal_id, {
      fingerprint: pre.fingerprint,
      sub: pre.sub,
      request_id: c.req.header('x-request-id') ?? null,
      trace: trace(c),
    });
    return c.json(proof);
  });

  app.get('/l3/outbox', async (c) => {
    const claims = await authed(c, 'outbox.read', false);
    if (claims.sub !== 'platform') return c.json({ error: { code: 'denied', message: 'platform only' } }, 403);
    const after = Number(c.req.query('after') ?? 0);
    const limit = Number(c.req.query('limit') ?? 200);
    return c.json(await readOutbox(core, Number.isFinite(after) ? after : 0, Number.isFinite(limit) ? limit : 200));
  });

  // Phase 4: the result of a task this app handed to another app. Wakes the waiting job.
  app.post('/l3/tasks.result', async (c) => {
    const claims = await authed(c, 'tasks.result');
    if (claims.sub !== 'platform') return c.json({ error: { code: 'denied', message: 'platform only' } }, 403);
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b.task_id !== 'string' || typeof b.status !== 'string') return c.json({ error: { code: 'bad_request', message: 'task_id and status required' } }, 400);
    const woke = await core.company(claims.company_id!, async (db) => {
      const w = await db.query<{ job_id: string }>(`select job_id from ${core.key}.waits where ref_id = $1 and kind = 'a2a_task'`, [b.task_id]);
      if (!w.rows[0]) return null;
      const ok = await core.book.readyWait(db, b.task_id, b.status, { task_id: b.task_id, status: b.status, from_app: b.from_app ?? null, result: b.result ?? null });
      if (ok) {
        await core.book.addStep(db, {
          company_id: claims.company_id!,
          job_id: w.rows[0].job_id,
          kind: 'system',
          summary: `${b.from_app ?? 'The other app'} answered task ${String(b.task_id).slice(0, 8)}: ${b.status}`,
        });
        await core.book.notify(db, `wait:${w.rows[0].job_id}`);
      }
      return ok;
    });
    if (woke === null) return c.json({ error: { code: 'not_found', message: 'no job waits on that task' } }, 404);
    return c.json({ ok: true, woke });
  });

  // R11: the platform acknowledges what it applied; acked events past retention are pruned.
  app.post('/l3/outbox.ack', async (c) => {
    const claims = await authed(c, 'outbox.ack', false);
    if (claims.sub !== 'platform') return c.json({ error: { code: 'denied', message: 'platform only' } }, 403);
    const b = await c.req.json().catch(() => null);
    const cursor = Number(b?.cursor);
    if (!Number.isInteger(cursor) || cursor < 0) return c.json({ error: { code: 'bad_request', message: 'cursor required' } }, 400);
    await core.runnerPool.query(`update ${core.key}.outbox_acked set cursor = greatest(cursor, $1), acked_at = now() where id = 1`, [cursor]);
    const pruned = await core.runnerPool.query(
      `delete from ${core.key}.outbox where id <= (select cursor from ${core.key}.outbox_acked where id = 1)
         and created_at < now() - ($1 || ' milliseconds')::interval`,
      [String(core.cfg.outboxRetentionMs ?? 7 * 86_400_000)],
    );
    return c.json({ ok: true, pruned: pruned.rowCount ?? 0 });
  });

  app.post('/l3/switchboard.changed', async (c) => {
    const claims = await authed(c, 'switchboard.changed');
    core.board.invalidate(claims.company_id!);
    return c.json({ ok: true });
  });

  // Reads from the platform or another app (a2a/borrowing). Writes by other
  // callers arrive as a2a tasks (Phase 4), never as direct effects.
  app.post('/l3/abilities/:key', async (c) => {
    const key = c.req.param('key');
    const claims = await authed(c, key);
    const resolved = await core.resolve(claims.company_id!, key);
    const ability = resolved?.meta;
    const handler = resolved?.handler;
    if (!resolved || !ability || !handler) return c.json({ error: { code: 'not_found', message: key } }, 404);
    if (handler.kind !== 'read') return c.json({ error: { code: 'denied', message: 'writes arrive as tasks, not direct calls' } }, 403);
    const board = await core.board.get(claims.company_id!, claims.sb_version ?? 0);
    if (board.setting(ability) === 'off') return c.json({ error: { code: 'switched_off', message: `${key} is switched off` } }, 403);
    const args = await c.req.json().catch(() => ({}));
    const bad = resolved.checkInput(args);
    if (bad) return c.json({ error: { code: 'bad_request', message: bad } }, 400);
    const result = await core.company(claims.company_id!, (db) =>
      handler.run(args, { company_id: claims.company_id!, caller: claims.sub, job_id: null, now: new Date(), db }),
    );
    const badOut = resolved.checkOutput(result);
    if (badOut) {
      core.log('contract violation', { key, badOut });
      return c.json({ error: { code: 'contract_violation', message: badOut } }, 500);
    }
    if (claims.sub.startsWith('app:')) {
      // Served to another app: recorded in this book with the gateway's request id, matching both audits (R4).
      await core.company(claims.company_id!, (db) =>
        core.book.recordOperation(db, {
          company_id: claims.company_id!,
          job_id: null,
          caller: claims.sub,
          ability_key: key,
          idempotency_key: claims.idem_key,
          outcome: 'served',
          gateway_request_id: c.req.header('x-request-id') ?? null,
        }),
      );
    }
    return c.json({ result });
  });

  return app;
}
