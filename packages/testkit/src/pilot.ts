// Boots NEOS in-process against a fresh database: the platform (gateway, desk,
// bridge, LLM proxy) and any number of apps cut from the template, each with
// its own backend (L3 + gate + runner) and agent worker. The assistant is pi's
// faux provider driven by a scripted brain, or the real Anthropic client
// against a fake upstream through the LLM proxy.

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider, type Context } from '@mariozechner/pi-ai';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { closeServer, createTestDatabase, roleUrl } from '@neop/pgkit';
import { generateSigningKeys, migratePlatform, startPlatform, type ChatBridge } from '@neop/platform';
import { doorSecretPaths, FileSecretStore, generateLlmSigningKey, migrateApp, startBackend, toolName, type AppDefinition, type NeopBackend, type Presence } from '@neop/template';
import { proxyModel, startAgentWorker } from '@neop/template/agent';

export interface BrainView {
  /** The system prompt (starter prompt, tools, skills). */
  system: string;
  /** The job message (first user message). */
  job: string;
  /** Text of every tool result so far, in order. */
  results: { tool: string; text: string; isError: boolean }[];
  /** Tool names offered to the model. */
  tools: string[];
  calls: number;
}

export type Brain = (v: BrainView) => { tool: string; args: unknown } | { text: string } | { error: string } | { hang: true };

export const call = (key: string, args: unknown = {}) => ({ tool: toolName(key), args });
export const finish = (summary: string, outcome = 'done', extra: Record<string, unknown> = {}) => call('job.finish', { outcome, summary, ...extra });

function view(ctx: Context): BrainView {
  const msgs = ctx.messages as any[];
  const first = msgs.find((m) => m.role === 'user');
  const job = typeof first?.content === 'string' ? first.content : (first?.content ?? []).map((c: any) => c.text ?? '').join('');
  const results = msgs
    .filter((m) => m.role === 'toolResult')
    .map((m) => ({ tool: m.toolName, text: (m.content ?? []).map((c: any) => c.text ?? '').join(''), isError: !!m.isError }));
  return { system: ctx.systemPrompt ?? '', job, results, tools: (ctx.tools ?? []).map((t) => t.name), calls: results.length };
}

/** A fake Matrix homeserver: records what the appservice sends, like Synapse would accept it. */
export interface FakeHomeserver {
  url: string;
  sent: { room: string; user: string; body: string; txn: string; event_id: string; msgtype: string }[];
  /** Appservice users registered, and rooms each has joined. */
  users: Set<string>;
  joined: { room: string; user: string }[];
  /** Push one event to the appservice as the homeserver would. */
  push(ev: { room_id: string; sender: string; body: string; in_reply_to?: string }): Promise<{ status: number; event_id: string }>;
  /** v3 §8: typed (custom) events the appservice posted, e.g. neos.neop.propose. */
  typed: { room: string; user: string; type: string; content: any; txn: string; event_id: string }[];
  /** Push one typed event (any type, any content) as the homeserver would; pass `event_id` to redeliver one. */
  pushTyped(ev: { room_id: string; sender: string; type: string; content: any; event_id?: string }): Promise<{ status: number; event_id: string }>;
  /** Room state the appservice reads when it binds a room. Default: invite-only, no encryption, approve at 50. */
  setState(room: string, type: string, content: any | null): void;
  /** Rooms created through createRoom, with the request body. */
  created: { room_id: string; user: string; body: any }[];
  close(): Promise<void>;
}

/** A NEOP room as v3 §8 wants it: invite-only, not encrypted, only people (level 50) post neos.neop.approve. */
export function goodRoomState(): Map<string, any> {
  return new Map<string, any>([
    ['m.room.join_rules', { join_rule: 'invite' }],
    ['m.room.power_levels', { users: {}, users_default: 0, events_default: 0, state_default: 50, events: { 'neos.neop.approve': 50 } }],
  ]);
}

export const MATRIX = { serverName: 'acme.example', hsToken: 'hs_token_' + 'x'.repeat(24), asToken: 'as_token_' + 'y'.repeat(24) };

