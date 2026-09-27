// THE MATRIX CLIENT ROAD (MATRIX_MODE=client) · the alternative to the appservice transport (matrix.ts).
//
// Each company-app install may speak in Matrix as ONE ordinary account (e.g. @ledger:hs) with an operator-issued
// access token read from a secret file, and a supervised /sync loop — in the PLATFORM process, never in the app
// backend. Ported from the proven client road of the NEOP Matrix-client handoff (26 Sep 2026), onto our rules:
//
//   in   a plain m.text in a 1:1 DM from an allowlisted sender (a linked PERSON, or a BRIDGE such as
//        @reasoning_agent / @neos-platform) becomes a task row and a signed tasks.open through the gateway —
//        the desk ask path (platform.openTask), never a raw push. Strangers, notices, other msgtypes, empty
//        bodies, backlog from before this start and rooms that are not 1:1 get nothing: no task, no reply.
//   out  EXACTLY ONE m.notice per message, m.in_reply_to → that message, txnId reply-<event_id>, sent when the
//        task settles as the outbox reports it (neos.tasks status/result, neos.approvals) — never scraped from
//        the app. Past the deadline (50 s) or on failure: one fixed sentence, and nothing more if the late
//        result arrives. The cursor and every message's reply state live in the platform database, so a restart
//        never answers a message twice.
//   yes  ONLY a person approves: a linked, allowlisted person's explicit answer, in their OWN recorded DM, as a
//        reply to a card this account showed there, goes through the same platform.answer() with the
//        fingerprint that card showed. A bridge's "go ahead" is never a yes: the reply names the card and says
//        it waits for a person's yes on My Desk (or in that person's DM). (Deliberately unlike the handoff §6.)
//   no   A bridge's CLEAR decline of a card it was shown (a reply to that card, or its id named) IS taken, as a
//        "no" for the person it relays for, with the fingerprint shown: a model may add caution, never remove it.
//        It is recorded as decided via that bridge on the person's behalf, and audited (chat.bridge_decline).
//   ask  a job's question (WP §8) is the one reply in the DM it was asked from, and is put in the asking person's own
//        DM; a reply to that notice answers it — a person's as their words, a bridge's as relayed, untrusted data.
//        A plain next message (not a reply) in that DM answers the latest open question of a job the sender asked
//        there, when it reads as an answer: the whole text for a one-field question, else `key: value` pairs (one
//        per line, or `;`-separated) naming at least one field. An answer is information for the job, never a yes.
//   stop a rejected token (401 M_UNKNOWN_TOKEN / M_MISSING_TOKEN, M_USER_DEACTIVATED) or an account mismatch
//        stops the client: no retries, no password login, never /logout (it would revoke the operator's token).
//
// Everything a message says is data: it becomes the task's ask text (the app fences it) or, for a person's reply
// to a card, a decision parsed from a fixed vocabulary.

import { readFileSync } from 'node:fs';
import type { ProposalCreatedPayload } from '@neop/contracts';
import type { Platform } from '../platform.ts';
import { parseDecision } from './bridge.ts';
import { roomText } from './format.ts';
import { answersFromText } from '@neop/contracts';
import { stripReplyFallback } from './matrix.ts';

export const FIXED_FAILURE = "I can't reach the books right now. Please try again in a moment.";
const MAX_REPLY = 8000;
const SAFE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~-';
/** The txnId for the one reply to an event: derived from its id, so a resend is the same transaction. */
export const replyTxnId = (eventId: string): string => `reply-${[...String(eventId)].map((c) => (SAFE.includes(c) ? c : '_')).join('')}`.slice(0, 255);
const clip = (s: unknown, n = MAX_REPLY): string => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), res()), { once: true });
  });
