import {sqlIdent} from '@neop/pgkit';
// Boots NEOS in-process against a fresh database, the v3 way (S9): the platform (people, Conversations, NeuralChat
// speaking Matrix as its own identity, the desk on the database, the registry, the LLM proxy) and any number of apps
// cut from the template, each with its own backend (gate + runner + its own Matrix presence + files listener) and agent
// worker, all talking through a fake homeserver. Nothing calls an app except Matrix; the desk reads and writes on the
// database. The assistant is pi's faux provider driven by a scripted brain, or the real Anthropic client against a
// fake upstream through the LLM proxy.

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider, type Context } from '@mariozechner/pi-ai';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { closeServer, createTestDatabase, roleUrl } from '@neop/pgkit';
import { generateSigningKeys, migratePlatform, startPlatform } from '@neop/platform';
import { doorSecretPaths, FileSecretStore, generateLlmSigningKey, migrateApp, startBackend, toolName, type AppDefinition, type NeopBackend, type Presence } from '@neop/template';
import { proxyModel, startAgentWorker } from '@neop/template/agent';
import { fakeMatrix, type FakeMatrix } from './fake-matrix.ts';

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
  pushTyped(ev: { room_id: string; sender: string; type: string; content: any; event_id?: string; to?: string }): Promise<{ status: number; event_id: string }>;
  /** Room state the appservice reads when it binds a room. Default: invite-only, no encryption, approve at 50. */
  setState(room: string, type: string, content: any | null): void;
  /** Rooms created through createRoom, with the request body. */
  created: { room_id: string; user: string; body: any }[];
  /**
   * v3 S5 · route every event an appservice user sends (m.room.message or typed) to these appservices, as a homeserver
   * pushes a room's events to every registration with a member there: in order, retried until each target takes it
   * (Matrix redelivers to an appservice that was down). Receivers ignore their own echo.
   */
  relayAll(targets: () => string[]): void;
  /** Every push attempt the relay made: event id, target, HTTP status (0: unreachable). */
  deliveries: { event_id: string; target: string; status: number }[];
  /** Push an event the relay already delivered again, to every target (Matrix may redeliver). */
  redeliver(eventId: string): Promise<void>;
  /**
   * v3 S6 · several apps' own appservices on one homeserver: events an app sends into a room are delivered (as the
   * homeserver would, in order, after the send returns) to every OTHER appservice with a name joined to that room.
   * `prefix` is the namespace (e.g. '@neop_ledger_'); `url` is that backend's /_matrix/app/v1 base.
   */
  route(prefix: string, url: () => string): void;
  /** What was delivered between appservices (by route prefix), in order. */
  delivered: { to: string; room: string; sender: string; type: string; content: any; event_id: string; status: number }[];
  /** Invites sent (POST /rooms/{room}/invite). */
  invites: { room: string; by: string; user: string }[];
  /** v3 S9: the media repository — mxc:// URI → bytes, content type, the name that uploaded it. */
  media: Map<string, { bytes: Buffer; type: string; by: string }>;
  /** Wait until every queued delivery between appservices has been made. */
  settle(): Promise<void>;
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
  const routes: { prefix: string; url: () => string }[] = [];
  const delivered: FakeHomeserver['delivered'] = [];
  const invites: FakeHomeserver['invites'] = [];
  const aliases = new Map<string, string>();
  const media: FakeHomeserver['media'] = new Map();
  let queue: Promise<void> = Promise.resolve();
  let htxn = 0;
  /** Deliver one event to every other appservice with a member in the room (in order, after the send returned). */
  const fanOut = (ev: { room: string; sender: string; type: string; content: any; event_id: string }) => {
    if (relayTargets) return; // v3 S5: the relay (relayAll) delivers everything, with retries
    const targets = routes.filter((r) => !ev.sender.startsWith(r.prefix) && joined.some((j) => j.room === ev.room && j.user.startsWith(r.prefix)));
    if (!targets.length) return;
    queue = queue.then(async () => {
      await new Promise((r) => setImmediate(r));
      for (const t of targets) {
        const res = await fetch(`${t.url()}/_matrix/app/v1/transactions/hs${++htxn}`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${MATRIX.hsToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ events: [{ type: ev.type, event_id: ev.event_id, room_id: ev.room, sender: ev.sender, content: ev.content }] }),
        }).catch(() => null);
        delivered.push({ to: t.prefix, room: ev.room, sender: ev.sender, type: ev.type, content: ev.content, event_id: ev.event_id, status: res?.status ?? 0 });
      }
    });
  };
  const stateOf = (room: string) => {
    if (!state.has(room)) state.set(room, goodRoomState());
    return state.get(room)!;
  };
  let n = 0;
  // v3 S5: the router — every appservice-sent event, pushed in order to every target, retried until taken.
  let relayTargets: (() => string[]) | null = null;
  let closed = false;
  let routeTxn = 0;
  const deliveries: FakeHomeserver['deliveries'] = [];
  const routed = new Map<string, any>();
  // One queue per target (a homeserver keeps one per registration): a receiver that is down holds only its own events.
  const chains: Promise<void>[] = [];
  const pushTo = async (url: string, ev: any): Promise<number> => {
    try {
      const res = await fetch(`${url}/_matrix/app/v1/transactions/r${++routeTxn}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${MATRIX.hsToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ events: [ev] }),
        signal: AbortSignal.timeout(20_000),
      });
      await res.text().catch(() => '');
      return res.status;
    } catch {
      return 0;
    }
  };
  const deliver = (ev: any): Promise<void> => {
    const count = relayTargets?.().length ?? 0;
    const all: Promise<void>[] = [];
    for (let k = 0; k < count; k++) {
      chains[k] = (chains[k] ?? Promise.resolve()).then(async () => {
        for (let i = 0; !closed && i < 600; i++) {
          // Read the target afresh on every attempt: a restarted receiver may listen on a new port.
          const target = relayTargets?.()[k];
          if (!target) return;
          const status = await pushTo(target, ev);
          deliveries.push({ event_id: ev.event_id, target, status });
          if (status === 200) return;
          await new Promise((r) => setTimeout(r, 100));
        }
      });
      all.push(chains[k]!);
    }
    return Promise.all(all).then(() => undefined);
  };
  const routeOut = (e: { type: string; event_id: string; room_id: string; sender: string; content: any }) => {
    if (!relayTargets) return;
    const ev = { ...e, origin_server_ts: Date.now() };
    routed.set(e.event_id, ev);
    setTimeout(() => void deliver(ev), 0);
  };
  const app = new Hono();
  const asOk = (c: any) => c.req.header('authorization') === `Bearer ${MATRIX.asToken}`;
  app.post('/_matrix/client/v3/register', async (c) => {
    if (!asOk(c)) return c.json({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    const b = await c.req.json();
    const id = `@${b.username}:${MATRIX.serverName}`;
    if (b.type !== 'm.login.application_service' || !/^(neop|neuralchat)_/.test(String(b.username))) return c.json({ errcode: 'M_EXCLUSIVE' }, 400);
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
    routeOut({ type: 'm.room.message', event_id, room_id: c.req.param('room'), sender: user, content: body });
    fanOut({ room: c.req.param('room'), sender: user, type: 'm.room.message', content: body, event_id });
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
    routeOut({ type: c.req.param('type'), event_id, room_id: c.req.param('room'), sender: user, content });
    fanOut({ room: c.req.param('room'), sender: user, type: c.req.param('type'), content, event_id });
    return c.json({ event_id });
  });
  app.get('/_matrix/client/v3/rooms/:room/state', (c) => {
    if (!asOk(c)) return c.json({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    return c.json([...stateOf(c.req.param('room')).entries()].map(([type, content]) => ({ type, state_key: '', content })));
  });
  app.put('/_matrix/client/v3/rooms/:room/state/m.room.power_levels/', async (c) => {
    if (!asOk(c)) return c.json({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    const user = c.req.query('user_id') ?? '';
    if (!joined.some((j) => j.room === c.req.param('room') && j.user === user)) return c.json({ errcode: 'M_FORBIDDEN' }, 403);
    stateOf(c.req.param('room')).set('m.room.power_levels', await c.req.json());
    return c.json({ event_id: `$state${++n}:${MATRIX.serverName}` });
  });
  app.post('/_matrix/client/v3/createRoom', async (c) => {
    if (!asOk(c)) return c.json({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    const user = c.req.query('user_id') ?? '';
    if (!users.has(user)) return c.json({ errcode: 'M_FORBIDDEN' }, 403);
    const body = await c.req.json();
    const alias = body.room_alias_name ? `#${body.room_alias_name}:${MATRIX.serverName}` : null;
    if (alias && aliases.has(alias)) return c.json({ errcode: 'M_ROOM_IN_USE', error: 'alias in use' }, 400);
    const room_id = `!made${++n}:${MATRIX.serverName}`;
    if (alias) aliases.set(alias, room_id);
    const st = new Map<string, any>();
    st.set('m.room.join_rules', { join_rule: body.preset === 'public_chat' ? 'public' : 'invite' });
    for (const e of body.initial_state ?? []) st.set(e.type, e.content);
    st.set('m.room.power_levels', { users: { [user]: 100 }, users_default: 0, events_default: 0, state_default: 50, events: {}, ...(body.power_level_content_override ?? {}) });
    state.set(room_id, st);
    created.push({ room_id, user, body });
    for (const u of body.invite ?? []) invites.push({ room: room_id, by: user, user: u });
    joined.push({ room: room_id, user });
    return c.json({ room_id });
  });
  // v3 S9 · the media repository (a task's files travel as mxc:// references, never as bytes in an event or a platform link).
  app.post('/_matrix/media/v3/upload', async (c) => {
    if (!asOk(c)) return c.json({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    const user = c.req.query('user_id') ?? '';
    if (!users.has(user)) return c.json({ errcode: 'M_FORBIDDEN' }, 403);
    const id = `media${++n}`;
    media.set(`mxc://${MATRIX.serverName}/${id}`, { bytes: Buffer.from(await c.req.arrayBuffer()), type: c.req.header('content-type') ?? 'application/octet-stream', by: user });
    return c.json({ content_uri: `mxc://${MATRIX.serverName}/${id}` });
  });
  app.get('/_matrix/client/v1/media/download/:server/:id', (c) => {
    if (!asOk(c)) return c.json({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    const f = media.get(`mxc://${c.req.param('server')}/${c.req.param('id')}`);
    if (!f) return c.json({ errcode: 'M_NOT_FOUND' }, 404);
    return new Response(new Uint8Array(f.bytes), { headers: { 'content-type': f.type } });
  });
  app.get('/_matrix/client/v3/directory/room/:alias', (c) => {
    if (!asOk(c)) return c.json({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    const room_id = aliases.get(c.req.param('alias'));
    return room_id ? c.json({ room_id, servers: [MATRIX.serverName] }) : c.json({ errcode: 'M_NOT_FOUND' }, 404);
  });
  app.post('/_matrix/client/v3/rooms/:room/invite', async (c) => {
    if (!asOk(c)) return c.json({ errcode: 'M_UNKNOWN_TOKEN' }, 401);
    const by = c.req.query('user_id') ?? '';
    const b = await c.req.json();
    if (!joined.some((j) => j.room === c.req.param('room') && j.user === by)) return c.json({ errcode: 'M_FORBIDDEN' }, 403);
    if (invites.some((i) => i.room === c.req.param('room') && i.user === b.user_id)) return c.json({ errcode: 'M_FORBIDDEN', error: 'already invited' }, 403);
    invites.push({ room: c.req.param('room'), by, user: b.user_id });
    return c.json({});
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
    deliveries,
    relayAll(t) {
      relayTargets = t;
    },
    async redeliver(eventId) {
      const ev = routed.get(eventId);
      if (!ev) throw new Error(`no routed event ${eventId}`);
      await deliver(ev);
    },
    delivered,
    invites,
    media,
    route(prefix, url) {
      const i = routes.findIndex((r) => r.prefix === prefix);
      if (i >= 0) routes.splice(i, 1);
      routes.push({ prefix, url });
    },
    async settle() {
      let q: Promise<void>;
      do {
        q = queue;
        await q;
      } while (q !== queue);
    },
    setState(room, type, content) {
      if (content === null) stateOf(room).delete(type);
      else stateOf(room).set(type, content);
    },
    async pushTyped(ev) {
      const event_id = ev.event_id ?? `$in${++evn}:${MATRIX.serverName}`;
      const target = ev.to ? routes.find((r) => r.prefix === ev.to || r.prefix === `@neop_${ev.to}_`)?.url() : platformUrl();
      if (!target) throw new Error(`no appservice route for ${ev.to}`);
      const res = await fetch(`${target}/_matrix/app/v1/transactions/${++txn}`, {
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
    close: async () => {
      closed = true;
      await closeServer(server as any);
    },
  };
}


export interface AppUnderTest {
  def: AppDefinition;
  /** Seed the company's data with the app role (RLS scoped). */
  seed?: (pool: NeopBackend['core']['appPool'], companyId: string) => Promise<unknown>;
}

export interface Pilot {
  /** The fake homeserver on the appservice road (every app's appservice and NeuralChat's); null on the client road. */
  hs: FakeHomeserver | null;
  /** The first app's own presence (every backend runs one: v3 S9, Matrix is the only road in). */
  presence: Presence | null;
  /** The first app's Matrix name at the pilot's company (appservice: @neop_<app>_<slug>; client road: its account). */
  neopUser: string | null;
  /** NeuralChat's own Matrix name at the pilot's company (null only with `neuralchat: false`). */
  neuralchatUser: string | null;
  /** The name NeuralChat gives a person with no Matrix id of their own (its namespace; never a sender). */
  neuralchatPerson(userId: string): string;
  /** Client road: the shared fake homeserver both accounts (the NEOP's, NeuralChat's) talk through. */
  mx: FakeMatrix | null;
  /** Appservice road: each app's Matrix name at the pilot's company. */
  neopUsers: Record<string, string>;
  /** Appservice road: the room each app is bound to at the pilot's company (NeuralChat posts tasks there). */
  appRooms: Record<string, string>;
  platformUrl: string;
  platform: Awaited<ReturnType<typeof startPlatform>>['platform'];
  /** The first app's backend (most tests drive one app). */
  backend: NeopBackend;
  backends: Record<string, NeopBackend>;
  company: { id: string };
  admin: { id: string; token: string };
  member: { id: string; token: string };
  /** A platform operator (registry reviews). */
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
  /**
   * Test harness only (v3 S9: the platform has no route into an app): run one of an app's read abilities in-process, the
   * way its gate would, as a person of a company — handler, input and output checks, the company's row-level security.
   * `status` mirrors what a caller would have been told (403 switched off / not installed, 404 unknown, 400 bad input).
   */
  read(key: string, args?: unknown, o?: { app?: string; company?: string; caller?: string }): Promise<{ status: number; body: any }>;
  waitFor<T>(fn: () => Promise<T | null | undefined | false>, what: string, ms?: number): Promise<T>;
  task(id: string): Promise<any>;
  desk(): Promise<any[]>;
  jobRow(jobId: string, app?: string): Promise<any>;
  /** Stop an app backend (runner, gate, presence, files) and start a fresh one: a forced restart. */
  restartBackend(app?: string): Promise<NeopBackend>;
  /**
   * v3 S7: deploy a new build of an app — the DBA applies its migration file (migrateApp), the backend restarts on
   * the new definition, and the app re-registers its manifest (which now carries the lines of what it installed).
   */
  rebuild(app: string, def: AppDefinition): Promise<NeopBackend>;
  /** The definition each app is running now (changes with rebuild). */
  defs: Record<string, AppDefinition>;
  adminUrl: string;
  close(): Promise<void>;
}

export const FAST = { pollMs: 150, expiryMs: 200, reconcileMs: 300, claimMs: 3_000, heartbeatMs: 500, sessionMaxMs: 20_000, proposalTtlMs: 60 * 60_000, maxAttempts: 5, retryBackoffMs: [100, 200, 300] };

export interface BootOptions {
  apps: AppUnderTest[];
  timings?: Partial<typeof FAST>;
  seed?: boolean;
  platformWorkers?: boolean;
  /** Route assistants through the platform LLM proxy to this upstream (real Anthropic wire format). */
  llmUpstream?: { url: string; apiKey: string; auth?: 'x-api-key' | 'bearer'; modelPrefix?: string };
  /** Extra backend settings per app. */
  backendConfig?: (app: string, company: { id: string }) => Partial<Parameters<typeof startBackend>[1]>;
  poolSize?: number;
  /** Platform DB pool; small by default because many pilots share one Postgres in the test run. */
  platformDbPool?: number;
  /**
   * The road every NEOP speaks on (v3 S9: every backend runs its own presence; there is no platform bridge):
   * 'appservice' (default) — a fake homeserver pushes to each backend's own /_matrix/app/v1; every app has its Matrix
   * name and a bound room at the company, and the homeserver routes every event between the apps' appservices and
   * NeuralChat's (the rooms and the bus room). 'client' — the first app's presence runs the client road (NeuralChat
   * #143's DM road); with `neuralchat`, @neuralchat_<slug>:hs.test and the app's @<app>:hs.test talk through one
   * shared fake homeserver (fakeMatrix); the other apps run the client road with no account.
   */
  presence?: 'appservice' | 'client';
  /**
   * NeuralChat speaks Matrix as its own identity (v3 S5; default on — the only road from a person's ask to an app).
   * false: no NeuralChat road (P.ask then fails; for tests that drive Matrix by hand).
   */
  neuralchat?: boolean;
  /** How long the ask waits for the app's "on it" in Matrix (default 3 s). */
  neuralchatAckWaitMs?: number;
  /** @deprecated v3 S9: every app always speaks as its own name on the appservice road. Ignored. */
  presenceAll?: boolean;
}

export async function bootPilot(opts: BootOptions): Promise<Pilot> {
  // Tests scrape metrics without a token; production must set NEOS_METRICS_TOKEN / NEOP_METRICS_TOKEN.
  process.env.NEOS_METRICS_PUBLIC ??= '1';
  process.env.NEOP_METRICS_PUBLIC ??= '1';
  const road = opts.presence ?? 'appservice';
  const withNeuralchat = opts.neuralchat !== false;
  const db = await createTestDatabase();
  await migratePlatform(db.adminUrl);
  for (const a of opts.apps) await migrateApp(db.adminUrl, a.def);

  const keys = await generateSigningKeys();
  // v3: each runner mints its assistants' LLM session tokens with its own key; the proxy holds the public halves.
  const llmKeys: Record<string, Awaited<ReturnType<typeof generateLlmSigningKey>>> = {};
  if (opts.llmUpstream) for (const a of opts.apps) llmKeys[a.def.manifest.app] = await generateLlmSigningKey(`llm-${a.def.manifest.app}`);
  let platUrl = '';
  const backends: Record<string, NeopBackend> = {};
  const first = opts.apps[0]!.def.manifest.app;
  const appserviceUrl = (key: string) => (backends[key]?.ports.appservice ? `http://127.0.0.1:${backends[key]!.ports.appservice}` : '');
  // Appservice road: one homeserver for everyone. Plain pushes (hs.push) go to the first app's appservice.
  const hs = road === 'appservice' ? await fakeHomeserver(() => appserviceUrl(first)) : null;
  const mx = road === 'client' && withNeuralchat ? fakeMatrix({ serverName: 'hs.test' }) : null;
  const ncTimings = { ackWaitMs: opts.neuralchatAckWaitMs ?? 3_000 };
  const neuralchat = !withNeuralchat
    ? undefined
    : road === 'appservice'
      ? { road: 'appservice' as const, homeserverUrl: hs!.url, serverName: MATRIX.serverName, hsToken: MATRIX.hsToken, asToken: MATRIX.asToken, ...ncTimings }
      : { road: 'client' as const, homeserverUrl: 'http://hs.test', accounts: [], fetchImpl: mx!.fetchImpl, syncTimeoutMs: 100, ...ncTimings };
  const plat = await startPlatform({
    neuralchat,
    llm: opts.llmUpstream ? { upstream: { baseUrl: opts.llmUpstream.url, apiKey: opts.llmUpstream.apiKey, auth: opts.llmUpstream.auth, modelPrefix: opts.llmUpstream.modelPrefix }, prices: { 'claude-sonnet-5': { input: 3, output: 15 } }, runnerKeys: Object.fromEntries(Object.entries(llmKeys).map(([k, v]) => [k, [v.publicJwk]])) } : undefined,
    dbUrl: roleUrl(db.adminUrl, 'neos_app'),
    dbPoolSize: opts.platformDbPool ?? 6,
    keys,
    workers: opts.platformWorkers !== false,
    timings: { neuralchatMs: 200 },
  });
  platUrl = plat.url;
  const company = await plat.platform.createCompany('Acme Traders', 'Asia/Kolkata');
  const admin = await plat.platform.createUser(company.id, { name: 'Priya', email: 'priya@acme.example', role: 'admin' });
  const member = await plat.platform.createUser(company.id, { name: 'Rahul', email: 'rahul@acme.example', role: 'member' });
  const operator = await plat.platform.createUser(company.id, { name: 'Ops', email: 'ops@neos.example', role: 'operator' });
  const operator2 = await plat.platform.createUser(company.id, { name: 'Reviewer', email: 'review@neos.example', role: 'operator' });
  const slug = (await plat.platform.db.query<{ slug: string }>('select slug from neos.companies where id = $1', [company.id])).rows[0]!.slug;
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

  const workers: Pilot['workers'] = {};
  const configs: Record<string, Parameters<typeof startBackend>[1]> = {};
  for (const a of opts.apps) {
    const key = a.def.manifest.app;
    workers[key] = await startAgentWorker({
      poolSize: opts.poolSize ?? 5,
      // With an upstream, the agent is keyless: each session gets a proxy token from the runner.
      model: opts.llmUpstream ? proxyModel({ NEOP_LLM_MODEL: 'claude-sonnet-5' }) : { model: faux.getModel() },
    });
    configs[key] = {
      appDbUrl: roleUrl(db.adminUrl, `${key}_app`),
      runnerDbUrl: roleUrl(db.adminUrl, `${key}_runner`),
      jobTokenSecret: randomBytes(32).toString('hex'),
      agentUrl: `http://127.0.0.1:${workers[key].port}`,
      poolSize: opts.poolSize ?? 5,
      runnerId: `runner-${key}`,
      secrets: new FileSecretStore({ root: doorsDir, app: key }),
      llm: llmKeys[key] ? { proxyUrl: `${plat.url}/llm`, signingKey: llmKeys[key].privateJwk } : undefined,
      timings: { ...FAST, ...(opts.timings ?? {}) },
      // v3 S9: every backend is on Matrix itself — its only road in.
      presence:
        road === 'appservice'
          ? { mode: 'appservice' as const, homeserverUrl: hs!.url, appservice: { hsToken: MATRIX.hsToken, asToken: MATRIX.asToken, port: 0, host: '127.0.0.1' }, mirrorEveryMs: 100 }
          : { mode: 'client' as const, homeserverUrl: 'http://hs.test', client: { accounts: [], syncTimeoutMs: 100, replyEveryMs: 50 }, mirrorEveryMs: 100 },
      ...(opts.backendConfig?.(key, company) ?? {}),
    };
    backends[key] = await startBackend(a.def, configs[key]!, {});
    await plat.platform.registerApp({ key, manifest: a.def.manifest, service_secret: randomBytes(24).toString('hex'), blocks: a.def.blocks });
    await plat.platform.installApp(company.id, key, admin.id);
    if (opts.seed !== false && a.seed) await a.seed(backends[key].core.appPool, company.id);
  }
  // Each app's own name and room at the company, written into its schema (as an admin would, PUT /api/chat/presence).
  let neopUser: string | null = null;
  const neopUsers: Record<string, string> = {};
  const appRooms: Record<string, string> = {};
  if (road === 'appservice') {
    for (const key of Object.keys(backends)) {
      neopUsers[key] = `@neop_${key}_${slug}:${MATRIX.serverName}`;
      // With NeuralChat, each app's room at the company (where NeuralChat posts its tasks); without, the test binds its own.
      if (withNeuralchat) appRooms[key] = `!${key}-room:${MATRIX.serverName}`;
      await plat.platform.setChatIdentity(company.id, key, { matrix_user: neopUsers[key], ...(appRooms[key] ? { room_ids: [appRooms[key]!] } : {}) }, `user:${admin.id}`);
      // pushTyped({to}) reaches that app's own appservice.
      hs!.route(`@neop_${key}_`, () => appserviceUrl(key));
    }
    neopUser = neopUsers[first]!;
    // The homeserver pushes every event any appservice sends to every registration (each app's, NeuralChat's): in
    // order, retried until taken, as Synapse does for a registration with a member in the room. Receivers keep what is theirs.
    if (withNeuralchat) hs!.relayAll(() => [...Object.keys(backends).map(appserviceUrl).filter(Boolean), platUrl]);
  }
  // NeuralChat's own name at the company, on the same road as the apps.
  let neuralchatUser: string | null = null;
  const neopClient = async (b: NeopBackend) => {
    // The app's own account on the shared homeserver (NEOP presence, client road), listening before NeuralChat speaks.
    await b.presence!.addClient({ account: neopUser!, accessToken: mx!.account(neopUser!) }, { homeserverUrl: 'http://hs.test', fetchImpl: mx!.fetchImpl, syncTimeoutMs: 100, replyEveryMs: 50 });
  };
  if (withNeuralchat) {
    if (road === 'appservice') {
      neuralchatUser = `@neuralchat_${slug}:${MATRIX.serverName}`;
    } else {
      neopUser = `@${first}:hs.test`;
      neuralchatUser = `@neuralchat_${slug}:hs.test`;
      await plat.platform.setChatIdentity(company.id, first, { matrix_user: neopUser }, `user:${admin.id}`);
      await neopClient(backends[first]!);
      await plat.platform.neuralchat!.addAccount({ company: company.id, account: neuralchatUser, token: mx!.account(neuralchatUser) });
    }
    await plat.platform.syncChat(company.id);
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
    get presence() {
      return backends[first]!.presence;
    },
    neopUser,
    neuralchatUser,
    neuralchatPerson: (userId) => `@neuralchat_${slug}_person_${userId.replace(/-/g, '')}:${road === 'appservice' ? MATRIX.serverName : 'hs.test'}`,
    mx,
    neopUsers,
    appRooms,
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
      // v3 S5: through Matrix the app's "on it" can come a moment after the ask answered — wait for it here.
      if (r.status === 200 && !r.body.job_id && r.body.task_id && r.body.status === 'OPEN') {
        r.body.job_id = await waitFor(async () => (await api('GET', `/api/tasks/${r.body.task_id}`)).body?.task?.job_id, `job of task ${r.body.task_id}`).catch(async (e) => {
          const t = (await api('GET', `/api/tasks/${r.body.task_id}`)).body?.task;
          throw new Error(`${(e as Error).message} (task ${t?.status}, road ${t?.road}, posted ${t?.matrix_event_id ?? 'no'}, last error ${t?.last_error ?? 'none'})`);
        });
      }
      if (r.status !== 200 || !r.body.job_id) throw new Error(`ask failed: ${JSON.stringify(r.body)}`);
      return r.body;
    },
    async read(key, args = {}, o = {}) {
      const b = backends[o.app ?? first]!;
      const core = b.core;
      const co = o.company ?? company.id;
      const inst = (await core.runnerPool.query(`select status from ${sqlIdent(core.key)}.installs where company_id = $1`, [co])).rows[0];
      if (inst?.status !== 'active') return { status: 403, body: { error: { code: 'not_installed', message: `${core.key} is not installed for this company` } } };
      const resolved = await core.resolve(co, key);
      if (!resolved || resolved.handler.kind !== 'read') return { status: 404, body: { error: { code: 'not_found', message: key } } };
      const board = await core.board.get(co);
      if (board.setting(resolved.meta) === 'off') return { status: 403, body: { error: { code: 'switched_off', message: `${key} is switched off` } } };
      const bad = resolved.checkInput(args);
      if (bad) return { status: 400, body: { error: { code: 'bad_request', message: bad } } };
      try {
        const result = await core.company(co, (db) => (resolved.handler as { run: (a: unknown, c: unknown) => Promise<unknown> }).run(args, { company_id: co, caller: o.caller ?? `user:${admin.id}`, job_id: null, now: new Date(), time_zone: board.company.time_zone, db }));
        const badOut = resolved.checkOutput(result);
        if (badOut) return { status: 500, body: { error: { code: 'contract_violation', message: badOut } } };
        return { status: 200, body: { result } };
      } catch (e) {
        const x = e as { status?: number; code?: string; message?: string };
        return { status: x.status ?? 500, body: { error: { code: x.code ?? 'internal', message: String(x.message ?? e) } } };
      }
    },
    waitFor,
    task: async (id) => (await api('GET', `/api/tasks/${id}`)).body,
    desk: async () => (await api('GET', '/api/desk')).body.cards,
    jobRow: async (jobId, app = first) => (await backends[app]!.core.runnerPool.query(`select * from ${sqlIdent(app)}.jobs where id = $1`, [jobId])).rows[0],
    async restartBackend(app = first) {
      const def = opts.apps.find((a) => a.def.manifest.app === app)!.def;
      await backends[app]!.stop().catch(() => {});
      const b = await startBackend(def, configs[app]!, {});
      backends[app] = b;
      if (app === first) pilot.backend = b;
      if (app === first && mx) await neopClient(b);
      return b;
    },
    defs: Object.fromEntries(opts.apps.map((a) => [a.def.manifest.app, a.def])),
    async rebuild(app, def) {
      const entry = opts.apps.find((a) => a.def.manifest.app === app);
      if (!entry) throw new Error(`no app ${app} in this pilot`);
      // The DBA applies the new build's migration file first (a refused file leaves the running build as it was).
      await migrateApp(db.adminUrl, def);
      await backends[app]!.stop().catch(() => {});
      entry.def = def;
      pilot.defs[app] = def;
      const b = await startBackend(def, configs[app]!, {});
      backends[app] = b;
      if (app === first) pilot.backend = b;
      if (app === first && mx) await neopClient(b);
      await plat.platform.registerApp({ key: app, manifest: def.manifest, blocks: def.blocks });
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

/**
 * An app's migration set as it stood before `file` (a copy of the folder without that file and those after it, and
 * migrate.json cut to match) — for a populated-data proof of an older TEMPLATE file: the book as it was then had the
 * template up to that file and the app's files of that time. (An app file that relies on a newer template file, such
 * as Ledger's 010 on t018's declared_reads, did not exist yet.) The caller removes the folder.
 */
export async function appMigrationsBefore(dir: string, file: string): Promise<string> {
  const { cp: copy, readFile } = await import('node:fs/promises');
  const out = await mkdtemp(path.join(os.tmpdir(), `neop-app-before-${file}-`));
  await copy(dir, out, { recursive: true });
  const led = JSON.parse(await readFile(path.join(out, 'migrate.json'), 'utf8')) as { migrations: { file: string }[] };
  for (const m of led.migrations.filter((x) => x.file >= file)) await rm(path.join(out, m.file));
  led.migrations = led.migrations.filter((m) => m.file < file);
  await writeFile(path.join(out, 'migrate.json'), JSON.stringify(led));
  return out;
}
