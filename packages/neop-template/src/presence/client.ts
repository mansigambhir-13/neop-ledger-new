// PRESENCE · THE CLIENT ROAD (NEOP_PRESENCE=client) — the ordinary-account /sync road NeuralChat #143 uses today,
// now in the NEOP's own backend (ported from packages/platform/src/bridge/client-sync.ts). One ordinary account
// per company (e.g. @ledger:acme.example) with an operator-issued access token read from a secret file; the
// company is the install whose <schema>.installs.matrix_user is that account (never the platform API):
//
//   in   a plain m.text in a 1:1 DM from an allowed sender — a linked person on the app's allowlist
//        (<schema>.people.chat_person) or an allowed agent sender (installs.agent_senders) — goes to
//        runner/inbound.ts once (event_id). Strangers, notices, other msgtypes, empty bodies, backlog from before
//        this start and rooms that are not 1:1 get nothing: no job, no reply. Invites are joined only from an
//        allowed sender, and only a 1:1 room is kept (recorded as that sender's DM, <schema>.presence_dms).
//   out  EXACTLY ONE m.notice per message, m.in_reply_to → it, txnId reply-<event_id>, when the job settles as the
//        book says — or the fixed sentence past MATRIX_REPLY_DEADLINE_MS (default 55 s, under NeuralChat's 60 s),
//        and nothing more if the late result arrives. The cursor and every reply's state live in this app's
//        schema (presence_accounts, inbound_events), so a restart never answers a message twice.
//   stop a rejected token (401 M_UNKNOWN_TOKEN / M_MISSING_TOKEN, M_USER_DEACTIVATED), an account mismatch or no
//        install for the account stops the client: no retries, no password login, never /logout.

import { readFileSync } from 'node:fs';
import { isTypedEventType } from '@neop/contracts';
import type { Inbound, Road } from '../runner/inbound.ts';
import { claimInbound } from './events.ts';
import type { Identity } from './identity.ts';
import { stripReplyFallback } from './lexicon.ts';

/** Under NeuralChat's 60 s wait for a reply, so the fixed sentence (never silence) reaches it in time. */
export const DEFAULT_REPLY_DEADLINE_MS = 55_000;

/** Only what the road needs: room timelines and invites. No presence, account data or ephemeral events. */
export const SYNC_FILTER = JSON.stringify({
  presence: { not_types: ['*'] },
  account_data: { not_types: ['*'] },
  room: { timeline: { limit: 50 }, state: { lazy_load_members: true }, ephemeral: { not_types: ['*'] }, account_data: { not_types: ['*'] } },
});

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), res()), { once: true });
  });

export class MatrixClientError extends Error {
  readonly status: number;
  readonly errcode: string | undefined;
  readonly retryAfterMs: number | null;
  /** A rejected or missing token needs a config fix: the client stops rather than retry. */
  readonly fatal: boolean;
  constructor(status: number, errcode: string | undefined, message?: string, retryAfterMs: number | null = null) {
    super(message || `matrix request failed (${status}${errcode ? ` ${errcode}` : ''})`);
    this.status = status;
    this.errcode = errcode;
    this.retryAfterMs = retryAfterMs;
    this.fatal = (status === 401 && (errcode === 'M_UNKNOWN_TOKEN' || errcode === 'M_MISSING_TOKEN')) || errcode === 'M_USER_DEACTIVATED';
  }
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/** One ordinary account, speaking only as itself (no ?user_id=). No login, no logout. */
export class MatrixClientHttp {
  readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  constructor(o: { homeserverUrl: string; accessToken: string; fetchImpl?: FetchLike }) {
    this.base = o.homeserverUrl.replace(/\/+$/, '');
    this.token = o.accessToken;
    this.fetchImpl = o.fetchImpl ?? (fetch as unknown as FetchLike);
  }
  async request<T = any>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const r = await this.fetchImpl(`${this.base}${path}`, {
      method,
      signal: signal ?? AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new MatrixClientError(r.status, j?.errcode, j?.error, Number.isFinite(Number(j?.retry_after_ms)) ? Number(j.retry_after_ms) : null);
    return j as T;
  }
  async whoami(): Promise<string> {
    return (await this.request<{ user_id: string }>('GET', '/_matrix/client/v3/account/whoami')).user_id;
  }
  async sendEvent(roomId: string, type: string, content: Record<string, unknown>, txnId: string): Promise<string> {
    const p = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(type)}/${encodeURIComponent(txnId)}`;
    return (await this.request<{ event_id: string }>('PUT', p, content)).event_id;
  }
  async join(roomId: string): Promise<void> {
    await this.request('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {});
  }
  async leave(roomId: string): Promise<void> {
    await this.request('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {}).catch((e) => {
      if (!(e instanceof MatrixClientError)) throw e;
    });
  }
  async members(roomId: string): Promise<string[]> {
    return Object.keys((await this.request<{ joined?: Record<string, unknown> }>('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`)).joined ?? {});
  }
}

