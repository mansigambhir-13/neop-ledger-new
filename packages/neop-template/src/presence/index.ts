// PRESENCE · the NEOP is on Matrix itself (WP v3 §8, §13 `src/presence`; V3 migration stage S4). Mandatory since S9:
// there is no platform bridge and no gateway, so this is the only way anything reaches the app. NEOP_PRESENCE chooses
// the road, per backend (default client — the production road beside NeuralChat #143):
//   appservice  this backend is the application service for @neop_<app>_.* (deploy/appservice.<app>.yaml): the
//               homeserver pushes to /_matrix/app/v1 on APPSERVICE_PORT; it speaks as each company's name, in the
//               app's rooms and the company's bus room (NEOP to NEOP).
//   client      one ordinary account per company (NeuralChat #143's road): /sync from here, one reply per message.
// Either way the ear is runner/inbound.ts, the mouth runner/mirror.ts, and everything is kept in this app's own
// schema (template t012).

import { readFileSync } from 'node:fs';
import { serve, type ServerType } from '@hono/node-server';
import { closeServer } from '@neop/pgkit';
import type { Core } from '../core.ts';
import { Inbound, type Road, type TypedIn } from '../runner/inbound.ts';
import { Mirror } from '../runner/mirror.ts';
import { Bus } from '../runner/bus.ts';
import { appserviceRoutes, AppserviceTransport, type AppserviceConfig } from './appservice.ts';
import { DEFAULT_REPLY_DEADLINE_MS, PresenceClient, type ClientAccountConfig, type ClientOptions, type FetchLike } from './client.ts';
import { claimInbound } from './events.ts';
import { downloadMedia } from './files.ts';
import { Identity, type InstallIdentity, type Who } from './identity.ts';

export type PresenceMode = 'appservice' | 'client';

export interface PresenceConfig {
  mode: PresenceMode;
  /** The homeserver's client-server URL (both roads). */
  homeserverUrl?: string;
  appservice?: Omit<AppserviceConfig, 'homeserverUrl'>;
  client?: { accounts: ClientAccountConfig[]; syncTimeoutMs?: number; replyEveryMs?: number; fetchImpl?: FetchLike };
  /** A message not settled by then gets the fixed sentence (default 55 s; MATRIX_REPLY_DEADLINE_MS). */
  replyDeadlineMs?: number;
  /** How often the mirror reads the outbox (default 500 ms). */
  mirrorEveryMs?: number;
}

function secret(env: NodeJS.ProcessEnv, name: string): string {
  const f = env[`${name}_FILE`];
  return (f ? readFileSync(f, 'utf8') : (env[name] ?? '')).trim();
}

/**
 * NEOP_PRESENCE=appservice|client (default client; v3 S9: there is no "off") and the road's settings:
 *   NEOP_MATRIX_HOMESERVER_URL                                     both roads
 *   NEOP_MATRIX_HS_TOKEN[_FILE] · NEOP_MATRIX_AS_TOKEN[_FILE] · APPSERVICE_PORT (4104) · APPSERVICE_HOST     appservice
 *   NEOP_MATRIX_CLIENT_ACCOUNTS[_FILE]  [{"account":"@ledger:hs","token_file":"/run/secrets/matrix_ledger_token"}]   client
 *   MATRIX_REPLY_DEADLINE_MS (55000) · MATRIX_SYNC_TIMEOUT_MS (30000)
 */
