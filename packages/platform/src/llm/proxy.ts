// THE LLM PROXY (R1). Anthropic Messages-compatible. Holds the provider key;
// the agent holds only a platform-signed session token scoped to one job
// session, one company and one app with a budget. Every call reserves its
// worst case against the job budget and the company-app daily cap before
// going upstream, then settles the real usage. Over budget → 402, before any
// upstream call. The agent's own spend report is informational only.

import { Hono } from 'hono';
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Pool } from '@neop/pgkit';
import { Tracer } from '@neop/contracts';

export interface Price {
  /** USD per million input tokens */
  input: number;
  /** USD per million output tokens */
  output: number;
}

export interface ProxyConfig {
  db: Pool;
  /** Keys that sign session tokens: the gateway keyring in-process, or the platform's JWKS URL. */
  jwks: (() => { keys: any[] }) | string;
  upstream: {
    baseUrl: string;
    apiKey: string;
    /** How the provider takes the key: Anthropic's x-api-key (default) or a Bearer token (OpenRouter's Anthropic-compatible API). */
    auth?: 'x-api-key' | 'bearer';
    /** Prefix added to the model id upstream (OpenRouter: "anthropic/"). Pricing and caps stay on the agent-facing id. */
    modelPrefix?: string;
  };
  /** Model id → price. Unknown models are refused (no unpriced spend). */
  prices: Record<string, Price>;
  /** Hard ceiling on max_tokens per call, whatever the client asks. */
  maxTokensCeiling?: number;
  log?: (m: string, e?: unknown) => void;
}

export interface SessionClaims {
  sub: string; // app:<key>
  company_id: string;
  job_id: string;
  sid: string;
  budget_micros: number;
  day_cap_micros: number;
  tz: string;
}

const micros = (tokens: number, usdPerMTok: number) => Math.ceil(tokens * usdPerMTok);

function anthropicError(status: number, type: string, message: string) {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json' } });
}