const CONSENT = /\b(go ahead|proceed|do it|carry (it )?out|confirm(ed)?)\b/i;
/** A clear "no" to a card: never mistaken for a yes (a decline wins over any consent word next to it). */
const DECLINE = /\b(no|decline[sd]?|reject(ed)?|drop(ped)?|cancel(led|ed)?|discard(ed)?|withdraw|don'?t (do|send|go ahead|proceed)|do not (do|send|go ahead|proceed))\b/i;

/**
 * Answers read from a plain (non-reply) message: the whole text for a one-field question; else `key: value`
 * (or `label: value`) pairs, one per line or `;`-separated. Null when the text names none of the question's
 * fields — it is then a new request, not an answer. `missing` lists required fields it left out.
 */
export function plainAnswers(
  q: { fields: { key: string; label: string; required?: boolean }[] },
  text: string,
): { answers: Record<string, string>; missing: { key: string; label: string }[] } | null {
  const body = text.trim();
  if (!body || !q.fields.length) return null;
  if (q.fields.length === 1) return { answers: { [q.fields[0]!.key]: body }, missing: [] };
  const answers: Record<string, string> = {};
  for (const part of body.split(/\r?\n|;/)) {
    const m = /^\s*([^:=]{1,200}?)\s*[:=]\s*(.*)$/.exec(part);
    if (!m) continue;
    const name = m[1]!.trim().toLowerCase();
    const f = q.fields.find((x) => x.key.toLowerCase() === name || x.label.toLowerCase() === name);
    if (f && m[2]!.trim()) answers[f.key] = m[2]!.trim();
  }
  if (!Object.keys(answers).length) return null;
  return { answers, missing: q.fields.filter((f) => f.required !== false && !(f.key in answers)).map((f) => ({ key: f.key, label: f.label })) };
}

/** Only what the road needs: room timelines and invites. No presence, account data or ephemeral events. */
export const SYNC_FILTER = JSON.stringify({
  presence: { not_types: ['*'] },
  account_data: { not_types: ['*'] },
  room: { timeline: { limit: 50 }, state: { lazy_load_members: true }, ephemeral: { not_types: ['*'] }, account_data: { not_types: ['*'] } },
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

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/** One ordinary account, speaking only as itself (no ?user_id=). No login, no logout. */
export class MatrixClientHttp {
  readonly base: string;
  readonly account: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  constructor(o: { homeserverUrl: string; account: string; accessToken: string; fetchImpl?: FetchLike }) {
    this.base = o.homeserverUrl.replace(/\/+$/, '');
    this.account = o.account;
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
  async send(roomId: string, content: Record<string, unknown>, txnId: string): Promise<string> {
    const p = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`;
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

export interface ChatClientAccount {
  /** The app's own Matrix account, e.g. @ledger:acme.example */
  account: string;
  /** Company id or slug of the install this account speaks for. */
  company: string;
  app: string;
  /** The operator-issued access token, or a file holding it (container secret). */
  accessToken?: string;
  tokenFile?: string;
}

export interface ChatClientsConfig {
  homeserverUrl: string;
  accounts: ChatClientAccount[];
  /** A message not settled by then gets the fixed sentence (default 50 s). */
  replyDeadlineMs?: number;
  /** /sync long-poll timeout (default 30 s). */
  syncTimeoutMs?: number;
  /** How often owed replies are checked against the tasks (default 250 ms). */
  replyEveryMs?: number;
  fetchImpl?: FetchLike;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** MATRIX_MODE=client: MATRIX_HOMESERVER_URL + MATRIX_CLIENT_ACCOUNTS (JSON, or MATRIX_CLIENT_ACCOUNTS_FILE). */
export function chatClientConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ChatClientsConfig | null {
  if ((env.MATRIX_MODE ?? 'appservice') !== 'client') return null;
  const homeserverUrl = String(env.MATRIX_HOMESERVER_URL ?? '').trim();
  const raw = env.MATRIX_CLIENT_ACCOUNTS_FILE ? readFileSync(env.MATRIX_CLIENT_ACCOUNTS_FILE, 'utf8') : (env.MATRIX_CLIENT_ACCOUNTS ?? '');
  if (!homeserverUrl || !raw.trim()) throw new Error('MATRIX_MODE=client needs MATRIX_HOMESERVER_URL and MATRIX_CLIENT_ACCOUNTS (or MATRIX_CLIENT_ACCOUNTS_FILE)');
  const list = JSON.parse(raw) as any[];
  if (!Array.isArray(list) || !list.length) throw new Error('MATRIX_CLIENT_ACCOUNTS must be a non-empty JSON array');
  const accounts: ChatClientAccount[] = list.map((a) => {
    if (!/^@[^:]+:.+$/.test(String(a?.account ?? '')) || !a?.company || !a?.app || !(a?.token_file || a?.tokenFile)) {
      throw new Error('each MATRIX_CLIENT_ACCOUNTS entry needs account (@user:server), company, app and token_file');
    }
    return { account: a.account, company: String(a.company), app: String(a.app), tokenFile: a.token_file ?? a.tokenFile };
  });
  const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return { homeserverUrl, accounts, replyDeadlineMs: num(env.MATRIX_REPLY_DEADLINE_MS), syncTimeoutMs: num(env.MATRIX_SYNC_TIMEOUT_MS) };
}

interface SyncEvent {
  event_id?: string;
  type?: string;
  sender?: string;
  state_key?: string;
  origin_server_ts?: number;
  content?: any;
}

type Sender = { kind: 'person'; user: { id: string; company_id: string; role: string; name: string } } | { kind: 'bridge'; actsFor: string | null };

export interface ChatClientStatus {
  account: string;
  company_id: string | null;
  app: string;
  running: boolean;
  stopped: { reason: string } | null;
  cursor: string | null;
}

/** One app account's client: the /sync ear, the inbound rules, and the one-reply mouth. */
export class ChatClient {
  readonly platform: Platform;
  readonly cfg: ChatClientAccount;
  readonly http: MatrixClientHttp;
  private readonly o: Required<Pick<ChatClientsConfig, 'replyDeadlineMs' | 'syncTimeoutMs' | 'replyEveryMs'>> & Pick<ChatClientsConfig, 'log'>;
  companyId: string | null = null;
  private appName = '';
  private cursor: string | null = null;
  private stopped: { reason: string } | null = null;
  private stopping = false;
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private replyTimer: NodeJS.Timeout | null = null;
  private replying = false;
  private readonly startedAt = Date.now();
  private readonly direct = new Map<string, string>(); // room → the peer it was seen 1:1 with

  constructor(platform: Platform, cfg: ChatClientAccount, o: Omit<ChatClientsConfig, 'accounts'>) {
    this.platform = platform;
    this.cfg = cfg;
    const token = cfg.accessToken ?? (cfg.tokenFile ? readFileSync(cfg.tokenFile, 'utf8').trim() : '');
    if (!token) throw new Error(`no access token for ${cfg.account} (set token_file)`);
    this.http = new MatrixClientHttp({ homeserverUrl: o.homeserverUrl, account: cfg.account, accessToken: token, fetchImpl: o.fetchImpl });
    this.o = { replyDeadlineMs: o.replyDeadlineMs ?? 50_000, syncTimeoutMs: o.syncTimeoutMs ?? 30_000, replyEveryMs: o.replyEveryMs ?? 250, log: o.log };
  }

  private log(msg: string, extra: Record<string, unknown> = {}): void {
    this.o.log?.(`chat-client: ${msg}`, { account: this.cfg.account, ...extra });
  }

  status(): ChatClientStatus {
    return { account: this.cfg.account, company_id: this.companyId, app: this.cfg.app, running: !!this.loop && !this.stopped && !this.stopping, stopped: this.stopped, cursor: this.cursor };
  }

  /** Bind the account to its install, then run the loop. Resolves once the loop is running (or stopped). */
  async start(): Promise<void> {
    const co = await this.platform.db.query<{ id: string }>('select id from neos.companies where id::text = $1 or slug = $1', [this.cfg.company]);
    if (!co.rows[0]) {
      this.stopped = { reason: 'no_company' };
      return void this.log('not started — no such company for this account', { company: this.cfg.company });
    }
    this.companyId = co.rows[0].id;
    this.appName = (await this.platform.db.query<{ name: string }>("select manifest->>'name' as name from neos.apps where key = $1", [this.cfg.app])).rows[0]?.name ?? this.cfg.app;
    const row = await this.platform.db.query<{ company_id: string; app_key: string; next_batch: string | null }>(
      `insert into neos.chat_accounts (account, company_id, app_key) values ($1,$2,$3)
       on conflict (account) do update set stopped_reason = null, updated_at = now() returning company_id, app_key, next_batch`,
      [this.cfg.account, this.companyId, this.cfg.app],
    );
    const r = row.rows[0]!;
    if (r.company_id !== this.companyId || r.app_key !== this.cfg.app) {
      this.stopped = { reason: 'bound_to_another_install' };
      return void this.log('not started — this account already speaks for another install');
    }
    this.cursor = r.next_batch;
    this.loop = this.run();
    this.replyTimer = setInterval(() => void this.replyTick().catch((e) => this.log('reply tick failed', { e: String(e) })), this.o.replyEveryMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.controller?.abort();
    if (this.replyTimer) clearInterval(this.replyTimer);
    this.replyTimer = null;
    await this.loop?.catch(() => {});
    while (this.replying) await sleep(10);
  }

  private async halt(reason: string, extra: Record<string, unknown> = {}): Promise<void> {
    this.stopped = { reason };
    this.stopping = true;
    this.controller?.abort();
    if (this.replyTimer) clearInterval(this.replyTimer);
    this.replyTimer = null;
    this.log(`STOPPED — ${reason === 'account_mismatch' ? 'the token belongs to another account' : 'the access token was rejected'}; fix the token file and restart (no retries, no login, no logout)`, { reason, ...extra });
    await this.platform.db.query('update neos.chat_accounts set stopped_reason = $2, updated_at = now() where account = $1', [this.cfg.account, reason]).catch(() => {});
  }

  // ── the ear ─────────────────────────────────────────────────────────────────
  private syncPath(since: string | null, timeout: number): string {
    return `/_matrix/client/v3/sync?timeout=${timeout}&filter=${encodeURIComponent(SYNC_FILTER)}${since ? `&since=${encodeURIComponent(since)}` : ''}`;
  }

  private async run(): Promise<void> {
    let failures = 0;
    let checked = false;
    while (!this.stopping) {
      this.controller = new AbortController();
      try {
        if (!checked) {
          const who = await this.http.whoami();
          if (who !== this.cfg.account) return void (await this.halt('account_mismatch', { whoami: who }));
          checked = true;
        }
        if (!this.cursor) {
          // First start: pending invites are handled, the timeline backlog is skipped (history never becomes a task).
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
    await this.platform.db.query('update neos.chat_accounts set next_batch = $2, updated_at = now() where account = $1', [this.cfg.account, next]);
  }

  private async batch(res: any, skipTimeline: boolean): Promise<void> {
    for (const [roomId, inv] of Object.entries<any>(res?.rooms?.invite ?? {})) {
      const mine = (inv?.invite_state?.events ?? []).find((e: SyncEvent) => e?.type === 'm.room.member' && e.state_key === this.cfg.account && e.content?.membership === 'invite');
      if (!mine || mine.sender === this.cfg.account) continue;
      await this.guard(() => this.onInvite(roomId, String(mine.sender)), { room: roomId });
    }
    if (skipTimeline) return;
    for (const [roomId, joined] of Object.entries<any>(res?.rooms?.join ?? {})) {
      for (const ev of joined?.timeline?.events ?? []) {
        if (!ev || typeof ev !== 'object' || ev.sender === this.cfg.account) continue;
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

  // ── who is writing ──────────────────────────────────────────────────────────
  /** An allowlisted sender for this install, or null (a stranger: ignored). */
  private async senderOf(matrixId: string): Promise<Sender | null> {
    const a = (
      await this.platform.db.query<{ kind: 'person' | 'bridge'; acts_for: string | null }>(
        'select kind, acts_for from neos.chat_allowlist where company_id = $1 and app_key = $2 and matrix_id = $3',
        [this.companyId, this.cfg.app, matrixId],
      )
    ).rows[0];
    if (!a) return null;
    if (a.kind === 'bridge') return { kind: 'bridge', actsFor: a.acts_for };
    const u = (await this.platform.db.query('select id, company_id, role, name from neos.users where matrix_user_id = $1 and company_id = $2', [matrixId, this.companyId])).rows[0];
    return u ? { kind: 'person', user: u } : null; // a person must also be linked to someone in this company
  }

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
    const ok = set.size === 2 && set.has(this.cfg.account) && set.has(peer);
    if (ok) this.direct.set(room, peer);
    return ok;
  }

  private async recordDm(peer: string, room: string): Promise<void> {
    await this.platform.db.query('delete from neos.chat_dms where account = $1 and room_id = $2 and peer <> $3', [this.cfg.account, room, peer]);
    await this.platform.db.query(
      `insert into neos.chat_dms (account, peer, room_id) values ($1,$2,$3)
       on conflict (account, peer) do update set room_id = excluded.room_id, recorded_at = now() where neos.chat_dms.room_id <> excluded.room_id`,
      [this.cfg.account, peer, room],
    );
  }

  private async dmOf(peer: string): Promise<string | null> {
    return (await this.platform.db.query<{ room_id: string }>('select room_id from neos.chat_dms where account = $1 and peer = $2', [this.cfg.account, peer])).rows[0]?.room_id ?? null;
  }

  /** Join only an allowlisted sender's invite, and only a 1:1 room; record it as that sender's DM. */
  private async onInvite(room: string, from: string): Promise<void> {
    if (!(await this.senderOf(from))) return void this.log('invite ignored — sender not on the allowlist', { room });
    await this.http.join(room);
    const members = new Set(await this.http.members(room).catch((e) => (e?.fatal ? Promise.reject(e) : [] as string[])));
    members.delete(this.cfg.account);
    if (members.size !== 1 || !members.has(from)) {
      await this.http.leave(room);
      return void this.log('left — not a 1:1 direct message', { room });
    }
    this.direct.set(room, from);
    await this.recordDm(from, room);
    this.log('direct message recorded', { room });
  }

  // ── what a message means ─────────────────────────────────────────────────────
  private async onEvent(room: string, ev: SyncEvent): Promise<void> {
    const c = ev.content ?? {};
    if (ev.type !== 'm.room.message' || typeof ev.event_id !== 'string') return;
    if (c.msgtype !== 'm.text' || typeof c.body !== 'string' || !c.body.trim()) return; // notices are never answered: no loops
    const sender = String(ev.sender ?? '');
    const ts = Number(ev.origin_server_ts);
    if (!Number.isFinite(ts) || ts < this.startedAt) return void this.log('ignored — backlog from before this start', { event: ev.event_id });
    const who = await this.senderOf(sender);
    if (!who) return void this.log('ignored — sender not on the allowlist', { event: ev.event_id });
    if (!(await this.isDirect(room, sender))) return void this.log('ignored — not a 1:1 direct message', { event: ev.event_id });
    const fresh = await this.platform.db.query(
      `insert into neos.chat_client_events (event_id, account, room_id, direction, sender, sender_kind, user_id, outcome)
       values ($1,$2,$3,'inbound',$4,$5,$6,'received') on conflict do nothing`,
      [ev.event_id, this.cfg.account, room, sender, who.kind, who.kind === 'person' ? who.user.id : who.actsFor],
    );
    if (!fresh.rowCount) return; // once per event, ever
    await this.recordDm(sender, room);
    const body = stripReplyFallback(c.body).trim().slice(0, 8000);
    const inReplyTo: string | null = c['m.relates_to']?.['m.in_reply_to']?.event_id ?? null;
    if (who.kind === 'person') await this.fromPerson(ev.event_id, room, sender, who.user, body, inReplyTo);
    else await this.fromBridge(ev.event_id, room, sender, who.actsFor, body, c['neos.on_behalf_of'], inReplyTo);
  }

  private async fromPerson(eventId: string, room: string, sender: string, user: { id: string; company_id: string; role: string }, body: string, inReplyTo: string | null): Promise<void> {
    if (inReplyTo) {
      // A reply to a question shown in this person's own DM: their answer, in their words.
      if (await this.answerByReply(eventId, room, sender, { user_id: user.id }, body, inReplyTo)) return;
      // An answer binds to a card THIS account showed in THIS person's own recorded DM, and to its fingerprint.
      const card = (
        await this.platform.db.query<{ approval_id: string; fingerprint_shown: string }>(
          `select e.approval_id, e.fingerprint_shown from neos.chat_client_events e
             join neos.chat_dms d on d.account = e.account and d.room_id = e.room_id and d.peer = $4
            where e.event_id = $1 and e.account = $2 and e.room_id = $3 and e.direction = 'outbound' and e.approval_id is not null`,
          [inReplyTo, this.cfg.account, room, sender],
        )
      ).rows[0];
      if (card) {
        const d = parseDecision(body);
        if (!d) return this.replyNow(eventId, room, 'unclear_answer', 'Reply to the card with "yes", "no" or "change: <what to change>". Nothing was recorded.', { approval_id: card.approval_id });
        try {
          await this.platform.answer(card.approval_id, user, { decision: d.decision, fingerprint_seen: card.fingerprint_shown, feedback: d.feedback });
        } catch (e) {
          return this.replyNow(eventId, room, 'answer_refused', `That answer was not recorded: ${(e as Error).message}.`, { approval_id: card.approval_id });
        }
        const task = (await this.platform.db.query<{ task_id: string | null }>('select task_id from neos.approvals where id = $1', [card.approval_id])).rows[0]?.task_id ?? null;
        if (d.decision === 'yes' && task) return this.owe(eventId, `answered:${d.decision}`, task, { approval_id: card.approval_id, fingerprint: card.fingerprint_shown });
        const said: Record<string, string> = { yes: 'approved', no: 'declined', change: 'sent back with your changes', withdraw: 'withdrawn' };
        return this.replyNow(eventId, room, `answered:${d.decision}`, `Recorded: card ${card.approval_id.slice(0, 8)} ${said[d.decision]}.`, { approval_id: card.approval_id, fingerprint: card.fingerprint_shown });
      }
    } else if (await this.answerPlain(eventId, room, sender, { user_id: user.id }, body)) return;
    await this.ask(eventId, room, user.id, body);
  }

  private async fromBridge(eventId: string, room: string, bridge: string, actsFor: string | null, body: string, onBehalf: unknown, inReplyTo: string | null = null): Promise<void> {
    // A reply to a question shown in the bridge's OWN DM answers it — as relayed, untrusted data. An answer is not a yes.
    if (inReplyTo && (await this.answerByReply(eventId, room, bridge, { relay: `bridge:${bridge}` }, body, inReplyTo))) return;
    // A bridge's clear "no" to a card it was shown is taken for the person: caution may be added, never removed.
    if (await this.declineByBridge(eventId, room, bridge, body, inReplyTo)) return;
    // A bridge's "go ahead" is never a yes. If a card from its asks is open, say who must answer it.
    if (parseDecision(body)?.decision === 'yes' || CONSENT.test(body)) {
      const open = (
        await this.platform.db.query<{ id: string; card: any; task_id: string }>(
          `select a.id, a.card, a.task_id from neos.approvals a
            where a.status = 'PENDING' and a.company_id = $3 and a.app_key = $4
              and a.task_id in (select task_id from neos.chat_client_events where account = $1 and sender = $2 and task_id is not null)
            order by a.created_at desc limit 5`,
          [this.cfg.account, bridge, this.companyId, this.cfg.app],
        )
      ).rows;
      if (open.length) {
        const who = await this.personOf(open[0]!.task_id);
        const cards = open.map((a) => `card ${a.id.slice(0, 8)} (${clip(a.card?.what, 200)})`).join('; ');
        await this.platform.gateway.audit({ company_id: this.companyId, actor: `chat:${bridge}`, app_key: this.cfg.app, action: 'chat.bridge_consent', outcome: 'not_a_yes', detail: { event_id: eventId, approvals: open.map((a) => a.id) } });
        return this.replyNow(
          eventId,
          room,
          'bridge_consent_refused',
          `Nothing was done: a bridge cannot approve. ${cards} is waiting for a person's yes — ${who ? `${who.name} can answer it` : 'a person answers it'} on My Desk in NEOS${who?.dm ? ` or in their own DM with ${this.cfg.account}` : ''}.`,
          { approval_id: open[0]!.id },
        );
      }
    }
    // A plain next message may be the answer to the question this bridge's job asked here.
    if (!inReplyTo && (await this.answerPlain(eventId, room, bridge, { relay: `bridge:${bridge}` }, body))) return;
    // The ask is opened for a person: the one the message names (if linked here), else the bridge's own `acts_for`.
    let person = actsFor;
    if (typeof onBehalf === 'string' && /^@[^:]+:.+$/.test(onBehalf)) {
      const u = (await this.platform.db.query<{ id: string }>('select id from neos.users where matrix_user_id = $1 and company_id = $2', [onBehalf, this.companyId])).rows[0];
      if (u) person = u.id;
    }
    if (!person) return this.replyNow(eventId, room, 'no_person', `Nothing was done: ${bridge} relays for a person, and no person is on record for it at this company.`);
    await this.platform.db.query('update neos.chat_client_events set user_id = $2 where event_id = $1', [eventId, person]);
    await this.ask(eventId, room, person, body);
  }

  /**
   * A reply to a question notice this account showed in the sender's OWN recorded DM answers that question
   * (WP §8 `answer`): a person's words as theirs (via chat), a bridge's as relayed, untrusted data (via
   * bridge). Returns false when the reply is not to a question here (it is then handled as before).
   */
  private async answerByReply(eventId: string, room: string, sender: string, who: { user_id?: string; relay?: string }, body: string, inReplyTo: string): Promise<boolean> {
    const shown = (
      await this.platform.db.query<{ question_id: string }>(
        `select e.question_id from neos.chat_client_events e
           join neos.chat_dms d on d.account = e.account and d.room_id = e.room_id and d.peer = $4
          where e.event_id = $1 and e.account = $2 and e.room_id = $3 and e.direction = 'outbound' and e.question_id is not null`,
        [inReplyTo, this.cfg.account, room, sender],
      )
    ).rows[0];
    if (!shown) return false;
    const q = (await this.platform.db.query('select * from neos.questions where id = $1 and company_id = $2', [shown.question_id, this.companyId])).rows[0];
    if (!q) return false;
    await this.platform.db.query('update neos.chat_client_events set question_id = $2 where event_id = $1', [eventId, q.id]);
    const answers = answersFromText({ text: q.text, why: q.why, fields: q.fields }, body);
    if (!answers) {
      await this.replyNow(eventId, room, 'unclear_answer', `Reply with one line per answer, as key: value (${q.fields.map((f: any) => f.key).join(', ')}). Nothing was recorded.`);
      return true;
    }
    return this.recordAnswer(eventId, room, q, who, answers);
  }

  /**
   * A plain message (not a reply) in the sender's own DM answers the latest open question shown there for a
   * job the sender asked in that DM — when it reads as an answer (plainAnswers). With required fields left
   * out, one reply asks for them and nothing is recorded; no new job is opened. False: it is a new request.
   */
  private async answerPlain(eventId: string, room: string, sender: string, who: { user_id?: string; relay?: string }, body: string): Promise<boolean> {
    const q = (
      await this.platform.db.query(
        `select q.* from neos.questions q
          where q.company_id = $1 and q.status = 'OPEN'
            and exists (select 1 from neos.chat_client_events o where o.account = $2 and o.room_id = $3 and o.direction = 'outbound' and o.question_id = q.id)
            and exists (select 1 from neos.chat_client_events i where i.account = $2 and i.room_id = $3 and i.direction = 'inbound' and i.sender = $4
                          and i.task_id is not null and i.task_id in (q.task_id, q.root_task_id))
          order by q.created_at desc limit 1`,
        [this.companyId, this.cfg.account, room, sender],
      )
    ).rows[0];
    if (!q) return false;
    const read = plainAnswers({ fields: q.fields }, body);
    if (!read) return false;
    await this.platform.db.query('update neos.chat_client_events set question_id = $2 where event_id = $1', [eventId, q.id]);
    if (read.missing.length) {
      await this.replyNow(
        eventId,
        room,
        'unclear_answer',
        `To answer the question, also give ${read.missing.map((f) => `${f.key} (${f.label})`).join(', ')} — as key: value, one per line or separated by ";". Nothing was recorded.`,
      );
      return true;
    }
    return this.recordAnswer(eventId, room, q, who, read.answers);
  }

  private async recordAnswer(eventId: string, room: string, q: any, who: { user_id?: string; relay?: string }, answers: Record<string, string>): Promise<boolean> {
    try {
      await this.platform.answerQuestion(q.id, { company_id: this.companyId!, ...who }, answers, who.user_id ? 'chat' : 'bridge');
    } catch (e) {
      await this.replyNow(eventId, room, 'answer_refused', `That answer was not recorded: ${(e as Error).message}.`);
      return true;
    }
    // The reply this answer is owed is the job's next word: its result, a card, or another question.
    const task = q.root_task_id ?? q.task_id;
    if (task) await this.owe(eventId, who.user_id ? 'answered:question' : 'relayed:question', task);
    else await this.replyNow(eventId, room, 'answered:question', 'Recorded your answer.');
    return true;
  }

  /**
   * A bridge's clear decline of a card it was shown in its own DM — as a reply to that card, or naming its id —
   * is recorded as the person's "no", with the fingerprint shown there, via this bridge. True when handled.
   */
  private async declineByBridge(eventId: string, room: string, bridge: string, body: string, inReplyTo: string | null): Promise<boolean> {
    if (!DECLINE.test(body) || parseDecision(body)?.decision === 'yes') return false;
    const shown = (
      await this.platform.db.query<{ approval_id: string; fingerprint_shown: string; event_id: string; fingerprint: string; task_id: string | null }>(
        `select e.approval_id, e.fingerprint_shown, e.event_id, a.fingerprint, a.task_id
           from neos.chat_client_events e
           join neos.chat_dms d on d.account = e.account and d.room_id = e.room_id and d.peer = $3
           join neos.approvals a on a.id = e.approval_id
          where e.account = $1 and e.room_id = $2 and e.direction = 'outbound' and e.approval_id is not null
            and a.status = 'PENDING' and a.company_id = $4
          order by e.at desc`,
        [this.cfg.account, room, bridge, this.companyId],
      )
    ).rows;
    const hits = shown.filter((c) => (inReplyTo ? c.event_id === inReplyTo : body.toLowerCase().includes(c.approval_id.slice(0, 8).toLowerCase())));
    const named = [...new Map(hits.map((c) => [c.approval_id, c])).values()];
    if (named.length !== 1) return false; // not exactly one card it was shown: the job hears it as a request
    const card = named[0]!;
    if (card.fingerprint !== card.fingerprint_shown) {
      await this.replyNow(eventId, room, 'answer_refused', `That was not recorded: card ${card.approval_id.slice(0, 8)} changed after it was shown here.`, { approval_id: card.approval_id });
      return true;
    }
    const requester = card.task_id ? (await this.platform.db.query<{ requester: string }>('select requester from neos.tasks where id = $1', [card.task_id])).rows[0]?.requester : null;
    const person = requester?.startsWith('user:')
      ? (await this.platform.db.query<{ id: string; name: string; company_id: string }>('select id, name, company_id from neos.users where id = $1 and company_id = $2', [requester.slice(5), this.companyId])).rows[0]
      : undefined;
    if (!person) {
      await this.replyNow(eventId, room, 'no_person', `Nothing was recorded: no person is on record for card ${card.approval_id.slice(0, 8)}.`, { approval_id: card.approval_id });
      return true;
    }
    try {
      await this.platform.answer(card.approval_id, person, { decision: 'no', fingerprint_seen: card.fingerprint_shown, feedback: `declined via ${bridge} on behalf of ${person.name}` });
    } catch (e) {
      await this.replyNow(eventId, room, 'answer_refused', `That was not recorded: ${(e as Error).message}.`, { approval_id: card.approval_id });
      return true;
    }
    await this.platform.gateway.audit({
      company_id: this.companyId,
      actor: `chat:${bridge}`,
      app_key: this.cfg.app,
      action: 'chat.bridge_decline',
      outcome: 'recorded_no',
      detail: { event_id: eventId, approval_id: card.approval_id, fingerprint_seen: card.fingerprint_shown, on_behalf_of: person.id },
    });
    await this.replyNow(eventId, room, 'declined:bridge', `Recorded: card ${card.approval_id.slice(0, 8)} declined for ${person.name}, via ${bridge}. Nothing will be done.`, {
      approval_id: card.approval_id,
      fingerprint: card.fingerprint_shown,
    });
    return true;
  }

  /** The desk ask path: a task row and a signed tasks.open through the gateway, as the person. */
  private async ask(eventId: string, room: string, userId: string, text: string): Promise<void> {
    const installed = await this.platform.db.query("select 1 from neos.installs where company_id = $1 and app_key = $2 and status = 'active'", [this.companyId, this.cfg.app]);
    if (!installed.rowCount) return this.replyNow(eventId, room, 'not_installed', 'This app is not installed for your company. Nothing was done.');
    const root = this.platform.gateway.tracer.start('neos.chat', null, { 'neop.company': this.companyId! });
    let task: { task_id: string };
    try {
      task = await this.platform.openTask({ company_id: this.companyId!, app_key: this.cfg.app, requester: `user:${userId}`, ask: text, trace_parent: root.header() });
    } finally {
      root.end();
    }
    await this.owe(eventId, 'task_opened', task.task_id);
    this.log('task opened', { event: eventId, task: task.task_id });
  }

  private async personOf(taskId: string): Promise<{ name: string; dm: string | null; matrix: string | null } | null> {
    const t = (await this.platform.db.query<{ requester: string }>('select requester from neos.tasks where id = $1', [taskId])).rows[0];
    if (!t?.requester.startsWith('user:')) return null;
    const u = (await this.platform.db.query<{ name: string; matrix_user_id: string | null }>('select name, matrix_user_id from neos.users where id = $1', [t.requester.slice(5)])).rows[0];
    if (!u) return null;
    const allowed = u.matrix_user_id
      ? (await this.platform.db.query("select 1 from neos.chat_allowlist where company_id = $1 and app_key = $2 and matrix_id = $3 and kind = 'person'", [this.companyId, this.cfg.app, u.matrix_user_id])).rowCount
      : 0;
    return { name: u.name, matrix: u.matrix_user_id, dm: allowed && u.matrix_user_id ? await this.dmOf(u.matrix_user_id) : null };
  }

  // ── the one reply ───────────────────────────────────────────────────────────
  private async owe(eventId: string, outcome: string, taskId: string, extra: { approval_id?: string; fingerprint?: string } = {}): Promise<void> {
    await this.platform.db.query(
      `update neos.chat_client_events set outcome = $2, task_id = $3, approval_id = coalesce($4, approval_id), fingerprint_shown = coalesce($5, fingerprint_shown),
              reply_status = 'waiting', reply_due_at = now() + ($6 || ' milliseconds')::interval where event_id = $1 and reply_status = 'none'`,
      [eventId, outcome, taskId, extra.approval_id ?? null, extra.fingerprint ?? null, String(this.o.replyDeadlineMs)],
    );
  }

  private async replyNow(eventId: string, room: string, outcome: string, text: string, extra: { approval_id?: string; fingerprint?: string } = {}): Promise<void> {
    const claimed = await this.platform.db.query(
      `update neos.chat_client_events set outcome = $2, approval_id = coalesce($3, approval_id), fingerprint_shown = coalesce($4, fingerprint_shown),
              reply_status = 'sending', reply_text = $5 where event_id = $1 and reply_status = 'none'`,
      [eventId, outcome, extra.approval_id ?? null, extra.fingerprint ?? null, clip(text)],
    );
    if (claimed.rowCount) await this.deliver(eventId, room, clip(text), null);
  }

  /** Every owed reply whose task has settled (as the outbox reported it), or whose deadline passed. */
  async replyTick(): Promise<number> {
    if (this.replying || this.stopped) return 0;
    this.replying = true;
    let n = 0;
    try {
      const { rows } = await this.platform.db.query(
        `select e.event_id, e.room_id, e.sender_kind, e.task_id, e.at, e.reply_status, e.reply_text, e.reply_due_at <= now() as overdue,
                t.status as task_status, t.result
           from neos.chat_client_events e left join neos.tasks t on t.id = e.task_id
          where e.account = $1 and e.reply_status in ('waiting', 'sending') order by e.at limit 50`,
        [this.cfg.account],
      );
      for (const r of rows) {
        if (this.stopping) break;
        if (r.reply_status === 'sending') {
          await this.deliver(r.event_id, r.room_id, r.reply_text, null); // a resend after a crash: same txn id
          continue;
        }
        const settled = await this.settled(r);
        const text = settled?.text ?? (r.overdue ? FIXED_FAILURE : null);
        if (!text) continue;
        const claimed = await this.platform.db.query(`update neos.chat_client_events set reply_status = 'sending', reply_text = $2 where event_id = $1 and reply_status = 'waiting'`, [r.event_id, clip(text)]);
        if (!claimed.rowCount) continue;
        this.log('task settled', { event: r.event_id, task: r.task_id, status: r.task_status, fixed: text === FIXED_FAILURE });
        await this.deliver(r.event_id, r.room_id, clip(text), settled?.card ?? null, settled?.question ?? null);
        n++;
      }
      if (!this.stopping) n += await this.questionsTick();
    } finally {
      this.replying = false;
    }
    return n;
  }

  /** What the one reply says, from the typed result and the desk's own records — or null while still working. */
  private async settled(r: any): Promise<{ text: string; card?: { approval_id: string; fingerprint: string }; question?: string } | null> {
    if (r.task_status === 'COMPLETED') {
      const res = r.result ?? {};
      const lines = [clip(res.summary, 6000) || 'Done.'];
      if (res.could_not?.length) lines.push(`Could not: ${res.could_not.join('; ')}`);
      return { text: lines.join('\n') };
    }
    if (r.task_status === 'FAILED' || r.task_status === 'CANCELLED') return { text: FIXED_FAILURE };
    // A card raised by this task since the message: the reply states what is proposed; only a person may say yes.
    const a = (
      await this.platform.db.query('select * from neos.approvals where task_id = $1 and status = $2 and created_at >= $3 order by created_at desc limit 1', [r.task_id, 'PENDING', r.at])
    ).rows[0];
    if (a) {
      const shown = { card: a.card, args: a.args, expires_at: new Date(a.expires_at).toISOString(), fingerprint: a.fingerprint } as unknown as ProposalCreatedPayload;
      if (r.sender_kind === 'person') return { text: roomText.card(this.appName, shown), card: { approval_id: a.id, fingerprint: a.fingerprint } };
      const who = await this.personOf(a.task_id);
      if (who?.dm) await this.showCard(who.dm, a.id, a.fingerprint, roomText.card(this.appName, shown));
      return {
        // Recorded as shown to the bridge (with its fingerprint), so its clear "no" can bind to it — never a yes.
        card: { approval_id: a.id, fingerprint: a.fingerprint },
        text: [
          `${this.appName} proposes: ${clip(a.card?.what, 1000)}`,
          `What changes: ${clip(a.card?.changes, 1000)}`,
          `Nothing is done yet. It awaits a person's approval — a bridge cannot approve it: ${who ? who.name : 'a person'} can say yes on My Desk in NEOS (card ${String(a.id).slice(0, 8)})${who?.dm ? ` or in their own DM with ${this.cfg.account}` : ''}. To drop it instead, reply "no" to this message.`,
        ].join('\n'),
      };
    }
    // A question the job (or an app it handed work to) asked since the message: the reply IS the question,
    // and a reply to it answers it. A bridge's ask also puts it in the person's own DM.
    const qn = (
      await this.platform.db.query("select * from neos.questions where (task_id = $1 or root_task_id = $1) and status = 'OPEN' and created_at >= $2 order by created_at desc limit 1", [r.task_id, r.at])
    ).rows[0];
    if (qn) {
      const body = roomText.question(qn.app_key === this.cfg.app ? this.appName : qn.app_key, { text: qn.text, why: qn.why, fields: qn.fields, due_at: new Date(qn.due_at).toISOString() });
      if (r.sender_kind !== 'person') {
        const who = await this.personOf(qn.root_task_id ?? r.task_id);
        if (who?.dm) await this.showQuestion(who.dm, qn.id, body);
      }
      return { text: body, question: qn.id };
    }
    const q = (
      await this.platform.db.query<{ body: string }>("select body from neos.conversation_messages where task_id = $1 and kind = 'card' and body like 'Question:%' and at >= $2 order by id desc limit 1", [r.task_id, r.at])
    ).rows[0];
    if (q) return { text: q.body };
    return null;
  }

  /** Show a question in a DM, so a reply to it answers it. Once per question and room (txn id). */
  private async showQuestion(room: string, questionId: string, body: string): Promise<void> {
    try {
      const event_id = await this.http.send(room, { msgtype: 'm.notice', body: clip(body) }, `question-${questionId}`);
      await this.platform.db.query(
        `insert into neos.chat_client_events (event_id, account, room_id, direction, sender, question_id, outcome) values ($1,$2,$3,'outbound',$2,$4,'question') on conflict do nothing`,
        [event_id, this.cfg.account, room, questionId],
      );
    } catch (e: any) {
      if (e?.fatal) return void (await this.halt('token_rejected', { status: e.status, errcode: e.errcode }));
      this.log('question could not be shown in the DM', { question: questionId, e: String(e?.message ?? e).slice(0, 200) });
    }
  }

  /**
   * Questions from jobs that were not asked through this account (the desk, NeuralChat): put to the
   * person they are asked of, in that person's own recorded DM — once.
   */
  async questionsTick(): Promise<number> {
    const { rows } = await this.platform.db.query(
      `select q.*, d.room_id from neos.questions q
         join neos.users u on u.id = q.asked_of
         join neos.chat_allowlist l on l.company_id = q.company_id and l.app_key = $2 and l.matrix_id = u.matrix_user_id and l.kind = 'person'
         join neos.chat_dms d on d.account = $1 and d.peer = u.matrix_user_id
        where q.company_id = $3 and q.app_key = $2 and q.status = 'OPEN'
          and not exists (select 1 from neos.chat_client_events e where e.account = $1 and e.direction = 'inbound' and e.task_id in (q.task_id, q.root_task_id))
          and not exists (select 1 from neos.chat_client_events e where e.account = $1 and e.room_id = d.room_id and e.question_id = q.id and e.direction = 'outbound')
        order by q.created_at limit 20`,
      [this.cfg.account, this.cfg.app, this.companyId],
    );
    for (const q of rows) {
      if (this.stopping) break;
      await this.showQuestion(q.room_id, q.id, roomText.question(this.appName, { text: q.text, why: q.why, fields: q.fields, due_at: new Date(q.due_at).toISOString() }));
    }
    return rows.length;
  }

  /** Show a card in a person's own recorded DM, so their reply to it can bind to its fingerprint. */
  private async showCard(room: string, approvalId: string, fingerprint: string, body: string): Promise<void> {
    try {
      const event_id = await this.http.send(room, { msgtype: 'm.notice', body: clip(body) }, `card-${approvalId}`);
      await this.platform.db.query(
        `insert into neos.chat_client_events (event_id, account, room_id, direction, sender, approval_id, fingerprint_shown, outcome) values ($1,$2,$3,'outbound',$2,$4,$5,'card') on conflict do nothing`,
        [event_id, this.cfg.account, room, approvalId, fingerprint],
      );
    } catch (e: any) {
      if (e?.fatal) return void (await this.halt('token_rejected', { status: e.status, errcode: e.errcode }));
      this.log('card could not be shown in the person’s DM', { approval: approvalId, e: String(e?.message ?? e).slice(0, 200) });
    }
  }

  private async deliver(eventId: string, room: string, text: string, card: { approval_id: string; fingerprint: string } | null, question: string | null = null): Promise<void> {
    const content = { msgtype: 'm.notice', body: text, 'm.relates_to': { 'm.in_reply_to': { event_id: eventId } } };
    try {
      const sent = await this.http.send(room, content, replyTxnId(eventId));
      await this.platform.db.query(`update neos.chat_client_events set reply_status = 'sent', reply_event_id = $2, replied_at = now() where event_id = $1`, [eventId, sent]);
      if (card) {
        await this.platform.db.query(
          `insert into neos.chat_client_events (event_id, account, room_id, direction, sender, approval_id, fingerprint_shown, outcome) values ($1,$2,$3,'outbound',$2,$4,$5,'card') on conflict do nothing`,
          [sent, this.cfg.account, room, card.approval_id, card.fingerprint],
        );
      }
      if (question) {
        await this.platform.db.query(
          `insert into neos.chat_client_events (event_id, account, room_id, direction, sender, question_id, outcome) values ($1,$2,$3,'outbound',$2,$4,'question') on conflict do nothing`,
          [sent, this.cfg.account, room, question],
        );
      }
      this.log('replied', { event: eventId, fixed: text === FIXED_FAILURE });
    } catch (e: any) {
      if (e?.fatal) return void (await this.halt('token_rejected', { status: e.status, errcode: e.errcode }));
      this.log('reply not sent yet — will retry with the same transaction', { event: eventId, status: e?.status });
    }
  }
}

/** Start one client per configured account (MATRIX_MODE=client). */
export async function startChatClients(platform: Platform, cfg: ChatClientsConfig): Promise<ChatClient[]> {
  const clients: ChatClient[] = [];
  for (const a of cfg.accounts) {
    // One bad account (no token file yet, no such install) never takes the platform down with it.
    try {
      const c = new ChatClient(platform, a, cfg);
      await c.start();
      clients.push(c);
    } catch (e) {
      cfg.log?.('chat-client: not started', { account: a.account, e: String((e as Error).message ?? e).slice(0, 200) });
    }
  }
  return clients;
}