export function presenceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PresenceConfig {
  const mode = String(env.NEOP_PRESENCE ?? 'client').trim().toLowerCase() || 'client';
  if (!['appservice', 'client'].includes(mode)) {
    throw new Error(`NEOP_PRESENCE must be appservice or client (got ${mode}): the NEOP's own presence is the only road to it (v3 S9 removed the platform bridge and the gateway)`);
  }
  const homeserverUrl = String(env.NEOP_MATRIX_HOMESERVER_URL ?? '').trim();
  if (!homeserverUrl) throw new Error(`NEOP_PRESENCE=${mode} needs NEOP_MATRIX_HOMESERVER_URL`);
  const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const base = { homeserverUrl, replyDeadlineMs: num(env.MATRIX_REPLY_DEADLINE_MS) };
  if (mode === 'appservice') {
    const hsToken = secret(env, 'NEOP_MATRIX_HS_TOKEN');
    const asToken = secret(env, 'NEOP_MATRIX_AS_TOKEN');
    if (!hsToken || !asToken) throw new Error('NEOP_PRESENCE=appservice needs NEOP_MATRIX_HS_TOKEN and NEOP_MATRIX_AS_TOKEN (or their _FILE)');
    return { ...base, mode: 'appservice', appservice: { hsToken, asToken, port: num(env.APPSERVICE_PORT) ?? 4104, host: env.APPSERVICE_HOST || undefined } };
  }
  const raw = env.NEOP_MATRIX_CLIENT_ACCOUNTS_FILE ? readFileSync(env.NEOP_MATRIX_CLIENT_ACCOUNTS_FILE, 'utf8') : (env.NEOP_MATRIX_CLIENT_ACCOUNTS ?? '');
  const list = raw.trim() ? (JSON.parse(raw) as any[]) : [];
  if (!Array.isArray(list) || !list.length) throw new Error('NEOP_PRESENCE=client needs NEOP_MATRIX_CLIENT_ACCOUNTS: a JSON list of {account, token_file}');
  const accounts = list.map((a): ClientAccountConfig => {
    if (!(a?.token_file || a?.tokenFile) || (a.account && !/^@[^:]+:.+$/.test(String(a.account)))) throw new Error('each NEOP_MATRIX_CLIENT_ACCOUNTS entry needs token_file (and account as @user:server, if given)');
    return { account: a.account ? String(a.account) : undefined, tokenFile: String(a.token_file ?? a.tokenFile) };
  });
  return { ...base, mode: 'client', client: { accounts, syncTimeoutMs: num(env.MATRIX_SYNC_TIMEOUT_MS) } };
}

/** The NEOP's presence in one backend process: identity, the ear (Inbound), the mouth (Mirror) and the live roads. */
export class Presence {
  readonly core: Core;
  readonly cfg: PresenceConfig;
  readonly identity: Identity;
  readonly inbound: Inbound;
  readonly mirror: Mirror;
  /** v3 S6: NEOP to NEOP in the company's bus room (appservice road only; null otherwise). */
  readonly bus: Bus | null;
  readonly transport: AppserviceTransport | null;
  readonly clients: PresenceClient[] = [];
  /** The appservice listener's port, when that road is on. */
  port: number | null = null;
  private server: ServerType | null = null;
  private readonly roads = new Map<string, Road>();
  /** Appservice rooms checked this process: fit (spoken in) or the reasons they are not. */
  private readonly rooms = new Map<string, true | string[]>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(core: Core, cfg: PresenceConfig) {
    this.core = core;
    this.cfg = cfg;
    this.identity = new Identity(core.runnerPool, core.key);
    this.inbound = new Inbound(core, this.identity, { replyDeadlineMs: cfg.replyDeadlineMs ?? DEFAULT_REPLY_DEADLINE_MS, log: (m, e) => this.log(m, e) });
    this.transport = cfg.mode === 'appservice' && cfg.appservice && cfg.homeserverUrl ? new AppserviceTransport({ ...cfg.appservice, homeserverUrl: cfg.homeserverUrl }) : null;
    this.mirror = new Mirror(core, this.identity, this.inbound, { roadOf: (a) => this.roadOf(a), roomReady: (r, room) => this.roomReady(r, room) });
    // The bus room is a multi-app room: only the appservice road (the app's own name in the room) speaks there.
    this.bus = this.transport ? new Bus(core, this.identity, this.inbound, { roadFor: (co) => this.roadForCompany(co), roomReady: (r, room) => this.roomReady(r, room) }) : null;
    this.inbound.bus = this.bus;
  }

