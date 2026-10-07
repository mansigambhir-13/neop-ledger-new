// PRESENCE · THE APPSERVICE ROAD (NEOP_PRESENCE=appservice; v3 §8, §13 deploy/appservice.yaml). The NEOP's own
// backend is a Matrix application service for its exclusive namespace (@neop_<app>_.*):
//   in   the homeserver PUTs /_matrix/app/v1/transactions/{txnId} with the hs_token (checked in constant time;
//        anything else is 403 M_FORBIDDEN). Each event goes to runner/inbound.ts once (event_id dedupe): typed
//        neos.neop.* events by sender class, plain m.text in the app's rooms. A room this app is not bound to
//        at any company (installs.room_ids) is ignored — no record, no reply. Our own echo is ignored.
//   out  PUT /_matrix/client/v3/rooms/{room}/send/{type}/{txnId}?user_id=<our name at that company> with the
//        as_token; the txn id is the dedupe key, so a resend is the same event.
//   rooms  each bound room is joined as the company's name and checked once per process: invite-only, NOT
//        end-to-end encrypted, only people at the neos.neop.approve level (contracts roomProblems). An unfit
//        room is not spoken in and nothing said there is acted on (outcome room_unfit).

import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { canPost, isTypedEventType, neopRoomPowerLevels, roomProblems, roomStateView } from '@neop/contracts';
import { stripReplyFallback } from './lexicon.ts';
import { RetryableInboundError } from './events.ts';

export interface AppserviceConfig {
  homeserverUrl: string;
  /** The homeserver's token to us (appservice.yaml hs_token). */
  hsToken: string;
  /** Our token to the homeserver (appservice.yaml as_token). */
  asToken: string;
  /** Where /_matrix/app/v1 listens (APPSERVICE_HOST / APPSERVICE_PORT; default 0.0.0.0:4104 in the image). */
  port?: number;
  host?: string;
  fetchImpl?: typeof fetch;
}

