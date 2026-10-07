// THE LLM PROXY (R1). Anthropic Messages-compatible. Holds the provider key;
// the agent holds only a session token scoped to one job session, one company
// and one app with a budget. v3 (S8): an app's runner mints that token itself
// with a key only this proxy trusts for that app (`runnerKeys`, public halves);
// v3 (S9): so does the platform for NeuralChat's routing model (principal `neuralchat`,
// its public half in the same map) — there is no platform JWKS any more. Every call reserves its
// worst case against the job budget and the company-app daily cap before
// going upstream, then settles the real usage. Over budget → 402, before any
// upstream call. The proxy is the single meter (S9): the per-job budget is
// held across every session of the job (a crashed session's successor does
// not get a fresh budget), and the app reads the metered spend from here
// (GET /v1/spend), never from the agent's own report.

import { Hono } from 'hono';
import { createLocalJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Pool, PoolClient } from '@neop/pgkit';
import { Tracer } from '@neop/contracts';

export interface Price {
  /** USD per million input tokens */
  input: number;
  /** USD per million output tokens */
  output: number;
}

export interface ProxyConfig {
  db: Pool;
  /**
   * v3: each app's runner signs its own sessions. app key → public Ed25519 JWKs (or a getter, for rotation).
   * A token issued `neop-runner:<app>` verifies only against that app's keys and must carry `sub` = `app:<app>`.
   * The platform's routing model is the principal `neuralchat` here, with the platform's public key. Nothing else verifies.
   */
  runnerKeys?: Record<string, any[]> | (() => Record<string, any[]>);
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
  const runnerSets = new Map<string, { at: number; set: JWTVerifyGetKey }>();
  const runnerKeys = (app: string): JWTVerifyGetKey | null => {
    const all = typeof cfg.runnerKeys === 'function' ? cfg.runnerKeys() : cfg.runnerKeys;
    const list = all && Object.hasOwn(all, app) ? all[app] : null;
    if (!list?.length) return null;
    const hit = runnerSets.get(app);
    if (hit && Date.now() - hit.at < 30_000) return hit.set;
    // Public halves only: a private component here would mean the proxy could mint for the app.
    const set = createLocalJWKSet({ keys: list.map(({ d: _d, ...pub }: any) => pub) });
    runnerSets.set(app, { at: Date.now(), set });
    return set;
  };