  /** The company's own name on the appservice road (null: no name there, or not this road). */
  async roadForCompany(companyId: string): Promise<Road | null> {
    if (!this.transport) return null;
    const inst = await this.identity.install(companyId);
    if (!inst?.matrix_user || inst.status !== 'active') return null;
    return this.appserviceRoad(companyId, inst.matrix_user);
  }

  log(msg: string, extra?: Record<string, unknown>): void {
    this.core.log(`presence: ${msg}`, extra);
  }

  // ── roads ───────────────────────────────────────────────────────────────────
  register(road: Road): void {
    this.roads.set(road.account, road);
  }
  unregister(road: Road): void {
    if (this.roads.get(road.account) === road) this.roads.delete(road.account);
  }

  /** The live road for one of our names: a running client, or (appservice) the company's name. */
  roadOf(account: string): Road | null {
    return this.roads.get(account) ?? null;
  }

  private appserviceRoad(companyId: string, account: string): Road {
    const known = this.roads.get(account);
    if (known && known.companyId === companyId) return known;
    const t = this.transport!;
    const road: Road = {
      kind: 'appservice',
      account,
      companyId,
      send: (room, content, txnId) => t.sendEvent(room, account, 'm.room.message', content, txnId),
      sendEvent: (room, type, content, txnId) => t.sendEvent(room, account, type, content, txnId),
      mayApproveHere: (room, sender) => t.canApprove(room, account, sender),
      download: (mxc, max) => downloadMedia({ homeserverUrl: t.cfg.homeserverUrl, token: t.cfg.asToken, asUser: account, fetchImpl: t.cfg.fetchImpl as any }, mxc, max),
    };
    this.roads.set(account, road);
    return road;
  }

  /** Appservice rooms are joined and checked once per process (v3 §8 room settings); DMs are always fit. */
  async roomReady(road: Road, room: string): Promise<boolean> {
    if (road.kind !== 'appservice' || !this.transport) return true;
    const key = `${road.account}|${room}`;
    const seen = this.rooms.get(key);
    if (seen) return seen === true;
    try {
      await this.transport.prepare(room, road.account);
      const inst = await this.identity.install(road.companyId);
      const nonPeople = [...(inst?.agent_senders ?? []), ...(room === inst?.bus_room_id ? Object.keys(inst?.bus_peers ?? {}) : [])];
      const problems = await this.transport.problems(room, road.account, nonPeople);
      this.rooms.set(key, problems.length ? problems : true);
      if (problems.length) this.log('room not fit for this app — not spoken in, nothing said there is acted on', { room, problems });
      return !problems.length;
    } catch (e) {
      this.log('room could not be joined or read yet', { room, e: String((e as Error)?.message ?? e).slice(0, 200) });
      return false; // tried again next time
    }
  }

  /** Forget a room's check (it was fixed, or re-bound): the next use checks it again. */
  recheckRoom(room: string): void {
    for (const k of [...this.rooms.keys()]) if (k.endsWith(`|${room}`)) this.rooms.delete(k);
  }

  /** Every company's name, a road; every bound room joined and checked (appservice road). */
  async refreshAppservice(): Promise<void> {
    if (!this.transport) return;
    for (const inst of await this.identity.named()) {
      const road = this.appserviceRoad(inst.company_id, inst.matrix_user!);
      for (const room of [...(inst.room_ids ?? []), ...(inst.bus_room_id ? [inst.bus_room_id] : [])]) await this.roomReady(road, room);
    }
  }

