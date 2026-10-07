// NEURALCHAT'S MATRIX TOOL · v3 S5 (WP v3 §1 steps 3–8, §7, §8, §12). The only way out of the reasoning agent to an
// app that runs with NEOP presence (S4): NeuralChat has its own Matrix identity per company — @neuralchat_<slug> on
// the appservice road (the platform's registration reserves @neuralchat_.*), or an ordinary account configured per
// company on the client road (MATRIX_NEURALCHAT_ACCOUNTS) — and, as itself:
//
//   out  posts a typed neos.neop.task in the app's room (appservice) or its 1:1 room with the app's account (client),
//        the thread rooted at that event. The body carries the person it is for (their Matrix id, or — for a person
//        with none — a name in NeuralChat's own namespace the app's `people` rows map to them), the ask, files BY
//        REFERENCE (contracts readTaskFields: the file is uploaded to the homeserver's media store and the event
//        carries its mxc:// URI with the sha256 and size; no bytes in events), the job a follow-up continues, and the trace. txnId `nc-task-<task>`: a resend is the same event (the homeserver's
//        txn dedupe), and the app dedupes on event_id and task_id (S4) — a job is opened once.
//        answers a question the app asked in the thread with a typed neos.neop.answer — the person's own reply in
//        Conversations, relayed (the app records it as relayed, untrusted data). It NEVER sends neos.neop.approve:
//        a person approves on the desk (answer_proposal) or as themselves in their own room.
//   in   reads the app's typed note / ask / propose / done in that thread (once per event_id, from the app's own
//        Matrix name only, bodies validated) into Conversations and neos.tasks — its own task store.
//
// v3 S9: this is the only road. An app with no Matrix name in its install row (or no bound room on the appservice
// road), or a company where NeuralChat has no identity, is not reachable: the task fails, saying why.

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import {
  isTypedEventType,
  maySend,
  parseTraceparent,
  shortType,
  taskFileField,
  TASK_PARENT_FIELD,
  threadRelation,
  threadRootOf,
  typedContent,
  validateTypedBody,
  type TaskResult,
  type TypedBodies,
} from '@neop/contracts';
import { tx } from '@neop/pgkit';
import { roomText } from './format.ts';
import type { Platform, TaskAttachment } from './platform.ts';

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text?(): Promise<string> }>;

export interface NeuralChatAccount {
  /** The company, by id or slug. */
  company: string;
  /** The account's Matrix id (checked against whoami at start); omitted: whatever whoami says. */
  account?: string;
  token?: string;
  tokenFile?: string;
}

export type NeuralChatMatrixConfig =
  | { road: 'appservice'; homeserverUrl: string; serverName: string; asToken: string; hsToken: string; fetchImpl?: FetchLike }
  | { road: 'client'; homeserverUrl: string; accounts: NeuralChatAccount[]; fetchImpl?: FetchLike; syncTimeoutMs?: number };

export interface NeuralChatOptions {
  log?: (m: string, e?: Record<string, unknown>) => void;
  /** How long the ask waits for the app's "on it" before answering (default 3 s): the ask stays quick either way. */
  ackWaitMs?: number;
  /** Past this, a task the app never acknowledged fails visibly (default 10 min). */
  deliveryWindowMs?: number;
  /** How long an answer waits for the app's typed ask to have been read in the thread (default 15 s). */
  askWaitMs?: number;
}

/** A NeuralChat name for a person with no Matrix id of their own: in NeuralChat's exclusive namespace, never a sender. */
export function personName(slug: string, userId: string, server: string): string {
  return `@neuralchat_${slug}_person_${userId.replace(/-/g, '')}:${server}`;
}

const serverOf = (mxid: string) => mxid.split(':').slice(1).join(':');
const SAFE = /[^A-Za-z0-9._~-]/g;
const txnSafe = (s: string) => s.replace(SAFE, '_').slice(0, 255);
const clip = (s: unknown, n: number) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

interface Route {
  road: 'appservice' | 'client';
  /** NeuralChat's own name here. */
  account: string;
  /** The app's Matrix name at the company. */
  peer: string;
  /** Where the task is posted (appservice: the app's first room; client: our 1:1 room with it, made on first use). */
  room: string | null;
}

interface ClientAccount {
  cfg: NeuralChatAccount;
  account: string | null;
  companyId: string | null;
  token: string;
  running: boolean;
  stopped: string | null;
  abort: AbortController | null;
  loop: Promise<void> | null;
}

export class NeuralChatMatrix {
  readonly platform: Platform;
  readonly cfg: NeuralChatMatrixConfig;
  readonly opts: NeuralChatOptions;
  private readonly joined = new Set<string>();
  private readonly clients: ClientAccount[] = [];
  private stopping = false;

  constructor(platform: Platform, cfg: NeuralChatMatrixConfig, opts: NeuralChatOptions = {}) {
    this.platform = platform;
    this.cfg = cfg;
    this.opts = opts;
    if (cfg.road === 'client') for (const a of cfg.accounts) this.clients.push(this.clientOf(a));
  }

