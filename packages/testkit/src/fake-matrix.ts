// A FAKE MATRIX HOMESERVER shared by SEVERAL client accounts (v3 S5: NeuralChat's own account and the NEOP's own
// account talk to each other through it, each with its own token and /sync). In memory, through an injected fetch —
// no network. What each account's /sync returns follows Matrix: an invite addressed to it, and the timeline of every
// room it has joined — on joining, the room's history so far (as a real homeserver's join sync carries it).
//
//   const mx = fakeMatrix({ serverName: 'hs.test' })
//   const t = mx.account('@ledger:hs.test')       → its access token
//   mx.fetchImpl                                    → pass as each client's fetchImpl
//   mx.typed(room?, type?) / mx.events(room?)       → what was posted
//   mx.redeliver(eventId)                           → the same event delivered again to every member (Matrix may)
//   mx.down(true|false)                             → every request fails (503) while down: a homeserver outage

import { randomUUID } from 'node:crypto';

export interface FakeMatrixEvent {
  event_id: string;
  room_id: string;
  sender: string;
  type: string;
  content: any;
  origin_server_ts: number;
  txn_id?: string;
}

export interface FakeMatrix {
  serverName: string;
  fetchImpl: (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; arrayBuffer(): Promise<ArrayBuffer> }>;
  /** v3 S9: files uploaded to the media store (mxc://<server>/<id> → bytes, type, uploader). */
  media: Map<string, { bytes: Buffer; type: string; by: string }>;
  account(mxid: string): string;
  rooms: Map<string, { members: Set<string>; invited: Set<string>; events: FakeMatrixEvent[]; direct: boolean; creator: string }>;
  events(room?: string): FakeMatrixEvent[];
  typed(room?: string, type?: string): FakeMatrixEvent[];
  redeliver(eventId: string): void;
  down(on: boolean): void;
  /** Requests made, by path kind (e.g. 'send', 'sync', 'createRoom'). */
  readonly counts: Record<string, number>;
}