export function llmProxyApp(cfg: ProxyConfig): Hono {
  const app = new Hono();
  const ceiling = cfg.maxTokensCeiling ?? 8_192;
  const tracer = new Tracer('neos-llm-proxy');
  let keySet: JWTVerifyGetKey | null = null;
  let keysAt = 0;
  const remote = typeof cfg.jwks === 'string' ? createRemoteJWKSet(new URL(cfg.jwks), { cacheMaxAge: 60_000 }) : null;
  const keys = (): JWTVerifyGetKey => {
    if (remote) return remote;
    if (!keySet || Date.now() - keysAt > 30_000) {
      keySet = createLocalJWKSet((cfg.jwks as () => { keys: any[] })());
      keysAt = Date.now();
    }
    return keySet;
  };

  async function verify(token: string | undefined): Promise<SessionClaims | null> {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, keys(), { issuer: 'neos-gateway', audience: 'llm-proxy', algorithms: ['EdDSA'] });
      return payload as unknown as SessionClaims;
    } catch {
      return null;
    }
  }

  /** Reserve `est` against the session and the day, atomically; false if either would go over. */
  async function reserve(s: SessionClaims, app: string, est: number): Promise<boolean> {
    const c = await cfg.db.connect();
    try {
      await c.query('begin');
      await c.query(
        `insert into neos.llm_sessions (sid, company_id, app_key, job_id, budget_micros) values ($1,$2,$3,$4,$5) on conflict (sid) do nothing`,
        [s.sid, s.company_id, app, s.job_id, s.budget_micros],
      );
      const day = (await c.query<{ d: string }>(`select (now() at time zone $1)::date::text as d`, [s.tz])).rows[0]!.d;
      await c.query(
        `insert into neos.llm_days (company_id, app_key, day, cap_micros) values ($1,$2,$3,$4) on conflict (company_id, app_key, day) do update set cap_micros = excluded.cap_micros`,
        [s.company_id, app, day, s.day_cap_micros],
      );
      const a = await c.query(
        `update neos.llm_sessions set reserved_micros = reserved_micros + $2, calls = calls + 1
          where sid = $1 and spent_micros + reserved_micros + $2 <= budget_micros`,
        [s.sid, est],
      );
      const b = await c.query(
        `update neos.llm_days set reserved_micros = reserved_micros + $4
          where company_id = $1 and app_key = $2 and day = $3 and spent_micros + reserved_micros + $4 <= cap_micros`,
        [s.company_id, app, day, est],
      );
      if (!a.rowCount || !b.rowCount) {
        await c.query('rollback');
        return false;
      }
      await c.query('commit');
      return true;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async function settle(s: SessionClaims, app: string, est: number, model: string, inTok: number, outTok: number, cost: number, outcome: 'settled' | 'upstream_error') {
    const c = await cfg.db.connect();
    try {
      await c.query('begin');
      const day = (await c.query<{ d: string }>(`select (now() at time zone $1)::date::text as d`, [s.tz])).rows[0]!.d;
      // Actual cost never exceeds the reservation (max_tokens is enforced upstream), so this cannot break the caps.
      const charged = Math.min(cost, est);
      await c.query(`update neos.llm_sessions set reserved_micros = reserved_micros - $2, spent_micros = spent_micros + $3 where sid = $1`, [s.sid, est, charged]);
      await c.query(
        `update neos.llm_days set reserved_micros = reserved_micros - $4, spent_micros = spent_micros + $5 where company_id = $1 and app_key = $2 and day = $3`,
        [s.company_id, app, day, est, charged],
      );
      await c.query(
        `insert into neos.llm_usage (sid, company_id, app_key, job_id, model, input_tokens, output_tokens, cost_micros, outcome) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [s.sid, s.company_id, app, s.job_id, model, inTok, outTok, charged, outcome],
      );
      await c.query('commit');
    } catch (e) {
      await c.query('rollback').catch(() => {});
      cfg.log?.('llm settle failed', e);
    } finally {
      c.release();
    }
  }

  app.post('/v1/messages', async (c) => {
    const s = await verify(c.req.header('x-api-key') ?? c.req.header('authorization')?.replace(/^Bearer /, ''));
    if (!s || !s.sub?.startsWith('app:')) return anthropicError(401, 'authentication_error', 'a valid NEOS session token is required');
    const appKey = s.sub.slice(4);
    const raw = await c.req.text();
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return anthropicError(400, 'invalid_request_error', 'body must be JSON');
    }
    const price = cfg.prices[body.model];
    if (!price) return anthropicError(400, 'invalid_request_error', `model ${body.model} is not priced on this proxy`);
    body.max_tokens = Math.min(Number(body.max_tokens) || ceiling, ceiling);
    // Worst case: every prompt byte a token (over-counts), plus max_tokens of output.
    const est = micros(raw.length, price.input) + micros(body.max_tokens, price.output);
    if (!(await reserve(s, appKey, est))) {
      await cfg.db.query(
        `insert into neos.llm_usage (sid, company_id, app_key, job_id, model, outcome) values ($1,$2,$3,$4,$5,'refused_budget')`,
        [s.sid, s.company_id, appKey, s.job_id, body.model],
      );
      return anthropicError(402, 'budget_exceeded', 'the model budget for this job or for today is used up');
    }

    let upstream: Response;
    try {
      upstream = await fetch(`${cfg.upstream.baseUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.upstream.auth === 'bearer' ? { authorization: `Bearer ${cfg.upstream.apiKey}` } : { 'x-api-key': cfg.upstream.apiKey }),
          'anthropic-version': c.req.header('anthropic-version') ?? '2023-06-01',
          ...(c.req.header('anthropic-beta') ? { 'anthropic-beta': c.req.header('anthropic-beta')! } : {}),
        },
        body: JSON.stringify(cfg.upstream.modelPrefix ? { ...body, model: cfg.upstream.modelPrefix + body.model } : body),
        signal: AbortSignal.timeout(300_000),
      });
    } catch (e) {
      await settle(s, appKey, est, body.model, 0, 0, 0, 'upstream_error');
      return anthropicError(502, 'api_error', `upstream unreachable: ${(e as Error).message}`);
    }
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      await settle(s, appKey, est, body.model, 0, 0, 0, 'upstream_error');
      return new Response(text, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' } });
    }

    const cost = (inTok: number, outTok: number) => micros(inTok, price.input) + micros(outTok, price.output);
    const span = tracer.start('llm.messages', c.req.header('traceparent') ?? null, { 'neop.app': appKey, 'neop.job': s.job_id, 'llm.model': body.model });
    if (!body.stream) {
      const json = await upstream.json();
      const u = json.usage ?? {};
      const inTok = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      await settle(s, appKey, est, body.model, inTok, u.output_tokens ?? 0, cost(inTok, u.output_tokens ?? 0), 'settled');
      span.set('llm.input_tokens', inTok).set('llm.output_tokens', u.output_tokens ?? 0).end();
      return c.json(json);
    }

    // Streaming: pass bytes through untouched while reading usage from the events.
    let inTok = 0;
    let outTok = 0;
    let buf = '';
    const decoder = new TextDecoder();
    const settleOnce = (() => {
      let done = false;
      return async () => {
        if (done) return;
        done = true;
        await settle(s, appKey, est, body.model, inTok, outTok, cost(inTok, outTok), 'settled');
        span.set('llm.input_tokens', inTok).set('llm.output_tokens', outTok).set('llm.cost_micros', cost(inTok, outTok)).end();
      };
    })();
    const tap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        ctl.enqueue(chunk);
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          try {
            const ev = JSON.parse(line.slice(5));
            if (ev.type === 'message_start') {
              const u = ev.message?.usage ?? {};
              inTok = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
              outTok = u.output_tokens ?? 0;
            } else if (ev.type === 'message_delta' && ev.usage) {
              outTok = ev.usage.output_tokens ?? outTok;
            }
          } catch {
            /* not JSON; pass through */
          }
        }
      },
      async flush() {
        await settleOnce();
      },
    });
    return new Response(upstream.body.pipeThrough(tap), {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  });

  return app;
}

/** Defaults; set real per-contract prices with NEOP_LLM_PRICES (JSON). */
export function pricesFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, Price> {
  if (env.NEOP_LLM_PRICES) return JSON.parse(env.NEOP_LLM_PRICES);
  return { 'claude-sonnet-5': { input: 3, output: 15 }, 'claude-haiku-4-5': { input: 1, output: 5 } };
}