export interface ClientAccountConfig {
  /** The account the operator says this token is for; a token of another account stops the client (account_mismatch). */
  account?: string;
  accessToken?: string;
  tokenFile?: string;
}

export interface ClientOptions {
  homeserverUrl: string;
  /** /sync long-poll timeout (default 30 s; MATRIX_SYNC_TIMEOUT_MS). */
  syncTimeoutMs?: number;
  /** How often owed replies are checked against the book (default 250 ms). */
  replyEveryMs?: number;
  fetchImpl?: FetchLike;
}

interface SyncEvent {
  event_id?: string;
  type?: string;
  sender?: string;
  state_key?: string;
  origin_server_ts?: number;
  content?: any;
}

export interface ClientStatus {
  account: string | null;
  company_id: string | null;
  running: boolean;
  stopped: { reason: string } | null;
  cursor: string | null;
}

/** What a client needs from the NEOP's presence. */
export interface ClientHost {
  schema: string;
  db: import('@neop/pgkit').Pool;
  identity: Identity;
  inbound: Inbound;
  /** The road is live (the mirror speaks through it) / gone. */
  register(road: Road): void;
  unregister(road: Road): void;
  log(msg: string, extra?: Record<string, unknown>): void;
}

/** One account's client: the /sync ear, the inbound rules (runner/inbound.ts) and the one-reply mouth. */
export class PresenceClient {
  readonly host: ClientHost;
  readonly cfg: ClientAccountConfig;
  readonly http: MatrixClientHttp;
  private readonly o: Required<Pick<ClientOptions, 'syncTimeoutMs' | 'replyEveryMs'>>;
  account: string | null = null;
  companyId: string | null = null;
  road: Road | null = null;
  private cursor: string | null = null;
  private stopped: { reason: string } | null = null;
  private stopping = false;
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private replyTimer: NodeJS.Timeout | null = null;
  private replying = false;
  private readonly startedAt = Date.now();
  private readonly direct = new Map<string, string>(); // room → the peer it was seen 1:1 with

  constructor(host: ClientHost, cfg: ClientAccountConfig, o: ClientOptions) {
    this.host = host;
    this.cfg = cfg;
    const token = cfg.accessToken ?? (cfg.tokenFile ? readFileSync(cfg.tokenFile, 'utf8').trim() : '');
    if (!token) throw new Error(`no access token for ${cfg.account ?? 'the Matrix account'} (set token_file)`);
    this.http = new MatrixClientHttp({ homeserverUrl: o.homeserverUrl, accessToken: token, fetchImpl: o.fetchImpl });
    this.o = { syncTimeoutMs: o.syncTimeoutMs ?? 30_000, replyEveryMs: o.replyEveryMs ?? 250 };
  }

  private log(msg: string, extra: Record<string, unknown> = {}): void {
    this.host.log(`client: ${msg}`, { account: this.account ?? this.cfg.account ?? null, ...extra });
  }