  async function verify(token: string | undefined): Promise<SessionClaims | null> {
    if (!token) return null;
    try {
      const iss = decodeJwt(token).iss ?? '';
      if (iss.startsWith('neop-runner:')) {
        // A runner-minted session: only that app's key, only that app's subject.
        const app = iss.slice('neop-runner:'.length);
        const set = runnerKeys(app);
        if (!set) return null;
        const { payload } = await jwtVerify(token, set, { issuer: iss, audience: 'llm-proxy', algorithms: ['EdDSA'], subject: `app:${app}` });
        return payload as unknown as SessionClaims;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Reserve `est` against the job and the day, atomically. The job budget is
   * per job, not per session (S9): every session row of the job counts, under
   * a per-job lock. Returns which cap refused it, or null when it fits.
   */
  async function reserve(s: SessionClaims, app: string, est: number): Promise<'job' | 'day' | null> {
    const c = await cfg.db.connect();
    try {
      await c.query('begin');
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [`llm-job:${app}:${s.job_id}`]);
      await c.query(
        `insert into neos.llm_sessions (sid, company_id, app_key, job_id, budget_micros) values ($1,$2,$3,$4,$5) on conflict (sid) do nothing`,
        [s.sid, s.company_id, app, s.job_id, s.budget_micros],
      );
      const day = (await c.query<{ d: string }>(`select (now() at time zone $1)::date::text as d`, [s.tz])).rows[0]!.d;
      await c.query(
        `insert into neos.llm_days (company_id, app_key, day, cap_micros) values ($1,$2,$3,$4) on conflict (company_id, app_key, day) do update set cap_micros = excluded.cap_micros`,
        [s.company_id, app, day, s.day_cap_micros],
      );
      const used = await c.query<{ n: string }>(
        `select coalesce(sum(spent_micros + reserved_micros), 0)::bigint as n from neos.llm_sessions where app_key = $1 and job_id = $2`,
        [app, s.job_id],
      );
      if (Number(used.rows[0]!.n) + est > s.budget_micros) {
        await c.query('rollback');
        return 'job';
      }
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
        return a.rowCount ? 'day' : 'job';
      }
      await c.query('commit');
      return null;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  /** What this job and this company-app day have spent, metered here (S9). */
  async function spend(s: SessionClaims, app: string) {
    const j = await cfg.db.query<{ spent: string; reserved: string }>(
      `select coalesce(sum(spent_micros), 0)::bigint as spent, coalesce(sum(reserved_micros), 0)::bigint as reserved
         from neos.llm_sessions where app_key = $1 and job_id = $2`,
      [app, s.job_id],
    );
    const d = await cfg.db.query<{ spent: string; reserved: string }>(
      `select spent_micros as spent, reserved_micros as reserved from neos.llm_days
        where company_id = $1 and app_key = $2 and day = (now() at time zone $3)::date`,
      [s.company_id, app, s.tz],
    );
    return {
      job_id: s.job_id,
      job_spent_micros: Number(j.rows[0]!.spent),
      job_reserved_micros: Number(j.rows[0]!.reserved),
      job_budget_micros: s.budget_micros,
      day_spent_micros: Number(d.rows[0]?.spent ?? 0),
      day_reserved_micros: Number(d.rows[0]?.reserved ?? 0),
      day_cap_micros: s.day_cap_micros,
    };
  }

  async function settle(s: SessionClaims, app: string, est: number, model: string, inTok: number, outTok: number, cost: number, outcome: 'settled' | 'upstream_error') {
    let c: PoolClient | null = null;
    try {
      // A streaming provider may finish while the process is shutting down. Pool acquisition is part of settlement
      // and must be contained too: an ended pool must not escape as an unhandled background rejection.
      c = await cfg.db.connect();
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
      await c?.query('rollback').catch(() => {});
      cfg.log?.('llm settle failed', e);
    } finally {
      c?.release();
    }
  }

  const bearer = (c: { req: { header: (n: string) => string | undefined } }) => c.req.header('x-api-key') ?? c.req.header('authorization')?.replace(/^Bearer /, '');

  // The app's view of the meter: what its job and its day have spent (S9, item 12).
  app.get('/v1/spend', async (c) => {
    const s = await verify(bearer(c));
    if (!s || !s.sub?.startsWith('app:')) return anthropicError(401, 'authentication_error', 'a valid NEOS session token is required');
    return c.json(await spend(s, s.sub.slice(4)));
  });

  app.post('/v1/messages', async (c) => {
    const s = await verify(bearer(c));
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
    const over = await reserve(s, appKey, est);
    if (over) {
      await cfg.db.query(
        `insert into neos.llm_usage (sid, company_id, app_key, job_id, model, outcome) values ($1,$2,$3,$4,$5,'refused_budget')`,
        [s.sid, s.company_id, appKey, s.job_id, body.model],
      );
      // Final, not transient: the runner ends the job and says which cap (S9).
      const usd = (m: number) => `$${(m / 1_000_000).toFixed(2)}`;
      return anthropicError(
        402,
        'budget_exceeded',
        over === 'job'
          ? `NEOS budget reached: the model budget for this job (${usd(s.budget_micros)}) is used up`
          : `NEOS budget reached: today's model budget for this app (${usd(s.day_cap_micros)}) is used up`,
      );
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
    const parse = (chunk: Uint8Array) => {
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
    };
    // Pass bytes through untouched. If the client goes away (a killed or timed-out
    // session), keep draining upstream: the provider still bills the call, so the
    // meter settles what it really cost and the reservation never leaks (S9).
    const reader = upstream.body.getReader();
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    let clientGone = false;
    const out = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c;
      },
      cancel() {
        clientGone = true;
      },
    });
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parse(value);
          if (!clientGone) {
            try {
              ctl.enqueue(value);
            } catch {
              clientGone = true;
            }
          }
        }
      } catch (e) {
        cfg.log?.('llm upstream stream broke', e);
      } finally {
        // Settle before the client sees the end, so the usage row exists when the call is over.
        await settleOnce();
        if (!clientGone) {
          try {
            ctl.close();
          } catch {
            /* already closed */
          }
        }
      }
    })();
    return new Response(out, {
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
