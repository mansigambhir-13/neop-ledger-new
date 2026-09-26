// NEOS platform-lite for the pilot: task store, desk approvals, grants,
// switchboards, vault and the workers that move them. It never reads an app's
// book; everything it knows about an app comes from signed L3 calls and the
// app's outbox (S4).

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { blocksProblem, isSetting, Metrics, rulesProblem, satisfies, strictest, type Decision, type Manifest, type OutboxEvent, type ProposalCreatedPayload, type Setting, type TaskResult } from '@neop/contracts';
import { modelRoute, pickApp, ROUTER_PRINCIPAL, type RouteDecision } from './neuralchat.ts';
import { isEnvelope, VaultCipher, type VaultKeys } from './vault.ts';
import { KeyRing } from './keys.ts';
import { Registry, type PackageBundle } from './registry.ts';
import { roomText } from './bridge/format.ts';
import { attestationProblem, manifestSha256, type ConformanceAttestation } from './conformance.ts';
import { createPool, tx, type Pool, type PoolClient } from '@neop/pgkit';
import { Gateway, GatewayError, retryableStatus } from './gateway.ts';
import type { SigningKeys } from './keys.ts';

export interface PlatformOptions {
  dbUrl: string;
  keys: SigningKeys;
  /** Directory the dev email door writes to (vault lends it per company). */
  mailboxRoot?: string;
  /** Vault keyring (AES-256-GCM). Required outside tests; tests get an ephemeral one. */
  vaultKeys?: VaultKeys;
  /** Platform DB pool (default 20; behind PgBouncer in production). */
  dbPoolSize?: number;
  /** Long-lived registry co-signing keys (separate from the gateway's short-lived tokens). */
  registryKeys?: KeyRing;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  timings?: { approvalsMs?: number; outboxMs?: number; tasksMs?: number; keysMs?: number; a2aResultGiveUpMs?: number; taskDeliveryWindowMs?: number };
  /** How long the gateway waits for an app's answer (default 30 s). */
  gatewayTimeoutMs?: number;
  /** Model NeuralChat routes asks with, through the LLM proxy (default NEOS_ROUTER_MODEL; none = keyword fallback). */
  routerModel?: string | null;
}

export interface ApproverPolicy {
  roles?: ('admin' | 'member')[];
  /** The person who asked (or started the a2a chain) may not approve. */
  four_eyes?: boolean;
}

export class PlatformError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type { VaultKeys };

const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];

export class Platform {
  readonly db: Pool;
  readonly gateway: Gateway;
  readonly vault: VaultCipher;
  registry!: Registry;
  readonly opts: PlatformOptions;
  private timers: NodeJS.Timeout[] = [];
  /** NeuralChat's routing model (null: keyword fallback, recorded as such). */
  routerModel: string | null;
  /** Test/fault-injection hooks. */
  readonly hooks: { afterResolve?: (approvalId: string) => Promise<void> } = {};

  constructor(opts: PlatformOptions) {
    this.opts = opts;
    this.db = createPool(opts.dbUrl, opts.dbPoolSize ?? 20);
    this.gateway = new Gateway(this.db, opts.keys, { timeoutMs: opts.gatewayTimeoutMs });
    this.routerModel = opts.routerModel !== undefined ? opts.routerModel : (process.env.NEOS_ROUTER_MODEL ?? null);
    this.vault = new VaultCipher(opts.vaultKeys ?? VaultCipher.generate());
    if (opts.registryKeys) this.registry = new Registry(this, opts.registryKeys);
  }

  /** Tests and dev: an ephemeral registry keyring when none was configured. */
  async ensureRegistry(): Promise<Registry> {
    if (!this.registry) {
      const { generateSigningKeys } = await import('./keys.ts');
      this.registry = new Registry(this, await generateSigningKeys());
    }
    return this.registry;
  }

  log(msg: string, extra?: Record<string, unknown>): void {
    this.opts.log?.(`[platform] ${msg}`, extra);
  }

  // ── setup ────────────────────────────────────────────────────────────────
  async createCompany(name: string, timeZone = 'Asia/Kolkata'): Promise<{ id: string; slug: string }> {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'company';
    for (let i = 0; ; i++) {
      const slug = i ? `${base}${i + 1}` : base;
      const r = await this.db.query<{ id: string; slug: string }>(
        'insert into neos.companies (name, time_zone, slug) values ($1, $2, $3) on conflict (slug) do nothing returning id, slug',
        [name, timeZone, slug],
      );
      if (r.rows[0]) return r.rows[0];
    }
  }

  /** (5a) A company installs an app; nothing reaches the app for a company that has not. */
  async installApp(companyId: string, app: string, by?: string): Promise<void> {
    await this.db.query(
      `insert into neos.installs (company_id, app_key, installed_by) values ($1, $2, $3)
       on conflict (company_id, app_key) do update set status = 'active'`,
      [companyId, app, by ?? null],
    );
  }

  /**
   * (5a) What NeuralChat is given: the company's installed apps, what each can
   * do, and which abilities need a yes there (effective setting, strictest wins).
   */
  async registryContext(companyId: string) {
    const r = await this.db.query<{ key: string; manifest: Manifest; settings: Record<string, Setting> | null; rules: any[] | null }>(
      `select a.key, a.manifest, sb.settings, sb.rules
         from neos.installs i join neos.apps a on a.key = i.app_key
         left join lateral (select settings, rules from neos.switchboards s where s.company_id = i.company_id and s.app_key = a.key order by version desc limit 1) sb on true
        where i.company_id = $1 and i.status = 'active' and a.status = 'active' order by a.key`,
      [companyId],
    );
    return r.rows.map((row) => {
      const forced = new Set((row.rules ?? []).filter((x) => x?.type === 'require_person').flatMap((x) => x.abilities ?? []));
      return {
        key: row.key,
        name: row.manifest.name,
        subject: row.manifest.subject,
        description: row.manifest.description,
        version: row.manifest.version,
        abilities: row.manifest.abilities
          .map((a) => {
            let setting = strictest(a.floor, row.settings?.[a.key]);
            if (setting === 'on' && a.kind === 'write' && forced.has(a.key)) setting = 'ask_first';
            return { key: a.key, title: a.title, description: a.description, kind: a.kind, setting, needs_yes: a.kind === 'write' && setting === 'ask_first' };
          })
          .filter((a) => a.setting !== 'off'),
      };
    });
  }

  async say(conversationId: string | null, companyId: string, author: string, body: string, kind: string, taskId: string | null = null, c: { query: Pool['query'] } = this.db): Promise<void> {
    if (!conversationId) return;
    await c.query('insert into neos.conversation_messages (company_id, conversation_id, task_id, author, body, kind) values ($1,$2,$3,$4,$5,$6)', [
      companyId,
      conversationId,
      taskId,
      author,
      body,
      kind,
    ]);
  }

  /**
   * Steps 1–6 from the NEOS app. The ask is stored in the conversation first
   * (2), NeuralChat picks an installed app with registry context (3, 5a), a
   * task is written (4) and handed over (6). Never waits for the job.
   */
  async ask(user: { id: string; company_id: string }, text: string, opts: { app?: string; conversation_id?: string } = {}) {
    // (1) The root of the trace for everything this ask causes, in every app.
    const root = this.gateway.tracer.start('neos.ask', null, { 'neop.company': user.company_id });
    try {
      return await this.askTraced(user, text, opts, root.header());
    } finally {
      root.end();
    }
  }

  private async askTraced(user: { id: string; company_id: string }, text: string, opts: { app?: string; conversation_id?: string }, trace: string) {
    // Hot path (ack latency): storing the ask and reading the registry context are independent — run them together.
    const store = async (): Promise<string> => {
      let id = opts.conversation_id ?? null;
      if (id) {
        const own = await this.db.query('select 1 from neos.conversations where id = $1 and user_id = $2 and company_id = $3', [id, user.id, user.company_id]);
        if (!own.rowCount) throw new PlatformError(404, 'not_found', 'no such conversation');
        await this.say(id, user.company_id, `user:${user.id}`, text, 'message');
        return id;
      }
      // New conversation and its first message in one round trip.
      id = (
        await this.db.query<{ id: string }>(
          `with c as (insert into neos.conversations (company_id, user_id) values ($1, $2) returning id),
                m as (insert into neos.conversation_messages (company_id, conversation_id, task_id, author, body, kind) select $1, c.id, null, $3, $4, 'message' from c)
           select id from c`,
          [user.company_id, user.id, `user:${user.id}`, text],
        )
      ).rows[0]!.id;
      return id;
    };
    const [conversationId, ctx] = await Promise.all([store(), this.registryContext(user.company_id)]);
    if (opts.app && !ctx.some((a) => a.key === opts.app)) throw new PlatformError(403, 'not_installed', `${opts.app} is not installed for your company`);
    const route: RouteDecision = opts.app ? { app: opts.app, method: 'explicit', reason: 'the person named the app' } : await this.route(user.company_id, conversationId, text, ctx);
    const appKey = route.app;
    if (!appKey) {
      const msg = 'No app here looks after that yet.';
      await this.say(conversationId, user.company_id, 'neuralchat', msg, 'notice');
      return { conversation_id: conversationId, handed_to: null, message: msg, routed_by: route.method, route_reason: route.reason };
    }
    const name = ctx.find((a) => a.key === appKey)!.name;
    const t = await this.openTask({
      company_id: user.company_id,
      app_key: appKey,
      requester: `user:${user.id}`,
      ask: text,
      conversation_id: conversationId,
      trace_parent: trace,
      routed_by: route.method,
      route_reason: route.reason,
      beforeDeliver: (id) => this.say(conversationId, user.company_id, 'neuralchat', `Handed to ${name} (task ${id.slice(0, 8)}).`, 'handoff', id),
    });
    return { conversation_id: conversationId, handed_to: appKey, routed_by: route.method, route_reason: route.reason, ...t };
  }

  /**
   * NeuralChat picks the app: a model reasons over the registry context through the LLM proxy
   * (platform budget); without a model, or when the call fails or answers outside the installed
   * apps, the keyword picker decides. Either way the method and reason are audited.
   */
  private async route(companyId: string, conversationId: string, ask: string, ctx: Awaited<ReturnType<Platform['registryContext']>>): Promise<RouteDecision> {
    let decision: RouteDecision;
    if (!this.routerModel || !this.llmProxyUrl) {
      decision = { app: pickApp(ask, ctx), method: 'keyword', reason: `keyword fallback: ${!this.routerModel ? 'no routing model is configured' : 'this platform runs no LLM proxy'}` };
    } else {
      try {
        await this.ensureRouterPrincipal();
        const tz = (await this.db.query<{ time_zone: string }>('select time_zone from neos.companies where id = $1', [companyId])).rows[0]?.time_zone ?? 'UTC';
        const token = await this.gateway.sign(
          {
            company_id: companyId,
            job_id: conversationId,
            sid: `route:${randomUUID()}`,
            budget_micros: Math.round(Number(process.env.NEOS_ROUTER_ASK_USD ?? 0.05) * 1_000_000),
            day_cap_micros: Math.round(Number(process.env.NEOS_ROUTER_DAY_USD ?? 5) * 1_000_000),
            tz,
          },
          'llm-proxy',
          `app:${ROUTER_PRINCIPAL}`,
          120,
        );
        const c = await modelRoute({ proxyUrl: this.llmProxyUrl, token, model: this.routerModel, ask, apps: ctx });
        decision = { app: c.app, method: 'model', reason: c.reason };
      } catch (e) {
        decision = { app: pickApp(ask, ctx), method: 'keyword', reason: `keyword fallback: the routing model failed (${String((e as Error).message ?? e).slice(0, 300)})` };
      }
    }
    await this.gateway.audit({ company_id: companyId, actor: 'neuralchat', app_key: decision.app ?? undefined, action: 'neuralchat.routed', outcome: decision.method, detail: { app: decision.app, reason: decision.reason, conversation_id: conversationId } });
    return decision;
  }

