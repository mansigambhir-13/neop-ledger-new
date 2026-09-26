// THE CHAT BRIDGE · one for everything (diagram A, 7.1, 7.6, 7.7, 7.9, 9).
// Knows who is writing, checks company, permissions and approvals, speaks as
// one chat user per app per company, and keeps an audit trail. It never
// delivers an unsigned message to an app: a room ask becomes a task row and a
// signed inbox.deliver call through the gateway (B4). The room is a mirror;
// everything it shows comes from typed outbox events, never the other way.

import type { Decision } from '@neop/contracts';
import type { Platform } from '../platform.ts';
import { PlatformError } from '../platform.ts';

export interface RoomTransport {
  /** Post as `asUser` into `roomId`; `txnId` makes a retried send idempotent. */
  send(roomId: string, asUser: string, body: string, txnId: string): Promise<{ event_id: string }>;
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
  | 'unclear_answer';

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

  async createAppRoom(companyId: string, app: string, roomId: string): Promise<string> {
    const co = await this.platform.db.query<{ slug: string }>('select slug from neos.companies where id = $1', [companyId]);
    if (!co.rows[0]) throw new PlatformError(404, 'not_found', 'no such company');
    const bot = this.botUser(app, co.rows[0].slug);
    await this.platform.db.query(
      `insert into neos.rooms (room_id, company_id, app_key, bot_user) values ($1,$2,$3,$4)
       on conflict (company_id, app_key, kind) do update set room_id = excluded.room_id, bot_user = excluded.bot_user`,
      [roomId, companyId, app, bot],
    );
    return bot;
  }

  async linkUser(userId: string, chatId: string): Promise<void> {
    await this.platform.db.query('update neos.users set matrix_user_id = $2 where id = $1', [userId, chatId]);
  }

  private async notice(roomId: string, key: string, body: string): Promise<void> {
    await this.platform.db.query(
      `insert into neos.room_messages (room_id, dedupe_key, kind, body) values ($1,$2,'notice',$3) on conflict do nothing`,
      [roomId, key, body],
    );
  }

  private async audit(ev: InboundRoomMessage, outcome: BridgeOutcome, extra: { user_id?: string; approval_id?: string; fingerprint?: string } = {}): Promise<void> {
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

    const room = (await this.platform.db.query<{ company_id: string; app_key: string }>('select company_id, app_key from neos.rooms where room_id = $1', [ev.room_id])).rows[0];
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
    this.timer = setInterval(() => void this.sendPending().catch((e) => this.opts.log?.('bridge send failed', e)), this.opts.sendEveryMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
