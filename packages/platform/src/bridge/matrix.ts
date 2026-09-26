// Matrix appservice adapter for the chat bridge (Application Service API v1).
//   inbound : the homeserver PUTs /_matrix/app/v1/transactions/{txnId} with hs_token
//   outbound: PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}?user_id=@neop_…
//             with as_token, as m.notice (bots do not answer notices: no loops)
// Registration: deploy/appservice.yaml claims the @neop_.* namespace.

import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { ChatBridge, RoomTransport } from './bridge.ts';

export interface MatrixConfig {
  homeserverUrl: string;
  serverName: string;
  /** Token the homeserver presents to us. */
  hsToken: string;
  /** Token we present to the homeserver. */
  asToken: string;
}

function tokenOk(given: string | undefined | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Strip the quoted fallback Matrix clients put in front of a reply. */
export function stripReplyFallback(body: string): string {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith('> ')) i++;
  if (i > 0 && lines[i] === '') i++;
  return lines.slice(i).join('\n');
}

export class MatrixTransport implements RoomTransport {
  readonly cfg: MatrixConfig;
  constructor(cfg: MatrixConfig) {
    this.cfg = cfg;
  }
  async send(roomId: string, asUser: string, body: string, txnId: string): Promise<{ event_id: string }> {
    const url =
      `${this.cfg.homeserverUrl.replace(/\/$/, '')}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}` +
      `/send/m.room.message/${encodeURIComponent(txnId)}?user_id=${encodeURIComponent(asUser)}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { authorization: `Bearer ${this.cfg.asToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'm.notice', body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`homeserver answered ${res.status}: ${await res.text()}`);
    return (await res.json()) as { event_id: string };
  }
}

export function matrixAppservice(bridge: ChatBridge, cfg: MatrixConfig): Hono {
  const app = new Hono();
  const authed = (c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } }) => {
    const h = c.req.header('authorization');
    return tokenOk(h?.startsWith('Bearer ') ? h.slice(7) : c.req.query('access_token'), cfg.hsToken);
  };

  app.put('/_matrix/app/v1/transactions/:txnId', async (c) => {
    if (!authed(c)) return c.json({ errcode: 'M_FORBIDDEN', error: 'bad hs_token' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { events?: any[] };
    for (const ev of body.events ?? []) {
      if (ev?.type !== 'm.room.message' || ev.content?.msgtype !== 'm.text' || typeof ev.content?.body !== 'string') continue;
      await bridge.onMessage({
        event_id: ev.event_id,
        room_id: ev.room_id,
        sender: ev.sender,
        body: stripReplyFallback(ev.content.body),
        in_reply_to: ev.content['m.relates_to']?.['m.in_reply_to']?.event_id ?? null,
      });
    }
    return c.json({});
  });

  // The homeserver asks whether users/rooms in our namespace exist.
  app.get('/_matrix/app/v1/users/:userId', (c) => (authed(c) ? (bridge.isOurs(c.req.param('userId')) ? c.json({}) : c.json({ errcode: 'M_NOT_FOUND' }, 404)) : c.json({ errcode: 'M_FORBIDDEN' }, 403)));
  app.get('/_matrix/app/v1/rooms/:alias', (c) => (authed(c) ? c.json({ errcode: 'M_NOT_FOUND' }, 404) : c.json({ errcode: 'M_FORBIDDEN' }, 403)));
  return app;
}
