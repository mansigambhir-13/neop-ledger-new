// ROOMS SETUP · v3 §8–§9, V3 migration stage S6 (docs/RUNBOOK.md "Bus room setup"). Idempotent: run it again and
// it finds what it made (by room alias, and by what each app's schema already holds) and only fills what is missing.
//
// For one company and its apps that run with their own presence (NEOP_PRESENCE=appservice):
//   #<app>-<co>      each app's own room — people and the app; the app speaks there as its own name
//   #neop-bus-<co>   the company's bus room — apps only: typed task · ask · answer · done · note between NEOPs
// Every room is invite-only (private preset), never end-to-end encrypted (audit needs the plaintext), with v3 power
// levels: people 50, NEOPs 20, the reasoning agent 10; neos.neop.approve needs 50 (people only), task and answer
// 10, ask · propose · done · note 20 (contracts v3RoomPowerLevels). Each room is created by the app's own name (its
// appservice as_token, ?user_id=), the other apps are invited, and each app's backend joins when it binds the room.
// The room ids go into each app's <schema>.installs through the platform (PUT /api/chat/presence → the neos_desk
// write-through): room_ids, bus_room_id, and bus_peers (the other apps on the bus: Matrix id → app key) — the only
// senders an app ever acts on in the bus room.
//
//   tsx scripts/rooms-setup.ts --company <slug> --app ledger=/run/secrets/ledger_as_token --app marketing=/run/…
//        [--person @priya:acme.example …] [--admin @ops:acme.example …] [--agent @neuralchat_acme:acme.example]
//
//   NEOS_URL                         the platform (its admin API)
//   NEOS_ADMIN_TOKEN[_FILE]          an admin of the company (PUT /api/chat/presence is admin-only, audited)
//   NEOP_MATRIX_HOMESERVER_URL       the homeserver's client-server URL
// Each app's Matrix name must already be set (PUT /api/chat/presence {app, matrix_user}; scripts/deploy.sh does it).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v3RoomPowerLevels } from '@neop/template';

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface RoomsSetupOptions {
  neosUrl: string;
  adminToken: string;
  homeserverUrl: string;
  /** The company's short name (room aliases: #<app>-<co>, #neop-bus-<co>). */
  company: string;
  /** The apps with their own presence here, and each one's appservice as_token. */
  apps: { app: string; asToken: string }[];
  /** People invited to each app's own room (level 50). */
  people?: string[];
  /** Room admins (level 100: may change the room's settings). */
  admins?: string[];
  /** The reasoning agent (level 10: may post task and answer, never approve). */
  agents?: string[];
  fetchImpl?: FetchLike;
  log?: (msg: string) => void;
}

export interface RoomsSetupResult {
  bus_room_id: string;
  rooms: Record<string, string>;
  created: string[];
}

const ALIAS_PART = /^[a-z0-9][a-z0-9-]{0,62}$/;