export function tokenOk(given: string | undefined | null, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Speaking as one of our names: register it in the namespace, join rooms, post, read room state. */
export class AppserviceTransport {
  readonly cfg: AppserviceConfig;
  private readonly f: typeof fetch;
  constructor(cfg: AppserviceConfig) {
    this.cfg = cfg;
    this.f = cfg.fetchImpl ?? fetch;
  }
  private get base(): string {
    return this.cfg.homeserverUrl.replace(/\/+$/, '');
  }
  private headers(json = true): Record<string, string> {
    return { authorization: `Bearer ${this.cfg.asToken}`, ...(json ? { 'content-type': 'application/json' } : {}) };
  }

  /** Register the name (appservice namespace; "in use" is fine) and join the room as it. */
  async prepare(roomId: string, asUser: string): Promise<void> {
    await this.register(asUser);
    const join = await this.f(`${this.base}/_matrix/client/v3/join/${encodeURIComponent(roomId)}?user_id=${encodeURIComponent(asUser)}`, { method: 'POST', headers: this.headers(), body: '{}', signal: AbortSignal.timeout(10_000) });
    if (!join.ok) throw new Error(`join ${roomId} as ${asUser}: ${join.status} ${await join.text()}`);
  }

  async register(asUser: string): Promise<void> {
    const localpart = asUser.slice(1).split(':')[0];
    const reg = await this.f(`${this.base}/_matrix/client/v3/register`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ type: 'm.login.application_service', username: localpart }), signal: AbortSignal.timeout(10_000) });
    if (!reg.ok) {
      const b = (await reg.json().catch(() => ({}))) as { errcode?: string };
      if (b.errcode !== 'M_USER_IN_USE') throw new Error(`register ${asUser}: ${reg.status} ${b.errcode ?? ''}`);
    }
  }

  async sendEvent(roomId: string, asUser: string, type: string, content: Record<string, unknown>, txnId: string): Promise<string> {
    const url = `${this.base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(type)}/${encodeURIComponent(txnId)}?user_id=${encodeURIComponent(asUser)}`;
    const res = await this.f(url, { method: 'PUT', headers: this.headers(), body: JSON.stringify(content), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`homeserver answered ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { event_id: string }).event_id;
  }

  async roomState(roomId: string, asUser: string): Promise<{ type?: string; state_key?: string; content?: any }[]> {
    const url = `${this.base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state?user_id=${encodeURIComponent(asUser)}`;
    const res = await this.f(url, { headers: this.headers(false), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`room state of ${roomId}: ${res.status} ${await res.text()}`);
    return (await res.json()) as { type?: string; state_key?: string; content?: any }[];
  }

  /**
   * Create a NEOP room as `asUser`: private preset (invite-only), no m.room.encryption, people (and admins) at the
   * approve level, the app, bridges and other NEOPs below it. The caller binds it (PUT /api/chat/presence room_ids).
   */
  async createRoom(asUser: string, o: { people: string[]; nonPeople?: string[]; admins?: string[]; name?: string }): Promise<string> {
    await this.register(asUser);
    const levels = neopRoomPowerLevels({ people: o.people, admins: o.admins, nonPeople: [asUser, ...(o.nonPeople ?? [])] });
    const creationLevels = structuredClone(levels) as { users?: Record<string, number> };
    creationLevels.users = { ...(creationLevels.users ?? {}), [asUser]: 100 };
    const body = {
      preset: 'private_chat',
      visibility: 'private',
      ...(o.name ? { name: o.name } : {}),
      invite: [...new Set([...o.people, ...(o.admins ?? []), ...(o.nonPeople ?? [])])],
      initial_state: [{ type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } }],
      power_level_content_override: creationLevels,
    };
    const res = await this.f(`${this.base}/_matrix/client/v3/createRoom?user_id=${encodeURIComponent(asUser)}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`createRoom as ${asUser}: ${res.status} ${await res.text()}`);
    const roomId = ((await res.json()) as { room_id: string }).room_id;
    // Synapse writes creation state after the initial override. Demote the NEOP only once that work is complete;
    // this must be the last state event so the NEOP can never raise itself or weaken approval controls later.
    const locked = await this.f(`${this.base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels/?user_id=${encodeURIComponent(asUser)}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(levels),
      signal: AbortSignal.timeout(10_000),
    });
    if (!locked.ok) throw new Error(`lock room ${roomId} as ${asUser}: ${locked.status} ${await locked.text()}`);
    return roomId;
  }

  /** Why the room cannot be spoken in as `self` (contracts roomProblems), or []. */
  async problems(roomId: string, self: string, nonPeople: string[]): Promise<string[]> {
    return roomProblems(roomStateView(await this.roomState(roomId, self)), { self, nonPeople });
  }

  /** Matrix's own rule, for the runner's fail-safe: may `sender` post neos.neop.approve here? */
  async canApprove(roomId: string, self: string, sender: string): Promise<boolean> {
    return canPost(roomStateView(await this.roomState(roomId, self)), sender, 'neos.neop.approve');
  }
}

export interface AppserviceSink {
  /** A typed neos.neop.* event. */
  onTyped(ev: { event_id: string; room_id: string; sender: string; type: string; content: any }): Promise<string>;
  /** A plain m.text (reply fallback already stripped). */
  onMessage(ev: { event_id: string; room_id: string; sender: string; body: string; in_reply_to: string | null }): Promise<string>;
  /** Is this Matrix id one of our names (the homeserver asks before it creates one)? */
  isOurs(userId: string): Promise<boolean>;
}

/** /_matrix/app/v1/* on the backend: the homeserver's pushes, checked against the hs_token. */
export function appserviceRoutes(sink: AppserviceSink, cfg: Pick<AppserviceConfig, 'hsToken'>, log: (m: string, e?: Record<string, unknown>) => void = () => {}): Hono {
  const app = new Hono();
  const authed = (c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } }) => {
    const h = c.req.header('authorization');
    return tokenOk(h?.startsWith('Bearer ') ? h.slice(7) : c.req.query('access_token'), cfg.hsToken);
  };
  const forbidden = (c: any) => c.json({ errcode: 'M_FORBIDDEN', error: 'bad hs_token' }, 403);

  const transactions = async (c: any) => {
    if (!authed(c)) return forbidden(c);
    const body = (await c.req.json().catch(() => ({}))) as { events?: any[] };
    let retry = false;
    for (const ev of Array.isArray(body.events) ? body.events : []) {
      try {
        if (typeof ev?.event_id !== 'string' || typeof ev.room_id !== 'string' || typeof ev.sender !== 'string') continue;
        if (isTypedEventType(ev.type)) {
          await sink.onTyped({ event_id: ev.event_id, room_id: ev.room_id, sender: ev.sender, type: ev.type, content: ev.content ?? {} });
          continue;
        }
        if (ev.type !== 'm.room.message' || ev.content?.msgtype !== 'm.text' || typeof ev.content?.body !== 'string' || !ev.content.body.trim()) continue;
        await sink.onMessage({
          event_id: ev.event_id,
          room_id: ev.room_id,
          sender: ev.sender,
          body: stripReplyFallback(ev.content.body).trim().slice(0, 8000),
          in_reply_to: ev.content['m.relates_to']?.['m.in_reply_to']?.event_id ?? null,
        });
      } catch (e) {
        // Malformed/nonretryable events retain their existing handling. An atomic bus update failure must be retried;
        // already committed update events are deduplicated when the homeserver redelivers the transaction.
        if (e instanceof RetryableInboundError) retry = true;
        log('an event could not be handled', { event: ev?.event_id, e: String((e as Error)?.message ?? e).slice(0, 200) });
      }
    }
    return retry ? c.json({ errcode: 'M_UNKNOWN', error: 'durable update not committed; retry transaction' }, 503) : c.json({});
  };
  app.put('/_matrix/app/v1/transactions/:txnId', transactions);
  app.put('/transactions/:txnId', transactions); // legacy path some homeserver versions still use

  // The homeserver asks whether users/rooms in our namespace exist.
  const user = async (c: any) => (authed(c) ? ((await sink.isOurs(c.req.param('userId'))) ? c.json({}) : c.json({ errcode: 'M_NOT_FOUND' }, 404)) : forbidden(c));
  app.get('/_matrix/app/v1/users/:userId', user);
  app.get('/users/:userId', user);
  const room = (c: any) => (authed(c) ? c.json({ errcode: 'M_NOT_FOUND' }, 404) : forbidden(c));
  app.get('/_matrix/app/v1/rooms/:alias', room);
  app.get('/rooms/:alias', room);
  app.post('/_matrix/app/v1/ping', (c) => (authed(c) ? c.json({}) : forbidden(c)));
  return app;
}