  // ── the appservice ear ──────────────────────────────────────────────────────
  private async roomOf(roomId: string, sender: string): Promise<{ road: Road; inst: InstallIdentity } | { outcome: string }> {
    const inst = await this.identity.installOfRoom(roomId);
    if (!inst) return { outcome: (await this.identity.isOurs(sender)) ? 'ignored_bot' : 'unknown_room' };
    if (sender === inst.matrix_user || (await this.identity.isOurs(sender))) return { outcome: 'ignored_bot' }; // our own echo: no loops
    const road = this.appserviceRoad(inst.company_id, inst.matrix_user!);
    if (!(await this.roomReady(road, roomId))) return { outcome: 'room_unfit' };
    return { road, inst };
  }

  async onAppserviceTyped(ev: TypedIn): Promise<string> {
    const r = await this.roomOf(ev.room_id, ev.sender);
    if ('outcome' in r) return r.outcome;
    // In the bus room only another app on the bus is anyone (v3 S6); elsewhere the room's people and allowed agents.
    const who: Who | null = r.inst.bus_room_id === ev.room_id ? await this.identity.busSender(r.road.companyId, ev.sender) : await this.identity.sender(r.road.companyId, ev.sender, 'appservice');
    // Bus questions and terminal replies commit their dedupe receipt, thread, wait and evidence together.
    // This must precede the generic eager receipt below, which is not a retryable inbox.
    if (who && r.inst.bus_room_id === ev.room_id && this.inbound.bus) {
      const result = await this.inbound.bus.receiveUpdate(r.road, ev, who);
      if (result !== null) return result;
    }
    const fresh = await claimInbound(
      this.core.runnerPool,
      this.core.key,
      {
        event_id: ev.event_id,
        company_id: r.road.companyId,
        account: r.road.account,
        room_id: ev.room_id,
        road: 'appservice',
        sender: ev.sender,
        sender_class: who?.cls ?? null,
        person_id: who?.cls === 'person' ? `user:${who.person.id}` : null,
        type: ev.type,
      },
      'typed:received',
    );
    if (!fresh) return 'duplicate';
    if (!who) {
      await this.inbound.setIn(ev.event_id, 'typed:unknown_sender', { detail: { type: ev.type } });
      return 'typed:unknown_sender';
    }
    return this.inbound.onTyped(r.road, ev, who);
  }

  async onAppserviceMessage(ev: { event_id: string; room_id: string; sender: string; body: string; in_reply_to: string | null }): Promise<string> {
    const r = await this.roomOf(ev.room_id, ev.sender);
    if ('outcome' in r) return r.outcome;
    const fresh = await claimInbound(this.core.runnerPool, this.core.key, {
      event_id: ev.event_id,
      company_id: r.road.companyId,
      account: r.road.account,
      room_id: ev.room_id,
      road: 'appservice',
      sender: ev.sender,
      sender_class: null,
      person_id: null,
      type: 'm.room.message',
    });
    if (!fresh) return 'duplicate';
    if (r.inst.bus_room_id === ev.room_id) {
      // The bus room carries typed events between apps; plain text there is nobody's task.
      await this.inbound.setIn(ev.event_id, 'bus:plain_ignored');
      return 'bus:plain_ignored';
    }
    return this.inbound.onRoomMessage(r.road, { event_id: ev.event_id, room: ev.room_id, sender: ev.sender, body: ev.body, in_reply_to: ev.in_reply_to });
  }

  /** Is this one of our names — a company's @neop_<app>_… (the homeserver asks before it creates one)? */
  async isOurs(userId: string): Promise<boolean> {
    return (await this.identity.isOurs(userId)) || userId.startsWith(`@neop_${this.core.key}_`);
  }

  // ── the client road ─────────────────────────────────────────────────────────
  /** Start one ordinary account's client (NEOP_PRESENCE=client; tests pass a fake homeserver's fetch). */
  async addClient(account: ClientAccountConfig, o: Partial<ClientOptions> = {}): Promise<PresenceClient> {
    const c = new PresenceClient(
      { schema: this.core.key, db: this.core.runnerPool, identity: this.identity, inbound: this.inbound, register: (r) => this.register(r), unregister: (r) => this.unregister(r), log: (m, e) => this.log(m, e) },
      account,
      { homeserverUrl: o.homeserverUrl ?? this.cfg.homeserverUrl ?? '', syncTimeoutMs: o.syncTimeoutMs ?? this.cfg.client?.syncTimeoutMs, replyEveryMs: o.replyEveryMs ?? this.cfg.client?.replyEveryMs, fetchImpl: o.fetchImpl ?? this.cfg.client?.fetchImpl },
    );
    await c.start();
    this.clients.push(c);
    return c;
  }