export async function roomsSetup(o: RoomsSetupOptions): Promise<RoomsSetupResult> {
  const f: FetchLike = o.fetchImpl ?? (fetch as unknown as FetchLike);
  const log = o.log ?? (() => {});
  const hs = o.homeserverUrl.replace(/\/+$/, '');
  const neos = o.neosUrl.replace(/\/+$/, '');
  if (!ALIAS_PART.test(o.company)) throw new Error(`company must be the company's short name (${ALIAS_PART}), got ${o.company}`);
  if (!o.apps.length) throw new Error('at least one app');
  const created: string[] = [];

  const api = async (method: string, p: string, body?: unknown) => {
    const r = await f(`${neos}${p}`, { method, headers: { authorization: `Bearer ${o.adminToken}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  const matrix = async (asToken: string, method: string, p: string, body?: unknown) => {
    const r = await f(`${hs}${p}`, { method, headers: { authorization: `Bearer ${asToken}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  };

  // Who each app is here (its name is set before rooms are made).
  const apps: { app: string; asToken: string; user: string; server: string; room_ids: string[]; bus_room_id: string | null }[] = [];
  for (const a of o.apps) {
    const id = await api('GET', `/api/chat/presence?app=${encodeURIComponent(a.app)}`);
    if (!id?.matrix_user) throw new Error(`${a.app} has no Matrix name at this company yet: PUT /api/chat/presence {app, matrix_user} first`);
    apps.push({ app: a.app, asToken: a.asToken, user: id.matrix_user, server: String(id.matrix_user).split(':').slice(1).join(':'), room_ids: id.room_ids ?? [], bus_room_id: id.bus_room_id ?? null });
  }
  const as = (a: (typeof apps)[number], method: string, p: string, body?: unknown) => matrix(a.asToken, method, `${p}${p.includes('?') ? '&' : '?'}user_id=${encodeURIComponent(a.user)}`, body);

  const register = async (a: (typeof apps)[number]) => {
    const r = await matrix(a.asToken, 'POST', '/_matrix/client/v3/register', { type: 'm.login.application_service', username: a.user.slice(1).split(':')[0] });
    if (!r.ok && r.body?.errcode !== 'M_USER_IN_USE') throw new Error(`register ${a.user}: ${r.status} ${r.body?.errcode ?? ''}`);
  };
  const resolve = async (a: (typeof apps)[number], alias: string): Promise<string | null> => {
    const r = await matrix(a.asToken, 'GET', `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`);
    return r.ok && typeof r.body?.room_id === 'string' ? r.body.room_id : null;
  };
  /** The room by its alias, or a new one made by `a` (invite-only, not encrypted, v3 levels). */
  const room = async (a: (typeof apps)[number], localAlias: string, name: string, invite: string[], levels: Record<string, unknown>): Promise<string> => {
    const alias = `#${localAlias}:${a.server}`;
    const found = await resolve(a, alias);
    if (found) return found;
    const r = await as(a, 'POST', '/_matrix/client/v3/createRoom', {
      preset: 'private_chat',
      visibility: 'private',
      name,
      room_alias_name: localAlias,
      invite: [...new Set(invite.filter((u) => u !== a.user))],
      initial_state: [{ type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } }],
      power_level_content_override: levels,
    });
    if (!r.ok) {
      if (r.body?.errcode === 'M_ROOM_IN_USE') {
        const again = await resolve(a, alias);
        if (again) return again;
      }
      throw new Error(`createRoom ${alias} as ${a.user}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    created.push(r.body.room_id);
    log(`created ${alias} (${r.body.room_id}) as ${a.user}`);
    return r.body.room_id as string;
  };
  const invite = async (a: (typeof apps)[number], roomId: string, user: string) => {
    // Already a member or already invited is fine: the homeserver answers 403 and nothing changes.
    await as(a, 'POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, { user_id: user }).catch(() => null);
  };

  for (const a of apps) await register(a);

  // Each app's own room (#<app>-<co>): people and the app (and the reasoning agent, below approve).
  const rooms: Record<string, string> = {};
  for (const a of apps) {
    const own = a.room_ids[0] ?? (await room(a, `${a.app}-${o.company}`, `${a.app} · ${o.company}`, [...(o.people ?? []), ...(o.admins ?? []), ...(o.agents ?? [])], v3RoomPowerLevels({ people: o.people, neops: [a.user], agents: o.agents, admins: o.admins })));
    rooms[a.app] = own;
    if (!a.room_ids.includes(own)) {
      await api('PUT', '/api/chat/presence', { app: a.app, room_ids: [own, ...a.room_ids] });
      log(`${a.app}: room ${own} bound`);
    }
  }

  // The bus (#neop-bus-<co>): apps only, made by the first app's name; every other app invited.
  const first = apps[0]!;
  const known = apps.map((a) => a.bus_room_id).find(Boolean) ?? null;
  const bus = known ?? (await room(first, `neop-bus-${o.company}`, `NEOP bus · ${o.company}`, [...apps.map((a) => a.user), ...(o.agents ?? []), ...(o.admins ?? [])], v3RoomPowerLevels({ neops: apps.map((a) => a.user), agents: o.agents, admins: o.admins })));
  for (const a of apps.slice(1)) await invite(first, bus, a.user);
  for (const a of apps) {
    const peers = Object.fromEntries(apps.filter((x) => x !== a).map((x) => [x.user, x.app]));
    await api('PUT', '/api/chat/presence', { app: a.app, bus_room_id: bus, bus_peers: peers });
  }
  log(`bus room ${bus}: ${apps.map((a) => a.app).join(', ')}`);
  return { bus_room_id: bus, rooms, created };
}

function secret(name: string): string {
  const file = process.env[`${name}_FILE`];
  return (file ? readFileSync(file, 'utf8') : (process.env[name] ?? '')).trim();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const many = (flag: string) => process.argv.flatMap((a, i) => (a === `--${flag}` && process.argv[i + 1] ? [process.argv[i + 1]!] : []));
  const company = many('company')[0];
  const apps = many('app').map((x) => {
    const [app, file] = x.split('=');
    if (!app || !file) throw new Error('--app <key>=<as_token file>');
    return { app, asToken: readFileSync(file, 'utf8').trim() };
  });
  const neosUrl = process.env.NEOS_URL ?? '';
  const adminToken = secret('NEOS_ADMIN_TOKEN');
  const homeserverUrl = process.env.NEOP_MATRIX_HOMESERVER_URL ?? '';
  if (!company || !apps.length || !neosUrl || !adminToken || !homeserverUrl) {
    console.error('usage: NEOS_URL=… NEOS_ADMIN_TOKEN[_FILE]=… NEOP_MATRIX_HOMESERVER_URL=… tsx scripts/rooms-setup.ts --company <slug> --app <key>=<as_token file> … [--person @…] [--admin @…] [--agent @…]');
    process.exit(2);
  }
  roomsSetup({ neosUrl, adminToken, homeserverUrl, company, apps, people: many('person'), admins: many('admin'), agents: many('agent'), log: (m) => console.log(m) })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(String(e?.message ?? e));
      process.exit(1);
    });
}
