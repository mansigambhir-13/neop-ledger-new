// Admin API for who may talk to an app in Matrix at this company (the allowlist the app's own presence reads) and the
// app's own Matrix name and rooms there. Admins only, every change audited. A PERSON entry must name a Matrix id
// already linked to someone in the company; a BRIDGE entry may name the person it relays for (acts_for). A
// bridge approves nothing, ever (v3 §5/§8/§16: only a person can say yes): `may_approve: true` is refused
// (400 bridge_cannot_approve) and migration 017 pins the column false.
//
//   GET    /api/chat/allowlist?app=ledger          → { entries: [{ app, matrix_id, kind, acts_for, user_id, dm_room }] }
//   PUT    /api/chat/allowlist                      { app, matrix_id, kind: 'person'|'bridge', acts_for? }
//   DELETE /api/chat/allowlist/:app/:matrix_id
//   GET    /api/chat/neuralchat                     → NeuralChat's own Matrix road and accounts at this company (v3 S5)
//   PUT    /api/users/:id/chat                      { matrix_user_id }
//   GET    /api/chat/presence?app=ledger           → { matrix_user, room_ids, agent_senders, agent_acts_for } (v3 S4)
//   PUT    /api/chat/presence                       { app, matrix_user?, room_ids? }   the NEOP's own name and rooms
// Every change here is written through to the app's own schema (Platform.syncChat, template t012), which is all
// a NEOP's own presence reads (v3 S9: there is no platform chat bridge; every NEOP speaks for itself).

import { Hono } from 'hono';
import type { Platform } from './platform.ts';

const MXID = /^@[^:\s]+:\S+$/;