  private clientOf(a: NeuralChatAccount): ClientAccount {
    const token = a.token ?? (a.tokenFile ? readFileSync(a.tokenFile, 'utf8').trim() : '');
    return { cfg: a, account: a.account ?? null, companyId: null, token, running: false, stopped: null, abort: null, loop: null };
  }

  private log(m: string, e?: Record<string, unknown>): void {
    (this.opts.log ?? ((x, y) => this.platform.log(x, y)))(`neuralchat: ${m}`, e);
  }

  private get fetch(): FetchLike {
    return this.cfg.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  // ── the homeserver ──────────────────────────────────────────────────────────
  private async mx<T = any>(method: string, path: string, body: unknown, auth: { token: string; asUser?: string }, signal?: AbortSignal): Promise<T> {
    const base = this.cfg.homeserverUrl.replace(/\/$/, '');
    const url = `${base}${path}${auth.asUser ? `${path.includes('?') ? '&' : '?'}user_id=${encodeURIComponent(auth.asUser)}` : ''}`;
    const res = await this.fetch(url, {
      method,
      headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`homeserver answered ${res.status} ${(j as any)?.errcode ?? ''} for ${method} ${path.split('?')[0]}`), { status: res.status, errcode: (j as any)?.errcode });
    return j as T;
  }

  private authFor(account: string): { token: string; asUser?: string } {
    if (this.cfg.road === 'appservice') return { token: this.cfg.asToken, asUser: account };
    const c = this.clients.find((x) => x.account === account);
    if (!c) throw new Error(`no NeuralChat client account ${account}`);
    return { token: c.token };
  }

  /** Appservice road: register our name (idempotent) and join the room once per process. */
  private async ensureJoined(room: string, account: string): Promise<void> {
    if (this.cfg.road !== 'appservice' || this.joined.has(`${account}|${room}`)) return;
    const auth = { token: this.cfg.asToken };
    await this.mx('POST', '/_matrix/client/v3/register', { type: 'm.login.application_service', username: account.slice(1).split(':')[0] }, auth).catch((e) => {
      if (e.errcode !== 'M_USER_IN_USE') throw e;
    });
    await this.mx('POST', `/_matrix/client/v3/join/${encodeURIComponent(room)}`, {}, { token: this.cfg.asToken, asUser: account });
    this.joined.add(`${account}|${room}`);
  }

  private async sendEvent(account: string, room: string, type: string, content: Record<string, unknown>, txn: string): Promise<string> {
    const r = await this.mx<{ event_id: string }>('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/${encodeURIComponent(type)}/${encodeURIComponent(txnSafe(txn))}`, content, this.authFor(account));
    return r.event_id;
  }

  // ── who and where ──────────────────────────────────────────────────────────
  /** NeuralChat's own Matrix name at a company, or null (no identity there: nothing can be handed to an app). */
  async identityFor(companyId: string): Promise<string | null> {
    if (this.cfg.road === 'appservice') {
      const slug = (await this.platform.db.query<{ slug: string }>('select slug from neos.companies where id = $1', [companyId])).rows[0]?.slug;
      return slug ? `@neuralchat_${slug}:${this.cfg.serverName}` : null;
    }
    const c = this.clients.find((x) => x.companyId === companyId && x.account && x.running);
    return c?.account ?? null;
  }

  /** Is this one of NeuralChat's own names (an echo)? */
  isOurs(mxid: string): boolean {
    if (this.cfg.road === 'appservice') return /^@neuralchat_[^:]+:/.test(mxid) && serverOf(mxid) === this.cfg.serverName;
    return this.clients.some((c) => c.account === mxid);
  }

  /**
   * v3 S5 · how a task reaches this app at this company: through Matrix — the app's install row names its Matrix user
   * and NeuralChat has an identity here; null → the app cannot be reached (v3 S9: there is no other road).
   */
  async routeFor(companyId: string, app: string): Promise<Route | null> {
    const account = await this.identityFor(companyId);
    if (!account) return null;
    const id = await this.platform.boards.readChatIdentity(app, companyId).catch(() => null);
    if (!id?.matrix_user) return null;
    if (this.cfg.road === 'appservice') {
      const room = id.room_ids?.[0];
      // On the appservice road the app hears only its bound rooms: with none, Matrix cannot reach it yet.
      if (!room) return null;
      return { road: 'appservice', account, peer: id.matrix_user, room };
    }
    const r = (await this.platform.db.query<{ room_id: string }>('select room_id from neos.neuralchat_rooms where company_id = $1 and app_key = $2 and account = $3 and peer = $4', [companyId, app, account, id.matrix_user])).rows[0];
    return { road: 'client', account, peer: id.matrix_user, room: r?.room_id ?? null };
  }

  /** The Matrix id a person is named by in a task: their own, else NeuralChat's name for them (the app's people rows map it). */
  async personMxid(companyId: string, userId: string, account: string): Promise<string | null> {
    const u = (await this.platform.db.query<{ matrix_user_id: string | null; slug: string }>('select u.matrix_user_id, c.slug from neos.users u join neos.companies c on c.id = u.company_id where u.id = $1 and u.company_id = $2', [userId, companyId])).rows[0];
    if (!u) return null;
    return u.matrix_user_id ?? personName(u.slug, userId, serverOf(account));
  }

  /** What syncChat writes into each app's schema for NeuralChat at a company: its name, and a name for every person without one. */
  async directoryFor(companyId: string): Promise<{ agent: string | null; people: { matrix_id: string; user_id: string; name: string; role: string }[] }> {
    const agent = await this.identityFor(companyId);
    if (!agent) return { agent: null, people: [] };
    const rows = (await this.platform.db.query<{ id: string; name: string; role: string; slug: string }>('select u.id, u.name, u.role, c.slug from neos.users u join neos.companies c on c.id = u.company_id where u.company_id = $1 and u.matrix_user_id is null', [companyId])).rows;
    return { agent, people: rows.map((u) => ({ matrix_id: personName(u.slug, u.id, serverOf(agent)), user_id: u.id, name: u.name, role: u.role })) };
  }

  // ── out: the task ───────────────────────────────────────────────────────────
  /** Client road: our 1:1 room with the app's account, made (and recorded) on first use. */
  private async ensureRoom(companyId: string, app: string, route: Route): Promise<string> {
    if (route.room) return route.room;
    const made = await this.mx<{ room_id: string }>('POST', '/_matrix/client/v3/createRoom', { preset: 'trusted_private_chat', is_direct: true, invite: [route.peer] }, this.authFor(route.account));
    const r = await this.platform.db.query<{ room_id: string }>(
      `insert into neos.neuralchat_rooms (company_id, app_key, account, peer, room_id) values ($1,$2,$3,$4,$5)
       on conflict (company_id, app_key, account) do update set peer = excluded.peer, room_id = case when neos.neuralchat_rooms.peer = excluded.peer then neos.neuralchat_rooms.room_id else excluded.room_id end
       returning room_id`,
      [companyId, app, route.account, route.peer, made.room_id],
    );
    return r.rows[0]!.room_id;
  }

  /**
   * v3 S9 · a file attached to a task goes to the homeserver's media store (as NeuralChat), and the task event carries
   * its mxc:// URI with the sha256 and size — the app downloads it from its own homeserver with its own token and
   * checks both. The platform serves no file to anyone. Returns the content URI.
   */
  private async uploadMedia(account: string, a: TaskAttachment, bytes: Buffer): Promise<string> {
    const base = this.cfg.homeserverUrl.replace(/\/$/, '');
    const auth = this.authFor(account);
    const url = `${base}/_matrix/media/v3/upload?filename=${encodeURIComponent(a.filename)}${auth.asUser ? `&user_id=${encodeURIComponent(auth.asUser)}` : ''}`;
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth.token}`, 'content-type': a.content_type ?? 'application/octet-stream' },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(60_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || typeof (j as any)?.content_uri !== 'string' || !/^mxc:\/\/[^/\s]+\/[A-Za-z0-9_-]+$/.test((j as any).content_uri)) {
      throw Object.assign(new Error(`homeserver refused the upload of ${a.filename} (${res.status} ${(j as any)?.errcode ?? ''})`), { status: res.status });
    }
    return (j as any).content_uri as string;
  }

  /**
   * Post the task (idempotent: txnId nc-task-<task>, so a resend after a failure is the same event). Records where and
   * as whom; the status stays OPEN until the app's "on it" arrives in the thread. Throws when the homeserver refused.
   */
  async deliver(taskId: string): Promise<string> {
    const t = (await this.platform.db.query('select * from neos.tasks where id = $1', [taskId])).rows[0];
    if (!t) throw new Error('no such task');
    if (t.matrix_event_id) return t.matrix_event_id;
    const route = await this.routeFor(t.company_id, t.app_key);
    if (!route) throw Object.assign(new Error(`${t.app_key} is not reachable in Matrix for this company any more`), { final: true });
    // The app must know NeuralChat's name (an agent sender) and the person by the name the task gives them before it
    // hears anything (written through as the desk) — before an invite, too.
    await this.platform.syncChat(t.company_id, t.app_key).catch((e) => this.log('chat directory not written through', { e: String(e) }));
    const room = route.road === 'client' ? await this.ensureRoom(t.company_id, t.app_key, route) : route.room!;
    if (route.road === 'appservice') await this.ensureJoined(room, route.account);
    const person = t.requester.startsWith('user:') ? await this.personMxid(t.company_id, t.requester.slice(5), route.account) : null;
    if (!person) throw Object.assign(new Error('nobody on record to ask for'), { final: true });
    const slug = (await this.platform.db.query<{ slug: string }>('select slug from neos.companies where id = $1', [t.company_id])).rows[0]!.slug;
    const fields: Record<string, string> = {};
    const files = (t.attachments ?? []) as TaskAttachment[];
    for (const [i, a] of files.entries()) {
      const bytes = Buffer.from(a.content_base64, 'base64');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const link = await this.uploadMedia(route.account, a, bytes);
      const [k, v] = taskFileField(i + 1, { id: `${t.id}/${i + 1}`, filename: a.filename, ...(a.content_type ? { content_type: a.content_type } : {}), sha256, bytes: bytes.length, link });
      fields[k] = v;
    }
    if (t.parent_job_id) fields[TASK_PARENT_FIELD] = t.parent_job_id;
    const body: TypedBodies['neos.neop.task'] = {
      task_id: t.id,
      company: slug,
      on_behalf_of: person,
      text: clip(t.ask, 8000),
      ...(Object.keys(fields).length ? { fields } : {}),
      ...(parseTraceparent(t.trace_parent) ? { trace: t.trace_parent } : {}),
    };
    const txn = t.matrix_txn ?? `nc-task-${t.id}`;
    await this.platform.db.query('update neos.tasks set matrix_room = $2, matrix_account = $3, matrix_txn = $4, updated_at = now() where id = $1', [t.id, room, route.account, txn]);
    const span = this.platform.tracer.start('neuralchat.task', t.trace_parent ?? null, { 'neop.app': t.app_key, 'neop.task': t.id });
    let eventId: string;
    try {
      eventId = await this.sendEvent(route.account, room, 'neos.neop.task', typedContent('neos.neop.task', body, `Task for ${t.app_key} from NeuralChat: ${clip(t.ask, 1000)}`, null), txn);
    } finally {
      span.end();
    }
    await this.platform.db.query('update neos.tasks set matrix_event_id = $2, delivered_at = now(), last_error = null, updated_at = now() where id = $1', [t.id, eventId]);
    await this.platform.audit({ company_id: t.company_id, actor: `chat:${route.account}`, app_key: t.app_key, action: 'neuralchat.task_posted', outcome: 'posted', detail: { task_id: t.id, room_id: room, event_id: eventId, files: files.length } });
    this.log('task posted', { task: t.id, room, event: eventId });
    return eventId;
  }

  /** Wait a moment for the app's "on it" (the ask answers quickly either way). */
  async waitAck(taskId: string): Promise<void> {
    const until = Date.now() + (this.opts.ackWaitMs ?? 3_000);
    while (Date.now() < until) {
      const s = (await this.platform.db.query<{ status: string; job_id: string | null }>('select status, job_id from neos.tasks where id = $1', [taskId])).rows[0];
      if (!s || s.job_id || s.status !== 'OPEN') return;
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  /** A person's answer, relayed as a typed answer in the task's thread (the app's book records it as relayed data). */
  async sendAnswer(taskId: string, waitId: string, answers: Record<string, unknown>): Promise<void> {
    const t = (await this.platform.db.query("select * from neos.tasks where id = $1 and road = 'matrix'", [taskId])).rows[0];
    if (!t?.matrix_event_id || !t.matrix_room || !t.matrix_account) throw new Error('this task has no Matrix thread');
    // The app takes an answer only to a question it has asked in this thread: the question can be on the desk (the app's
    // own wait) a moment before its typed ask is posted — wait for NeuralChat to have read that ask.
    const until = Date.now() + (this.opts.askWaitMs ?? 15_000);
    while (!(await this.platform.db.query("select 1 from neos.neuralchat_events where task_id = $1 and type = 'neos.neop.ask' and detail->>'wait_id' = $2", [taskId, waitId])).rowCount) {
      if (Date.now() > until) {
        this.log('answer sent before the ask was read in the thread', { task: taskId, wait: waitId });
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const body: TypedBodies['neos.neop.answer'] = { wait_id: waitId, answers: answers as TypedBodies['neos.neop.answer']['answers'], ...(parseTraceparent(t.trace_parent) ? { trace: t.trace_parent } : {}) };
    const digest = createHash('sha256').update(JSON.stringify(answers)).digest('hex').slice(0, 16);
    const text = `Answer from NeuralChat: ${Object.entries(answers).map(([k, v]) => `${k}: ${String(v)}`).join('; ')}`;
    await this.sendEvent(t.matrix_account, t.matrix_room, 'neos.neop.answer', { ...typedContent('neos.neop.answer', body, clip(text, 2000), null), 'm.relates_to': threadRelation(t.matrix_event_id) }, `nc-answer-${waitId}-${digest}`);
    await this.platform.audit({ company_id: t.company_id, actor: `chat:${t.matrix_account}`, app_key: t.app_key, action: 'neuralchat.answer_posted', outcome: 'posted', detail: { task_id: t.id, wait_id: waitId } });
  }

  // ── in: the app's thread ────────────────────────────────────────────────────
  /**
   * One event from the homeserver (appservice transaction or /sync). Returns true when it belonged to one of
   * NeuralChat's threads (handled or deduped), false when it is none of NeuralChat's business.
   */
  async onEvent(ev: { event_id: string; room_id: string; sender: string; type: string; content: any }): Promise<boolean> {
    if (!isTypedEventType(ev.type) || typeof ev.event_id !== 'string') return false;
    if (this.isOurs(ev.sender)) return true; // our own echo
    const root = threadRootOf(ev.content);
    if (!root) return false;
    const t = (await this.platform.db.query("select * from neos.tasks where road = 'matrix' and matrix_room = $1 and matrix_event_id = $2", [ev.room_id, root])).rows[0];
    if (!t) return false;
    const claimed = await this.platform.db.query(
      `insert into neos.neuralchat_events (event_id, company_id, task_id, room_id, sender, type) values ($1,$2,$3,$4,$5,$6) on conflict (event_id) do nothing returning 1`,
      [ev.event_id, t.company_id, t.id, ev.room_id, ev.sender, ev.type],
    );
    if (!claimed.rowCount) return true; // Matrix redelivered it
    const outcome = await this.read(t, ev).catch((e) => {
      this.log('event not applied', { event: ev.event_id, e: String(e?.message ?? e) });
      return `error:${String(e?.message ?? e).slice(0, 200)}`;
    });
    await this.platform.db.query('update neos.neuralchat_events set outcome = $2 where event_id = $1', [ev.event_id, outcome]);
    return true;
  }

  private async read(t: any, ev: { event_id: string; room_id: string; sender: string; type: string; content: any }): Promise<string> {
    const id = await this.platform.boards.readChatIdentity(t.app_key, t.company_id).catch(() => null);
    // Only the app itself speaks in its thread for it: anyone else's words there are not the app's.
    if (!id?.matrix_user || ev.sender !== id.matrix_user) return 'not_the_app';
    const type = ev.type as keyof TypedBodies;
    if (!maySend('neop', type)) return `refused:${shortType(type)}`;
    const v = validateTypedBody(type, ev.content);
    if (!v.ok) return `invalid:${v.error}`;
    const span = this.platform.tracer.start(`neuralchat.read ${shortType(type)}`, t.trace_parent ?? null, { 'neop.app': t.app_key, 'neop.task': t.id });
    try {
      const appName = (await this.platform.db.query<{ name: string }>("select manifest->>'name' as name from neos.apps where key = $1", [t.app_key])).rows[0]?.name ?? t.app_key;
      const author = `app:${t.app_key}`;
      switch (type) {
        case 'neos.neop.note': {
          const b = v.body as TypedBodies['neos.neop.note'];
          if (b.step_id === 'ack') {
            await tx(this.platform.db, async (c) => {
              const u = await c.query(
                `update neos.tasks set job_id = coalesce(job_id, $2::uuid), status = case when status = 'OPEN' then 'ACKNOWLEDGED' else status end, attachments = null, updated_at = now()
                  where id = $1 and job_id is null returning 1`,
                [t.id, b.job_id],
              );
              if (u.rowCount) await this.platform.say(t.conversation_id, t.company_id, author, `On it — ${appName} job ${b.job_id.slice(0, 8)}.`, 'ack', t.id, c);
            });
            return 'note:ack';
          }
          if (b.step_id.startsWith('stale-')) {
            await this.platform.say(t.conversation_id, t.company_id, author, clip(ev.content?.body ?? b.text, 2000), 'notice', t.id);
            return 'note:stale';
          }
          await this.platform.say(t.conversation_id, t.company_id, author, `· ${clip(b.text, 2000)}`, 'step', t.id);
          await this.settleStatus(t);
          return 'note';
        }
        case 'neos.neop.ask': {
          const b = v.body as TypedBodies['neos.neop.ask'];
          await this.platform.say(t.conversation_id, t.company_id, author, roomText.question(appName, { text: b.question.text, why: b.question.why, fields: b.question.fields as any, due_at: b.due }), 'card', t.id);
          await this.platform.db.query(`update neos.tasks set status = 'NEEDS_INPUT', updated_at = now() where id = $1 and status in ('OPEN', 'ACKNOWLEDGED', 'WAITING')`, [t.id]);
          await this.platform.db.query('update neos.neuralchat_events set detail = $2 where event_id = $1', [ev.event_id, JSON.stringify({ wait_id: b.wait_id })]);
          return 'ask';
        }
        case 'neos.neop.propose': {
          const b = v.body as TypedBodies['neos.neop.propose'];
          const card = await this.platform.boards
            .deskRead(t.company_id, async (c) => (await c.query<{ card: any }>('select card from neos.v_desk_cards where app_key = $1 and proposal_id::text = $2', [t.app_key, b.proposal_id])).rows[0])
            .catch(() => undefined);
          const what = card?.card?.what ?? clip(String(b.text).split('\n')[0]!.replace(/^.*? asks first — /, ''), 500);
          await this.platform.say(t.conversation_id, t.company_id, author, `Waiting for a yes on your desk: ${what}`, 'waiting', t.id);
          await this.platform.db.query(`update neos.tasks set status = 'WAITING', updated_at = now() where id = $1 and status in ('OPEN', 'ACKNOWLEDGED', 'NEEDS_INPUT')`, [t.id]);
          return 'propose';
        }
        case 'neos.neop.done': {
          const b = v.body as TypedBodies['neos.neop.done'];
          const r = b.result as Partial<TaskResult>;
          const result: TaskResult = {
            outcome: (['done', 'failed', 'blocked', 'needs_input', 'cancelled'] as const).includes(r.outcome as any) ? (r.outcome as TaskResult['outcome']) : 'done',
            summary: clip(r.summary ?? 'Done.', 8000),
            changed: Array.isArray(r.changed) ? r.changed.map(String) : [],
            could_not: b.could_not,
            sources: Array.isArray(r.sources) ? r.sources.map(String) : [],
          };
          const status = result.outcome === 'cancelled' ? 'CANCELLED' : result.outcome === 'failed' ? 'FAILED' : 'COMPLETED';
          await tx(this.platform.db, async (c) => {
            const u = await c.query(`update neos.tasks set status = case when status = 'CANCELLED' then status else $2 end, result = $3, job_id = coalesce(job_id, $4::uuid), attachments = null, updated_at = now() where id = $1 and result is null returning 1`, [t.id, status, JSON.stringify(result), b.job_id]);
            if (!u.rowCount) return;
            await this.platform.say(t.conversation_id, t.company_id, author, result.summary, 'result', t.id, c);
          });
          return 'done';
        }
        default:
          return `info:${shortType(type)}`; // a task or an answer from the app in our thread: not work for NeuralChat
      }
    } finally {
      span.end();
    }
  }

  /** After a step: the task is WAITING while a card is pending, NEEDS_INPUT while a question is open, else working. */
  private async settleStatus(t: any): Promise<void> {
    const cur = (await this.platform.db.query<{ status: string; job_id: string | null }>('select status, job_id from neos.tasks where id = $1', [t.id])).rows[0];
    if (!cur?.job_id || !['WAITING', 'NEEDS_INPUT'].includes(cur.status)) return;
    const open = await this.platform.boards
      .deskRead(t.company_id, async (c) => ({
        cards: (await c.query("select 1 from neos.v_desk_cards where app_key = $1 and job_id = $2 and status = 'PENDING' limit 1", [t.app_key, cur.job_id])).rowCount,
        questions: (await c.query('select 1 from neos.v_open_questions where app_key = $1 and job_id = $2 limit 1', [t.app_key, cur.job_id])).rowCount,
      }))
      .catch(() => null);
    if (!open) return;
    const next = open.cards ? 'WAITING' : open.questions ? 'NEEDS_INPUT' : 'ACKNOWLEDGED';
    if (next !== cur.status) await this.platform.db.query(`update neos.tasks set status = $2, updated_at = now() where id = $1 and status = $3`, [t.id, next, cur.status]);
  }

  // ── the worker ──────────────────────────────────────────────────────────────
  /**
   * Resend what the homeserver did not take (same txnId: never a second event), and fail visibly a task the app never
   * acknowledged within the window (Matrix redelivers to an app that was down; past the window nobody is coming).
   */
  async tick(): Promise<void> {
    const windowMs = this.opts.deliveryWindowMs ?? 10 * 60_000;
    const due = await this.platform.db.query<{ id: string; delivered: boolean; overdue: boolean; open_attempts: number }>(
      `select id, matrix_event_id is not null as delivered, created_at < now() - ($1 || ' milliseconds')::interval as overdue, open_attempts
         from neos.tasks where road = 'matrix' and status = 'OPEN' and job_id is null and (matrix_event_id is not null or next_attempt_at <= now()) order by created_at limit 20`,
      [String(windowMs)],
    );
    for (const t of due.rows) {
      if (t.overdue) {
        await this.platform.db.query(`update neos.tasks set status = 'FAILED', last_error = $2, updated_at = now() where id = $1 and status = 'OPEN' and job_id is null`, [
          t.id,
          t.delivered ? 'the app never acknowledged the task in Matrix' : 'the task could not be posted in Matrix',
        ]);
        continue;
      }
      if (t.delivered) continue;
      await this.deliver(t.id).catch((e) => this.failedSend(t.id, t.open_attempts, e));
    }
  }

  /** A send that failed: retried with backoff (a definite refusal fails at once). */
  async failedSend(taskId: string, attempts: number, e: unknown): Promise<void> {
    const backoff = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];
    const n = attempts + 1;
    const final = (e as { final?: boolean }).final === true;
    await this.platform.db.query(
      `update neos.tasks set open_attempts = $2, last_error = $3, next_attempt_at = now() + ($4 || ' milliseconds')::interval, status = case when $5 then 'FAILED' else status end, updated_at = now() where id = $1`,
      [taskId, n, String((e as Error)?.message ?? e).slice(0, 500), String(backoff[Math.min(n, backoff.length - 1)]), final],
    );
    this.log('task not posted', { task: taskId, attempts: n, e: String((e as Error)?.message ?? e).slice(0, 200) });
  }

  // ── the client road's ear ──────────────────────────────────────────────────
  /** Start every configured account's /sync loop (client road); the appservice road is pushed to instead. */
  async start(): Promise<void> {
    this.stopping = false;
    for (const c of this.clients) await this.startClient(c);
  }

  /** Tests and ops: add an account at runtime and start it. */
  async addAccount(a: NeuralChatAccount): Promise<void> {
    if (this.cfg.road !== 'client') throw new Error('accounts are for the client road');
    const c = this.clientOf(a);
    this.clients.push(c);
    await this.startClient(c);
  }

  private async startClient(c: ClientAccount): Promise<void> {
    const co = (await this.platform.db.query<{ id: string }>('select id from neos.companies where id::text = $1 or slug = $1', [c.cfg.company])).rows[0];
    if (!co) return void (c.stopped = 'no_company', this.log('client account not started: no such company', { company: c.cfg.company }));
    c.companyId = co.id;
    let who: string;
    try {
      who = (await this.mx<{ user_id: string }>('GET', '/_matrix/client/v3/account/whoami', undefined, { token: c.token })).user_id;
    } catch (e) {
      c.stopped = 'token_rejected';
      return void this.log('client account not started: token rejected', { e: String(e) });
    }
    if (c.account && c.account !== who) return void ((c.stopped = 'account_mismatch'), this.log('client account not started: whoami differs', { account: c.account, whoami: who }));
    c.account = who;
    await this.platform.db.query(
      `insert into neos.neuralchat_accounts (account, company_id) values ($1, $2) on conflict (account) do update set company_id = excluded.company_id, stopped_reason = null, updated_at = now()`,
      [who, co.id],
    );
    c.running = true;
    c.abort = new AbortController();
    c.loop = this.syncLoop(c);
    // The apps at this company must know NeuralChat's name before it speaks.
    await this.platform.syncChat(co.id).catch(() => {});
  }

  private async syncLoop(c: ClientAccount): Promise<void> {
    const timeout = this.cfg.road === 'client' ? (this.cfg.syncTimeoutMs ?? 30_000) : 30_000;
    let failures = 0;
    while (c.running && !this.stopping) {
      try {
        const since = (await this.platform.db.query<{ next_batch: string | null }>('select next_batch from neos.neuralchat_accounts where account = $1', [c.account])).rows[0]?.next_batch ?? null;
        const filter = JSON.stringify({ presence: { types: [] }, account_data: { types: [] }, room: { ephemeral: { types: [] }, account_data: { types: [] } } });
        const res = await this.mx<any>('GET', `/_matrix/client/v3/sync?timeout=${since ? timeout : 0}&filter=${encodeURIComponent(filter)}${since ? `&since=${encodeURIComponent(since)}` : ''}`, undefined, { token: c.token }, c.abort!.signal);
        for (const [roomId, joined] of Object.entries<any>(res?.rooms?.join ?? {})) {
          for (const e of joined?.timeline?.events ?? []) {
            if (typeof e?.event_id !== 'string' || typeof e?.sender !== 'string') continue;
            await this.onEvent({ event_id: e.event_id, room_id: roomId, sender: e.sender, type: e.type, content: e.content ?? {} });
          }
        }
        if (res?.next_batch) await this.platform.db.query('update neos.neuralchat_accounts set next_batch = $2, updated_at = now() where account = $1', [c.account, res.next_batch]);
        failures = 0;
      } catch (e: any) {
        if (!c.running || this.stopping || e?.name === 'AbortError') break;
        if (e?.status === 401) {
          c.running = false;
          c.stopped = 'token_rejected';
          await this.platform.db.query("update neos.neuralchat_accounts set stopped_reason = 'token_rejected', updated_at = now() where account = $1", [c.account]).catch(() => {});
          this.log('client account stopped: token rejected', { account: c.account });
          break;
        }
        failures++;
        await new Promise((r) => setTimeout(r, Math.min(30_000, 250 * 2 ** Math.min(failures, 7))));
      }
    }
  }

  status(): { road: string; accounts: { account: string | null; company_id: string | null; running: boolean; stopped: string | null }[] } {
    return { road: this.cfg.road, accounts: this.clients.map((c) => ({ account: c.account, company_id: c.companyId, running: c.running, stopped: c.stopped })) };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const c of this.clients) {
      c.running = false;
      c.abort?.abort();
    }
    await Promise.all(this.clients.map((c) => c.loop?.catch(() => {})));
  }
}

function tokenOk(given: string | undefined | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The platform's routes for NeuralChat's road: on the appservice road, the endpoints the homeserver pushes NeuralChat's
 * events to (its registration: @neuralchat_.* only; v3 S9 — the platform keeps no Matrix name or namespace for any app).
 */
export function neuralChatRoutes(nc: NeuralChatMatrix): Hono {
  const app = new Hono();
  if (nc.cfg.road === 'appservice') {
    const hs = nc.cfg.hsToken;
    const authed = (c: any) => {
      const h = c.req.header('authorization');
      return tokenOk(h?.startsWith('Bearer ') ? h.slice(7) : c.req.query('access_token'), hs);
    };
    const tx = async (c: any) => {
      if (!authed(c)) return c.json({ errcode: 'M_FORBIDDEN', error: 'bad hs_token' }, 403);
      const body = (await c.req.json().catch(() => ({}))) as { events?: any[] };
      for (const ev of body.events ?? []) {
        if (typeof ev?.event_id !== 'string' || typeof ev?.room_id !== 'string' || typeof ev?.sender !== 'string') continue;
        await nc.onEvent({ event_id: ev.event_id, room_id: ev.room_id, sender: ev.sender, type: ev.type, content: ev.content ?? {} });
      }
      return c.json({});
    };
    app.put('/_matrix/app/v1/transactions/:txnId', tx);
    app.put('/transactions/:txnId', tx);
    app.get('/_matrix/app/v1/users/:userId', (c) => (authed(c) ? (nc.isOurs(c.req.param('userId')) ? c.json({}) : c.json({ errcode: 'M_NOT_FOUND' }, 404)) : c.json({ errcode: 'M_FORBIDDEN' }, 403)));
    app.get('/_matrix/app/v1/rooms/:alias', (c) => (authed(c) ? c.json({ errcode: 'M_NOT_FOUND' }, 404) : c.json({ errcode: 'M_FORBIDDEN' }, 403)));
    app.post('/_matrix/app/v1/ping', (c) => (authed(c) ? c.json({}) : c.json({ errcode: 'M_FORBIDDEN' }, 403)));
  }
  return app;
}

/**
 * NEOS_NEURALCHAT_MATRIX=appservice|client — required (v3 S9: NeuralChat always speaks Matrix; there is no other road to
 * an app). appservice: the platform's own registration (MATRIX_HOMESERVER_URL, MATRIX_SERVER_NAME, MATRIX_HS_TOKEN,
 * MATRIX_AS_TOKEN[_FILE]; @neuralchat_.* only). client: MATRIX_HOMESERVER_URL and MATRIX_NEURALCHAT_ACCOUNTS[_FILE] =
 * [{company, account?, token_file}] — one ordinary account per company (the production default beside #143's road).
 */
export function neuralChatConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NeuralChatMatrixConfig {
  const mode = (env.NEOS_NEURALCHAT_MATRIX ?? '').trim();
  if (mode !== 'appservice' && mode !== 'client') throw new Error(`NEOS_NEURALCHAT_MATRIX must be appservice or client (got ${mode || 'nothing'}): NeuralChat reaches apps only through Matrix`);
  const homeserverUrl = String(env.MATRIX_HOMESERVER_URL ?? '').trim();
  if (!homeserverUrl) throw new Error('NEOS_NEURALCHAT_MATRIX needs MATRIX_HOMESERVER_URL');
  if (mode === 'appservice') {
    const need = ['MATRIX_SERVER_NAME', 'MATRIX_HS_TOKEN', 'MATRIX_AS_TOKEN'].filter((k) => !env[k]);
    if (need.length) throw new Error(`NEOS_NEURALCHAT_MATRIX=appservice needs ${need.join(', ')}`);
    return { road: 'appservice', homeserverUrl, serverName: env.MATRIX_SERVER_NAME!, hsToken: env.MATRIX_HS_TOKEN!, asToken: env.MATRIX_AS_TOKEN! };
  }
  const raw = env.MATRIX_NEURALCHAT_ACCOUNTS_FILE ? readFileSync(env.MATRIX_NEURALCHAT_ACCOUNTS_FILE, 'utf8') : (env.MATRIX_NEURALCHAT_ACCOUNTS ?? '');
  const list = JSON.parse(raw || '[]') as any[];
  if (!Array.isArray(list) || !list.length) throw new Error('NEOS_NEURALCHAT_MATRIX=client needs MATRIX_NEURALCHAT_ACCOUNTS (a JSON array)');
  const accounts = list.map((a): NeuralChatAccount => {
    if (!a?.company || !(a?.token_file || a?.tokenFile) || (a.account !== undefined && !/^@[^:]+:.+$/.test(String(a.account)))) throw new Error('each MATRIX_NEURALCHAT_ACCOUNTS entry needs company, token_file and (optionally) account @user:server');
    return { company: String(a.company), ...(a.account ? { account: String(a.account) } : {}), tokenFile: a.token_file ?? a.tokenFile };
  });
  const n = Number(env.MATRIX_SYNC_TIMEOUT_MS);
  return { road: 'client', homeserverUrl, accounts, ...(Number.isFinite(n) && n > 0 ? { syncTimeoutMs: n } : {}) };
}
