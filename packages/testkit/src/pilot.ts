// Boots NEOS in-process against a fresh database: the platform (gateway, desk,
// bridge, LLM proxy) and any number of apps cut from the template, each with
// its own backend (L3 + gate + runner) and agent worker. The assistant is pi's
// faux provider driven by a scripted brain, or the real Anthropic client
// against a fake upstream through the LLM proxy.

import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider, type Context } from '@mariozechner/pi-ai';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { closeServer, createTestDatabase, roleUrl } from '@neop/pgkit';
import { generateSigningKeys, migratePlatform, startPlatform, type ChatBridge } from '@neop/platform';
import { migrateApp, startBackend, toolName, type AppDefinition, type NeopBackend } from '@neop/template';
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
  /** Push one event to the appservice as the homeserver would. */
  push(ev: { room_id: string; sender: string; body: string; in_reply_to?: string }): Promise<{ status: number; event_id: string }>;
  close(): Promise<void>;
}

export const MATRIX = { serverName: 'acme.example', hsToken: 'hs_token_' + 'x'.repeat(24), asToken: 'as_token_' + 'y'.repeat(24) };

async function fakeHomeserver(platformUrl: () => string): Promise<FakeHomeserver> {
  const sent: FakeHomeserver['sent'] = [];
  const byTxn = new Map<string, string>();
  let n = 0;
  const app = new Hono();
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
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve({ server, port: info.port }));
  });
  let txn = 0;
  let evn = 0;
  return {
    url: `http://127.0.0.1:${port}`,
    sent,
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
  mailDir: string;
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

export const FAST = { pollMs: 150, expiryMs: 200, reconcileMs: 300, claimMs: 3_000, heartbeatMs: 500, sessionMaxMs: 20_000, proposalTtlMs: 60 * 60_000, maxAttempts: 5 };

export interface BootOptions {
  apps: AppUnderTest[];
  timings?: Partial<typeof FAST>;
  seed?: boolean;
  platformWorkers?: boolean;
  chat?: boolean;
  /** Route assistants through the platform LLM proxy to this upstream (real Anthropic wire format). */
  llmUpstream?: { url: string; apiKey: string; auth?: 'x-api-key' | 'bearer'; modelPrefix?: string };
  poolSize?: number;
  /** Platform DB pool; small by default because many pilots share one Postgres in the test run. */
  platformDbPool?: number;
}

export async function bootPilot(opts: BootOptions): Promise<Pilot> {
  // Tests scrape metrics without a token; production must set NEOS_METRICS_TOKEN / NEOP_METRICS_TOKEN.
  process.env.NEOS_METRICS_PUBLIC ??= '1';
  process.env.NEOP_METRICS_PUBLIC ??= '1';
  const db = await createTestDatabase();
  await migratePlatform(db.adminUrl);
  for (const a of opts.apps) await migrateApp(db.adminUrl, a.def);

  const keys = await generateSigningKeys();
  let platUrl = '';
  const hs = opts.chat ? await fakeHomeserver(() => platUrl) : null;
  const plat = await startPlatform({
    chat: hs ? { matrix: { homeserverUrl: hs.url, serverName: MATRIX.serverName, hsToken: MATRIX.hsToken, asToken: MATRIX.asToken } } : undefined,
    bridgeSendEveryMs: 100,
    llm: opts.llmUpstream ? { upstream: { baseUrl: opts.llmUpstream.url, apiKey: opts.llmUpstream.apiKey, auth: opts.llmUpstream.auth, modelPrefix: opts.llmUpstream.modelPrefix }, prices: { 'claude-sonnet-5': { input: 3, output: 15 } } } : undefined,
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
  const mailDir = await mkdtemp(path.join(os.tmpdir(), 'neop-mail-'));
  await plat.platform.setVaultSecret(company.id, 'email', { provider: 'dev-mailbox', dir: mailDir });
  for (const door of ['social', 'ads', 'gst_portal']) {
    await plat.platform.setVaultSecret(company.id, door, { provider: 'dev-file', dir: path.join(mailDir, `_${door}`) });
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
      timings: { ...FAST, ...(opts.timings ?? {}) },
    };
    backends[key] = await startBackend(a.def, configs[key]!, {});
    await plat.platform.registerApp({ key, l3_url: `http://127.0.0.1:${backends[key].ports.l3}`, manifest: a.def.manifest, service_secret: secret });
    await plat.platform.installApp(company.id, key, admin.id);
    if (opts.seed !== false && a.seed) await a.seed(backends[key].core.appPool, company.id);
  }
  const first = opts.apps[0]!.def.manifest.app;

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
    platformUrl: plat.url,
    platform: plat.platform,
    backend: backends[first]!,
    backends,
    company,
    admin,
    member,
    operator,
    mailDir,
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
      await plat.platform.db.query('update neos.apps set l3_url = $2 where key = $1', [app, `http://127.0.0.1:${b.ports.l3}`]);
      return b;
    },
    async close() {
      faux.unregister();
      for (const b of Object.values(backends)) await b.stop().catch(() => {});
      for (const w of Object.values(workers)) await closeServer(w.server as any);
      await plat.stop().catch(() => {});
      await hs?.close();
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