  /** The platform-owned principal NeuralChat's model spend is metered under (never routed to). */
  private async ensureRouterPrincipal(): Promise<void> {
    await this.db.query(
      `insert into neos.apps (key, l3_url, manifest, contract_version, service_secret_hash, status)
       values ($1, 'platform:internal', $2, '1', $3, 'platform') on conflict (key) do nothing`,
      [ROUTER_PRINCIPAL, JSON.stringify({ app: ROUTER_PRINCIPAL, name: 'NeuralChat', subject: 'routing', description: 'platform router', abilities: [] }), hashSecret(randomBytes(32).toString('hex'))],
    );
  }

  async conversation(user: { id: string; company_id: string }, id: string) {
    const conv = await this.db.query('select * from neos.conversations where id = $1 and user_id = $2 and company_id = $3', [id, user.id, user.company_id]);
    if (!conv.rows[0]) throw new PlatformError(404, 'not_found', 'no such conversation');
    const msgs = await this.db.query('select id, author, kind, body, task_id, at from neos.conversation_messages where conversation_id = $1 order by id', [id]);
    const tasks = await this.db.query('select id, app_key, status, job_id, result from neos.tasks where conversation_id = $1 order by created_at', [id]);
    return { conversation: conv.rows[0], messages: msgs.rows, tasks: tasks.rows };
  }

