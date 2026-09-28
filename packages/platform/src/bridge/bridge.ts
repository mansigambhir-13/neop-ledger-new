// THE CHAT BRIDGE · one for everything (diagram A, 7.1, 7.6, 7.7, 7.9, 9).
// Knows who is writing, checks company, permissions and approvals, speaks as
// one chat user per app per company, and keeps an audit trail. It never
// delivers an unsigned message to an app: a room ask becomes a task row and a
// signed inbox.deliver call through the gateway (B4). The room is a mirror;
// everything it shows comes from typed outbox events, never the other way.

import { tx } from '@neop/pgkit';
import { canPost, neopRoomPowerLevels, roomProblems, roomStateView, typedContent, type Decision } from '@neop/contracts';
import type { Platform } from '../platform.ts';
import { PlatformError } from '../platform.ts';
import { classOfNonPerson, dueTypedOut, handleTyped, typedTxnId, type TypedIn, type TypedOut, type TypedRoad, type TypedWho } from './typed.ts';

export interface RoomTransport {
  /** Post as `asUser` into `roomId`; `txnId` makes a retried send idempotent. */
  send(roomId: string, asUser: string, body: string, txnId: string): Promise<{ event_id: string }>;
  /** Make sure the app's identity exists on the homeserver and has joined the room. */
  prepare?(roomId: string, asUser: string): Promise<void>;
  /** v3 §8: post a typed (custom) event, e.g. neos.neop.propose, as `asUser`. */
  sendEvent?(roomId: string, asUser: string, type: string, content: Record<string, unknown>, txnId: string): Promise<{ event_id: string }>;
  /** The room's current state events (join rules, encryption, power levels), read as `asUser`. */
  roomState?(roomId: string, asUser: string): Promise<{ type?: string; state_key?: string; content?: any }[]>;
  /** Create a room as `asUser` (Client-Server createRoom body). */
  createRoom?(asUser: string, body: Record<string, unknown>): Promise<{ room_id: string }>;
}

export interface InboundTypedEvent {
  event_id: string;
  room_id: string;
  sender: string;
  type: string;
  content: any;
}

export interface InboundRoomMessage {
  event_id: string;
  room_id: string;
  /** Chat identity of the sender, e.g. @priya:acme.example */
  sender: string;
  body: string;
  /** Event this message replies to (answers to a card arrive this way). */
  in_reply_to?: string | null;
}

export type BridgeOutcome =
  | 'ignored_bot'
  | 'duplicate'
  | 'unknown_room'
  | 'unknown_sender'
  | 'not_installed'
  | 'task_opened'
  | `answered:${Decision}`
  | 'answer_refused'
  | 'unclear_answer'
  | `typed:${string}`;

export interface BridgeOptions {
  serverName: string;
  /** Local-part prefix of the app identities this bridge owns. */
  botPrefix?: string;
  sendEveryMs?: number;
  log?: (m: string, e?: unknown) => void;
}

export function parseDecision(text: string): { decision: Decision; feedback?: string } | null {
  const t = text.trim();
  const change = /^change\s*[:\-–]\s*([\s\S]+)$/i.exec(t);
  if (change) return { decision: 'change', feedback: change[1]!.trim() };
  if (/^(yes|y|approve|approved)\b/i.test(t)) return { decision: 'yes' };
  if (/^(no|n|reject|decline)\b/i.test(t)) return { decision: 'no' };
  if (/^withdraw\b/i.test(t)) return { decision: 'withdraw' };
  return null;
}

export class ChatBridge {
  readonly platform: Platform;
  readonly transport: RoomTransport;
  readonly opts: Required<Omit<BridgeOptions, 'log'>> & Pick<BridgeOptions, 'log'>;
  private timer: NodeJS.Timeout | null = null;
  private sending = false;

  constructor(platform: Platform, transport: RoomTransport, opts: BridgeOptions) {
    this.platform = platform;
    this.transport = transport;
    this.opts = { botPrefix: "neop_", ...opts, sendEveryMs: opts.sendEveryMs ?? 500 };
  }