  status(): ClientStatus {
    return { account: this.account, company_id: this.companyId, running: !!this.loop && !this.stopped && !this.stopping, stopped: this.stopped, cursor: this.cursor };
  }

  /**
   * Who the token is (whoami), which install speaks as it (installs.matrix_user), then the loop. Resolves once the
   * loop is running — or stopped: a rejected token, another account than configured, or no install.
   */
  async start(): Promise<void> {
    let who: string;
    try {
      who = await this.http.whoami();
    } catch (e: any) {
      if (e?.fatal) return void (await this.halt('token_rejected', { status: e.status, errcode: e.errcode }));
      this.stopped = { reason: 'unreachable' };
      return void this.log('not started — the homeserver could not be reached', { e: String(e?.message ?? e).slice(0, 200) });
    }
    this.account = who;
    if (this.cfg.account && who !== this.cfg.account) return void (await this.halt('account_mismatch', { whoami: who }));
    const installs = await this.host.identity.installsOf(who);
    if (installs.length !== 1) return void (await this.halt(installs.length ? 'bound_to_two_installs' : 'no_install', { whoami: who }));
    this.companyId = installs[0]!.company_id;
    const row = (
      await this.host.db.query<{ company_id: string; road: string; next_batch: string | null }>(
        `insert into ${this.host.schema}.presence_accounts (account, company_id, road) values ($1, $2, 'client')
         on conflict (account) do update set stopped_reason = null, updated_at = now() returning company_id, road, next_batch`,
        [who, this.companyId],
      )
    ).rows[0]!;
    if (row.company_id !== this.companyId) {
      // The name moved to another company: its cursor and DMs belong to the old install. Start clean for the new one.
      await this.host.db.query(`update ${this.host.schema}.presence_accounts set company_id = $2, next_batch = null where account = $1`, [who, this.companyId]);
      row.next_batch = null;
    }
    this.cursor = row.next_batch;
    const http = this.http;
    const self = this;
    this.road = {
      kind: 'client',
      account: who,
      companyId: this.companyId,
      async send(room, content, txnId) {
        return self.guardSend(() => http.sendEvent(room, 'm.room.message', content, txnId));
      },
      async sendEvent(room, type, content, txnId) {
        return self.guardSend(() => http.sendEvent(room, type, content, txnId));
      },
    };
    this.host.register(this.road);
    this.loop = this.run();
    this.replyTimer = setInterval(() => void this.replyTick().catch((e) => this.log('reply tick failed', { e: String(e) })), this.o.replyEveryMs);
  }