export function chatRoutes(platform: Platform): Hono {
  const app = new Hono();
  const admin = async (c: any) => {
    const u = await platform.authUser(c.req.header('authorization'));
    if (!u) return { error: c.json({ error: { code: 'unauthenticated', message: 'sign in required' } }, 401) };
    if (u.role !== 'admin') return { error: c.json({ error: { code: 'denied', message: 'admins only' } }, 403) };
    return { u };
  };
  const bad = (c: any, message: string) => c.json({ error: { code: 'bad_request', message } }, 400);

  app.get('/api/chat/allowlist', async (c) => {
    const a = await admin(c);
    if (a.error) return a.error;
    const appKey = c.req.query('app') ?? null;
    const { rows } = await platform.db.query(
      `select l.app_key as app, l.matrix_id, l.kind, l.acts_for, u.id as user_id, l.added_at
         from neos.chat_allowlist l
         left join neos.users u on l.kind = 'person' and u.matrix_user_id = l.matrix_id and u.company_id = l.company_id
        where l.company_id = $1 and ($2::text is null or l.app_key = $2) order by l.app_key, l.kind, l.matrix_id`,
      [a.u!.company_id, appKey],
    );
    return c.json({ entries: rows });
  });

  app.put('/api/chat/allowlist', async (c) => {
    const a = await admin(c);
    if (a.error) return a.error;
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.app !== 'string' || typeof b.matrix_id !== 'string' || !MXID.test(b.matrix_id)) return bad(c, 'app and a Matrix id like @name:server');
    if (b.kind !== 'person' && b.kind !== 'bridge') return bad(c, "kind is 'person' or 'bridge'");
    // v3 §5/§8/§16: nothing approves on a person's behalf. A person approves on the desk or in their own DM.
    if (b.may_approve != null && b.may_approve !== false) {
      return c.json({ error: { code: 'bridge_cannot_approve', message: "nothing approves on a person's behalf: a person says yes on the desk or in their own DM" } }, 400);
    }
    try {
      await platform.assertInstalled(b.app, a.u!.company_id);
    } catch (e: any) {
      return c.json({ error: { code: e.code ?? 'not_installed', message: String(e.message ?? e) } }, e.status ?? 403);
    }
    let actsFor: string | null = null;
    if (b.kind === 'person') {
      if (b.acts_for != null) return bad(c, 'only a bridge relays for someone');
      const linked = await platform.db.query('select 1 from neos.users where matrix_user_id = $1 and company_id = $2', [b.matrix_id, a.u!.company_id]);
      if (!linked.rowCount) return bad(c, 'link that Matrix id to a person in your company first (PUT /api/users/:id/chat)');
    } else {
      const person = await platform.db.query<{ matrix_user_id: string | null }>('select matrix_user_id from neos.users where matrix_user_id = $1', [b.matrix_id]);
      if (person.rowCount) return bad(c, 'that Matrix id belongs to a person; a person is allowlisted as a person');
      if (b.acts_for != null) {
        if (typeof b.acts_for !== 'string' || !/^[0-9a-f-]{36}$/i.test(b.acts_for)) return bad(c, 'acts_for is a person id');
        const same = await platform.db.query('select 1 from neos.users where id = $1 and company_id = $2', [b.acts_for, a.u!.company_id]);
        if (!same.rowCount) return c.json({ error: { code: 'not_found', message: 'no such person in your company' } }, 404);
        actsFor = b.acts_for;
      }
    }
    await platform.db.query(
      `insert into neos.chat_allowlist (company_id, app_key, matrix_id, kind, acts_for, added_by) values ($1,$2,$3,$4,$5,$6)
       on conflict (company_id, app_key, matrix_id) do update set kind = excluded.kind, acts_for = excluded.acts_for, added_by = excluded.added_by, added_at = now()`,
      [a.u!.company_id, b.app, b.matrix_id, b.kind, actsFor, a.u!.id],
    );
    await platform.audit({
      company_id: a.u!.company_id,
      actor: `user:${a.u!.id}`,
      app_key: b.app,
      action: 'chat.allowlist_set',
      outcome: b.kind,
      detail: { matrix_id: b.matrix_id, acts_for: actsFor },
    });
    await platform.syncChat(a.u!.company_id, b.app); // v3 S4: the app's own presence reads its schema, never neos
    return c.json({ ok: true, app: b.app, matrix_id: b.matrix_id, kind: b.kind, acts_for: actsFor });
  });

  app.delete('/api/chat/allowlist/:app/:matrix_id', async (c) => {
    const a = await admin(c);
    if (a.error) return a.error;
    const r = await platform.db.query('delete from neos.chat_allowlist where company_id = $1 and app_key = $2 and matrix_id = $3', [a.u!.company_id, c.req.param('app'), c.req.param('matrix_id')]);
    if (!r.rowCount) return c.json({ error: { code: 'not_found', message: 'not on the allowlist' } }, 404);
    await platform.audit({ company_id: a.u!.company_id, actor: `user:${a.u!.id}`, app_key: c.req.param('app'), action: 'chat.allowlist_removed', outcome: c.req.param('matrix_id') });
    await platform.syncChat(a.u!.company_id, c.req.param('app'));
    return c.json({ ok: true });
  });

  // v3 S5 · NeuralChat's own Matrix road at this company: its name here and, on the client road, how its account is doing.
  app.get('/api/chat/neuralchat', async (c) => {
    const a = await admin(c);
    if (a.error) return a.error;
    const nc = platform.neuralchat;
    if (!nc) return c.json({ road: null, account: null, accounts: [] });
    const st = nc.status();
    return c.json({ road: st.road, account: await nc.identityFor(a.u!.company_id), accounts: st.accounts.filter((x) => x.company_id === a.u!.company_id) });
  });

  // v3 S4 · NEOP presence: the app's own Matrix name at this company and its rooms live in the app's schema
  // (<app>.installs.matrix_user / room_ids); its backend speaks as that name. Admins only, audited.
  app.get('/api/chat/presence', async (c) => {
    const a = await admin(c);
    if (a.error) return a.error;
    const appKey = c.req.query('app') ?? '';
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(appKey)) return bad(c, 'app required');
    try {
      await platform.assertInstalled(appKey, a.u!.company_id);
    } catch (e: any) {
      return c.json({ error: { code: e.code ?? 'not_installed', message: String(e.message ?? e) } }, e.status ?? 403);
    }
    const id = await platform.boards.readChatIdentity(appKey, a.u!.company_id);
    if (!id) return c.json({ error: { code: 'no_app_schema', message: `${appKey} has no presence tables on this database` } }, 409);
    return c.json({ app: appKey, ...id });
  });

  app.put('/api/chat/presence', async (c) => {
    const a = await admin(c);
    if (a.error) return a.error;
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.app !== 'string' || !/^[a-z][a-z0-9_]{0,40}$/.test(b.app)) return bad(c, 'app required');
    if (b.matrix_user !== undefined && b.matrix_user !== null && (typeof b.matrix_user !== 'string' || !MXID.test(b.matrix_user))) return bad(c, 'matrix_user is a Matrix id like @neop_ledger_acme:server');
    if (b.room_ids !== undefined && (!Array.isArray(b.room_ids) || b.room_ids.length > 20 || b.room_ids.some((r) => typeof r !== 'string' || !/^![^:\s]+:\S+$/.test(r)))) return bad(c, 'room_ids is a list of room ids like !abc:server');
    // v3 S6: the company's bus room (#neop-bus-<co>) and the other apps on it (Matrix id → app key), from rooms-setup.
    if (b.bus_room_id !== undefined && b.bus_room_id !== null && (typeof b.bus_room_id !== 'string' || !/^![^:\s]+:\S+$/.test(b.bus_room_id))) return bad(c, 'bus_room_id is a room id like !abc:server');
    if (
      b.bus_peers !== undefined &&
      (!b.bus_peers ||
        typeof b.bus_peers !== 'object' ||
        Array.isArray(b.bus_peers) ||
        Object.keys(b.bus_peers).length > 50 ||
        Object.entries(b.bus_peers as Record<string, unknown>).some(([k, v]) => !MXID.test(k) || typeof v !== 'string' || !/^[a-z][a-z0-9_]{0,40}$/.test(v)))
    )
      return bad(c, 'bus_peers maps Matrix ids to app keys, like {"@neop_marketing_acme:server": "marketing"}');
    if (b.matrix_user === undefined && b.room_ids === undefined && b.bus_room_id === undefined && b.bus_peers === undefined) return bad(c, 'matrix_user and/or room_ids');
    // The app's name is its own: another app's (or another company's) install may not already speak as it.
    try {
      await platform.setChatIdentity(
        a.u!.company_id,
        b.app,
        {
          matrix_user: b.matrix_user as string | null | undefined,
          room_ids: b.room_ids as string[] | undefined,
          bus_room_id: b.bus_room_id as string | null | undefined,
          bus_peers: b.bus_peers as Record<string, string> | undefined,
        },
        `user:${a.u!.id}`,
      );
    } catch (e: any) {
      return c.json({ error: { code: e.code ?? 'chat_error', message: String(e.message ?? e) } }, e.status ?? 500);
    }
    await platform.audit({ company_id: a.u!.company_id, actor: `user:${a.u!.id}`, app_key: b.app, action: 'chat.presence_set', outcome: 'ok', detail: { matrix_user: b.matrix_user ?? null, room_ids: b.room_ids ?? null, ...(b.bus_room_id !== undefined ? { bus_room_id: b.bus_room_id } : {}), ...(b.bus_peers !== undefined ? { bus_peers: b.bus_peers } : {}) } });
    return c.json({ ok: true, app: b.app, ...(await platform.boards.readChatIdentity(b.app, a.u!.company_id)) });
  });

  // A person's own Matrix id (so the apps know them when they write in a room or a DM).
  app.put('/api/users/:id/chat', async (c) => {
    const a = await admin(c);
    if (a.error) return a.error;
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.matrix_user_id !== 'string' || !MXID.test(b.matrix_user_id)) return bad(c, 'a chat id like @priya:server');
    const r = await platform.db.query('update neos.users set matrix_user_id = $3 where id = $1 and company_id = $2', [c.req.param('id'), a.u!.company_id, b.matrix_user_id]);
    if (!r.rowCount) return c.json({ error: { code: 'not_found', message: 'no such person in your company' } }, 404);
    await platform.audit({ company_id: a.u!.company_id, actor: `user:${a.u!.id}`, action: 'chat.user_linked', outcome: b.matrix_user_id });
    await platform.syncChat(a.u!.company_id);
    return c.json({ ok: true });
  });
  return app;
}