  /** One chat user per app per company: @neop_ledger_acme:server */
  botUser(app: string, companySlug: string): string {
    return `@${this.opts.botPrefix}${app}_${companySlug}:${this.opts.serverName}`;
  }

  isOurs(sender: string): boolean {
    return sender.startsWith(`@${this.opts.botPrefix}`) && sender.endsWith(`:${this.opts.serverName}`);
  }

  /**
   * Bind an app's room (v3 §8 + B7): the app's identity joins it, and the room is refused unless it is
   * invite-only, NOT end-to-end encrypted, and its power levels let only people post neos.neop.approve (the
   * app's own identity and every allowlisted bridge/NEOP below that level). A transport that cannot read room
   * state (a test double) skips the check; the Matrix transport always reads it.
   */
  async createAppRoom(companyId: string, app: string, roomId: string): Promise<string> {
    const co = await this.platform.db.query<{ slug: string }>('select slug from neos.companies where id = $1', [companyId]);
    if (!co.rows[0]) throw new PlatformError(404, 'not_found', 'no such company');
    const bot = this.botUser(app, co.rows[0].slug);
    await this.transport.prepare?.(roomId, bot);
    if (this.transport.roomState) {
      const nonPeople = (
        await this.platform.db.query<{ matrix_id: string }>("select matrix_id from neos.chat_allowlist where company_id = $1 and app_key = $2 and kind = 'bridge'", [companyId, app])
      ).rows.map((r) => r.matrix_id);
      const problems = roomProblems(roomStateView(await this.transport.roomState(roomId, bot)), { self: bot, nonPeople });
      if (problems.length) throw new PlatformError(409, 'room_unfit', `this room cannot be bound to ${app}: ${problems.join('; ')}`);
    }
    await tx(this.platform.db, async (c) => {
      await c.query(`update neos.rooms set status = 'retired' where company_id = $1 and app_key = $2 and kind = 'app' and status = 'active' and room_id <> $3`, [companyId, app, roomId]);
      await c.query(
        `insert into neos.rooms (room_id, company_id, app_key, bot_user, status) values ($1,$2,$3,$4,'active')
         on conflict (room_id) do update set status = 'active', bot_user = excluded.bot_user`,
        [roomId, companyId, app, bot],
      );
    });
    return bot;
  }