  /** A person stops a task; the app withdraws what is open and cancels the job. */
  async cancelTask(user: { id: string; company_id: string }, taskId: string, reason?: string) {
    const t = (await this.db.query('select * from neos.tasks where id = $1 and company_id = $2', [taskId, user.company_id])).rows[0];
    if (!t) throw new PlatformError(404, 'not_found', 'no such task');
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status)) return { status: t.status };
    const res = await this.gateway.call({
      caller: 'platform',
      app: t.app_key,
      endpoint: 'tasks.cancel',
      company_id: t.company_id,
      body: { task_id: t.id, by: `user:${user.id}`, reason: reason ?? null },
      idem_key: `cancel:${t.id}`,
    });
    if (res.status !== 200) throw new PlatformError(res.status, 'cancel_failed', JSON.stringify(res.body));
    await this.db.query(`update neos.tasks set status = 'CANCELLED', updated_at = now() where id = $1 and status not in ('COMPLETED', 'FAILED')`, [t.id]);
    return { status: 'CANCELLED' };
  }

  async createUser(companyId: string, u: { name: string; email: string; role: 'admin' | 'member' | 'operator'; token?: string }): Promise<{ id: string; token: string }> {
    const token = u.token ?? `neos_${randomBytes(24).toString('base64url')}`;
    const r = await this.db.query<{ id: string }>(
      'insert into neos.users (company_id, name, email, role, token_hash) values ($1,$2,$3,$4,$5) returning id',
      [companyId, u.name, u.email, u.role, hashSecret(token)],
    );
    return { id: r.rows[0]!.id, token };
  }

  async registerApp(a: {
    key: string;
    l3_url: string;
    manifest: Manifest;
    service_secret: string;
    blocks?: Record<string, unknown>;
    /** The conformance attestation (scripts/conformance.ts) for exactly this manifest. Required in production. */
    conformance?: unknown;
    /** The app's registry author key (Ed25519 public JWK): what it publishes must be signed with its private half. */
    author_public_key?: unknown;
  }): Promise<void> {
    if (a.key === ROUTER_PRINCIPAL) throw new PlatformError(422, 'reserved_key', `${a.key} is reserved by the platform`);
    // Plan, test bar: an app is registered on green, not on promises.
    const unattested = attestationProblem(a.conformance, a.key, a.manifest);
    if (unattested && process.env.NEOS_ENV === 'production') {
      await this.gateway.audit({ company_id: null, actor: 'platform', app_key: undefined, action: 'app.register_refused', outcome: 'unattested', detail: { app: a.key, problem: unattested } });
      throw new PlatformError(422, 'unattested', `${a.key} is not registered: ${unattested}`);
    }
    if (a.author_public_key !== undefined && !isEd25519Jwk(a.author_public_key)) throw new PlatformError(422, 'bad_author_key', 'the author key must be an Ed25519 public JWK ({kty:"OKP", crv:"Ed25519", x})');
    const bad = a.manifest.abilities.find((x) => x.kind === 'read' && x.floor === 'ask_first');
    if (bad) throw new PlatformError(422, 'read_cannot_ask_first', `${bad.key}: a read cannot be ask-first`);
    const blocks = a.blocks ?? {};
    const problem = blocksProblem(blocks, a.manifest);
    if (problem) throw new PlatformError(422, 'bad_blocks', problem);
    // Borrowing (WP §10): what this app `uses` must exist at a version in its range…
    const others = new Map((await this.db.query<{ key: string; manifest: Manifest }>('select key, manifest from neos.apps where key <> $1', [a.key])).rows.map((r) => [r.key, r.manifest]));
    for (const u of a.manifest.uses ?? []) {
      if (u.ability === 'tasks.open') continue;
      const owner = others.get(u.app);
      // Owner not registered yet: its own registration checks this range (below), and the call is refused until then.
      if (!owner) continue;
      const ab = owner.abilities.find((x) => x.key === u.ability);
      if (!ab || ab.kind !== 'read') throw new PlatformError(422, 'uses_unknown_ability', `${u.app} has no read ${u.ability}`);
      if (!satisfies(ab.version, u.range)) throw new PlatformError(422, 'uses_version', `${a.key} needs ${u.ability}@${u.range}; ${u.app} serves ${ab.version}`);
    }
    // …and an owner may not re-register in a way that breaks a version its borrowers pin.
    for (const [key, m] of others) {
      for (const u of (m.uses ?? []).filter((x) => x.app === a.key && x.ability !== 'tasks.open')) {
        const ab = a.manifest.abilities.find((x) => x.key === u.ability);
        if (!ab || !satisfies(ab.version, u.range)) {
          throw new PlatformError(409, 'breaks_borrower', `${key} uses ${u.ability}@${u.range}; this manifest ${ab ? `serves ${ab.version}` : 'drops it'}`);
        }
      }
    }
    await this.db.query(
      `insert into neos.apps (key, l3_url, manifest, contract_version, service_secret_hash, blocks, conformance, author_key) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (key) do update set l3_url = excluded.l3_url, manifest = excluded.manifest,
         contract_version = excluded.contract_version, service_secret_hash = excluded.service_secret_hash, blocks = excluded.blocks,
         conformance = excluded.conformance, author_key = coalesce(excluded.author_key, neos.apps.author_key)
       where neos.apps.status <> 'platform'`,
      [
        a.key,
        a.l3_url,
        JSON.stringify(a.manifest),
        a.manifest.contract_version,
        hashSecret(a.service_secret),
        JSON.stringify(blocks),
        unattested ? null : JSON.stringify(a.conformance),
        a.author_public_key === undefined ? null : JSON.stringify(a.author_public_key),
      ],
    );
    await this.db.query('insert into neos.outbox_cursors (app_key) values ($1) on conflict do nothing', [a.key]);
    // Dev accepts an app without a green attestation, but never silently.
    await this.gateway.audit({
      company_id: null,
      actor: 'platform',
      action: 'app.registered',
      outcome: unattested ? 'unattested' : 'attested',
      detail: { app: a.key, manifest_sha256: manifestSha256(a.manifest), ...(unattested ? { problem: unattested } : { commit: (a.conformance as ConformanceAttestation).commit }) },
    });
  }

  async authService(header: string | undefined): Promise<string | null> {
    const m = /^Service ([a-z][a-z0-9_]*):(.+)$/.exec(header ?? '');
    if (!m) return null;
    const h = hashSecret(m[2]!);
    const r = await this.db.query<{ key: string }>(
      `select key from neos.apps where key = $1 and status = 'active'
          and (service_secret_hash = $2 or (previous_service_secret_hash = $2 and secret_rotated_at > now() - interval '1 day'))`,
      [m[1], h],
    );
    return r.rows[0]?.key ?? null;
  }

  /** Rotate an app's service secret; the old one keeps working for a day (R10). */
  async rotateServiceSecret(app: string, next: string): Promise<void> {
    await this.db.query(
      `update neos.apps set previous_service_secret_hash = service_secret_hash, service_secret_hash = $2, secret_rotated_at = now() where key = $1`,
      [app, hashSecret(next)],
    );
    await this.gateway.audit({ company_id: null, actor: 'platform', app_key: app, action: 'service_secret.rotated' });
  }

  async authUser(header: string | undefined): Promise<{ id: string; company_id: string; role: string; name: string } | null> {
    const m = /^Bearer (.+)$/.exec(header ?? '');
    if (!m) return null;
    const r = await this.db.query('select id, company_id, role, name from neos.users where token_hash = $1', [hashSecret(m[1]!)]);
    return r.rows[0] ?? null;
  }

  async setVaultSecret(companyId: string, door: string, secret: Record<string, unknown>): Promise<void> {
    await this.db.query(
      `insert into neos.vault_secrets (company_id, door, secret) values ($1,$2,$3)
       on conflict (company_id, door) do update set secret = excluded.secret, updated_at = now()`,
      [companyId, door, JSON.stringify(this.vault.seal(secret, `${companyId}:${door}`))],
    );
  }

  /** Re-encrypt every secret under the active vault key (after adding a key, or to seal legacy rows). */
  async rekeyVault(): Promise<number> {
    const rows = (await this.db.query<{ company_id: string; door: string; secret: unknown }>('select company_id, door, secret from neos.vault_secrets')).rows;
    let n = 0;
    for (const r of rows) {
      const aad = `${r.company_id}:${r.door}`;
      if (isEnvelope(r.secret) && r.secret.kid === this.vault.active) continue;
      const plain = isEnvelope(r.secret) ? this.vault.open(r.secret, aad) : (r.secret as Record<string, unknown>);
      await this.db.query('update neos.vault_secrets set secret = $3, updated_at = now() where company_id = $1 and door = $2', [
        r.company_id,
        r.door,
        JSON.stringify(this.vault.seal(plain, aad)),
      ]);
      n++;
    }
    return n;
  }

  // ── switchboards ─────────────────────────────────────────────────────────
  async switchboard(companyId: string, app: string) {
    const co = await this.db.query('select id, name, time_zone from neos.companies where id = $1', [companyId]);
    if (!co.rows[0]) throw new PlatformError(404, 'not_found', 'no such company');
    const r = await this.db.query(
      'select version, settings, rules, budget, approvals from neos.switchboards where company_id = $1 and app_key = $2 order by version desc limit 1',
      [companyId, app],
    );
    const sb = r.rows[0] ?? { version: 0, settings: {}, rules: [], budget: {}, approvals: {} };
    return { ...sb, company: co.rows[0] };
  }

  /** A company can only tighten a switch; it can never loosen the app's floor. */
  async setSwitchboard(
    companyId: string,
    app: string,
    by: string,
    patch: { settings?: Record<string, Setting>; rules?: unknown[]; budget?: Record<string, number>; approvals?: Record<string, ApproverPolicy> },
  ): Promise<number> {
    const appRow = await this.db.query<{ manifest: Manifest }>('select manifest from neos.apps where key = $1', [app]);
    const manifest = appRow.rows[0]?.manifest;
    if (!manifest) throw new PlatformError(404, 'not_found', 'no such app');
    const lines: { key: string; kind: string; floor: Setting }[] = [...manifest.abilities, ...(await this.packageAbilities(app, companyId))];
    const skills = await this.skillLines(app, companyId, manifest);
    for (const [k, v] of Object.entries(patch.settings ?? {})) {
      if (k.startsWith('skill:')) {
        if (!skills.some((x) => `skill:${x.key}` === k)) throw new PlatformError(422, 'unknown_skill', `${k.slice(6)} is not a skill of ${app}`);
        if (v !== 'on' && v !== 'off') throw new PlatformError(422, 'bad_setting', `${k}: a skill line is on or off`);
        continue;
      }
      const a = lines.find((x) => x.key === k);
      if (!a) throw new PlatformError(422, 'unknown_ability', `${k} is not in ${app}'s manifest`);
      if (!isSetting(v)) throw new PlatformError(422, 'bad_setting', `${k}: ${String(v)}`);
      if (strictest(a.floor, v) !== v) throw new PlatformError(422, 'cannot_loosen', `${k}: the app's floor is ${a.floor}; a company can only tighten it`);
      if (a.kind === 'read' && v === 'ask_first') throw new PlatformError(422, 'read_cannot_ask_first', `${k} is a read: it can be on or off, not ask-first`);
    }
    if (patch.rules !== undefined) {
      const problem = rulesProblem(patch.rules, lines.map((a) => a.key));
      if (problem) throw new PlatformError(422, 'bad_rule', problem);
    }
    for (const [k, pol] of Object.entries(patch.approvals ?? {})) {
      if (k !== '*' && !lines.some((a) => a.key === k && a.kind === 'write')) throw new PlatformError(422, 'unknown_ability', `${k} is not a write of ${app}`);
      if (pol.roles && (!Array.isArray(pol.roles) || pol.roles.some((r) => !['admin', 'member'].includes(r)))) throw new PlatformError(422, 'bad_policy', `${k}: roles must be admin/member`);
    }
    const version = await tx(this.db, async (c) => {
      const cur = await c.query('select version, settings, rules, budget, approvals from neos.switchboards where company_id = $1 and app_key = $2 order by version desc limit 1 for update', [
        companyId,
        app,
      ]);
      const prev = cur.rows[0] ?? { version: 0, settings: {}, rules: [], budget: {}, approvals: {} };
      const next = prev.version + 1;
      await c.query(
        'insert into neos.switchboards (company_id, app_key, version, settings, rules, budget, updated_by, approvals) values ($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          companyId,
          app,
          next,
          JSON.stringify({ ...prev.settings, ...(patch.settings ?? {}) }),
          JSON.stringify(patch.rules ?? prev.rules),
          JSON.stringify({ ...prev.budget, ...(patch.budget ?? {}) }),
          by,
          JSON.stringify({ ...prev.approvals, ...(patch.approvals ?? {}) }),
        ],
      );
      return next;
    });
    await this.gateway.audit({ company_id: companyId, actor: `user:${by}`, app_key: app, action: 'switchboard.changed', outcome: String(version), detail: patch });
    // Tell the app so its gate drops its cache now, not in 30 s — and keep telling it until it answers.
    await this.notifyApp(app, companyId);
    return version;
  }

  // ── grants (standing yeses, D8) ──────────────────────────────────────────
  async createGrant(g: { company_id: string; app_key: string; ability_key: string; limits: Record<string, unknown>; expires_at: Date; created_by: string }): Promise<string> {
    const r = await this.db.query<{ id: string }>(
      'insert into neos.grants (company_id, app_key, ability_key, limits, expires_at, created_by) values ($1,$2,$3,$4,$5,$6) returning id',
      [g.company_id, g.app_key, g.ability_key, JSON.stringify(g.limits), g.expires_at, g.created_by],
    );
    return r.rows[0]!.id;
  }

  /** Mint an execution token for a gate-proposed action a grant covers; null if none does. */
  async grantExecutionToken(app: string, req: { company_id: string; job_id: string; proposal_id: string; ability_key: string; ability_version?: string; fingerprint: string; amount_minor?: number; currency?: string; recipients?: string[] }) {
    await this.assertInstalled(app, req.company_id);
    const grants = await this.db.query(
      `select * from neos.grants where company_id = $1 and app_key = $2 and ability_key = $3 and status = 'ACTIVE' and expires_at > now() order by created_at`,
      [req.company_id, app, req.ability_key],
    );
    for (const g of grants.rows) {
      const L = g.limits as { per_call_minor?: number; per_month_minor?: number; currency?: string; recipients_allow?: string[] };
      // A limit the call cannot be measured against never auto-approves (H1): a person decides.
      const hasAmountLimit = L.per_call_minor !== undefined || L.per_month_minor !== undefined;
      if (hasAmountLimit && typeof req.amount_minor !== 'number') continue;
      if (L.currency && req.currency !== L.currency) continue;
      if (L.per_call_minor !== undefined && req.amount_minor! > L.per_call_minor) continue;
      if (L.recipients_allow && (!req.recipients?.length || req.recipients.some((r) => !L.recipients_allow!.includes(r)))) continue;
      if (L.per_month_minor !== undefined) {
        // "This month" is the company's month (C5: company time zone), not the database's UTC month.
        const used = await this.db.query<{ s: string }>(
          `select coalesce(sum((a.detail->>'amount_minor')::bigint), 0)::bigint as s
             from neos.audit a, neos.companies co
            where co.id = $2 and a.action = 'grant.used' and a.detail->>'grant_id' = $1
              and a.at >= ${MONTH_START_SQL('co.time_zone')}`,
          [g.id, req.company_id],
        );
        if (Number(used.rows[0]!.s) + (req.amount_minor ?? 0) > L.per_month_minor) continue;
      }
      const token = await this.gateway.mint({
        aud: app,
        sub: `grant:${g.id}`,
        company_id: req.company_id,
        ability: 'proposals.execute',
        idem_key: `grant:${req.proposal_id}`,
        ...(req.ability_version ? { ability_version: req.ability_version } : {}),
        exec: true,
        proposal_id: req.proposal_id,
        fingerprint: req.fingerprint,
      });
      await this.gateway.audit({
        company_id: req.company_id,
        actor: `grant:${g.id}`,
        app_key: app,
        action: 'grant.used',
        ability_key: req.ability_key,
        outcome: 'token_minted',
        detail: { grant_id: g.id, proposal_id: req.proposal_id, fingerprint: req.fingerprint, amount_minor: req.amount_minor ?? null, job_id: req.job_id },
      });
      return { token, grant_id: g.id as string };
    }
    return null;
  }

  /** A grant suspends itself the moment something goes wrong under it. */
  private async suspendGrantIfFailed(approvalOrProposal: { proposal_id: string; outcome: string }, c: { query: Pool['query'] } = this.db): Promise<void> {
    if (approvalOrProposal.outcome === 'DONE') return;
    const r = await c.query<{ grant_id: string }>(
      `select detail->>'grant_id' as grant_id from neos.audit where action = 'grant.used' and detail->>'proposal_id' = $1 limit 1`,
      [approvalOrProposal.proposal_id],
    );
    const gid = r.rows[0]?.grant_id;
    if (gid) {
      const s = await c.query(`update neos.grants set status = 'SUSPENDED', suspended_reason = $2 where id = $1 and status = 'ACTIVE' returning company_id, app_key, ability_key`, [
        gid,
        `execution ${approvalOrProposal.outcome} for proposal ${approvalOrProposal.proposal_id}`,
      ]);
      const g = s.rows[0];
      if (g) {
        await c.query(`insert into neos.audit (company_id, actor, app_key, action, ability_key, outcome, detail) values ($1, 'platform', $2, 'grant.suspended', $3, $4, $5)`, [
          g.company_id,
          g.app_key,
          g.ability_key,
          approvalOrProposal.outcome,
          JSON.stringify({ grant_id: gid, proposal_id: approvalOrProposal.proposal_id }),
        ]);
      }
    }
  }

  /** A person lets one app call another's ability (borrowing) or hand it tasks (`tasks.open`). */
  async grantAcl(user: { id: string; company_id: string }, g: { caller_app: string; target_app: string; ability_key: string }): Promise<void> {
    const m = (await this.db.query<{ manifest: Manifest }>('select manifest from neos.apps where key = $1', [g.target_app])).rows[0]?.manifest;
    if (!m) throw new PlatformError(404, 'not_found', `no app ${g.target_app}`);
    if (g.ability_key !== 'tasks.open' && !m.abilities.some((a) => a.key === g.ability_key && a.kind === 'read')) {
      throw new PlatformError(422, 'not_borrowable', `${g.ability_key} is not a read of ${g.target_app}; writes are asked for as tasks`);
    }
    await this.db.query(
      `insert into neos.acl (caller_app, target_app, ability_key, company_id, granted_by) values ($1,$2,$3,$4,$5) on conflict do nothing`,
      [g.caller_app, g.target_app, g.ability_key, user.company_id, user.id],
    );
    await this.gateway.audit({ company_id: user.company_id, actor: `user:${user.id}`, app_key: g.target_app, action: 'acl.granted', ability_key: g.ability_key, detail: g });
    // The borrower's gate re-reads what it may borrow now, not when its cache expires.
    await this.notifyApp(g.caller_app, user.company_id).catch(() => {});
  }

  async revokeAcl(user: { id: string; company_id: string }, g: { caller_app: string; target_app: string; ability_key: string }): Promise<void> {
    await this.db.query('delete from neos.acl where caller_app = $1 and target_app = $2 and ability_key = $3 and company_id = $4', [g.caller_app, g.target_app, g.ability_key, user.company_id]);
    await this.gateway.audit({ company_id: user.company_id, actor: `user:${user.id}`, app_key: g.target_app, action: 'acl.revoked', ability_key: g.ability_key, detail: g });
    await this.notifyApp(g.caller_app, user.company_id).catch(() => {});
  }

  // ── package migrations (run by the ops migration runner, never at request time) ──
  async pendingPackageMigrations(): Promise<{ host_app: string; entry_key: string; version: string; bundle: PackageBundle }[]> {
    const r = await this.db.query(
      `select distinct i.host_app, i.entry_key, i.pinned_version as version, e.artifact_hash
         from neos.registry_installs i join neos.registry_entries e on e.key = i.entry_key and e.version = i.pinned_version
        where i.status = 'pending_migration' and e.kind = 'package'`,
    );
    const out = [];
    for (const row of r.rows) {
      const bytes = await this.registry.artifact(row.artifact_hash);
      if (bytes) out.push({ host_app: row.host_app, entry_key: row.entry_key, version: row.version, bundle: JSON.parse(bytes.toString('utf8')) as PackageBundle });
    }
    return out;
  }

  async markPackageMigrated(host: string, key: string, version: string, detail: Record<string, unknown> = {}): Promise<void> {
    await tx(this.db, async (c) => {
      await c.query('insert into neos.package_migrations (host_app, entry_key, version) values ($1,$2,$3) on conflict do nothing', [host, key, version]);
      await c.query(`update neos.registry_installs set status = 'active', last_error = null where host_app = $1 and entry_key = $2 and pinned_version = $3 and status = 'pending_migration'`, [host, key, version]);
      await c.query(`insert into neos.audit (actor, app_key, action, outcome, detail) values ('platform', $1, 'registry.package_migrated', 'ok', $2)`, [host, JSON.stringify({ entry: key, version, ...detail })]);
    });
  }

  /**
   * A package's migrations or self-test failed: the install does not go active. An update goes back
   * to the version it replaced (still migrated); a first install is marked failed. Audited.
   */
  async failPackageInstall(host: string, key: string, version: string, error: string): Promise<void> {
    await tx(this.db, async (c) => {
      const rows = (
        await c.query<{ company_id: string; previous_version: string | null }>(
          `select company_id, previous_version from neos.registry_installs where host_app = $1 and entry_key = $2 and pinned_version = $3 and status = 'pending_migration' for update`,
          [host, key, version],
        )
      ).rows;
      for (const r of rows) {
        const back = r.previous_version
          ? (await c.query('select 1 from neos.package_migrations where host_app = $1 and entry_key = $2 and version = $3', [host, key, r.previous_version])).rowCount
          : 0;
        await c.query(
          `update neos.registry_installs set status = $5, pinned_version = $6, previous_version = null, last_error = $4
            where company_id = $1 and host_app = $2 and entry_key = $3`,
          [r.company_id, host, key, error.slice(0, 1000), back ? 'active' : 'failed', back ? r.previous_version : version],
        );
        await c.query(`insert into neos.audit (company_id, actor, app_key, action, outcome, detail) values ($1, 'platform', $2, 'registry.install_failed', $3, $4)`, [
          r.company_id,
          host,
          back ? 'rolled_back' : 'failed',
          JSON.stringify({ entry: key, version, back_to: back ? r.previous_version : null, error: error.slice(0, 500) }),
        ]);
      }
    });
  }

  /** Run one pending package migration (with its self-test) and settle the install either way. */
  async applyPackageMigration(p: { host_app: string; entry_key: string; version: string; bundle: PackageBundle }, run: () => Promise<string[]>): Promise<string[]> {
    let applied: string[];
    try {
      applied = await run();
    } catch (e) {
      await this.failPackageInstall(p.host_app, p.entry_key, p.version, String((e as Error).message ?? e));
      throw e;
    }
    await this.markPackageMigrated(p.host_app, p.entry_key, p.version, { applied, selftest: /\bselftest\b/.test(p.bundle.handlers) ? 'passed' : 'none' });
    return applied;
  }

  // ── borrowing and a2a (Phase 4) ───────────────────────────────────────────
  /** What a host needs to offer a borrowed ability: the owner's contract and its setting at this company. */
  async borrowDescribe(host: string, req: { company_id: string; app?: string | null; ability: string }) {
    await this.assertInstalled(host, req.company_id);
    if (!req.app) {
      // A requirement of an installed registry entry: its owner is whoever the admin's ACL row names.
      const row = (await this.db.query<{ target_app: string }>('select target_app from neos.acl where caller_app = $1 and ability_key = $2 and company_id = $3 order by granted_at limit 1', [host, req.ability, req.company_id])).rows[0];
      if (!row) throw new PlatformError(404, 'not_granted', `no ACL row lets ${host} borrow ${req.ability}`);
      req = { ...req, app: row.target_app };
    }
    const owner = (await this.registryContext(req.company_id)).find((a) => a.key === req.app);
    if (!owner) throw new PlatformError(404, 'not_installed', `${req.app} is not installed for this company`);
    const line = owner.abilities.find((a) => a.key === req.ability);
    const manifest = (await this.db.query<{ manifest: Manifest }>('select manifest from neos.apps where key = $1', [req.app])).rows[0]!.manifest;
    const ability = manifest.abilities.find((a) => a.key === req.ability);
    if (!ability) throw new PlatformError(404, 'not_found', `${req.app} has no ${req.ability}`);
    const acl = await this.db.query('select 1 from neos.acl where caller_app = $1 and target_app = $2 and ability_key = $3 and company_id = $4', [
      host,
      req.app,
      req.ability,
      req.company_id,
    ]);
    return { ability, owner: req.app, owner_setting: line?.setting ?? 'off', acl: (acl.rowCount ?? 0) > 0 };
  }

  /** A call from one app's backend to another app, through the gateway, as `app:<host>`. */
  async internalCall(host: string, req: { company_id: string; app: string; endpoint: string; body?: unknown; idem_key: string }) {
    await this.assertInstalled(host, req.company_id);
    if (['tasks.open', 'proposals.resolve', 'proposals.execute', 'outbox.read', 'inbox.deliver', 'tasks.cancel', 'tasks.result', 'switchboard.changed', 'outbox.ack', 'schedules.set', 'schedules.list', 'manifest'].includes(req.endpoint)) {
      throw new PlatformError(403, 'denied', `${req.endpoint} is not callable this way`);
    }
    return this.gateway.call({ caller: `app:${host}`, app: req.app, endpoint: req.endpoint, company_id: req.company_id, body: req.body, idem_key: req.idem_key });
  }

  /**
   * An app hands a task to another app (a2a). The chain of apps is carried in
   * `lineage`; a target already in it, or a chain deeper than 3, is refused
   * here — the only place that sees both apps (R3).
   */
  async openA2ATask(host: string, req: { company_id: string; target: string; ask: string; parent_task_id: string | null; host_job_id: string }) {
    await this.assertInstalled(host, req.company_id);
    const parent = req.parent_task_id
      ? (await this.db.query<{ lineage: string[]; company_id: string }>('select lineage, company_id from neos.tasks where id = $1', [req.parent_task_id])).rows[0]
      : null;
    if (parent && parent.company_id !== req.company_id) throw new PlatformError(403, 'denied', 'parent task belongs to another company');
    const lineage = [...(parent?.lineage ?? []), host];
    if (req.target === host || lineage.includes(req.target)) throw new PlatformError(409, 'a2a_loop', `${req.target} is already in this chain (${lineage.join(' → ')})`);
    if (lineage.length > 3) throw new PlatformError(409, 'a2a_depth', `a2a chains stop at depth 3 (${lineage.join(' → ')})`);
    const r = await this.db.query<{ id: string }>(
      `insert into neos.tasks (company_id, app_key, requester, ask, parent_task_id, lineage, host_job_id) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [req.company_id, req.target, `app:${host}`, req.ask, req.parent_task_id, JSON.stringify(lineage), req.host_job_id],
    );
    const id = r.rows[0]!.id;
    try {
      await this.deliverTask(id);
    } catch (e) {
      if (e instanceof GatewayError && e.status === 403) {
        // Refused by the gateway (no ACL, not installed): final, not retried.
        await this.db.query(`update neos.tasks set status = 'FAILED', last_error = $2, result_delivered_at = now() where id = $1`, [id, e.message]);
        throw new PlatformError(403, e.code, e.message);
      }
      // Otherwise the task stays OPEN and tasksTick retries delivery.
    }
    return { task_id: id, lineage };
  }

  /** Deliver finished a2a results to the host app's job (signed tasks.result), until acknowledged. */
  async a2aResultsTick(): Promise<void> {
    const due = await this.db.query(
      `select t.*, split_part(t.requester, ':', 2) as host_app from neos.tasks t
        where t.requester like 'app:%' and t.result_delivered_at is null and t.status in ('COMPLETED', 'FAILED', 'CANCELLED')
          and t.result_failed_at is null and (t.result_next_at is null or t.result_next_at <= now())
        order by t.updated_at limit 20`,
    );
    const giveUpMs = this.opts.timings?.a2aResultGiveUpMs ?? 10 * 60_000;
    for (const t of due.rows) {
      let why: string;
      try {
        const res = await this.gateway.call({
          caller: 'platform',
          app: t.host_app,
          endpoint: 'tasks.result',
          company_id: t.company_id,
          // The idempotency key names the attempt: a 404 is never stored, but a fresh key keeps each retry a real call.
          body: { task_id: t.id, status: t.status, from_app: t.app_key, result: t.result },
          idem_key: `result:${t.id}:${t.result_attempts}`,
        });
        if (res.status === 200) {
          await this.db.query('update neos.tasks set result_delivered_at = now(), last_error = null where id = $1', [t.id]);
          continue;
        }
        // 404 "no job waits on that task" is not an answer: the host may not have recorded its wait yet.
        why = `tasks.result answered ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`;
      } catch (e) {
        why = String(e);
      }
      await this.resultRetryOrGiveUp(t, why, giveUpMs);
    }
  }

  /** Back off and retry an undelivered a2a result; past the window, give up loudly (audit + task failure). */
  private async resultRetryOrGiveUp(t: any, why: string, giveUpMs: number): Promise<void> {
    const first = t.result_first_try_at ? new Date(t.result_first_try_at).getTime() : Date.now();
    const n = Number(t.result_attempts) + 1;
    if (Date.now() - first >= giveUpMs) {
      const msg = `result could not be delivered to ${t.host_app} after ${n} attempts: ${why}`.slice(0, 500);
      await tx(this.db, async (c) => {
        await c.query(
          `update neos.tasks set status = 'FAILED', result_failed_at = now(), result_attempts = $2, last_error = $3, updated_at = now() where id = $1`,
          [t.id, n, msg],
        );
        await c.query(`insert into neos.audit (company_id, actor, app_key, action, outcome, detail) values ($1, 'platform', $2, 'a2a.result_undeliverable', 'gave_up', $3)`, [
          t.company_id,
          t.host_app,
          JSON.stringify({ task_id: t.id, from_app: t.app_key, task_status: t.status, attempts: n, error: why.slice(0, 300) }),
        ]);
      });
      this.log('a2a result undeliverable; task failed', { task: t.id, host: t.host_app });
      return;
    }
    await this.db.query(
      `update neos.tasks set result_attempts = $2, result_first_try_at = coalesce(result_first_try_at, now()),
         result_next_at = now() + ($3 || ' milliseconds')::interval, last_error = $4 where id = $1`,
      [t.id, n, String(BACKOFF_MS[Math.min(n - 1, BACKOFF_MS.length - 1)]), why.slice(0, 500)],
    );
  }

  // ── LLM session tokens (R1) ───────────────────────────────────────────────
  /** Where agents reach the LLM proxy; null when this platform runs none (tests with a local model). */
  llmProxyUrl: string | null = null;

  /**
   * A token scoped to one assistant session. The budget comes from the
   * company's switchboard, never from the app or the agent.
   */
  async llmSession(app: string, req: { company_id: string; job_id: string; sid: string; ttl_seconds: number }) {
    if (!this.llmProxyUrl) throw new PlatformError(404, 'no_llm_proxy', 'this platform runs no LLM proxy');
    const inst = await this.db.query("select 1 from neos.installs where company_id = $1 and app_key = $2 and status = 'active'", [req.company_id, app]);
    if (!inst.rowCount) throw new PlatformError(403, 'not_installed', `${app} is not installed for this company`);
    const sb = await this.switchboard(req.company_id, app);
    const perJob = Number(sb.budget?.per_job_usd ?? 5);
    const perDay = Number(sb.budget?.per_day_usd ?? 50);
    const token = await this.gateway.sign(
      {
        company_id: req.company_id,
        job_id: req.job_id,
        sid: req.sid,
        budget_micros: Math.round(perJob * 1_000_000),
        day_cap_micros: Math.round(perDay * 1_000_000),
        tz: sb.company.time_zone,
      },
      'llm-proxy',
      `app:${app}`,
      Math.max(60, req.ttl_seconds),
    );
    return { base_url: this.llmProxyUrl, token };
  }

  // ── vault ────────────────────────────────────────────────────────────────
  /** B1: an app acts for a company only if that company installed it. */
  async assertInstalled(app: string, companyId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(companyId ?? '')) throw new PlatformError(400, 'bad_request', 'company_id required');
    const r = await this.db.query("select 1 from neos.installs where company_id = $1 and app_key = $2 and status = 'active'", [companyId, app]);
    if (!r.rowCount) throw new PlatformError(403, 'not_installed', `${app} is not installed for this company`);
  }

  /** The doors an app may borrow keys for at a company: its manifest's, plus those of packages that company pinned for it. */
  /** The abilities an installed package adds to a host's switchboard (WP §10: lines marked "from <package>"). */
  async packageAbilities(app: string, companyId: string): Promise<{ key: string; kind: 'read' | 'write'; floor: Setting; version: string; package: string; package_version: string; install_status: string }[]> {
    const r = await this.db.query<{ entry_key: string; version: string; offers: any; status: string }>(
      `select i.entry_key, e.version, e.offers, i.status from neos.registry_installs i
         join neos.registry_entries e on e.key = i.entry_key and e.version = i.pinned_version
        where i.company_id = $1 and i.host_app = $2 and i.status <> 'disabled' and e.kind = 'package'`,
      [companyId, app],
    );
    return r.rows.flatMap((row) =>
      (Array.isArray(row.offers) ? row.offers : []).map((o: any) => ({ key: o.key, kind: o.kind, floor: o.floor, version: o.version, package: row.entry_key, package_version: row.version, install_status: row.status })),
    );
  }

  /** Tell an app its board changed (settings, installs): it drops its caches for that company. */
  async notifyApp(app: string, companyId: string): Promise<void> {
    const v = (await this.db.query<{ v: number }>('select coalesce(max(version), 0)::int as v from neos.switchboards where company_id = $1 and app_key = $2', [companyId, app])).rows[0]!.v;
    // Durable first: the push is owed until the app acknowledges it, across retries and restarts.
    const row = (
      await this.db.query(
        `insert into neos.app_notifications (company_id, app_key, version, idem_key) values ($1,$2,$3,$4)
         on conflict (company_id, app_key) do update set version = excluded.version, idem_key = excluded.idem_key, attempts = 0, next_attempt_at = now(), last_error = null
         returning *`,
        [companyId, app, v, `sb:${companyId}:${app}:${v}:${randomUUID()}`],
      )
    ).rows[0];
    await this.deliverNotification(row);
  }

  /** Push one owed switchboard.changed; the row goes only when the app answered 200. */
  private async deliverNotification(n: { company_id: string; app_key: string; version: number; idem_key: string; attempts: number }): Promise<boolean> {
    let err: string;
    try {
      const res = await this.gateway.call({ caller: 'platform', app: n.app_key, endpoint: 'switchboard.changed', company_id: n.company_id, body: { version: n.version }, idem_key: n.idem_key });
      const final = res.status !== 200 && !retryableStatus(res.status, res.body);
      if (res.status === 200 || final) {
        await this.db.query('delete from neos.app_notifications where company_id = $1 and app_key = $2 and idem_key = $3', [n.company_id, n.app_key, n.idem_key]);
        if (final) await this.gateway.audit({ company_id: n.company_id, actor: 'platform', app_key: n.app_key, action: 'switchboard.notify_refused', outcome: String(res.status), detail: res.body });
        return res.status === 200;
      }
      err = `answered ${res.status}`;
    } catch (e) {
      if (e instanceof GatewayError && e.status < 500) {
        // Not installed / not active: nothing to tell, and retrying cannot change that.
        await this.db.query('delete from neos.app_notifications where company_id = $1 and app_key = $2 and idem_key = $3', [n.company_id, n.app_key, n.idem_key]);
        return false;
      }
      err = String(e);
    }
    const a = n.attempts + 1;
    // Short, capped backoff: a switch-off must not lag behind an app that was briefly away.
    const wait = [250, 500, 1_000, 2_000, 5_000][Math.min(a - 1, 4)]!;
    await this.db.query(
      `update neos.app_notifications set attempts = $4, last_error = $5, next_attempt_at = now() + ($6 || ' milliseconds')::interval where company_id = $1 and app_key = $2 and idem_key = $3`,
      [n.company_id, n.app_key, n.idem_key, a, err.slice(0, 500), String(wait)],
    );
    this.log('switchboard.changed not delivered; will retry', { app: n.app_key, attempts: a, e: err });
    return false;
  }

  async notificationsTick(): Promise<void> {
    const due = await this.db.query(`select * from neos.app_notifications where next_attempt_at <= now() order by next_attempt_at limit 50`);
    await Promise.all(due.rows.map((n) => this.deliverNotification(n).catch(() => false)));
  }

  /** Skill lines on the board (WP §10): the app's own skills and registry skills pinned for it. */
  async skillLines(app: string, companyId: string, manifest: Manifest) {
    const own = (manifest.skills ?? []).map((s: any) => ({ key: s.key as string, requires: (s.requires ?? []) as string[], from: 'own' }));
    const reg = await this.db.query<{ entry_key: string; requires: string[]; owner_app: string | null; pinned_version: string }>(
      `select i.entry_key, e.requires, e.owner_app, i.pinned_version from neos.registry_installs i
         join neos.registry_entries e on e.key = i.entry_key and e.version = i.pinned_version
        where i.company_id = $1 and i.host_app = $2 and i.status = 'active' and e.kind = 'skill'`,
      [companyId, app],
    );
    return [...own, ...reg.rows.map((r) => ({ key: r.entry_key, requires: r.requires ?? [], from: `${r.owner_app ?? 'registry'} v${r.pinned_version}` }))];
  }

  async declaredDoors(app: string, companyId: string): Promise<Set<string>> {
    const m = (await this.db.query<{ manifest: Manifest }>('select manifest from neos.apps where key = $1', [app])).rows[0]?.manifest;
    const doors = new Set((m?.doors ?? []).map((d) => d.key));
    const pkgs = await this.db.query<{ artifact_hash: string }>(
      `select e.artifact_hash from neos.registry_installs i join neos.registry_entries e on e.key = i.entry_key and e.version = i.pinned_version
        where i.company_id = $1 and i.host_app = $2 and i.status = 'active' and e.kind = 'package'`,
      [companyId, app],
    );
    for (const p of pkgs.rows) {
      const bytes = await this.registry.artifact(p.artifact_hash);
      for (const d of bytes ? (JSON.parse(bytes.toString('utf8')).manifest?.doors ?? []) : []) doors.add(String(d));
    }
    return doors;
  }

  async lend(app: string, companyId: string, door: string): Promise<Record<string, unknown>> {
    await this.assertInstalled(app, companyId);
    if (!(await this.declaredDoors(app, companyId)).has(door)) {
      await this.gateway.audit({ company_id: companyId, actor: `app:${app}`, app_key: app, action: 'vault.lend', ability_key: door, outcome: 'refused_undeclared' });
      throw new PlatformError(403, 'undeclared_door', `${app} does not declare the ${door} door`);
    }
    const r = await this.db.query<{ secret: Record<string, unknown> }>('select secret from neos.vault_secrets where company_id = $1 and door = $2', [companyId, door]);
    await this.gateway.audit({ company_id: companyId, actor: `app:${app}`, app_key: app, action: 'vault.lend', ability_key: door, outcome: r.rows[0] ? 'lent' : 'none' });
    if (!r.rows[0]) throw new PlatformError(404, 'no_secret', `no ${door} credential for this company`);
    const s = r.rows[0].secret;
    if (!isEnvelope(s)) throw new PlatformError(500, 'vault_unsealed', 'secret is not sealed; run rekeyVault');
    return this.vault.open(s, `${companyId}:${door}`);
  }

  // ── tasks (NeuralChat hands an ask to an app) ────────────────────────────
  async openTask(t: {
    company_id: string;
    app_key: string;
    requester: string;
    ask: string;
    conversation_id?: string | null;
    origin?: 'app' | 'room';
    room_id?: string | null;
    room_event_id?: string | null;
    trace_parent?: string | null;
    routed_by?: 'explicit' | 'model' | 'keyword' | null;
    route_reason?: string | null;
    /** Runs after the task row exists and before it is handed to the app. */
    beforeDeliver?: (taskId: string) => Promise<void>;
  }): Promise<{ task_id: string; status: string; job_id: string | null; ack: string | null }> {
    // Handed over inline right below; the retry worker only looks at it if that fails (no double delivery under load).
    const r = await this.db.query(
      `insert into neos.tasks (company_id, app_key, requester, ask, conversation_id, origin, room_id, trace_parent, routed_by, route_reason, next_attempt_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + interval '10 seconds') returning *`,
      [t.company_id, t.app_key, t.requester, t.ask, t.conversation_id ?? null, t.origin ?? 'app', t.room_id ?? null, t.trace_parent ?? null, t.routed_by ?? null, t.route_reason ?? null],
    );
    const row = r.rows[0]!;
    const id: string = row.id;
    if (t.room_event_id) await this.db.query('update neos.room_events set task_id = $2 where event_id = $1', [t.room_event_id, id]);
    await t.beforeDeliver?.(id);
    const out = await this.deliverTask(row, t.room_event_id ?? undefined).catch(() => null);
    if (out) return { task_id: id, status: out.status, job_id: out.job_id, ack: out.ack };
    const cur = await this.db.query('select status, job_id from neos.tasks where id = $1', [id]);
    return { task_id: id, status: cur.rows[0].status, job_id: cur.rows[0].job_id, ack: null };
  }

  /** Hand a task to its app (tasks.open, or inbox.deliver for a room message). Takes the row or its id. */
  private async deliverTask(taskOrId: string | any, roomEventId?: string): Promise<{ ack: string; status: string; job_id: string } | null> {
    const t = typeof taskOrId === 'string' ? (await this.db.query('select * from neos.tasks where id = $1', [taskOrId])).rows[0] : taskOrId;
    if (!t || t.status !== 'OPEN') return null;
    try {
      const fromRoom = t.origin === 'room';
      const ev = fromRoom ? (roomEventId ? { event_id: roomEventId } : (await this.db.query<{ event_id: string }>('select event_id from neos.room_events where task_id = $1 limit 1', [t.id])).rows[0]) : null;
      const res = await this.gateway.call<{ job_id: string; ack: string }>({
        caller: t.requester.startsWith('app:') ? t.requester : 'platform',
        app: t.app_key,
        endpoint: fromRoom ? 'inbox.deliver' : 'tasks.open',
        company_id: t.company_id,
        body: fromRoom
          ? { task_id: t.id, event_id: ev?.event_id ?? t.id, room_id: t.room_id, sender: t.requester, text: t.ask }
          : { task_id: t.id, ask: t.ask, requester: t.requester },
        idem_key: `task:${t.id}`,
        trace: t.trace_parent,
      });
      if (res.status !== 200) {
        // A definite refusal (4xx other than timeout / rate limit) will not change on retry: fail it now.
        const final = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
        throw Object.assign(new Error(`tasks.open answered ${res.status}: ${JSON.stringify(res.body)}`), { final });
      }
      const u = await this.db.query<{ status: string; job_id: string }>(
        `update neos.tasks set status = case when status = 'OPEN' then 'ACKNOWLEDGED' else status end, job_id = $2, updated_at = now() where id = $1 returning status, job_id`,
        [t.id, res.body.job_id],
      );
      return { ack: res.body.ack, status: u.rows[0]!.status, job_id: u.rows[0]!.job_id };
    } catch (e) {
      // An app that is down (restarting, redeploying) is retried for a window of time, not a count of
      // attempts: a burst of restarts must not lose a person's ask. Past the window, or on a definite
      // refusal, the task fails visibly.
      const attempts = t.open_attempts + 1;
      const windowMs = this.opts.timings?.taskDeliveryWindowMs ?? 10 * 60_000;
      await this.db.query(
        `update neos.tasks set open_attempts = $2, last_error = $3, next_attempt_at = now() + ($4 || ' milliseconds')::interval,
           status = case when $5 or created_at < now() - ($6 || ' milliseconds')::interval then 'FAILED' else status end, updated_at = now() where id = $1`,
        [t.id, attempts, String(e).slice(0, 500), String(BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]), (e as { final?: boolean }).final === true, String(windowMs)],
      );
      throw e;
    }
  }

  async tasksTick(): Promise<void> {
    const due = await this.db.query<{ id: string }>(`select id from neos.tasks where status = 'OPEN' and next_attempt_at <= now() order by created_at limit 20`);
    for (const t of due.rows) await this.deliverTask(t.id).catch(() => {});
  }

  // ── desk: the recorded yes (B3) ──────────────────────────────────────────
  /**
   * A person answers a card against the fingerprint they saw. The platform
   * writes its own row first (RECORDED), then a worker drives resolve → execute
   * until terminal, so a crash between the two never strands a yes.
   */
  /** The person who started the chain that led to this card (walks a2a parents). */
  private async rootRequester(taskId: string | null): Promise<string | null> {
    let id = taskId;
    for (let i = 0; id && i < 10; i++) {
      const t = (await this.db.query<{ requester: string; parent_task_id: string | null }>('select requester, parent_task_id from neos.tasks where id = $1', [id])).rows[0];
      if (!t) return null;
      if (t.requester.startsWith('user:')) return t.requester.slice(5);
      id = t.parent_task_id;
    }
    return null;
  }

  /** R8: who may answer this card. The company sets it; a person may never approve past it. */
  private async checkApprover(approvalId: string, user: { id: string; company_id: string; role?: string }, decision: Decision): Promise<void> {
    const a = (await this.db.query('select app_key, ability_key, task_id, company_id from neos.approvals where id = $1 and company_id = $2', [approvalId, user.company_id])).rows[0];
    if (!a) return; // not found is reported by answer()
    const sb = await this.switchboard(user.company_id, a.app_key);
    const pol: ApproverPolicy = sb.approvals?.[a.ability_key] ?? sb.approvals?.['*'] ?? {};
    if (decision === 'withdraw' || decision === 'no') return; // anyone may stop; only saying yes is restricted
    const role = user.role ?? (await this.db.query<{ role: string }>('select role from neos.users where id = $1', [user.id])).rows[0]?.role;
    if (pol.roles?.length && !pol.roles.includes(role as 'admin' | 'member')) {
      throw new PlatformError(403, 'not_an_approver', `only ${pol.roles.join(' or ')} may approve ${a.ability_key}`);
    }
    if (pol.four_eyes) {
      const root = await this.rootRequester(a.task_id);
      if (!root) throw new PlatformError(403, 'four_eyes', 'nobody on record asked for this; four-eyes cannot be satisfied');
      if (root === user.id) throw new PlatformError(403, 'four_eyes', 'the person who asked cannot also approve this');
    }
  }

  async answer(approvalId: string, user: { id: string; company_id: string; role?: string }, a: { decision: Decision; fingerprint_seen: string; feedback?: string }): Promise<void> {
    await this.checkApprover(approvalId, user, a.decision);
    const r = await this.db.query(
      `update neos.approvals set status = 'RECORDED', decision = $3, fingerprint_seen = $4, feedback = $5,
         decided_by = $2, decided_at = now(), next_attempt_at = now(), updated_at = now()
       where id = $1 and company_id = $6 and status = 'PENDING' and expires_at > now()
         and ($3 <> 'yes' or fingerprint = $4)
       returning id`,
      [approvalId, user.id, a.decision, a.fingerprint_seen, a.feedback ?? null, user.company_id],
    );
    if (!r.rowCount) {
      const cur = await this.db.query('select status, expires_at, fingerprint from neos.approvals where id = $1 and company_id = $2', [approvalId, user.company_id]);
      if (!cur.rows[0]) throw new PlatformError(404, 'not_found', 'no such card');
      // A yes only covers what was shown (WP §5). A mismatch is refused at the door and the card stays
      // open for a yes to what is really on it — not recorded, which would burn the card and strand the job.
      if (cur.rows[0].status === 'PENDING' && new Date(cur.rows[0].expires_at) > new Date() && a.decision === 'yes' && cur.rows[0].fingerprint !== a.fingerprint_seen) {
        await this.gateway.audit({ company_id: user.company_id, actor: `user:${user.id}`, action: 'desk.answer', outcome: 'refused_stale_fingerprint', detail: { approval_id: approvalId, fingerprint_seen: a.fingerprint_seen } });
        throw new PlatformError(409, 'stale_fingerprint', 'what you approved is not what is on the card now; look at it again and answer that');
      }
      throw new PlatformError(409, 'not_open', `this card is ${cur.rows[0].status === 'PENDING' ? 'expired' : cur.rows[0].status}`);
    }
    await this.gateway.audit({ company_id: user.company_id, actor: `user:${user.id}`, action: 'desk.answer', outcome: a.decision, detail: { approval_id: approvalId, fingerprint_seen: a.fingerprint_seen } });
    void this.approvalsTick().catch(() => {});
  }

  async approvalsTick(): Promise<void> {
    // Lease rows so two workers never drive the same approval at once.
    const due = await this.db.query(
      `update neos.approvals set next_attempt_at = now() + interval '60 seconds'
        where id in (select id from neos.approvals where status in ('RECORDED', 'RESOLVED') and next_attempt_at <= now()
                      order by next_attempt_at limit 10 for update skip locked)
        returning *`,
    );
    for (const a of due.rows) await this.driveApproval(a).catch((e) => this.log('approval step failed', { id: a.id, e: String(e) }));
  }

  private async backoff(a: { id: string; attempts: number }, err: string): Promise<void> {
    const n = a.attempts + 1;
    await this.db.query(
      `update neos.approvals set attempts = $2, last_error = $3, next_attempt_at = now() + ($4 || ' milliseconds')::interval, updated_at = now() where id = $1`,
      [a.id, n, err.slice(0, 500), String(BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)])],
    );
  }

  private async driveApproval(a: any): Promise<void> {
    a.trace_parent ??= a.task_id ? (await this.db.query<{ trace_parent: string | null }>('select trace_parent from neos.tasks where id = $1', [a.task_id])).rows[0]?.trace_parent : null;
    if (a.status === 'RECORDED') {
      let res;
      try {
        res = await this.gateway.call({
          caller: 'platform',
          app: a.app_key,
          endpoint: 'proposals.resolve',
          company_id: a.company_id,
          body: { proposal_id: a.proposal_id, decision: a.decision, fingerprint_seen: a.fingerprint_seen, decided_by: `user:${a.decided_by}`, feedback: a.feedback },
          idem_key: `resolve:${a.id}`,
          trace: a.trace_parent,
        });
      } catch (e) {
        return this.backoff(a, String(e));
      }
      if (res.status >= 500) return this.backoff(a, `resolve ${res.status}`);
      if (res.status !== 200) {
        await this.db.query(`update neos.approvals set status = 'REFUSED', last_error = $2, updated_at = now() where id = $1`, [a.id, JSON.stringify(res.body)]);
        return;
      }
      const next = a.decision === 'yes' ? 'RESOLVED' : 'CLOSED';
      // Keep the lease while this worker carries on to execute; a crash lets it lapse and another worker resumes.
      await this.db.query(`update neos.approvals set status = $2, next_attempt_at = now() + interval '60 seconds', attempts = 0, updated_at = now() where id = $1`, [a.id, next]);
      await this.hooks.afterResolve?.(a.id);
      if (next === 'CLOSED') return;
      a = { ...a, status: 'RESOLVED', attempts: 0 };
    }
    if (a.status === 'RESOLVED') {
      // The execution token is minted only against a matching recorded yes.
      if (a.decision !== 'yes' || a.fingerprint_seen !== a.fingerprint) {
        await this.db.query(`update neos.approvals set status = 'REFUSED', last_error = 'no matching yes', updated_at = now() where id = $1`, [a.id]);
        return;
      }
      let res;
      try {
        res = await this.gateway.call({
          caller: 'platform',
          app: a.app_key,
          endpoint: 'proposals.execute',
          company_id: a.company_id,
          body: { proposal_id: a.proposal_id },
          idem_key: `execute:${a.id}`,
          exec: { proposal_id: a.proposal_id, fingerprint: a.fingerprint, ability_version: a.ability_version },
          trace: a.trace_parent,
        });
      } catch (e) {
        return this.backoff(a, String(e));
      }
      if (res.status >= 500 || (res.status === 409 && res.body?.error?.code === 'in_progress')) return this.backoff(a, `execute ${res.status}`);
      if (res.status !== 200) {
        await this.db.query(`update neos.approvals set status = 'REFUSED', last_error = $2, updated_at = now() where id = $1`, [a.id, JSON.stringify(res.body)]);
        return;
      }
      // The outbox consumer may already have settled the card from proposal.executed; never undo that.
      await this.db.query(`update neos.approvals set status = $3, proof = $2, updated_at = now() where id = $1 and status = 'RESOLVED'`, [
        a.id,
        JSON.stringify(res.body),
        approvalStatusFor(res.body?.outcome),
      ]);
    }
  }

  // ── outbox consumer ──────────────────────────────────────────────────────
  async outboxTick(): Promise<number> {
    const apps = await this.db.query<{ key: string }>("select key from neos.apps where status = 'active'");
    let n = 0;
    for (const { key } of apps.rows) n += await this.pullOutbox(key).catch((e) => (this.log('outbox pull failed', { key, e: String(e) }), 0));
    return n;
  }

  /**
   * Pull and apply one app's events. The cursor row is held for the whole
   * pull (SKIP LOCKED), so two pulls — overlapping ticks or two platform
   * processes — never apply the same events twice.
   */
  async pullOutbox(app: string): Promise<number> {
    return tx(this.db, async (c) => {
      const cur = await c.query<{ cursor: number }>('select cursor from neos.outbox_cursors where app_key = $1 for update skip locked', [app]);
      if (!cur.rows[0]) return 0; // another pull holds it
      const after = cur.rows[0].cursor;
      const res = await this.gateway.call<{ events: OutboxEvent<any>[]; next_cursor: number }>({
        caller: 'platform',
        app,
        endpoint: 'outbox.read',
        company_id: null,
        query: { after, limit: 200 },
      });
      if (res.status !== 200) throw new GatewayError(res.status, 'outbox', JSON.stringify(res.body));
      const { events, next_cursor } = res.body;
      if (!events.length) return 0;
      for (const e of events) {
        // Each event in its own savepoint: one bad event is parked, not allowed to stall the rest.
        await c.query('savepoint ev');
        try {
          await this.consume(c, app, e);
          await c.query('release savepoint ev');
        } catch (err) {
          await c.query('rollback to savepoint ev');
          await c.query(
            `insert into neos.outbox_dead_letters (app_key, event_id, company_id, event_type, payload, error) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
            [app, e.id, e.company_id, e.event_type, JSON.stringify(e.payload), String(err).slice(0, 1000)],
          );
          await c.query(`insert into neos.audit (company_id, actor, app_key, action, outcome, detail) values ($1, 'platform', $2, 'outbox.dead_letter', 'parked', $3)`, [
            e.company_id,
            app,
            JSON.stringify({ event_id: e.id, event_type: e.event_type, error: String(err).slice(0, 300) }),
          ]);
          this.log('outbox event parked', { app, id: e.id, type: e.event_type, err: String(err) });
        }
      }
      await c.query('update neos.outbox_cursors set cursor = $2, updated_at = now() where app_key = $1', [app, next_cursor]);
      return events.length;
    });
  }

  /** The task an event belongs to (by task id, or by job id for steps and executions). */
  private async taskFor(c: PoolClient, app: string, p: { task_id?: string | null; job_id?: string | null }, companyId: string) {
    const r = p.task_id
      ? await c.query('select * from neos.tasks where id = $1 and app_key = $2 and company_id = $3', [p.task_id, app, companyId])
      : await c.query('select * from neos.tasks where app_key = $1 and job_id = $2 and company_id = $3', [app, p.job_id, companyId]);
    return r.rows[0] ?? null;
  }

  /** The room a job is mirrored to: the room it came from, else the company's app room. */
  private async roomFor(c: PoolClient, companyId: string, app: string, task: { room_id?: string | null } | null): Promise<string | null> {
    if (task?.room_id) return task.room_id;
    const r = await c.query<{ room_id: string }>("select room_id from neos.rooms where company_id = $1 and app_key = $2 and kind = 'app' and status = 'active'", [companyId, app]);
    return r.rows[0]?.room_id ?? null;
  }

  private async mirror(
    c: PoolClient,
    room: string | null,
    m: { dedupe_key: string; kind: 'ack' | 'step' | 'card' | 'answer' | 'result' | 'notice'; body: string; approval_id?: string; fingerprint_shown?: string },
  ): Promise<void> {
    if (!room) return;
    await c.query(
      `insert into neos.room_messages (room_id, dedupe_key, kind, body, approval_id, fingerprint_shown) values ($1,$2,$3,$4,$5,$6)
       on conflict (room_id, dedupe_key) do nothing`,
      [room, m.dedupe_key, m.kind, m.body, m.approval_id ?? null, m.fingerprint_shown ?? null],
    );
  }

  private async consume(c: PoolClient, app: string, e: OutboxEvent<any>): Promise<void> {
    const p = e.payload;
    const appName = (await c.query<{ name: string }>("select manifest->>'name' as name from neos.apps where key = $1", [app])).rows[0]?.name ?? app;
    switch (e.event_type) {
      case 'job.acknowledged': {
        await c.query(
          `update neos.tasks set job_id = $2, status = case when status = 'OPEN' then 'ACKNOWLEDGED' else status end, updated_at = now()
            where id = $1 and app_key = $3 and company_id = $4`,
          [p.task_id, p.job_id, app, e.company_id],
        );
        const task = await this.taskFor(c, app, p, e.company_id);
        const text = `On it — ${appName} job ${String(p.job_id).slice(0, 8)}.`;
        await this.say(task?.conversation_id ?? null, e.company_id, `app:${app}`, text, 'ack', task?.id ?? null, c);
        await this.mirror(c, await this.roomFor(c, e.company_id, app, task), { dedupe_key: `ack:${p.job_id}`, kind: 'ack', body: text });
        break;
      }
      case 'proposal.created': {
        const pc = p as ProposalCreatedPayload;
        const ins = await c.query<{ id: string }>(
          `insert into neos.approvals (company_id, app_key, proposal_id, job_id, task_id, ability_key, ability_version, args, card, fingerprint, expires_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (app_key, proposal_id) do update set updated_at = neos.approvals.updated_at returning id`,
          [e.company_id, app, pc.proposal_id, pc.job_id, pc.task_id, pc.ability_key, pc.ability_version, JSON.stringify(pc.args), JSON.stringify(pc.card), pc.fingerprint, pc.expires_at],
        );
        const task = await this.taskFor(c, app, pc, e.company_id);
        if (task) await c.query(`update neos.tasks set status = 'WAITING', updated_at = now() where id = $1 and status in ('OPEN','ACKNOWLEDGED')`, [task.id]);
        await this.say(task?.conversation_id ?? null, e.company_id, `app:${app}`, `Waiting for a yes on your desk: ${pc.card.what}`, 'waiting', task?.id ?? null, c);
        await this.mirror(c, await this.roomFor(c, e.company_id, app, task), {
          dedupe_key: `card:${pc.proposal_id}`,
          kind: 'card',
          body: roomText.card(appName, pc),
          approval_id: ins.rows[0]!.id,
          fingerprint_shown: pc.fingerprint,
        });
        break;
      }
      case 'proposal.resolved': {
        // An app-side withdrawal (e.g. the task was cancelled) closes a card nobody answered.
        if (p.status === 'WITHDRAWN') {
          await c.query(
            `update neos.approvals set status = 'CLOSED', decision = 'withdraw', last_error = 'withdrawn by the app', updated_at = now()
              where app_key = $1 and proposal_id = $2 and status = 'PENDING'`,
            [app, p.proposal_id],
          );
        }
        const task = await this.taskFor(c, app, p, e.company_id);
        await this.mirror(c, await this.roomFor(c, e.company_id, app, task), { dedupe_key: `resolved:${p.proposal_id}:${p.decision}`, kind: 'answer', body: roomText.resolved(p) });
        break;
      }
      case 'proposal.expired': {
        await c.query(`update neos.approvals set status = 'EXPIRED', updated_at = now() where app_key = $1 and proposal_id = $2 and status = 'PENDING'`, [app, p.proposal_id]);
        const task = await this.taskFor(c, app, p, e.company_id);
        await this.mirror(c, await this.roomFor(c, e.company_id, app, task), { dedupe_key: `expired:${p.proposal_id}`, kind: 'notice', body: `Proposal ${String(p.proposal_id).slice(0, 8)} expired: nobody answered in time. Nothing was done.` });
        break;
      }
      case 'proposal.executed': {
        await c.query(`insert into neos.audit (company_id, actor, app_key, action, outcome, detail) values ($1, $2, $3, 'proposal.executed', $4, $5)`, [
          e.company_id,
          `app:${app}`,
          app,
          p.outcome,
          JSON.stringify(p),
        ]);
        await this.suspendGrantIfFailed({ proposal_id: p.proposal_id, outcome: p.outcome }, c);
        // The app's own record of the execution settles the card, even when the platform's execute call
        // timed out and every retry is still pending. Reconciliation later moves an UNKNOWN to where it
        // really ended, with the settled proof.
        await c.query(
          `update neos.approvals set status = $3, proof = coalesce($4::jsonb, proof), last_error = null, updated_at = now()
            where app_key = $1 and proposal_id = $2 and status in (${p.reconciled ? "'RESOLVED', 'EXECUTED', 'FAILED', 'UNKNOWN'" : "'RESOLVED'"})`,
          [app, p.proposal_id, approvalStatusFor(p.outcome), p.proof ? JSON.stringify(p.proof) : null],
        );
        const task = await this.taskFor(c, app, p, e.company_id);
        // The job is working again until it reports.
        if (task) await c.query(`update neos.tasks set status = 'ACKNOWLEDGED', updated_at = now() where id = $1 and status = 'WAITING'`, [task.id]);
        await this.mirror(c, await this.roomFor(c, e.company_id, app, task), {
          dedupe_key: `executed:${p.proposal_id}:${p.reconciled ? 'r' : 'x'}`,
          kind: 'notice',
          body: roomText.executed(p),
        });
        break;
      }
      case 'step.mirror': {
        await c.query('insert into neos.activity (company_id, app_key, job_id, seq, kind, summary) values ($1,$2,$3,$4,$5,$6) on conflict do nothing', [
          e.company_id,
          app,
          p.job_id,
          p.seq,
          p.kind,
          p.summary,
        ]);
        if (!['received', 'report', 'failed', 'proposal'].includes(p.kind)) {
          const task = await this.taskFor(c, app, p, e.company_id);
          await this.mirror(c, await this.roomFor(c, e.company_id, app, task), { dedupe_key: `step:${p.job_id}:${p.seq}`, kind: 'step', body: `· ${p.summary}` });
        }
        break;
      }
      case 'a2a.requested': {
        // C6: a2a calls are mirrored into the desk activity feed (there is no bus room).
        const target = (await c.query<{ ask: string; app_key: string; name: string | null }>(
          `select t.ask, t.app_key, a.manifest->>'name' as name from neos.tasks t left join neos.apps a on a.key = t.app_key where t.id = $1 and t.company_id = $2`,
          [p.task_id, e.company_id],
        )).rows[0];
        const who = target?.name ?? p.target ?? 'another app';
        const summary = `${appName} asked ${who} (task ${String(p.task_id).slice(0, 8)})${target ? `: ${target.ask.slice(0, 300)}` : ''}`;
        await c.query(
          `insert into neos.activity (company_id, app_key, job_id, seq, kind, summary, dedupe_key) values ($1,$2,$3,null,'a2a',$4,$5)
           on conflict (app_key, dedupe_key) where dedupe_key is not null do nothing`,
          [e.company_id, app, p.job_id, summary, `a2a:${p.task_id}`],
        );
        break;
      }
      case 'card.raised': {
        const task = await this.taskFor(c, app, p, e.company_id);
        const text = `${p.kind === 'question' ? 'Question' : 'Heads-up'}: ${p.text}`;
        await c.query('insert into neos.conversation_messages (company_id, conversation_id, task_id, author, body, kind) values ($1,$2,$3,$4,$5,$6)', [
          e.company_id,
          task?.conversation_id ?? null,
          task?.id ?? null,
          `app:${app}`,
          text,
          'card',
        ]);
        await this.mirror(c, await this.roomFor(c, e.company_id, app, task), { dedupe_key: `cardraised:${e.id}`, kind: 'notice', body: text });
        break;
      }
      case 'operation.recorded':
        await c.query(
          `insert into neos.audit (company_id, actor, app_key, action, ability_key, idem_key, outcome, detail) values ($1,$2,$3,'app.operation',$4,$5,$6,$7)`,
          [e.company_id, p.caller, app, p.ability_key, p.idempotency_key, p.outcome, JSON.stringify(p)],
        );
        break;
      case 'task.completed':
      case 'task.failed': {
        const result = p.result as TaskResult;
        const task = await this.taskFor(c, app, p, e.company_id);
        if (task) {
          const status = result.outcome === 'cancelled' ? 'CANCELLED' : e.event_type === 'task.completed' ? 'COMPLETED' : 'FAILED';
          await c.query(`update neos.tasks set status = $2, result = $3, updated_at = now() where id = $1`, [task.id, status, JSON.stringify(result)]);
          // (8) Conversations gets the result, typed, from the finished task.
          await c.query('insert into neos.conversation_messages (company_id, conversation_id, task_id, author, body, kind) values ($1,$2,$3,$4,$5,$6)', [
            e.company_id,
            task.conversation_id,
            task.id,
            `app:${app}`,
            result.summary,
            'result',
          ]);
        }
        // (7.9) The room gets the same typed result: what it did, what changed, what it could not do.
        await this.mirror(c, await this.roomFor(c, e.company_id, app, task), { dedupe_key: `result:${p.job_id}`, kind: 'result', body: roomText.result(appName, result) });
        break;
      }
      default:
        break;
    }
  }

  // ── dead letters (R12) ────────────────────────────────────────────────────
  async deadLetters(companyId: string) {
    const r = await this.db.query('select app_key, event_id, event_type, error, at, replayed_at from neos.outbox_dead_letters where company_id = $1 order by at desc limit 200', [companyId]);
    return r.rows;
  }

  /** Re-apply a parked event after the platform bug is fixed; it is marked, never deleted. */
  async replayDeadLetter(companyId: string, app: string, eventId: number): Promise<void> {
    await tx(this.db, async (c) => {
      const d = (await c.query('select * from neos.outbox_dead_letters where app_key = $1 and event_id = $2 and company_id = $3 for update', [app, eventId, companyId])).rows[0];
      if (!d) throw new PlatformError(404, 'not_found', 'no such dead letter');
      if (d.replayed_at) throw new PlatformError(409, 'already_replayed', 'already replayed');
      await c.query('savepoint replay');
      try {
        await this.consume(c, app, { id: d.event_id, company_id: d.company_id, event_type: d.event_type, payload: d.payload, created_at: d.at });
      } catch (e) {
        await c.query('rollback to savepoint replay');
        throw new PlatformError(409, 'replay_failed', `still fails: ${String(e).slice(0, 300)}`);
      }
      await c.query('update neos.outbox_dead_letters set replayed_at = now() where app_key = $1 and event_id = $2', [app, eventId]);
      await c.query(`insert into neos.audit (company_id, actor, app_key, action, outcome, detail) values ($1, 'platform', $2, 'outbox.replayed', 'ok', $3)`, [
        companyId,
        app,
        JSON.stringify({ event_id: eventId }),
      ]);
    });
  }

  /** Tell each app what the platform has durably applied, so it can prune (R11). */
  async ackOutboxes(): Promise<void> {
    const rows = (await this.db.query<{ app_key: string; cursor: number }>("select c.app_key, c.cursor from neos.outbox_cursors c join neos.apps a on a.key = c.app_key where a.status = 'active' and c.cursor > 0")).rows;
    for (const r of rows) {
      await this.gateway
        .call({ caller: 'platform', app: r.app_key, endpoint: 'outbox.ack', company_id: null, body: { cursor: Number(r.cursor) }, idem_key: `ack:${r.app_key}:${r.cursor}` })
        .catch((e) => this.log('outbox ack failed', { app: r.app_key, e: String(e) }));
    }
  }

  async retention(): Promise<void> {
    await this.db.query(`delete from neos.gateway_ledger where created_at < now() - interval '30 days'`);
  }

  /** Prometheus: gateway counters/latency plus platform state read at scrape time. */
  async renderMetrics(): Promise<string> {
    const q = async (sql: string) => (await this.db.query(sql)).rows;
    const g = [
      Metrics.lines('neop_tasks', 'Tasks by app and status', 'gauge', (await q('select app_key, status, count(*)::int as n from neos.tasks group by 1, 2')).map((r) => ({ labels: { app: r.app_key, status: r.status }, value: r.n }))),
      Metrics.lines('neop_approvals', 'Desk approvals by status', 'gauge', (await q('select app_key, status, count(*)::int as n from neos.approvals group by 1, 2')).map((r) => ({ labels: { app: r.app_key, status: r.status }, value: r.n }))),
      Metrics.lines(
        'neop_approval_answer_seconds_avg',
        'Mean time from card to answer (last 7 days)',
        'gauge',
        (await q("select app_key, coalesce(avg(extract(epoch from decided_at - created_at)), 0)::float as s from neos.approvals where decided_at > now() - interval '7 days' group by 1")).map((r) => ({ labels: { app: r.app_key }, value: r.s })),
      ),
      Metrics.lines('neop_dead_letters', 'Parked outbox events not yet replayed', 'gauge', (await q('select app_key, count(*)::int as n from neos.outbox_dead_letters where replayed_at is null group by 1')).map((r) => ({ labels: { app: r.app_key }, value: r.n }))),
      Metrics.lines(
        'neop_llm_spend_usd_today',
        'Model spend today per company and app (USD)',
        'gauge',
        (await q('select company_id, app_key, spent_micros from neos.llm_days where day = current_date')).map((r) => ({ labels: { company: r.company_id, app: r.app_key }, value: Number(r.spent_micros) / 1e6 })),
      ),
      Metrics.lines('neop_llm_refused_total', 'Model calls refused on budget', 'counter', (await q("select app_key, count(*)::int as n from neos.llm_usage where outcome = 'refused_budget' group by 1")).map((r) => ({ labels: { app: r.app_key }, value: r.n }))),
    ];
    return (await this.gateway.metrics.render()) + g.join('\n') + '\n';
  }

  // ── gateway key rotation (R10), durable ──────────────────────────────────
  /**
   * Publish a new signing key now and schedule its activation in the database, so a
   * restart inside the window (verifiers' JWKS caches refreshing) still activates it on
   * time: whichever process holds the keyring activates it on its next tick.
   */
  async rotateGatewayKey(by: string, activateAfterMs = 120_000): Promise<{ next: string; activate_at: string }> {
    const cur = this.gateway.keys.active;
    await this.db.query(`insert into neos.gateway_keys (kid, state, activated_at) values ($1, 'active', now()) on conflict (kid) do nothing`, [cur.kid]);
    const pending = await this.db.query(`select kid from neos.gateway_keys where state = 'next'`);
    if (pending.rowCount) throw new PlatformError(409, 'rotation_in_progress', `key ${pending.rows[0].kid} is already waiting to activate`);
    const k = await this.gateway.keys.rotate();
    const r = await this.db.query<{ activate_at: Date }>(
      `insert into neos.gateway_keys (kid, state, activate_at) values ($1, 'next', now() + ($2 || ' milliseconds')::interval) returning activate_at`,
      [k.kid, String(Math.max(0, Math.round(activateAfterMs)))],
    );
    await this.gateway.audit({ company_id: null, actor: by, action: 'gateway.key_published', outcome: k.kid, detail: { activate_after_ms: activateAfterMs } });
    return { next: k.kid, activate_at: r.rows[0]!.activate_at.toISOString() };
  }

  /** Activate any published key whose time has come (runs on the worker tick and at start). */
  async keysTick(): Promise<string | null> {
    const due = (await this.db.query<{ kid: string }>(`select kid from neos.gateway_keys where state = 'next' and activate_at <= now() order by activate_at limit 1`)).rows[0];
    if (!due) return null;
    const ring = this.gateway.keys;
    const k = ring.keys.find((x) => x.kid === due.kid);
    if (!k) {
      this.log('scheduled gateway key is not in this keyring; cannot activate it here', { kid: due.kid });
      return null;
    }
    if (k.state === 'next') await ring.activate();
    await tx(this.db, async (c) => {
      await c.query(`update neos.gateway_keys set state = 'retired', retired_at = now() where state = 'previous'`);
      await c.query(`update neos.gateway_keys set state = 'previous' where state = 'active' and kid <> $1`, [due.kid]);
      await c.query(`update neos.gateway_keys set state = 'active', activated_at = now() where kid = $1`, [due.kid]);
      await c.query(`insert into neos.audit (actor, action, outcome) values ('platform', 'gateway.key_activated', $1)`, [due.kid]);
    });
    return due.kid;
  }

  /** Stop publishing the previous key once every token it signed has expired (2× token TTL after activation). */
  async retirePreviousGatewayKey(by: string, force = false): Promise<{ retired: string[] }> {
    const act = (await this.db.query<{ age_s: number }>(`select extract(epoch from now() - activated_at)::float as age_s from neos.gateway_keys where state = 'active'`)).rows[0];
    const minS = 2 * 60; // 2 × GATEWAY_TOKEN_TTL_S
    if (!force && act && act.age_s < minS) throw new PlatformError(409, 'too_soon', `the active key signed its first token ${Math.round(act.age_s)} s ago; tokens from the previous key may still be live (wait ${minS} s)`);
    const prev = this.gateway.keys.keys.filter((k) => k.state === 'previous').map((k) => k.kid);
    await this.gateway.keys.retirePrevious();
    await this.db.query(`update neos.gateway_keys set state = 'retired', retired_at = now() where state = 'previous'`);
    await this.gateway.audit({ company_id: null, actor: by, action: 'gateway.key_retired', outcome: prev.join(',') || 'none', detail: { force } });
    return { retired: prev };
  }

  async gatewayKeys() {
    const rows = (await this.db.query('select kid, state, published_at, activate_at, activated_at, retired_at from neos.gateway_keys order by published_at')).rows;
    return { keys: this.gateway.keys.keys.map((k) => ({ kid: k.kid, state: k.state, created_at: k.created_at, schedule: rows.find((r) => r.kid === k.kid) ?? null })) };
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  start(): void {
    const t = { approvalsMs: 1_000, outboxMs: 1_000, tasksMs: 5_000, ...(this.opts.timings ?? {}) };
    const loop = (fn: () => Promise<unknown>, ms: number) => {
      let busy = false;
      this.timers.push(
        setInterval(() => {
          if (busy) return;
          busy = true;
          void fn()
            .catch(() => {})
            .finally(() => (busy = false));
        }, ms),
      );
    };
    loop(() => this.approvalsTick(), t.approvalsMs);
    loop(() => this.outboxTick(), t.outboxMs);
    loop(() => this.tasksTick(), t.tasksMs);
    loop(() => this.a2aResultsTick(), t.approvalsMs);
    loop(() => this.notificationsTick(), t.approvalsMs);
    loop(() => this.keysTick(), t.keysMs ?? 1_000);
    loop(() => this.ackOutboxes(), 60_000);
    loop(() => this.retention(), 3_600_000);
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.db.end().catch(() => {});
  }
}

export function isEd25519Jwk(k: unknown): boolean {
  const j = k as { kty?: unknown; crv?: unknown; x?: unknown; d?: unknown } | null;
  return !!j && typeof j === 'object' && j.kty === 'OKP' && j.crv === 'Ed25519' && typeof j.x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(j.x) && j.d === undefined;
}

/** The first instant of the current month in a time zone, as SQL over a tz expression. */
export const MONTH_START_SQL = (tz: string) => `(date_trunc('month', now() at time zone ${tz}) at time zone ${tz})`;

/** Where a card ends once its execution reports: DONE → EXECUTED; FAILED and UNKNOWN say so. */
export function approvalStatusFor(outcome: unknown): 'EXECUTED' | 'FAILED' | 'UNKNOWN' {
  return outcome === 'FAILED' ? 'FAILED' : outcome === 'UNKNOWN' ? 'UNKNOWN' : 'EXECUTED';
}

export function hashSecret(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
