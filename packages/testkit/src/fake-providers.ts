// Provider doubles with the semantics production depends on.
//   Resend: POST /emails honours Idempotency-Key (same body → original id, no
//   second send; different body → 409); GET /emails/:id returns the message.
//   GSP (GST Suvidha Provider): POST filing with Idempotency-Key, GET by key.
// Both can inject: a lost response after the provider acted, a definite
// refusal, and an outage.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { closeServer } from '@neop/pgkit';

export type Fault = null | 'drop_after_accept' | 'refuse' | 'outage';

export interface FakeProvider {
  url: string;
  token: string;
  /** Messages/filings actually performed (one per idempotency key). */
  performed: { key: string; id: string; body: any }[];
  requests: { method: string; path: string; key: string | null; auth: string | null }[];
  fault: Fault;
  close(): Promise<void>;
}

async function start(app: Hono): Promise<{ url: string; server: any }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve({ url: `http://127.0.0.1:${info.port}`, server }));
  });
}

function common(token: string) {
  const state = { performed: [] as FakeProvider['performed'], requests: [] as FakeProvider['requests'], fault: null as Fault, byKey: new Map<string, { id: string; body: string }>() };
  const app = new Hono();
  app.use('*', async (c, next) => {
    state.requests.push({ method: c.req.method, path: c.req.path, key: c.req.header('idempotency-key') ?? null, auth: c.req.header('authorization') ?? null });
    if (c.req.header('authorization') !== `Bearer ${token}`) return c.json({ message: 'unauthorized' }, 401);
    if (state.fault === 'outage') return c.json({ message: 'unavailable' }, 503);
    return next();
  });
  /** Accept (or replay) an idempotent create; applies the drop/refuse faults. */
  const create = async (c: any, prefix: string): Promise<Response> => {
    const key = c.req.header('idempotency-key');
    if (!key) return c.json({ message: 'Idempotency-Key required' }, 400);
    const raw = await c.req.text();
    if (state.fault === 'refuse') return c.json({ message: 'validation failed: recipient rejected' }, 422);
    const prior = state.byKey.get(key);
    if (prior) {
      if (prior.body !== raw) return c.json({ message: 'idempotency key reused with a different body' }, 409);
      return c.json({ id: prior.id, reference: prior.id });
    }
    const id = `${prefix}_${state.performed.length + 1}`;
    state.byKey.set(key, { id, body: raw });
    state.performed.push({ key, id, body: JSON.parse(raw) });
    if (state.fault === 'drop_after_accept') {
      state.fault = null; // once
      // The provider acted, but the caller never gets its answer (the response is lost).
      return c.json({ message: 'upstream gateway timeout' }, 504);
    }
    return c.json({ id, reference: id });
  };
  return { state, app, create };
}

export async function fakeResend(): Promise<FakeProvider> {
  const token = 're_test_' + Math.random().toString(36).slice(2);
  const { state, app, create } = common(token);
  app.post('/emails', (c) => create(c, 'email'));
  app.get('/emails/:id', (c) => {
    const p = state.performed.find((x) => x.id === c.req.param('id'));
    if (!p) return c.json({ message: 'not found' }, 404);
    return c.json({ object: 'email', id: p.id, to: p.body.to, from: p.body.from, subject: p.body.subject, created_at: new Date().toISOString(), last_event: 'delivered' });
  });
  const { url, server } = await start(app);
  return Object.assign(state, { url, token, close: () => closeServer(server) }) as unknown as FakeProvider;
}

export async function fakeGsp(): Promise<FakeProvider> {
  const token = 'gsp_' + Math.random().toString(36).slice(2);
  const { state, app, create } = common(token);
  app.post('/v1/gstr3b/file', (c) => create(c, 'ARN'));
  app.get('/v1/gstr3b/filings/:key', (c) => {
    const p = state.performed.find((x) => x.key === c.req.param('key'));
    return p ? c.json({ reference: p.id, ...p.body, status: 'FILED' }) : c.json({ message: 'not found' }, 404);
  });
  const { url, server } = await start(app);
  return Object.assign(state, { url, token, close: () => closeServer(server) }) as unknown as FakeProvider;
}