/** A fake homeserver that pushes to `target()` — the platform's appservice, or (v3 S4) a NEOP backend's own. */
export async function fakeHomeserver(platformUrl: () => string): Promise<FakeHomeserver> {
  const sent: FakeHomeserver['sent'] = [];
  const users = new Set<string>();
  const joined: FakeHomeserver['joined'] = [];
  const byTxn = new Map<string, string>();
  const typed: FakeHomeserver['typed'] = [];
  const created: FakeHomeserver['created'] = [];
  const state = new Map<string, Map<string, any>>();
  const stateOf = (room: string) => {
    if (!state.has(room)) state.set(room, goodRoomState());
    return state.get(room)!;
  };
  let n = 0;
  const app = new Hono();
  const asOk = (c: any) => c.req.header('authorization') === `Bearer ${MATRIX.asToken}`;
  app.post('/_matrix/client/v3/register', async (c) => {
    if (!asOk(c)) return c.json({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    const b = await c.req.json();
    const id = `@${b.username}:${MATRIX.serverName}`;
    if (b.type !== 'm.login.application_service' || !String(b.username).startsWith('neop_')) return c.json({ errcode: 'M_EXCLUSIVE' }, 400);
    if (users.has(id)) return c.json({ errcode: 'M_USER_IN_USE' }, 400);
    users.add(id);
    return c.json({ user_id: id });
  });
  app.post('/_matrix/client/v3/join/:room', (c) => {
    if (!asOk(c)) return c.json({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    const user = c.req.query('user_id') ?? '';
    if (!users.has(user)) return c.json({ errcode: 'M_FORBIDDEN' }, 403);
    joined.push({ room: c.req.param('room'), user });
    return c.json({ room_id: c.req.param('room') });
  });
  app.put('/_matrix/client/v3/rooms/:room/send/m.room.message/:txn', async (c) => {
    if (c.req.header('authorization') !== `Bearer ${MATRIX.asToken}`) return c.json({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    const txn = c.req.param('txn');
    const user = c.req.query('user_id') ?? '';
    const key = `${user}:${txn}`;
    if (byTxn.has(key)) return c.json({ event_id: byTxn.get(key) });
    const body = await c.req.json();
    const event_id = `$out${++n}:${MATRIX.serverName}`;
    byTxn.set(key, event_id);
    sent.push({ room: c.req.param('room'), user, body: body.body, txn, event_id, msgtype: body.msgtype });
    return c.json({ event_id });
  });
  app.put('/_matrix/client/v3/rooms/:room/send/:type/:txn', async (c) => {
    if (!asOk(c)) return c.json({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    const txn = c.req.param('txn');
    const user = c.req.query('user_id') ?? '';
    const key = `${user}:${txn}`;
    if (byTxn.has(key)) return c.json({ event_id: byTxn.get(key) });
    const content = await c.req.json();
    const event_id = `$out${++n}:${MATRIX.serverName}`;
    byTxn.set(key, event_id);
    typed.push({ room: c.req.param('room'), user, type: c.req.param('type'), content, txn, event_id });
    return c.json({ event_id });
  });
  app.get('/_matrix/client/v3/rooms/:room/state', (c) => {
    if (!asOk(c)) return c.json({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    return c.json([...stateOf(c.req.param('room')).entries()].map(([type, content]) => ({ type, state_key: '', content })));
  });
  app.post('/_matrix/client/v3/createRoom', async (c) => {
    if (!asOk(c)) return c.json({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    const user = c.req.query('user_id') ?? '';
    if (!users.has(user)) return c.json({ errcode: 'M_FORBIDDEN' }, 403);
    const body = await c.req.json();
    const room_id = `!made${++n}:${MATRIX.serverName}`;
    const st = new Map<string, any>();
    st.set('m.room.join_rules', { join_rule: body.preset === 'public_chat' ? 'public' : 'invite' });
    for (const e of body.initial_state ?? []) st.set(e.type, e.content);
    st.set('m.room.power_levels', { users: { [user]: 100 }, users_default: 0, events_default: 0, state_default: 50, events: {}, ...(body.power_level_content_override ?? {}) });
    state.set(room_id, st);
    created.push({ room_id, user, body });
    joined.push({ room: room_id, user });
    return c.json({ room_id });
  });
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve({ server, port: info.port }));
  });
  let txn = 0;
  let evn = 0;
  return {
    url: `http://127.0.0.1:${port}`,
    sent,
    users,
    joined,
    typed,
    created,
    setState(room, type, content) {
      if (content === null) stateOf(room).delete(type);
      else stateOf(room).set(type, content);
    },
    async pushTyped(ev) {
      const event_id = ev.event_id ?? `$in${++evn}:${MATRIX.serverName}`;
      const res = await fetch(`${platformUrl()}/_matrix/app/v1/transactions/${++txn}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${MATRIX.hsToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ events: [{ type: ev.type, event_id, room_id: ev.room_id, sender: ev.sender, content: ev.content }] }),
      });
      return { status: res.status, event_id };
    },
    async push(ev) {
      const event_id = `$in${++evn}:${MATRIX.serverName}`;
      const content: any = { msgtype: 'm.text', body: ev.body };
      if (ev.in_reply_to) content['m.relates_to'] = { 'm.in_reply_to': { event_id: ev.in_reply_to } };
      const res = await fetch(`${platformUrl()}/_matrix/app/v1/transactions/${++txn}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${MATRIX.hsToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ events: [{ type: 'm.room.message', event_id, room_id: ev.room_id, sender: ev.sender, content }] }),
      });
      return { status: res.status, event_id };
    },
    close: () => closeServer(server as any),
  };
}


export interface AppUnderTest {
  def: AppDefinition;
  /** Seed the company's data with the app role (RLS scoped). */
  seed?: (pool: NeopBackend['core']['appPool'], companyId: string) => Promise<unknown>;
}

export interface Pilot {
  hs: FakeHomeserver | null;
  bridge: ChatBridge | null;
  /** v3 S4: the first app's own presence (null unless booted with `presence`). */
  presence: Presence | null;
  /** v3 S4, presence 'appservice': the first app's Matrix name at the pilot's company. */
  neopUser: string | null;
  platformUrl: string;
  platform: Awaited<ReturnType<typeof startPlatform>>['platform'];
  /** The first app's backend (most tests drive one app). */
  backend: NeopBackend;
  backends: Record<string, NeopBackend>;
  company: { id: string };
  admin: { id: string; token: string };
  member: { id: string; token: string };
  /** A platform operator (registry reviews, key rotation). */
  operator: { id: string; token: string };
  /** A second operator: registry reviews are four-eyes (the submitter cannot co-sign). */
  operator2: { id: string; token: string };
  mailDir: string;
  /** The door secret store (v3 §12): `<doorsDir>/<company>/[<app>/]<door>.json`, 0600, read by each backend per call. */
  doorsDir: string;
  /** Provision a door credential in the secret store (as ops would). Default: company-wide at this pilot's company. */
  setDoorSecret(door: string, secret: Record<string, unknown>, o?: { company?: string; app?: string }): Promise<string>;
  /** Remove a door credential (the door then fails definitely: "not connected"). */
  removeDoorSecret(door: string, o?: { company?: string; app?: string }): Promise<void>;
  worker: Awaited<ReturnType<typeof startAgentWorker>>;
  workers: Record<string, Awaited<ReturnType<typeof startAgentWorker>>>;
  setBrain(b: Brain): void;
  api<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }>;
  ask(text: string, token?: string, app?: string): Promise<{ task_id: string; job_id: string }>;
  waitFor<T>(fn: () => Promise<T | null | undefined | false>, what: string, ms?: number): Promise<T>;
  task(id: string): Promise<any>;
  desk(): Promise<any[]>;
  jobRow(jobId: string, app?: string): Promise<any>;
  /** Stop an app backend (runner, L3, gate) and start a fresh one: a forced restart. */
  restartBackend(app?: string): Promise<NeopBackend>;
  adminUrl: string;
  close(): Promise<void>;
}

export const FAST = { pollMs: 150, expiryMs: 200, reconcileMs: 300, claimMs: 3_000, heartbeatMs: 500, sessionMaxMs: 20_000, proposalTtlMs: 60 * 60_000, maxAttempts: 5, retryBackoffMs: [100, 200, 300] };

export interface BootOptions {
  apps: AppUnderTest[];
  timings?: Partial<typeof FAST>;
  seed?: boolean;
  platformWorkers?: boolean;
  chat?: boolean;
  /** Route assistants through the platform LLM proxy to this upstream (real Anthropic wire format). */
  llmUpstream?: { url: string; apiKey: string; auth?: 'x-api-key' | 'bearer'; modelPrefix?: string };
  /** Extra backend settings per app (e.g. the neos-v1 bridge, which needs the company id). */
  backendConfig?: (app: string, company: { id: string }) => Partial<Parameters<typeof startBackend>[1]>;
  poolSize?: number;
  /** Platform DB pool; small by default because many pilots share one Postgres in the test run. */
  platformDbPool?: number;
  /**
   * v3 S4 · the first app speaks in Matrix itself (NEOP_PRESENCE): 'appservice' — a fake homeserver pushes to the
   * backend's own /_matrix/app/v1 (the platform runs no bridge) and the app's name at the company is set;
   * 'client' — the backend's presence runs with no account yet (tests add one with a fake client homeserver).
   */
  presence?: 'appservice' | 'client';
}

export async function bootPilot(opts: BootOptions): Promise<Pilot> {
  // Tests scrape metrics without a token; production must set NEOS_METRICS_TOKEN / NEOP_METRICS_TOKEN.
  process.env.NEOS_METRICS_PUBLIC ??= '1';
  process.env.NEOP_METRICS_PUBLIC ??= '1';
  const db = await createTestDatabase();
  await migratePlatform(db.adminUrl);
  for (const a of opts.apps) await migrateApp(db.adminUrl, a.def);

  const keys = await generateSigningKeys();
  // v3: each runner mints its assistants' LLM session tokens with its own key; the proxy holds the public halves.
  const llmKeys: Record<string, Awaited<ReturnType<typeof generateLlmSigningKey>>> = {};
  if (opts.llmUpstream) for (const a of opts.apps) llmKeys[a.def.manifest.app] = await generateLlmSigningKey(`llm-${a.def.manifest.app}`);
  let platUrl = '';
  let presenceUrl = '';
  const hs = opts.presence === 'appservice' ? await fakeHomeserver(() => presenceUrl) : opts.chat ? await fakeHomeserver(() => platUrl) : null;
  const plat = await startPlatform({
    chat: hs && opts.presence !== 'appservice' ? { matrix: { homeserverUrl: hs.url, serverName: MATRIX.serverName, hsToken: MATRIX.hsToken, asToken: MATRIX.asToken } } : undefined,
    bridgeSendEveryMs: 100,
    llm: opts.llmUpstream ? { upstream: { baseUrl: opts.llmUpstream.url, apiKey: opts.llmUpstream.apiKey, auth: opts.llmUpstream.auth, modelPrefix: opts.llmUpstream.modelPrefix }, prices: { 'claude-sonnet-5': { input: 3, output: 15 } }, runnerKeys: Object.fromEntries(Object.entries(llmKeys).map(([k, v]) => [k, [v.publicJwk]])) } : undefined,
    dbUrl: roleUrl(db.adminUrl, 'neos_app'),
    dbPoolSize: opts.platformDbPool ?? 6,
    keys,
    workers: opts.platformWorkers !== false,
    timings: { approvalsMs: 150, outboxMs: 150, tasksMs: 300 },
  });
  platUrl = plat.url;
  const company = await plat.platform.createCompany('Acme Traders', 'Asia/Kolkata');
  const admin = await plat.platform.createUser(company.id, { name: 'Priya', email: 'priya@acme.example', role: 'admin' });
  const member = await plat.platform.createUser(company.id, { name: 'Rahul', email: 'rahul@acme.example', role: 'member' });
  const operator = await plat.platform.createUser(company.id, { name: 'Ops', email: 'ops@neos.example', role: 'operator' });
  const operator2 = await plat.platform.createUser(company.id, { name: 'Reviewer', email: 'review@neos.example', role: 'operator' });
  const mailDir = await mkdtemp(path.join(os.tmpdir(), 'neop-mail-'));
  // v3 §12: door credentials live in the secret store, per (app, company), read by the backend per call.
  const doorsDir = await mkdtemp(path.join(os.tmpdir(), 'neop-doors-'));
  const doorFile = (door: string, o: { company?: string; app?: string } = {}) => {
    const p = doorSecretPaths(doorsDir, o.company ?? company.id, o.app ?? 'x', door);
    return o.app ? p.own : p.company;
  };
  const setDoorSecret = async (door: string, secret: Record<string, unknown>, o: { company?: string; app?: string } = {}) => {
    const f = doorFile(door, o);
    await mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
    // Write-then-rename, as ops rotates: a reader sees the old file or the new one, never half of one.
    const tmp = `${f}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(secret), { mode: 0o600 });
    await chmod(tmp, 0o600);
    const { rename } = await import('node:fs/promises');
    await rename(tmp, f);
    return f;
  };
  const removeDoorSecret = async (door: string, o: { company?: string; app?: string } = {}) => rm(doorFile(door, o), { force: true });
  await setDoorSecret('email', { provider: 'dev-mailbox', dir: mailDir });
  for (const door of ['social', 'ads', 'gst_portal']) {
    await setDoorSecret(door, { provider: 'dev-file', dir: path.join(mailDir, `_${door}`) });
  }

  const faux = registerFauxProvider({ provider: `faux-${randomBytes(3).toString('hex')}`, tokensPerSecond: 1_000_000 });
  let brain: Brain = () => ({ text: 'no brain set' });
  const factory = (ctx: Context) => {
    const out = brain(view(ctx));
    if ('hang' in out) return new Promise<never>(() => {});
    if ('tool' in out) return fauxAssistantMessage(fauxToolCall(out.tool, out.args as any), { stopReason: 'toolUse' });
    if ('error' in out) return fauxAssistantMessage([fauxText('')], { stopReason: 'error', errorMessage: out.error });
    return fauxAssistantMessage(out.text);
  };
  faux.setResponses(Array.from({ length: 20_000 }, () => factory));

  const backends: Record<string, NeopBackend> = {};
  const workers: Pilot['workers'] = {};
  const configs: Record<string, Parameters<typeof startBackend>[1]> = {};
  for (const a of opts.apps) {
    const key = a.def.manifest.app;
    workers[key] = await startAgentWorker({
      poolSize: opts.poolSize ?? 5,
      // With an upstream, the agent is keyless: each session gets a proxy token from the runner.
      model: opts.llmUpstream ? proxyModel({ NEOP_LLM_MODEL: 'claude-sonnet-5' }) : { model: faux.getModel() },
    });
    const secret = randomBytes(24).toString('hex');
    configs[key] = {
      appDbUrl: roleUrl(db.adminUrl, `${key}_app`),
      runnerDbUrl: roleUrl(db.adminUrl, `${key}_runner`),
      platformUrl: plat.url,
      serviceSecret: secret,
      jobTokenSecret: randomBytes(32).toString('hex'),
      agentUrl: `http://127.0.0.1:${workers[key].port}`,
      poolSize: opts.poolSize ?? 5,
      runnerId: `runner-${key}`,
      packageCacheDir: await mkdtemp(path.join(os.tmpdir(), `neop-pkg-${key}-`)),
      jwksCacheMs: 1_000,
      secrets: new FileSecretStore({ root: doorsDir, app: key }),
      llm: llmKeys[key] ? { proxyUrl: `${plat.url}/llm`, signingKey: llmKeys[key].privateJwk } : undefined,
      timings: { ...FAST, ...(opts.timings ?? {}) },
      ...(opts.presence && a === opts.apps[0]
        ? {
            presence:
              opts.presence === 'appservice'
                ? { mode: 'appservice' as const, homeserverUrl: hs!.url, appservice: { hsToken: MATRIX.hsToken, asToken: MATRIX.asToken, port: 0, host: '127.0.0.1' }, mirrorEveryMs: 100 }
                : { mode: 'client' as const, homeserverUrl: 'http://hs.test', client: { accounts: [], syncTimeoutMs: 100, replyEveryMs: 50 }, mirrorEveryMs: 100 },
          }
        : {}),
      ...(opts.backendConfig?.(key, company) ?? {}),
    };
    backends[key] = await startBackend(a.def, configs[key]!, {});
    await plat.platform.registerApp({ key, l3_url: `http://127.0.0.1:${backends[key].ports.l3}`, manifest: a.def.manifest, service_secret: secret, blocks: a.def.blocks });
    await plat.platform.installApp(company.id, key, admin.id);
    if (opts.seed !== false && a.seed) await a.seed(backends[key].core.appPool, company.id);
  }
  const first = opts.apps[0]!.def.manifest.app;
  // v3 S4: the app's own name at the company, written into its schema (as an admin would, PUT /api/chat/presence).
  let neopUser: string | null = null;
  if (opts.presence === 'appservice') {
    presenceUrl = `http://127.0.0.1:${backends[first]!.ports.appservice}`;
    const slug = (await plat.platform.db.query<{ slug: string }>('select slug from neos.companies where id = $1', [company.id])).rows[0]!.slug;
    neopUser = `@neop_${first}_${slug}:${MATRIX.serverName}`;
    await plat.platform.setChatIdentity(company.id, first, { matrix_user: neopUser }, `user:${admin.id}`);
  }

  const api = async (method: string, p: string, body?: unknown, token = admin.token) => {
    const res = await fetch(plat.url + p, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const waitFor = async <T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 15_000): Promise<T> => {
    const until = Date.now() + ms;
    let last: unknown;
    while (Date.now() < until) {
      try {
        const v = await fn();
        if (v) return v as T;
      } catch (e) {
        last = e;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
  };

  const pilot: Pilot = {
    hs,
    bridge: plat.bridge,
    get presence() {
      return backends[first]!.presence;
    },
    neopUser,
    platformUrl: plat.url,
    platform: plat.platform,
    backend: backends[first]!,
    backends,
    company,
    admin,
    member,
    operator,
    operator2,
    mailDir,
    doorsDir,
    setDoorSecret,
    removeDoorSecret,
    worker: workers[first]!,
    workers,
    adminUrl: db.adminUrl,
    setBrain: (b) => {
      brain = b;
    },
    api: api as Pilot['api'],
    async ask(text, token, app = first) {
      const r = await api('POST', '/api/ask', { text, app }, token);
      if (r.status !== 200 || !r.body.job_id) throw new Error(`ask failed: ${JSON.stringify(r.body)}`);
      return r.body;
    },
    waitFor,
    task: async (id) => (await api('GET', `/api/tasks/${id}`)).body,
    desk: async () => (await api('GET', '/api/desk')).body.cards,
    jobRow: async (jobId, app = first) => (await backends[app]!.core.runnerPool.query(`select * from ${app}.jobs where id = $1`, [jobId])).rows[0],
    async restartBackend(app = first) {
      const def = opts.apps.find((a) => a.def.manifest.app === app)!.def;
      await backends[app]!.stop().catch(() => {});
      const b = await startBackend(def, configs[app]!, {});
      backends[app] = b;
      if (app === first) pilot.backend = b;
      if (app === first && b.ports.appservice) presenceUrl = `http://127.0.0.1:${b.ports.appservice}`;
      await plat.platform.db.query('update neos.apps set l3_url = $2 where key = $1', [app, `http://127.0.0.1:${b.ports.l3}`]);
      return b;
    },
    async close() {
      faux.unregister();
      for (const b of Object.values(backends)) await b.stop().catch(() => {});
      for (const w of Object.values(workers)) await closeServer(w.server as any);
      await plat.stop().catch(() => {});
      await hs?.close();
      await rm(doorsDir, { recursive: true, force: true }).catch(() => {});
      await db.drop();
    },
  };
  return pilot;
}

/** Last tool result text that mentions a proposal id. */
export function proposalIdFrom(v: BrainView): string | null {
  for (const r of [...v.results].reverse()) {
    const m = /Proposal ([0-9a-f-]{36})/.exec(r.text);
    if (m) return m[1]!;
  }
  return null;
}
