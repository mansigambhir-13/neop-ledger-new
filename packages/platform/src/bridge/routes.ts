// Admin API for the Matrix client road: who may DM an app's account at this company (the allowlist), and how
// each configured account is doing. Admins only, every change audited. A PERSON entry must name a Matrix id
// already linked to someone in the company; a BRIDGE entry may name the person it relays for (acts_for) —
// a bridge never approves anything, whatever it says.
//
//   GET    /api/chat/allowlist?app=ledger          → { entries: [{ app, matrix_id, kind, acts_for, user_id, dm_room }] }
//   PUT    /api/chat/allowlist                      { app, matrix_id, kind: 'person'|'bridge', acts_for? }
//   DELETE /api/chat/allowlist/:app/:matrix_id
//   GET    /api/chat/client                         → { accounts: [status…] } for this company
//   PUT    /api/users/:id/chat                      { matrix_user_id }   (only when no appservice bridge mounts it)

import { Hono } from 'hono';
import type { Platform } from '../platform.ts';
import type { ChatClient } from './client-sync.ts';

const MXID = /^@[^:\s]+:\S+$/;

export function chatClientRoutes(platform: Platform, clients: () => ChatClient[], opts: { linkUsers?: boolean } = {}): Hono {
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
      `select l.app_key as app, l.matrix_id, l.kind, l.acts_for, u.id as user_id, d.room_id as dm_room, l.added_at
         from neos.chat_allowlist l
         left join neos.users u on l.kind = 'person' and u.matrix_user_id = l.matrix_id and u.company_id = l.company_id
         left join neos.chat_accounts ac on ac.company_id = l.company_id and ac.app_key = l.app_key
         left join neos.chat_dms d on d.account = ac.account and d.peer = l.matrix_id
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
    await platform.gateway.audit({ company_id: a.u!.company_id, actor: `user:${a.u!.id}`, app_key: b.app, action: 'chat.allowlist_set', outcome: b.kind, detail: { matrix_id: b.matrix_id, acts_for: actsFor } });
    return c.json({ ok: true, app: b.app, matrix_id: b.matrix_id, kind: b.kind, acts_for: actsFor });
  });

  app.delete('/api/chat/allowlist/:app/:matrix_id', async (c) => {
    const a = await admin(c);
    if (a.error) return a.error;
    const r = await platform.db.query('delete from neos.chat_allowlist where company_id = $1 and app_key = $2 and matrix_id = $3', [a.u!.company_id, c.req.param('app'), c.req.param('matrix_id')]);
    if (!r.rowCount) return c.json({ error: { code: 'not_found', message: 'not on the allowlist' } }, 404);
    await platform.gateway.audit({ company_id: a.u!.company_id, actor: `user:${a.u!.id}`, app_key: c.req.param('app'), action: 'chat.allowlist_removed', outcome: c.req.param('matrix_id') });
    return c.json({ ok: true });
  });

  app.get('/api/chat/client', async (c) => {
    const a = await admin(c);
    if (a.error) return a.error;
    const live = new Map(clients().map((x) => [x.cfg.account, x.status()]));
    const { rows } = await platform.db.query('select account, app_key as app, stopped_reason, updated_at from neos.chat_accounts where company_id = $1 order by account', [a.u!.company_id]);
    return c.json({
      accounts: rows.map((r: any) => ({ account: r.account, app: r.app, running: live.get(r.account)?.running ?? false, stopped: live.get(r.account)?.stopped ?? (r.stopped_reason ? { reason: r.stopped_reason } : null) })),
    });
  });

  if (opts.linkUsers) {
    app.put('/api/users/:id/chat', async (c) => {
      const a = await admin(c);
      if (a.error) return a.error;
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof b.matrix_user_id !== 'string' || !MXID.test(b.matrix_user_id)) return bad(c, 'a chat id like @priya:server');
      const r = await platform.db.query('update neos.users set matrix_user_id = $3 where id = $1 and company_id = $2', [c.req.param('id'), a.u!.company_id, b.matrix_user_id]);
      if (!r.rowCount) return c.json({ error: { code: 'not_found', message: 'no such person in your company' } }, 404);
      await platform.gateway.audit({ company_id: a.u!.company_id, actor: `user:${a.u!.id}`, action: 'chat.user_linked', outcome: b.matrix_user_id });
      return c.json({ ok: true });
    });
  }
  return app;
}