export function fakeMatrix(o: { serverName?: string } = {}): FakeMatrix {
  const server = o.serverName ?? 'hs.test';
  const tokens = new Map<string, string>(); // token → account
  const rooms: FakeMatrix['rooms'] = new Map();
  const queues = new Map<string, { kind: 'invite' | 'timeline'; room: string; ev: any }[]>(); // per account, what /sync delivers
  const txns = new Map<string, string>();
  const counts: Record<string, number> = {};
  const all: FakeMatrixEvent[] = [];
  const waiters = new Set<() => void>();
  const media: FakeMatrix['media'] = new Map();
  let isDown = false;
  let n = 0;
  const wake = () => {
    for (const w of [...waiters]) w();
  };
  const q = (acct: string) => {
    if (!queues.has(acct)) queues.set(acct, []);
    return queues.get(acct)!;
  };
  const post = (room: string, sender: string, type: string, content: any, txn?: string): FakeMatrixEvent => {
    const ev: FakeMatrixEvent = { event_id: `$m${++n}-${randomUUID().slice(0, 6)}:${server}`, room_id: room, sender, type, content, origin_server_ts: Date.now(), ...(txn ? { txn_id: txn } : {}) };
    const r = rooms.get(room)!;
    r.events.push(ev);
    all.push(ev);
    for (const m of r.members) q(m).push({ kind: 'timeline', room, ev });
    wake();
    return ev;
  };

  async function fetchImpl(url: string, init: any = {}) {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname);
    const method = init.method ?? 'GET';
    const isUpload = p === '/_matrix/media/v3/upload';
    const body = init.body && !isUpload ? JSON.parse(init.body) : null;
    const reply = (status: number, j: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => j, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(j)).buffer as ArrayBuffer });
    const kind = p.includes('/send/') ? 'send' : (p.split('/').filter(Boolean).at(-1) ?? p);
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (isDown) return reply(503, { errcode: 'M_UNKNOWN', error: 'homeserver is down' });
    const auth = String(init.headers?.Authorization ?? init.headers?.authorization ?? '').replace(/^Bearer /, '');
    const me = tokens.get(auth);
    if (!me) return reply(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'unknown token' });
    if (p === '/_matrix/client/v3/account/whoami') return reply(200, { user_id: me });
    // v3 S9 · the media repository: an upload (any account), an authenticated download (any account of this server).
    if (isUpload && method === 'POST') {
      const id = `m${++n}${randomUUID().replace(/-/g, '').slice(0, 10)}`;
      const bytes = Buffer.from(init.body instanceof Uint8Array ? init.body : typeof init.body === 'string' ? Buffer.from(init.body) : new Uint8Array(init.body ?? []));
      media.set(`mxc://${server}/${id}`, { bytes, type: String(init.headers?.['content-type'] ?? 'application/octet-stream'), by: me });
      return reply(200, { content_uri: `mxc://${server}/${id}` });
    }
    let md: RegExpMatchArray | null;
    if ((md = p.match(/^\/_matrix\/client\/v1\/media\/download\/([^/]+)\/([^/]+)$/)) && method === 'GET') {
      const f = media.get(`mxc://${md[1]}/${md[2]}`);
      if (!f) return reply(404, { errcode: 'M_NOT_FOUND', error: 'no such media' });
      const ab = f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) as ArrayBuffer;
      return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => ab };
    }
    if (p === '/_matrix/client/v3/sync') {
      const since = u.searchParams.get('since');
      const seq = since ? Number(since.slice(1)) : 0;
      const timeout = Number(u.searchParams.get('timeout') ?? 0);
      if (since && seq >= q(me).length && timeout > 0) {
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
      const list = q(me);
      const out: any = { next_batch: `s${list.length}`, rooms: { join: {}, invite: {} } };
      for (const [i, e] of list.entries()) {
        if (i < seq) continue;
        if (e.kind === 'invite') out.rooms.invite[e.room] = { invite_state: { events: [e.ev] } };
        else {
          out.rooms.join[e.room] ??= { timeline: { events: [] } };
          const { room_id: _r, ...ev } = e.ev; // a sync timeline event carries no room_id
          out.rooms.join[e.room].timeline.events.push(ev);
        }
      }
      return reply(200, out);
    }
    if (p === '/_matrix/client/v3/createRoom' && method === 'POST') {
      const id = `!x${++n}-${randomUUID().slice(0, 6)}:${server}`;
      rooms.set(id, { members: new Set([me]), invited: new Set(body?.invite ?? []), events: [], direct: !!body?.is_direct, creator: me });
      for (const who of body?.invite ?? []) {
        q(who).push({ kind: 'invite', room: id, ev: { type: 'm.room.member', state_key: who, sender: me, content: { membership: 'invite', is_direct: !!body?.is_direct } } });
      }
      wake();
      return reply(200, { room_id: id });
    }
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/_matrix\/client\/v3\/(?:rooms\/([^/]+)\/join|join\/([^/]+))$/)) && method === 'POST') {
      const id = (m[1] ?? m[2])!;
      const r = rooms.get(id);
      if (!r) return reply(404, { errcode: 'M_NOT_FOUND', error: 'no such room' });
      if (!r.members.has(me) && !r.invited.has(me)) return reply(403, { errcode: 'M_FORBIDDEN', error: 'not invited' });
      r.invited.delete(me);
      if (!r.members.has(me)) {
        r.members.add(me);
        for (const ev of r.events) q(me).push({ kind: 'timeline', room: id, ev }); // the join sync carries the history
        wake();
      }
      return reply(200, { room_id: id });
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
      const key = `${me}|${m[1]}|${m[3]}`;
      if (txns.has(key)) return reply(200, { event_id: txns.get(key) }); // a resend with the same txn id is the same event
      if (!rooms.get(m[1]!)?.members.has(me)) return reply(403, { errcode: 'M_FORBIDDEN', error: 'not in the room' });
      const ev = post(m[1]!, me, m[2]!, body, m[3]);
      txns.set(key, ev.event_id);
      return reply(200, { event_id: ev.event_id });
    }
    return reply(404, { errcode: 'M_UNRECOGNIZED', error: `${method} ${p}` });
  }

  return {
    serverName: server,
    fetchImpl,
    rooms,
    counts,
    media,
    account(mxid) {
      for (const [t, a] of tokens) if (a === mxid) return t;
      const t = `tok-${mxid.slice(1).split(':')[0]}-${randomUUID().slice(0, 8)}`;
      tokens.set(t, mxid);
      return t;
    },
    events: (room) => all.filter((e) => !room || e.room_id === room),
    typed: (room, type) => all.filter((e) => e.type.startsWith('neos.neop.') && (!room || e.room_id === room) && (!type || e.type === type)),
    redeliver(eventId) {
      const ev = all.find((e) => e.event_id === eventId);
      if (!ev) throw new Error(`no event ${eventId}`);
      for (const mbr of rooms.get(ev.room_id)!.members) q(mbr).push({ kind: 'timeline', room: ev.room_id, ev });
      wake();
    },
    down(on) {
      isDown = on;
      wake();
    },
  };
}