  /** A rejected token while speaking stops the client like one rejected while listening. */
  private async guardSend(fn: () => Promise<string>): Promise<string> {
    try {
      return await fn();
    } catch (e: any) {
      if (e?.fatal) await this.halt('token_rejected', { status: e.status, errcode: e.errcode });
      throw e;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.controller?.abort();
    if (this.replyTimer) clearInterval(this.replyTimer);
    this.replyTimer = null;
    if (this.road) this.host.unregister(this.road);
    await this.loop?.catch(() => {});
    while (this.replying) await sleep(10);
  }

  private async halt(reason: string, extra: Record<string, unknown> = {}): Promise<void> {
    if (this.stopped) return;
    this.stopped = { reason };
    this.stopping = true;
    this.controller?.abort();
    if (this.replyTimer) clearInterval(this.replyTimer);
    this.replyTimer = null;
    if (this.road) this.host.unregister(this.road);
    const why: Record<string, string> = {
      account_mismatch: 'the token belongs to another account',
      token_rejected: 'the access token was rejected',
      no_install: 'no install of this app speaks as this account (PUT /api/chat/presence matrix_user)',
      bound_to_two_installs: 'two installs speak as this account',
    };
    this.log(`STOPPED — ${why[reason] ?? reason}; fix it and restart (no retries, no login, no logout)`, { reason, ...extra });
    if (this.account && this.companyId) {
      await this.host.db.query(`update ${this.host.schema}.presence_accounts set stopped_reason = $2, updated_at = now() where account = $1`, [this.account, reason]).catch(() => {});
    }
  }

  // ── the ear ─────────────────────────────────────────────────────────────────
  private syncPath(since: string | null, timeout: number): string {
    return `/_matrix/client/v3/sync?timeout=${timeout}&filter=${encodeURIComponent(SYNC_FILTER)}${since ? `&since=${encodeURIComponent(since)}` : ''}`;
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      this.controller = new AbortController();
      try {
        if (!this.cursor) {
          // First start: pending invites are handled, the timeline backlog is skipped (history never becomes a job).
          const first = await this.http.request<any>('GET', this.syncPath(null, 0), undefined, this.controller.signal);
          await this.batch(first, true);
          await this.saveCursor(first.next_batch);
          this.log('listening from now — history before this start is not read');
        } else {
          const res = await this.http.request<any>('GET', this.syncPath(this.cursor, this.o.syncTimeoutMs), undefined, this.controller.signal);
          await this.batch(res, false);
          if (typeof res?.next_batch === 'string') await this.saveCursor(res.next_batch);
        }
        failures = 0;
      } catch (e: any) {
        if (this.stopping) break;
        if (e?.fatal) return void (await this.halt('token_rejected', { status: e.status, errcode: e.errcode }));
        failures++;
        const wait = e?.status === 429 && e.retryAfterMs != null ? Math.min(60_000, Math.max(0, e.retryAfterMs)) : Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5));
        this.log('sync error — retrying', { status: e?.status, errcode: e?.errcode, retryInMs: wait });
        await sleep(wait, this.controller.signal);
      }
    }
  }

  private async saveCursor(next: string): Promise<void> {
    if (typeof next !== 'string') return;
    this.cursor = next;
    await this.host.db.query(`update ${this.host.schema}.presence_accounts set next_batch = $2, updated_at = now() where account = $1`, [this.account, next]);
  }

  private async batch(res: any, skipTimeline: boolean): Promise<void> {
    for (const [roomId, inv] of Object.entries<any>(res?.rooms?.invite ?? {})) {
      const mine = (inv?.invite_state?.events ?? []).find((e: SyncEvent) => e?.type === 'm.room.member' && e.state_key === this.account && e.content?.membership === 'invite');
      if (!mine || mine.sender === this.account) continue;
      await this.guard(() => this.onInvite(roomId, String(mine.sender)), { room: roomId });
    }
    if (skipTimeline) return;
    for (const [roomId, joined] of Object.entries<any>(res?.rooms?.join ?? {})) {
      for (const ev of joined?.timeline?.events ?? []) {
        if (!ev || typeof ev !== 'object' || ev.sender === this.account) continue;
        await this.guard(() => this.onEvent(roomId, ev), { room: roomId, event: ev.event_id });
      }
    }
  }

  private async guard(fn: () => Promise<unknown>, where: Record<string, unknown>): Promise<void> {
    try {
      await fn();
    } catch (e: any) {
      if (e?.fatal) throw e; // the loop stops on a rejected token
      this.log('an event could not be handled', { ...where, e: String(e?.message ?? e).slice(0, 200) });
    }
  }

  // ── who is writing, and where ───────────────────────────────────────────────
  private async isDirect(room: string, peer: string): Promise<boolean> {
    if (this.direct.get(room) === peer) return true;
    let members: string[];
    try {
      members = await this.http.members(room);
    } catch (e: any) {
      if (e?.fatal) throw e;
      return false;
    }
    const set = new Set(members);
    const ok = set.size === 2 && set.has(this.account!) && set.has(peer);
    if (ok) this.direct.set(room, peer);
    return ok;
  }

  private async recordDm(peer: string, room: string): Promise<void> {
    const s = this.host.schema;
    await this.host.db.query(`delete from ${s}.presence_dms where account = $1 and room_id = $2 and peer <> $3`, [this.account, room, peer]);
    await this.host.db.query(
      `insert into ${s}.presence_dms (company_id, account, peer, room_id) values ($1,$2,$3,$4)
       on conflict (account, peer) do update set room_id = excluded.room_id, company_id = excluded.company_id, recorded_at = now()
        where ${s}.presence_dms.room_id <> excluded.room_id or ${s}.presence_dms.company_id <> excluded.company_id`,
      [this.companyId, this.account, peer, room],
    );
  }

  /** Join only an allowed sender's invite, and only a 1:1 room; record it as that sender's DM. */
  private async onInvite(room: string, from: string): Promise<void> {
    if (!(await this.host.identity.sender(this.companyId!, from, 'client'))) return void this.log('invite ignored — sender not on the allowlist', { room });
    await this.http.join(room);
    const members = new Set(await this.http.members(room).catch((e) => (e?.fatal ? Promise.reject(e) : ([] as string[]))));
    members.delete(this.account!);
    if (members.size !== 1 || !members.has(from)) {
      await this.http.leave(room);
      return void this.log('left — not a 1:1 direct message', { room });
    }
    this.direct.set(room, from);
    await this.recordDm(from, room);
    this.log('direct message recorded', { room });
  }

  /** What a message means (runner/inbound.ts), once it is known to be fresh, from an allowed sender, in their DM. */
  private async onEvent(room: string, ev: SyncEvent): Promise<void> {
    const c = ev.content ?? {};
    const typed = isTypedEventType(ev.type);
    if (!typed) {
      if (ev.type !== 'm.room.message' || typeof ev.event_id !== 'string') return;
      if (c.msgtype !== 'm.text' || typeof c.body !== 'string' || !c.body.trim()) return; // notices are never answered: no loops
    }
    if (typeof ev.event_id !== 'string') return;
    const sender = String(ev.sender ?? '');
    const ts = Number(ev.origin_server_ts);
    if (!Number.isFinite(ts) || ts < this.startedAt) return void this.log('ignored — backlog from before this start', { event: ev.event_id });
    const who = await this.host.identity.sender(this.companyId!, sender, 'client');
    if (!who) return void this.log('ignored — sender not on the allowlist', { event: ev.event_id });
    if (!(await this.isDirect(room, sender))) return void this.log('ignored — not a 1:1 direct message', { event: ev.event_id });
    const fresh = await claimInbound(
      this.host.db,
      this.host.schema,
      {
        event_id: ev.event_id,
        company_id: this.companyId!,
        account: this.account!,
        room_id: room,
        road: 'client',
        sender,
        sender_class: who.cls,
        person_id: who.cls === 'person' ? `user:${who.person.id}` : who.actsFor ? `user:${who.actsFor}` : null,
        type: String(ev.type),
      },
      typed ? 'typed:received' : 'received',
    );
    if (!fresh) return; // once per event, ever
    await this.recordDm(sender, room);
    if (typed) {
      const outcome = await this.host.inbound.onTyped(this.road!, { event_id: ev.event_id, room_id: room, sender, type: String(ev.type), content: c }, who);
      return void this.log('typed event', { event: ev.event_id, type: ev.type, outcome });
    }
    await this.host.inbound.onDirectMessage(this.road!, {
      event_id: ev.event_id,
      room,
      sender,
      who,
      body: stripReplyFallback(c.body).trim().slice(0, 8000),
      in_reply_to: c['m.relates_to']?.['m.in_reply_to']?.event_id ?? null,
      on_behalf_of: c['neos.on_behalf_of'],
    });
  }

  /** Owed replies, and questions to put in people's own DMs. */
  async replyTick(): Promise<number> {
    if (this.replying || this.stopped || !this.road) return 0;
    this.replying = true;
    try {
      let n = await this.host.inbound.replyTick(this.road, () => this.stopping);
      if (!this.stopping) n += await this.host.inbound.questionsTick(this.road);
      return n;
    } catch (e: any) {
      if (!e?.fatal) this.log('reply not sent yet — will retry with the same transaction', { e: String(e?.message ?? e).slice(0, 200) });
      return 0;
    } finally {
      this.replying = false;
    }
  }
}
