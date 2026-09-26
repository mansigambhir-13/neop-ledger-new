// THE GATEWAY · one for all apps (D4: a module in the platform backend).
// Caller auth, ACL, execution tokens, idempotency ledger, audit. It protects
// every app from every other caller; the gate inside each app protects the app
// from its own model. Both are required.

import { randomUUID } from 'node:crypto';
import { canonicalize, CONTRACT_VERSION, GATEWAY_ISSUER, GATEWAY_TOKEN_TTL_S, Metrics, sha256, Tracer, type GatewayClaims } from '@neop/contracts';
import type { Pool } from '@neop/pgkit';
import { SignJWT } from 'jose';
import type { SigningKeys } from './keys.ts';

export interface GatewayCall {
  /** `platform`, `user:<id>` or `app:<key>` */
  caller: string;
  app: string;
  /** L3 endpoint: tasks.open, proposals.resolve, proposals.execute, outbox.read, switchboard.changed, inbox.deliver, manifest, or an ability key */
  endpoint: string;
  company_id: string | null;
  body?: unknown;
  query?: Record<string, string | number>;
  idem_key?: string;
  /** Extra claims (execution tokens only). */
  exec?: { proposal_id: string; fingerprint: string };
  /** W3C traceparent of the caller's span; the call continues that trace. */
  trace?: string | null;
}

export interface GatewayResponse<T = any> {
  status: number;
  body: T;
  request_id: string;
  replayed: boolean;
}

export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const PATHS: Record<string, { method: 'GET' | 'POST'; path: string }> = {
  'tasks.open': { method: 'POST', path: '/l3/tasks.open' },
  'inbox.deliver': { method: 'POST', path: '/l3/inbox.deliver' },
  'proposals.resolve': { method: 'POST', path: '/l3/proposals.resolve' },
  'proposals.execute': { method: 'POST', path: '/l3/proposals.execute' },
  'outbox.read': { method: 'GET', path: '/l3/outbox' },
  'switchboard.changed': { method: 'POST', path: '/l3/switchboard.changed' },
  'tasks.cancel': { method: 'POST', path: '/l3/tasks.cancel' },
  'outbox.ack': { method: 'POST', path: '/l3/outbox.ack' },
  'tasks.result': { method: 'POST', path: '/l3/tasks.result' },
  manifest: { method: 'GET', path: '/l3/manifest' },
};

export class Gateway {
  readonly db: Pool;
  readonly keys: SigningKeys;
  tracer = new Tracer('neos-gateway');
  metrics = new Metrics();
  /** Test hook: a transport failure after the app answered (simulates a crash). */
  fetchImpl: typeof fetch = fetch;
  constructor(db: Pool, keys: SigningKeys) {
    this.db = db;
    this.keys = keys;
  }

  jwks(): { keys: unknown[] } {
    return this.keys.jwks();
  }

