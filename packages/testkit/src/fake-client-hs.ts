// A FAKE MATRIX HOMESERVER for the CLIENT road (packages/platform/src/bridge/client-sync.ts): one ordinary account
// signs in with an access token and pulls with /sync. In memory, through an injected fetch — no network. Ported
// from the handoff's tests/_fake-client-hs.mjs.
//
//   const hs = fakeClientHomeserver({ me: '@ledger:hs.test' })
//   hs.fetchImpl                          → pass as the client's fetchImpl
//   hs.invite(from, { also })             → a new room with `from` (and `also`) joined, and an invite for us → room id
//   hs.joinedRoom(other, { also })        → a room we are ALREADY in (history from before the client listened)
//   hs.say(room, sender, content, { ts }) → a timeline event the other member sent                     → the event
//   hs.expireToken()                      → every token is rejected (401 M_UNKNOWN_TOKEN)
//   hs.sent / hs.notices(room)            → what our account posted; hs.requests / hs.logins / hs.logouts → counters

import { randomUUID } from 'node:crypto';

export interface FakeClientEvent {
  event_id: string;
  sender: string;
  type: string;
  content: any;
  origin_server_ts: number;
  room_id: string;
  txn_id?: string;
}

export interface FakeClientHomeserver {
  me: string;
  token: string;
  fetchImpl: (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
  rooms: Map<string, { members: Set<string>; events: FakeClientEvent[] }>;
  sent: FakeClientEvent[];
  readonly requests: number;
  readonly logins: number;
  readonly logouts: number;
  invite(from: string, o?: { also?: string[] }): string;
  joinedRoom(other: string, o?: { also?: string[] }): string;
  say(room: string, sender: string, content: Record<string, unknown>, o?: { ts?: number }): FakeClientEvent;
  notices(room?: string): FakeClientEvent[];
  expireToken(): void;
}

export function fakeClientHomeserver(o: { me?: string; token?: string; whoamiAs?: string | null; serverName?: string } = {}): FakeClientHomeserver {
  const me = o.me ?? '@ledger:hs.test';
  const token = o.token ?? 'tok-initial';
  const server = o.serverName ?? me.split(':').slice(1).join(':');
  const tokens = new Set([token]);
  const rooms: FakeClientHomeserver['rooms'] = new Map();
  const log: { kind: 'invite' | 'timeline'; room: string; ev: any }[] = []; // what /sync delivers, in order
  const sent: FakeClientEvent[] = [];
  const txns = new Map<string, string>();
  let logins = 0;
  let logouts = 0;
  let requests = 0;
  let n = 0;
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const w of [...waiters]) w();
  };
  const newRoom = () => {
    const id = `!r${++n}-${randomUUID().slice(0, 6)}:${server}`;
    rooms.set(id, { members: new Set(), events: [] });
    return id;
  };
  const event = (room: string, sender: string, type: string, content: any, extra: Partial<FakeClientEvent> = {}): FakeClientEvent => ({
    event_id: `$e${++n}-${randomUUID().slice(0, 6)}:${server}`,
    sender,
    type,
    content,
    origin_server_ts: Date.now(),
    room_id: room,
    ...extra,
  });

  function syncBody(since: number) {
    const out: any = { next_batch: `s${log.length}`, rooms: { join: {}, invite: {} } };
    for (const [i, e] of log.entries()) {
      if (i < since) continue;
      if (e.kind === 'invite') out.rooms.invite[e.room] = { invite_state: { events: [e.ev] } };
      else {
        out.rooms.join[e.room] ??= { timeline: { events: [] } };
        const { room_id: _r, ...ev } = e.ev; // a sync timeline event carries no room_id
        out.rooms.join[e.room].timeline.events.push(ev);
      }
    }
    return out;
  }

  async function fetchImpl(url: string, init: any = {}) {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const reply = (status: number, j: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => j });
    requests++;
    if (p.endsWith('/logout') || p.endsWith('/logout/all')) {
      logouts++;
      return reply(200, {});
    }
    if (p === '/_matrix/client/v3/login') {
      logins++;
      return reply(403, { errcode: 'M_FORBIDDEN', error: 'no password logins here' });
    }
    const auth = String(init.headers?.Authorization ?? init.headers?.authorization ?? '').replace(/^Bearer /, '');
    if (!tokens.has(auth)) return reply(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'unknown token' });
    if (p === '/_matrix/client/v3/account/whoami') return reply(200, { user_id: o.whoamiAs ?? me });
    if (p === '/_matrix/client/v3/sync') {
      const since = u.searchParams.get('since');
      const seq = since ? Number(since.slice(1)) : 0;
      const timeout = Number(u.searchParams.get('timeout') ?? 0);
      if (since && seq >= log.length && timeout > 0) {
        await new Promise<void>((res) => {
          const t = setTimeout(done, Math.min(timeout, 150));
          function done() {
            clearTimeout(t);
            waiters.delete(done);
            res();
          }
          waiters.add(done);
          init.signal?.addEventListener('abort', done, { once: true });
        });
      }
      if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (!tokens.has(auth)) return reply(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'unknown token' });
      return reply(200, syncBody(seq));
    }
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/join$/)) && method === 'POST') {
      rooms.get(m[1]!)?.members.add(me);
      return reply(200, { room_id: m[1] });
    }
    if ((m = p.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/leave$/)) && method === 'POST') {
      rooms.get(m[1]!)?.members.delete(me);
      return reply(200, {});
    }
    if ((m = p.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/joined_members$/))) {
      const r = rooms.get(m[1]!);
      if (!r?.members.has(me)) return reply(403, { errcode: 'M_FORBIDDEN', error: 'not in the room' });
      return reply(200, { joined: Object.fromEntries([...r.members].map((x) => [x, {}])) });
    }
    if ((m = p.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/([^/]+)\/([^/]+)$/)) && method === 'PUT') {
      // A resend with the same transaction id is not posted twice, like a real homeserver.
      const key = `${m[1]}|${m[3]}`;
      if (txns.has(key)) return reply(200, { event_id: txns.get(key) });
      if (!rooms.get(m[1]!)?.members.has(me)) return reply(403, { errcode: 'M_FORBIDDEN', error: 'not in the room' });
      const ev = event(m[1]!, me, m[2]!, body, { txn_id: m[3] });
      rooms.get(m[1]!)!.events.push(ev);
      sent.push(ev);
      txns.set(key, ev.event_id);
      return reply(200, { event_id: ev.event_id });
    }
    return reply(404, { errcode: 'M_UNRECOGNIZED', error: `${method} ${p}` });
  }

  return {
    me,
    token,
    fetchImpl,
    rooms,
    sent,
    get requests() {
      return requests;
    },
    get logins() {
      return logins;
    },
    get logouts() {
      return logouts;
    },
    invite(from, { also = [] } = {}) {
      const id = newRoom();
      for (const x of [from, ...also]) rooms.get(id)!.members.add(x);
      log.push({ kind: 'invite', room: id, ev: { type: 'm.room.member', state_key: me, sender: from, content: { membership: 'invite', is_direct: true } } });
      wake();
      return id;
    },
    joinedRoom(other, { also = [] } = {}) {
      const id = newRoom();
      for (const x of [me, other, ...also]) rooms.get(id)!.members.add(x);
      return id;
    },
    say(room, sender, content, { ts } = {}) {
      const ev = event(room, sender, 'm.room.message', content, ts != null ? { origin_server_ts: ts } : {});
      rooms.get(room)?.events.push(ev);
      log.push({ kind: 'timeline', room, ev });
      wake();
      return ev;
    },
    notices: (room) => sent.filter((e) => e.type === 'm.room.message' && e.content?.msgtype === 'm.notice' && (!room || e.room_id === room)),
    expireToken() {
      tokens.clear();
      wake();
    },
  };
}