  async removeClient(c: PresenceClient): Promise<void> {
    await c.stop();
    const i = this.clients.indexOf(c);
    if (i >= 0) this.clients.splice(i, 1);
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────
  async start(opts: { host?: string } = {}): Promise<void> {
    // v3 S6: the gate hands tasks and borrowed calls to the bus from now on (never the platform's a2a routing).
    this.core.bus = this.bus;
    if (this.cfg.mode === 'appservice' && this.transport) {
      const routes = appserviceRoutes(
        { onTyped: (ev) => this.onAppserviceTyped(ev), onMessage: (ev) => this.onAppserviceMessage(ev), isOurs: (u) => this.isOurs(u) },
        { hsToken: this.cfg.appservice!.hsToken },
        (m, e) => this.log(m, e),
      );
      const { server, port } = await new Promise<{ server: ServerType; port: number }>((resolve) => {
        const s = serve({ fetch: routes.fetch, port: this.cfg.appservice?.port ?? 0, hostname: this.cfg.appservice?.host ?? opts.host ?? '127.0.0.1' }, (info) => resolve({ server: s, port: info.port }));
      });
      this.server = server;
      this.port = port;
      await this.refreshAppservice().catch((e) => this.log('rooms not ready yet', { e: String(e) }));
    }
    if (this.cfg.mode === 'client') {
      for (const a of this.cfg.client?.accounts ?? []) {
        // One bad account (no token file yet, no install) never takes the backend down with it.
        await this.addClient(a).catch((e) => this.log('client not started', { account: a.account ?? null, e: String((e as Error)?.message ?? e).slice(0, 200) }));
      }
    }
    const every = this.cfg.mirrorEveryMs ?? 500;
    let n = 0;
    this.timer = setInterval(() => {
      if (this.stopped) return;
      // New names and rooms are picked up as the platform writes them (every ~20 passes); the mirror every pass.
      const refresh = this.cfg.mode === 'appservice' && n++ % 20 === 0 ? this.refreshAppservice().catch(() => {}) : Promise.resolve();
      void refresh.then(() => this.mirror.tick()).catch((e) => this.log('mirror failed', { e: String(e) }));
    }, every);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.core.bus === this.bus) this.core.bus = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of [...this.clients]) await c.stop().catch(() => {});
    if (this.server) await closeServer(this.server as any).catch(() => {});
    this.server = null;
  }
}

export { AppserviceTransport, appserviceRoutes, tokenOk, type AppserviceConfig } from './appservice.ts';
export { DEFAULT_REPLY_DEADLINE_MS, MatrixClientError, MatrixClientHttp, PresenceClient, SYNC_FILTER, type ClientAccountConfig, type ClientStatus } from './client.ts';
export { FIXED_FAILURE, roomText, waitingCardText, amountsLine } from './cards.ts';
export { claimInbound, keyTxnId, replyTxnId, taskIdForEvent } from './events.ts';
export { classOfNonPerson, Identity, neopUser, type Person, type Who } from './identity.ts';
export { cardTextOf, goAheadOf, GO_AHEAD_LEXICON, isConsent, numbersIn, numbersNotOn, parseDecision, plainAnswers, stripReplyFallback } from './lexicon.ts';
export { Inbound, type Road } from '../runner/inbound.ts';
export { Mirror } from '../runner/mirror.ts';
export { Bus, borrowedCallAsk, type BusPeer, type BusRoad } from '../runner/bus.ts';
