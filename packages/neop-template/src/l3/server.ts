// L3 · the app's private HTTP surface. Only the gateway reaches it (network
// policy), and every call carries a gateway-signed, single-use token (B4).

import type { GatewayClaims } from '@neop/contracts';
import { Hono, type Context } from 'hono';
import { ExecError } from '../capabilities/execute.ts';
import { cancelJob } from '../capabilities/platform/tasks.cancel.ts';
import { openJob, requesterMatches, validateOpen } from '../capabilities/platform/tasks.open.ts';
import { readOutbox } from '../capabilities/platform/outbox.read.ts';
import { answerWait, validateAnswer } from '../capabilities/platform/waits.answer.ts';
import type { Core } from '../core.ts';
import { renderBackendMetrics } from './metrics.ts';
import { AuthError } from './auth.ts';

function bearer(c: Context): string | null {
  const h = c.req.header('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

/** A schedule as the platform sends it: {id?, ask, requester, rule: {every, at, weekday?, day?}, enabled?}. */
export function validateSchedule(b: any): string | null {
  if (!b || typeof b !== 'object') return 'body required';
  if (b.id !== undefined && (typeof b.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(b.id))) return 'id must be a uuid';
  if (typeof b.ask !== 'string' || !b.ask.trim() || b.ask.length > 8000) return 'ask (1..8000 chars) required';
  if (typeof b.requester !== 'string' || !/^(user|app):.+/.test(b.requester)) return 'requester (user:<id> | app:<key>) required';
  const r = b.rule;
  if (!r || !['day', 'week', 'month'].includes(r.every)) return "rule.every must be 'day', 'week' or 'month'";
  if (typeof r.at !== 'string' || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(r.at)) return 'rule.at must be HH:MM (company time)';
  if (r.every === 'week' && !(Number.isInteger(r.weekday) && r.weekday >= 1 && r.weekday <= 7)) return 'rule.weekday (1 = Monday … 7) required';
  if (r.every === 'month' && !(Number.isInteger(r.day) && r.day >= 1 && r.day <= 31)) return 'rule.day (1..31) required';
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return 'enabled must be a boolean';
  return null;
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
    return c.json(await openJob(core, claims.company_id!, { ...body, source, trace: trace(c), origin: body.task_id }));
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
    return c.json(await openJob(core, claims.company_id!, { task_id: b.task_id, ask: b.text, requester: b.sender, source: 'room', trace: trace(c), origin: b.event_id }));
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

  // WP §8 `answer`: an answer to a question a job asked (job.ask). Platform only — a person on the
  // desk, in their conversation or DM; a bridge or the reasoning agent only as relayed, untrusted data.
  // Another app never answers here: its calls are refused at the gateway and again below.
  app.post('/l3/waits.answer', async (c) => {
    const claims = await authed(c, 'waits.answer');
    if (claims.sub !== 'platform') return c.json({ error: { code: 'denied', message: 'only the platform records answers' } }, 403);
    const body = await c.req.json().catch(() => null);
    const bad = validateAnswer(body);
    if (bad) return c.json({ error: { code: 'bad_request', message: bad } }, 400);
    return c.json(await answerWait(core, claims.company_id!, body));
  });

  // WP §12: a job's raw session transcripts, for audit. Platform only; never offered to a model.
  app.get('/l3/jobs.transcript', async (c) => {
    const claims = await authed(c, 'jobs.transcript');
    if (claims.sub !== 'platform') return c.json({ error: { code: 'denied', message: 'platform only' } }, 403);
    const jobId = c.req.query('job_id') ?? '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) return c.json({ error: { code: 'bad_request', message: 'job_id (uuid) required' } }, 400);
    const out = await core.company(claims.company_id!, async (db) => {
      const job = await core.book.getJob(db, jobId);
      return job ? { job_id: job.id, status: job.status, sessions: await core.book.transcripts(db, job.id) } : null;
    });
    if (!out) return c.json({ error: { code: 'not_found', message: 'no such job' } }, 404);
    return c.json(out);
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
      if (!w.rows[0]) {
        // A hand-off still being written (its wait exists, its task id not yet): not ours to
        // drop. Answer "try again" so the platform redelivers instead of marking it done (item 5).
        const inflight = await db.query(`select 1 from ${core.key}.waits where kind = 'a2a_task' and ref_id is null and status = 'pending' limit 1`);
        return inflight.rowCount ? 'retry' : null;
      }
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
    // 503, not 4xx: the gateway stores 4xx answers against the idempotency key and replays them;
    // a 5xx is retried, so the platform's next delivery reaches the wait once it has its task id.
    if (woke === 'retry') return c.json({ error: { code: 'handoff_in_progress', message: 'a hand-off is still being recorded; deliver again' } }, 503);
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
      `delete from ${core.key}.outbox o where o.id <= (select cursor from ${core.key}.outbox_acked where id = 1)
         and o.created_at < now() - ($1 || ' milliseconds')::interval
         and not exists (select 1 from ${core.key}.presence_mirror m where m.company_id = o.company_id and m.cursor < o.id)`, // v3 S4: never before the presence mirror read it
      [String(core.cfg.outboxRetentionMs ?? 7 * 86_400_000)],
    );
    return c.json({ ok: true, pruned: pruned.rowCount ?? 0 });
  });

  // WP §7 timers: the platform sets a schedule on a person's behalf; the runner opens a
  // source='timer' job at each slot (company time zone, database time). Platform only.
  app.post('/l3/schedules.set', async (c) => {
    const claims = await authed(c, 'schedules.set');
    if (claims.sub !== 'platform') return c.json({ error: { code: 'denied', message: 'only the platform sets schedules' } }, 403);
    const b = await c.req.json().catch(() => null);
    const bad = validateSchedule(b);
    if (bad) return c.json({ error: { code: 'bad_request', message: bad } }, 400);
    const board = await core.board.get(claims.company_id!);
    const tz = board.company.time_zone;
    const row = await core.company(claims.company_id!, async (db) => {
      const rule = JSON.stringify(b.rule);
      const enabled = b.enabled !== false;
      if (b.id) {
        const r = await db.query(
          `update ${core.key}.schedules set ask = $2, requester = $3, rule = $4, time_zone = $5, enabled = $6,
                  next_run_at = case when $6 then ${core.key}.next_run($4::jsonb, $5, now()) end, updated_at = now()
            where id = $1 returning *`,
          [b.id, b.ask, b.requester, rule, tz, enabled],
        );
        return r.rows[0] ?? null;
      }
      const r = await db.query(
        `insert into ${core.key}.schedules (company_id, ask, requester, rule, time_zone, enabled, next_run_at)
         values ($1, $2, $3, $4, $5, $6, case when $6 then ${core.key}.next_run($4::jsonb, $5, now()) end) returning *`,
        [claims.company_id, b.ask, b.requester, rule, tz, enabled],
      );
      return r.rows[0];
    });
    if (!row) return c.json({ error: { code: 'not_found', message: 'no such schedule' } }, 404);
    return c.json({ schedule: row });
  });

  app.get('/l3/schedules', async (c) => {
    const claims = await authed(c, 'schedules.list');
    if (claims.sub !== 'platform') return c.json({ error: { code: 'denied', message: 'platform only' } }, 403);
    const rows = await core.company(claims.company_id!, async (db) => (await db.query(`select * from ${core.key}.schedules order by created_at`)).rows);
    return c.json({ schedules: rows });
  });

  // The platform's push when something it still holds changed (an ACL row, a registry install). A change to
  // the board itself reaches the gate as NOTIFY 'board:<company>' from this app's own schema (t010).
  app.post('/l3/switchboard.changed', async (c) => {
    const claims = await authed(c, 'switchboard.changed');
    core.board.invalidate(claims.company_id!);
    // A changed ACL or line changes what may be borrowed: drop that cache too (item 6).
    core.borrowed.invalidate(claims.company_id!);
    // Installs and uninstalls change which package lines and skills exist: reload them now.
    core.packages.invalidate(claims.company_id!);
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
      handler.run(args, { company_id: claims.company_id!, caller: claims.sub, job_id: null, now: new Date(), time_zone: board.company.time_zone, db }),
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
          request: args,
          result,
          reason: `a read served to ${claims.sub} through the gateway`,
        }),
      );
    }
    return c.json({ result });
  });

  return app;
}