  /**
   * Create a NEOP room as the app's identity and bind it: private preset (invite-only), no m.room.encryption,
   * and power levels where people (and the named admins) may post neos.neop.approve and the app, bridges and
   * other NEOPs may not. The creator gives up room admin in the same call: it sits at the agents' level.
   */
  async createRoom(companyId: string, app: string, o: { people: string[]; admins?: string[]; name?: string }): Promise<{ room_id: string; bot: string }> {
    if (!this.transport.createRoom) throw new PlatformError(501, 'unsupported', 'this chat transport cannot create rooms');
    const co = await this.platform.db.query<{ slug: string }>('select slug from neos.companies where id = $1', [companyId]);
    if (!co.rows[0]) throw new PlatformError(404, 'not_found', 'no such company');
    const bot = this.botUser(app, co.rows[0].slug);
    const nonPeople = (
      await this.platform.db.query<{ matrix_id: string }>("select matrix_id from neos.chat_allowlist where company_id = $1 and app_key = $2 and kind = 'bridge'", [companyId, app])
    ).rows.map((r) => r.matrix_id);
    const { room_id } = await this.transport.createRoom(bot, {
      preset: 'private_chat',
      visibility: 'private',
      ...(o.name ? { name: o.name } : {}),
      invite: [...new Set([...o.people, ...(o.admins ?? []), ...nonPeople])],
      initial_state: [{ type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } }],
      power_level_content_override: neopRoomPowerLevels({ people: o.people, admins: o.admins, nonPeople: [bot, ...nonPeople] }),
    });
    return { room_id, bot: await this.createAppRoom(companyId, app, room_id) };
  }

  async linkUser(userId: string, chatId: string): Promise<void> {
    const r = await this.platform.db.query<{ company_id: string }>('update neos.users set matrix_user_id = $2 where id = $1 returning company_id', [userId, chatId]);
    // v3 S4: written through to every installed app's own schema (a NEOP's presence reads only that).
    if (r.rows[0]) await this.platform.syncChat(r.rows[0].company_id);
  }

  private async notice(roomId: string, key: string, body: string): Promise<void> {
    await this.platform.db.query(
      `insert into neos.room_messages (room_id, dedupe_key, kind, body) values ($1,$2,'notice',$3) on conflict do nothing`,
      [roomId, key, body],
    );
  }

  private async audit(ev: { event_id: string }, outcome: BridgeOutcome, extra: { user_id?: string; approval_id?: string; fingerprint?: string } = {}): Promise<void> {
    await this.platform.db.query(
      `update neos.room_events set outcome = $2, user_id = coalesce($3, user_id), approval_id = coalesce($4, approval_id), fingerprint_shown = coalesce($5, fingerprint_shown)
        where event_id = $1`,
      [ev.event_id, outcome, extra.user_id ?? null, extra.approval_id ?? null, extra.fingerprint ?? null],
    );
  }

  async onMessage(ev: InboundRoomMessage): Promise<BridgeOutcome> {
    if (this.isOurs(ev.sender)) return 'ignored_bot'; // never answer ourselves (no bot loops)
    const fresh = await this.platform.db.query(
      `insert into neos.room_events (event_id, room_id, direction, sender, outcome, body) values ($1,$2,'inbound',$3,'received',$4) on conflict do nothing`,
      [ev.event_id, ev.room_id, ev.sender, ev.body.slice(0, 8000)],
    );
    if (!fresh.rowCount) return 'duplicate';

    const room = (await this.platform.db.query<{ company_id: string; app_key: string }>("select company_id, app_key from neos.rooms where room_id = $1 and status = 'active'", [ev.room_id])).rows[0];
    if (!room) {
      await this.audit(ev, 'unknown_room');
      return 'unknown_room';
    }
    // Knows who is writing: a chat identity linked to a person in this company, or nobody.
    const user = (
      await this.platform.db.query<{ id: string; company_id: string }>('select id, company_id from neos.users where matrix_user_id = $1 and company_id = $2', [
        ev.sender,
        room.company_id,
      ])
    ).rows[0];
    if (!user) {
      await this.audit(ev, 'unknown_sender');
      await this.notice(ev.room_id, `unknown:${ev.event_id}`, `I can only act for people linked to this company on NEOS. Nothing was done.`);
      return 'unknown_sender';
    }
    const installed = await this.platform.db.query("select 1 from neos.installs where company_id = $1 and app_key = $2 and status = 'active'", [room.company_id, room.app_key]);
    if (!installed.rowCount) {
      await this.audit(ev, 'not_installed', { user_id: user.id });
      await this.notice(ev.room_id, `notinstalled:${ev.event_id}`, `This app is not installed for your company. Nothing was done.`);
      return 'not_installed';
    }

    // An answer: a reply to a card this bridge posted, bound to the fingerprint that card showed.
    if (ev.in_reply_to) {
      const card = (
        await this.platform.db.query<{ approval_id: string; fingerprint_shown: string }>(
          `select approval_id, fingerprint_shown from neos.room_events where event_id = $1 and direction = 'outbound' and approval_id is not null and room_id = $2`,
          [ev.in_reply_to, ev.room_id],
        )
      ).rows[0];
      if (card) {
        const d = parseDecision(ev.body);
        if (!d) {
          await this.audit(ev, 'unclear_answer', { user_id: user.id, approval_id: card.approval_id });
          await this.notice(ev.room_id, `unclear:${ev.event_id}`, 'Reply to the card with "yes", "no" or "change: <what to change>".');
          return 'unclear_answer';
        }
        try {
          await this.platform.answer(card.approval_id, user, { decision: d.decision, fingerprint_seen: card.fingerprint_shown, feedback: d.feedback });
        } catch (e) {
          await this.audit(ev, 'answer_refused', { user_id: user.id, approval_id: card.approval_id, fingerprint: card.fingerprint_shown });
          await this.notice(ev.room_id, `refused:${ev.event_id}`, `That answer was not recorded: ${(e as Error).message}.`);
          return 'answer_refused';
        }
        await this.audit(ev, `answered:${d.decision}`, { user_id: user.id, approval_id: card.approval_id, fingerprint: card.fingerprint_shown });
        return `answered:${d.decision}`;
      }
    }

    // An ask: a task row, then a signed call. The "on it" comes back from the app's outbox.
    await this.platform.openTask({
      company_id: room.company_id,
      app_key: room.app_key,
      requester: `user:${user.id}`,
      ask: ev.body,
      origin: 'room',
      room_id: ev.room_id,
      room_event_id: ev.event_id,
    });
    await this.audit(ev, 'task_opened', { user_id: user.id });
    return 'task_opened';
  }

  // ── v3 §8 typed events (typed.ts): an additional, stricter road in the same rooms ─────────────────────────────
  /** A typed event pushed by the homeserver: dedupe on event_id, know who is writing (by class), then the shared rules. */
  async onTyped(ev: InboundTypedEvent): Promise<BridgeOutcome> {
    const room = (
      await this.platform.db.query<{ company_id: string; app_key: string; bot_user: string }>("select company_id, app_key, bot_user from neos.rooms where room_id = $1 and status = 'active'", [ev.room_id])
    ).rows[0];
    if (room ? ev.sender === room.bot_user : this.isOurs(ev.sender)) return 'ignored_bot'; // our own echo: no loops
    const fresh = await this.platform.db.query(
      `insert into neos.room_events (event_id, room_id, direction, sender, outcome, body) values ($1,$2,'inbound',$3,'typed:received',$4) on conflict do nothing`,
      [ev.event_id, ev.room_id, ev.sender, JSON.stringify({ type: ev.type, content: ev.content ?? null }).slice(0, 8000)],
    );
    if (!fresh.rowCount) return 'duplicate';
    if (!room) {
      await this.audit(ev, 'unknown_room');
      return 'unknown_room';
    }
    const person = (
      await this.platform.db.query<{ id: string; company_id: string; role: string; name: string }>('select id, company_id, role, name from neos.users where matrix_user_id = $1 and company_id = $2', [
        ev.sender,
        room.company_id,
      ])
    ).rows[0];
    let who: TypedWho | null = person ? { cls: 'person', person } : null;
    if (!who) {
      const a = (
        await this.platform.db.query<{ acts_for: string | null }>("select acts_for from neos.chat_allowlist where company_id = $1 and app_key = $2 and matrix_id = $3 and kind = 'bridge'", [
          room.company_id,
          room.app_key,
          ev.sender,
        ])
      ).rows[0];
      if (a) who = { cls: classOfNonPerson(ev.sender), actsFor: a.acts_for };
    }
    if (!who) {
      await this.audit(ev, 'typed:unknown_sender');
      await this.platform.gateway.audit({ company_id: room.company_id, actor: `chat:${ev.sender}`, app_key: room.app_key, action: 'chat.typed_in', outcome: 'unknown_sender', detail: { event_id: ev.event_id, room_id: ev.room_id, type: ev.type } });
      return 'typed:unknown_sender';
    }
    if (who.person) await this.audit(ev, 'typed:received', { user_id: who.person.id });
    const appName = (await this.platform.db.query<{ name: string }>("select manifest->>'name' as name from neos.apps where key = $1", [room.app_key])).rows[0]?.name ?? room.app_key;
    return (await handleTyped(this.typedRoad(room.company_id, room.app_key, appName), ev as TypedIn, who)) as BridgeOutcome;
  }

  private typedRoad(companyId: string, app: string, appName: string): TypedRoad {
    const db = this.platform.db;
    return {
      platform: this.platform,
      companyId,
      app,
      appName,
      record: async (ev, outcome, x = {}) => {
        await db.query(
          `update neos.room_events set outcome = $2, task_id = coalesce($3, task_id), approval_id = coalesce($4, approval_id), fingerprint_shown = coalesce($5, fingerprint_shown), user_id = coalesce($6, user_id)
            where event_id = $1`,
          [ev.event_id, outcome, x.task_id ?? null, x.approval_id ?? null, x.fingerprint ?? null, x.user_id ?? null],
        );
      },
      say: async (ev, outcome, text) => {
        await db.query('update neos.room_events set outcome = $2 where event_id = $1', [ev.event_id, outcome]);
        await this.notice(ev.room_id, `typed:${ev.event_id}`, text);
      },
      openTask: async (ev, personId, text) => {
        await db.query('update neos.room_events set user_id = $2 where event_id = $1', [ev.event_id, personId]);
        const t = await this.platform.openTask({ company_id: companyId, app_key: app, requester: `user:${personId}`, ask: text, origin: 'room', room_id: ev.room_id, room_event_id: ev.event_id });
        await db.query("update neos.room_events set outcome = 'typed:task_opened', task_id = $2 where event_id = $1", [ev.event_id, t.task_id]);
        return t.task_id;
      },
      mayApproveHere: async (room, sender) => {
        if (!this.transport.roomState) return true; // a test double without room state: membership is the rule
        const bot = (await db.query<{ bot_user: string }>('select bot_user from neos.rooms where room_id = $1', [room])).rows[0]?.bot_user;
        return !!bot && canPost(roomStateView(await this.transport.roomState(room, bot)), sender, 'neos.neop.approve');
      },
      settledIn: async () => {}, // the room hears the job's next word from the outbox mirror, as for any answer
      shown: async (room, kind, row) => {
        if (kind === 'approval') {
          return !!(await db.query("select 1 from neos.room_events where room_id = $1 and direction = 'outbound' and approval_id = $2 limit 1", [room, row.id])).rowCount;
        }
        return !!(
          await db.query(
            `select 1 from neos.room_messages where room_id = $1 and dedupe_key = $2 and status = 'sent'
             union all select 1 from neos.room_events where room_id = $1 and direction = 'outbound' and outcome = $3 limit 1`,
            [room, `question:${row.wait_id}`, `typed:ask:${row.wait_id}`],
          )
        ).rowCount;
      },
      rootOf: async (room, taskId) =>
        (
          await db.query<{ event_id: string; sender: string }>(
            "select event_id, sender from neos.room_events where room_id = $1 and direction = 'inbound' and task_id = $2 and outcome = 'typed:task_opened' order by at limit 1",
            [room, taskId],
          )
        ).rows[0] ?? null,
      taskOfRoot: async (room, root) =>
        (await db.query<{ task_id: string }>("select task_id from neos.room_events where room_id = $1 and event_id = $2 and direction = 'inbound' and outcome = 'typed:task_opened'", [room, root])).rows[0]
          ?.task_id ?? null,
      emit: async (room, taskId, root, out) => {
        await this.emitTyped(room, taskId, root, out);
      },
    };
  }

  /** Post one typed event as the room's app identity (same txn id on a resend) and record it, once per key. */
  private async emitTyped(room: string, taskId: string | null, root: string | null, out: TypedOut): Promise<boolean> {
    if (!this.transport.sendEvent) return false;
    const db = this.platform.db;
    const seen = await db.query("select 1 from neos.room_events where room_id = $1 and direction = 'outbound' and task_id is not distinct from $2 and outcome = $3 limit 1", [room, taskId, out.key]);
    if (seen.rowCount) return false;
    const bot = (await db.query<{ bot_user: string }>('select bot_user from neos.rooms where room_id = $1', [room])).rows[0]?.bot_user;
    if (!bot) return false;
    const content = typedContent(out.type, out.body, out.fallback.slice(0, 8000), root);
    const { event_id } = await this.transport.sendEvent(room, bot, out.type, content, typedTxnId(taskId, out.key));
    await db.query(
      `insert into neos.room_events (event_id, room_id, direction, sender, task_id, approval_id, fingerprint_shown, outcome, body) values ($1,$2,'outbound',$3,$4,$5,$6,$7,$8) on conflict do nothing`,
      [event_id, room, bot, taskId, out.approval_id ?? null, out.fingerprint ?? null, out.key, out.fallback.slice(0, 8000)],
    );
    return true;
  }

  /** Typed threads in the rooms (rooted at a typed task): the note · ask · propose · done each is owed now, once. */
  async typedTick(): Promise<number> {
    if (!this.transport.sendEvent) return 0;
    const { rows } = await this.platform.db.query<{ event_id: string; room_id: string; task_id: string; app_key: string }>(
      `select e.event_id, e.room_id, e.task_id, t.app_key from neos.room_events e join neos.tasks t on t.id = e.task_id
        where e.direction = 'inbound' and e.outcome = 'typed:task_opened'
          and (t.status not in ('COMPLETED', 'FAILED', 'CANCELLED') or t.updated_at > now() - interval '1 hour')
          and not exists (select 1 from neos.room_events o where o.room_id = e.room_id and o.direction = 'outbound' and o.task_id = e.task_id and o.outcome = 'typed:done')
        order by e.at limit 20`,
    );
    let n = 0;
    for (const r of rows) {
      const sent = new Set(
        (await this.platform.db.query<{ outcome: string }>("select outcome from neos.room_events where room_id = $1 and direction = 'outbound' and task_id = $2 and outcome like 'typed:%'", [r.room_id, r.task_id])).rows.map(
          (x) => x.outcome,
        ),
      );
      const appName = (await this.platform.db.query<{ name: string }>("select manifest->>'name' as name from neos.apps where key = $1", [r.app_key])).rows[0]?.name ?? r.app_key;
      for (const out of await dueTypedOut(this.platform, { task_id: r.task_id, app_name: appName }, sent)) {
        try {
          if (await this.emitTyped(r.room_id, r.task_id, r.event_id, out)) n++;
        } catch (e) {
          this.opts.log?.('typed event not sent yet — will retry with the same transaction', e);
          break;
        }
      }
    }
    return n;
  }

  /** Deliver pending mirrors in order, each once (txn id = row id). */
  async sendPending(): Promise<number> {
    if (this.sending) return 0;
    this.sending = true;
    let n = 0;
    try {
      const { rows } = await this.platform.db.query(
        `select m.*, r.bot_user from neos.room_messages m join neos.rooms r on r.room_id = m.room_id
          where m.status = 'pending' order by m.id limit 50`,
      );
      for (const m of rows) {
        try {
          const { event_id } = await this.transport.send(m.room_id, m.bot_user, m.body, `neop-${m.id}`);
          await this.platform.db.query(`update neos.room_messages set status = 'sent', event_id = $2 where id = $1`, [m.id, event_id]);
          await this.platform.db.query(
            `insert into neos.room_events (event_id, room_id, direction, sender, approval_id, fingerprint_shown, outcome, body)
             values ($1,$2,'outbound',$3,$4,$5,$6,$7) on conflict do nothing`,
            [event_id, m.room_id, m.bot_user, m.approval_id, m.fingerprint_shown, m.kind, m.body.slice(0, 8000)],
          );
          n++;
        } catch (e) {
          await this.platform.db.query(
            `update neos.room_messages set attempts = attempts + 1, last_error = $2, status = case when attempts + 1 >= 10 then 'failed' else 'pending' end where id = $1`,
            [m.id, String(e).slice(0, 500)],
          );
          break; // keep per-room order: retry this one first next time
        }
      }
    } finally {
      this.sending = false;
    }
    return n;
  }

  start(): void {
    this.timer = setInterval(
      () =>
        void this.sendPending()
          .then(() => this.typedTick())
          .catch((e) => this.opts.log?.('bridge send failed', e)),
      this.opts.sendEveryMs,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