  async mint(claims: Omit<GatewayClaims, 'iss' | 'jti' | 'iat' | 'exp'>): Promise<string> {
    return new SignJWT({ ...claims } as Record<string, unknown>)
      .setProtectedHeader({ alg: 'EdDSA', kid: this.keys.active.kid, typ: 'JWT' })
      .setIssuer(GATEWAY_ISSUER)
      .setAudience(claims.aud)
      .setSubject(claims.sub)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${GATEWAY_TOKEN_TTL_S}s`)
      .sign(this.keys.active.privateKey);
  }


  async audit(e: { company_id: string | null; actor: string; app_key?: string; action: string; ability_key?: string; idem_key?: string; request_id?: string; outcome?: string; detail?: unknown }): Promise<void> {
    await this.db.query(
      `insert into neos.audit (company_id, actor, app_key, action, ability_key, idem_key, request_id, outcome, detail) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [e.company_id, e.actor, e.app_key ?? null, e.action, e.ability_key ?? null, e.idem_key ?? null, e.request_id ?? null, e.outcome ?? null, JSON.stringify(e.detail ?? null)],
    );
  }

  /** Sign a non-L3 token with the active key (e.g. LLM session tokens, aud 'llm-proxy'). */
  async sign(claims: Record<string, unknown>, aud: string, sub: string, ttlSeconds: number): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', kid: this.keys.active.kid, typ: 'JWT' })
      .setIssuer(GATEWAY_ISSUER)
      .setAudience(aud)
      .setSubject(sub)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
      .sign(this.keys.active.privateKey);
  }

  async call<T = any>(req: GatewayCall): Promise<GatewayResponse<T>> {
    const PLATFORM_DOORS = ['proposals.resolve', 'proposals.execute', 'outbox.read', 'inbox.deliver', 'switchboard.changed', 'tasks.cancel', 'outbox.ack', 'tasks.result'];
    const callerApp = req.caller.startsWith('app:') ? req.caller.slice(4) : null;
    const route = PATHS[req.endpoint] ?? { method: 'POST' as const, path: `/l3/abilities/${encodeURIComponent(req.endpoint)}` };
    const ledgered = route.method === 'POST' && !(req.company_id === null && req.endpoint === 'outbox.ack'); // acks are monotonic; no ledger row
    if (ledgered && !req.idem_key) throw new GatewayError(400, 'idempotency_required', 'Idempotency-Key is required on writes');
    if (callerApp && PLATFORM_DOORS.includes(req.endpoint)) throw new GatewayError(403, 'denied', 'only the platform may use platform doors');
    const requestHash = sha256(canonicalize({ endpoint: req.endpoint, company: req.company_id, body: req.body ?? null, query: req.query ?? null }));
    let requestId: string = randomUUID();

    // One round trip (hot path, load-tested): every check the gateway makes, and — only
    // when they all pass — the idempotency-ledger row for this call.
    const pre = (
      await this.db.query<{ l3_url: string; status: string; installed: boolean; acl_ok: boolean; sb_version: number | null; inserted: string | null }>(
        `with a as (
           select a.key, a.l3_url, a.status,
                  ($2::uuid is null or exists (select 1 from neos.installs i where i.company_id = $2 and i.app_key = a.key and i.status = 'active')) as installed,
                  ($3::text is null or ($2::uuid is not null and exists (select 1 from neos.acl x where x.caller_app = $3 and x.target_app = a.key and x.ability_key = $4 and x.company_id = $2))) as acl_ok,
                  (select max(version) from neos.switchboards s where s.company_id = $2 and s.app_key = a.key) as sb_version
             from neos.apps a where a.key = $1),
         ins as (
           insert into neos.gateway_ledger (caller, target_app, idem_key, endpoint, request_hash, request_id)
           select $5, a.key, $6, $4, $7, $8 from a
            where $9 and a.status = 'active' and a.installed and a.acl_ok
           on conflict do nothing returning request_id)
         select a.l3_url, a.status, a.installed, a.acl_ok, a.sb_version, (select request_id::text from ins) as inserted from a`,
        [req.app, req.company_id, callerApp, req.endpoint, req.caller, req.idem_key ?? null, requestHash, requestId, ledgered],
      )
    ).rows[0];
    if (!pre || pre.status !== 'active') throw new GatewayError(404, 'app_unavailable', `app ${req.app} is not registered or not active`);
    // (5a) An app acts only for a company that has installed it.
    if (!pre.installed) throw new GatewayError(403, 'not_installed', `${req.app} is not installed for this company`);
    if (callerApp && !pre.acl_ok) {
      // Another app may call only what an ACL row a person granted allows (a2a, borrowing).
      await this.audit({ company_id: req.company_id, actor: req.caller, app_key: req.app, action: 'gateway.denied', ability_key: req.endpoint, outcome: 'denied' });
      throw new GatewayError(403, 'denied', `${req.caller} may not call ${req.app}.${req.endpoint}`);
    }
    if (ledgered && !pre.inserted) {
      const p = (
        await this.db.query<{ request_hash: string; status: number | null; response: any; request_id: string }>(
          'select request_hash, status, response, request_id from neos.gateway_ledger where caller = $1 and target_app = $2 and idem_key = $3',
          [req.caller, req.app, req.idem_key],
        )
      ).rows[0]!;
      if (p.request_hash !== requestHash) throw new GatewayError(422, 'idempotency_conflict', 'same Idempotency-Key, different request');
      if (p.status !== null) return { status: p.status, body: p.response as T, request_id: p.request_id, replayed: true };
      requestId = p.request_id; // an earlier attempt never completed: retry (at least once)
    }

    const token = await this.mint({
      aud: req.app,
      sub: req.caller,
      company_id: req.company_id,
      ability: req.endpoint,
      idem_key: req.idem_key ?? requestId,
      sb_version: pre.sb_version ?? undefined,
      ...(req.exec ? { exec: true as const, proposal_id: req.exec.proposal_id, fingerprint: req.exec.fingerprint } : {}),
    });
    const span = this.tracer.start(`gateway ${req.endpoint}`, req.trace ?? null, { 'neop.app': req.app, 'neop.caller': req.caller, 'neop.request_id': requestId });
    const t0 = process.hrtime.bigint();
    const qs = req.query ? '?' + new URLSearchParams(Object.entries(req.query).map(([k, v]) => [k, String(v)])).toString() : '';
    let res: Response;
    try {
      res = await this.fetchImpl(pre.l3_url.replace(/\/$/, '') + route.path + qs, {
        method: route.method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'contract-version': CONTRACT_VERSION,
          'x-request-id': requestId,
          traceparent: span.header(),
          ...(req.idem_key ? { 'idempotency-key': req.idem_key } : {}),
        },
        body: route.method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined,
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
    } catch (e) {
      span.set('http.status', 0).end('error', 'unreachable');
      this.metrics.inc('neop_gateway_calls_total', 'Gateway calls into apps', { app: req.app, endpoint: req.endpoint, status: 'unreachable' });
      await this.audit({ company_id: req.company_id, actor: req.caller, app_key: req.app, action: `l3.${req.endpoint}`, idem_key: req.idem_key, request_id: requestId, outcome: 'unreachable' });
      throw new GatewayError(502, 'unreachable', `${req.app} did not answer: ${(e as Error).message}`);
    }
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    span.set('http.status', res.status).end(res.status >= 500 ? 'error' : 'ok');
    const endpointLabel = PATHS[req.endpoint] ? req.endpoint : 'ability';
    this.metrics.inc('neop_gateway_calls_total', 'Gateway calls into apps', { app: req.app, endpoint: endpointLabel, status: String(res.status) });
    this.metrics.observe('neop_gateway_latency_seconds', 'Gateway call latency', Number(process.hrtime.bigint() - t0) / 1e9, { app: req.app, endpoint: endpointLabel });
    // 4xx answers are deterministic and stored; 5xx may succeed on retry. Ledger + audit in one round trip.
    const store = ledgered && res.status < 500;
    const audit = req.endpoint !== 'outbox.read';
    if (store || audit) {
      await this.db.query(
        `with l as (
           update neos.gateway_ledger set status = $4, response = $5 where $6 and caller = $1 and target_app = $2 and idem_key = $3 returning 1
         )
         insert into neos.audit (company_id, actor, app_key, action, ability_key, idem_key, request_id, outcome)
         select $8, $1, $2, $9, $10, $3, $11, $12 where $7`,
        [req.caller, req.app, req.idem_key ?? null, res.status, JSON.stringify(body), store, audit, req.company_id, `l3.${req.endpoint}`, req.endpoint, requestId, String(res.status)],
      );
    }
    return { status: res.status, body: body as T, request_id: requestId, replayed: false };
  }
}
