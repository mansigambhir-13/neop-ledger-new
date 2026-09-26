// THE ASSISTANT WORKER POOL · the agent container. Holds a per-app LLM virtual
// key and nothing else: no database, no vault, no route to the platform. It
// accepts sessions from its own runner and talks only to its own gate.

import { serve, type ServerType } from '@hono/node-server';
import type { Model } from '@mariozechner/pi-ai';
import { Hono } from 'hono';
import type { JobBundle } from './bundle.ts';
import { runSession, type EndReason, type SessionControl, type SessionModel } from './extension.ts';

export interface LlmSession {
  base_url: string;
  token: string;
}

export interface AgentWorkerOptions {
  poolSize: number;
  /**
   * How a session reaches a model. In production this is `proxyModel`: the
   * runner hands each session a budgeted token for the platform's LLM proxy
   * and the agent holds no key of its own.
   */
  model: SessionModel | ((bundle: JobBundle, llm: LlmSession | null) => SessionModel);
  /** Only accept gate URLs from this allow-list (the app's own backend). */
  allowedGates?: string[];
  onEnd?: (jobId: string, reason: EndReason) => void;
}

export function agentWorkerApp(opts: AgentWorkerOptions): { app: Hono; active: Set<string>; done: Promise<void>[]; kill: (jobId: string) => boolean } {
  const app = new Hono();
  const active = new Set<string>();
  const controls = new Map<string, SessionControl>();
  const done: Promise<void>[] = [];
  app.get('/live', (c) => c.json({ ok: true, active: active.size, pool: opts.poolSize }));
  app.post('/sessions', async (c) => {
    if (active.size >= opts.poolSize) return c.json({ error: 'pool full' }, 503);
    const body = await c.req.json().catch(() => null);
    if (!body?.bundle?.job?.id || typeof body.token !== 'string' || typeof body.gate_url !== 'string') return c.json({ error: 'bad request' }, 400);
    if (opts.allowedGates && !opts.allowedGates.includes(body.gate_url)) return c.json({ error: 'gate not allowed' }, 403);
    const bundle = body.bundle as JobBundle;
    const key = `${bundle.job.id}:${Date.now()}`;
    active.add(key);
    const llm = (body.llm ?? null) as LlmSession | null;
    let m: SessionModel;
    try {
      m = typeof opts.model === 'function' ? opts.model(bundle, llm) : opts.model;
    } catch (e) {
      active.delete(key);
      return c.json({ error: String(e) }, 400);
    }
    const control: SessionControl = {};
    controls.set(bundle.job.id, control);
    const p = runSession(bundle, body.token, body.gate_url, m, control)
      .then((r) => opts.onEnd?.(bundle.job.id, r))
      .catch(() => {})
      .finally(() => {
        active.delete(key);
        if (controls.get(bundle.job.id) === control) controls.delete(bundle.job.id);
      });
    done.push(p);
    return c.json({ accepted: true }, 202);
  });
  const kill = (jobId: string) => {
    const c = controls.get(jobId);
    if (!c?.kill) return false;
    c.kill();
    return true;
  };
  return { app, active, done, kill };
}

export function startAgentWorker(opts: AgentWorkerOptions & { port?: number; host?: string }): Promise<{ port: number; server: ServerType; active: Set<string>; done: Promise<void>[]; kill: (jobId: string) => boolean }> {
  const { app, active, done, kill } = agentWorkerApp(opts);
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port ?? 0, hostname: opts.host ?? '127.0.0.1' }, (info) =>
      resolve({ port: info.port, server, active, done, kill }),
    );
  });
}

/** Production model factory: the proxy URL and the session token come from the runner, per session. */
export function proxyModel(env: NodeJS.ProcessEnv = process.env): (bundle: JobBundle, llm: LlmSession | null) => SessionModel {
  return (_bundle, llm) => {
    if (!llm) throw new Error('no LLM session token: the agent holds no key of its own');
    const base = modelFromEnv({ ...env, NEOP_LLM_BASE_URL: llm.base_url, NEOP_LLM_VIRTUAL_KEY: llm.token });
    // The proxy continues the job's trace.
    if (_bundle.trace) base.model = { ...base.model, headers: { ...(base.model.headers ?? {}), traceparent: _bundle.trace } };
    return base;
  };
}

/** Model from env (direct, for local development only): base URL and key. */
export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): SessionModel {
  const id = env.NEOP_LLM_MODEL ?? 'claude-sonnet-5';
  const api = (env.NEOP_LLM_API ?? 'anthropic-messages') as any;
  const model: Model<any> = {
    id,
    name: id,
    api,
    provider: env.NEOP_LLM_PROVIDER ?? 'anthropic',
    baseUrl: env.NEOP_LLM_BASE_URL ?? 'https://api.anthropic.com',
    reasoning: false,
    input: ['text'],
    cost: { input: Number(env.NEOP_LLM_COST_IN ?? 3), output: Number(env.NEOP_LLM_COST_OUT ?? 15), cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
  const key = env.NEOP_LLM_VIRTUAL_KEY;
  return { model, getApiKey: () => key };
}
