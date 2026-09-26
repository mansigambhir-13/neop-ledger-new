// The gate's endpoint: the only thing the assistant container can reach in
// this backend. Every call carries a runner-minted job token (S5).

import type { JobTokenClaims } from '@neop/contracts';
import { Hono, type Context } from 'hono';
import type { Core } from '../core.ts';
import { Gate, SessionLost } from './gate.ts';

export function gateApp(core: Core, gate: Gate, onSessionEnd: (claims: JobTokenClaims, reason: string) => Promise<void>): Hono {
  const app = new Hono();

  const claimsOf = async (c: Context): Promise<JobTokenClaims | null> => {
    const h = c.req.header('authorization');
    if (!h?.startsWith('Bearer ')) return null;
    try {
      return await core.jobTokens.verify(h.slice(7));
    } catch {
      return null;
    }
  };

  app.onError((err, c) => {
    if (err instanceof SessionLost) return c.json({ error: { code: 'session_lost', message: err.message } }, 409);
    core.log('gate error', { error: (err as Error).message, stack: (err as Error).stack });
    return c.json({ error: { code: 'internal', message: 'gate error' } }, 500);
  });

  app.post('/gate/call', async (c) => {
    const claims = await claimsOf(c);
    if (!claims) return c.json({ error: { code: 'unauthenticated', message: 'a valid job token is required' } }, 401);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.tool !== 'string') return c.json({ error: { code: 'bad_request', message: 'tool required' } }, 400);
    const span = core.tracer.start(`gate ${body.tool}`, c.req.header('traceparent') ?? null, { 'neop.job': claims.sub });
    try {
      const r = await gate.call(claims, body.tool, body.args ?? {});
      span.set('neop.decision', r.status).set('neop.code', 'code' in r ? r.code : null).end();
      core.metrics.inc('neop_gate_decisions_total', 'Gate decisions by ability and result', { app: core.key, ability: body.tool, decision: r.status });
      return c.json(r);
    } catch (e) {
      span.end('error', String(e));
      throw e;
    }
  });

  app.post('/gate/heartbeat', async (c) => {
    const claims = await claimsOf(c);
    if (!claims) return c.json({ error: { code: 'unauthenticated', message: 'job token required' } }, 401);
    await gate.heartbeat(claims);
    return c.json({ ok: true });
  });

  app.post('/gate/usage', async (c) => {
    const claims = await claimsOf(c);
    if (!claims) return c.json({ error: { code: 'unauthenticated', message: 'job token required' } }, 401);
    const b = await c.req.json().catch(() => ({}));
    await gate.usage(claims, Number(b.cost_usd));
    return c.json({ ok: true });
  });

  app.post('/gate/session.end', async (c) => {
    const claims = await claimsOf(c);
    if (!claims) return c.json({ error: { code: 'unauthenticated', message: 'job token required' } }, 401);
    const b = await c.req.json().catch(() => ({}));
    await onSessionEnd(claims, typeof b.reason === 'string' ? b.reason : 'ended');
    return c.json({ ok: true });
  });

  return app;
}
