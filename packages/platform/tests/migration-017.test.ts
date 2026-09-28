// migration-017.test · v3 §5/§8/§16 "only a person can say yes": 016's per-bridge may_approve is withdrawn.
// Proof on populated data (WP §11): a platform database migrated through 016, with allowlist rows of every kind
// (a bridge an admin had let approve included), upgrades without losing a row; every grant is revoked and
// recorded in the audit trail; the check is validated, so no grant can be written again — not even by SQL.
// And the admin API refuses may_approve:true (400 bridge_cannot_approve).
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFamily, createTestDatabase, migrate, roleUrl } from '@neop/pgkit';
import { chatClientRoutes, generateSigningKeys, migratePlatform, Platform, PLATFORM_MIGRATIONS } from '../src/index.ts';

let db: { adminUrl: string; drop: () => Promise<void> };
let dir016 = '';
let c: pg.Client;
let p: Platform;
beforeAll(async () => {
  db = await createTestDatabase();
  dir016 = await mkdtemp(path.join(os.tmpdir(), 'neos-016-'));
  await cp(PLATFORM_MIGRATIONS, dir016, { recursive: true });
  const led = JSON.parse(await readFile(path.join(dir016, 'migrate.json'), 'utf8'));
  for (const m of led.migrations.filter((x: { file: string }) => x.file >= '017')) await rm(path.join(dir016, m.file));
  led.migrations = led.migrations.filter((m: { file: string }) => m.file < '017');
  await writeFile(path.join(dir016, 'migrate.json'), JSON.stringify(led));
  c = new pg.Client({ connectionString: db.adminUrl });
  await c.connect();
});
afterAll(async () => {
  await p?.stop();
  await c?.end();
  await db?.drop();
  if (dir016) await rm(dir016, { recursive: true, force: true });
});

describe('017 on a populated platform database', () => {
  it('keeps every allowlist row, revokes every may_approve grant (audited), and validates the check', async () => {
    await bootstrapFamily(db.adminUrl, 'neos', { runner: false });
    const first = await migrate({ adminUrl: db.adminUrl, schema: 'neos', sources: { dir: dir016 }, tenantLint: false });
    expect(first.at(-1)!.name).toBe('016_bridge_approve.sql');
    const co = (await c.query("insert into neos.companies (name, slug) values ('Acme', 'acme') returning id")).rows[0].id;
    const u = (await c.query("insert into neos.users (company_id, name, email, role, token_hash, matrix_user_id) values ($1, 'Priya', 'p@x', 'admin', 'h', '@p:hs') returning id", [co])).rows[0].id;
    await c.query(`insert into neos.apps (key, l3_url, manifest, contract_version, service_secret_hash) values ('ledger', 'http://l3', '{"name":"Ledger","abilities":[]}', '1', 'h')`);
    for (const [mx, kind, actsFor, may] of [
      ['@p:hs', 'person', null, false],
      ['@agent:hs', 'bridge', u, true],
      ['@agent2:hs', 'bridge', u, true],
      ['@plain:hs', 'bridge', u, false],
      ['@platform:hs', 'bridge', null, false],
    ] as const) {
      await c.query('insert into neos.chat_allowlist (company_id, app_key, matrix_id, kind, acts_for, may_approve, added_by) values ($1, $2, $3, $4, $5, $6, $7)', [co, 'ledger', mx, kind, actsFor, may, u]);
    }
    const before = (await c.query('select company_id, app_key, matrix_id, kind, acts_for, added_by, added_at from neos.chat_allowlist order by matrix_id')).rows;

    const applied = await migratePlatform(db.adminUrl);
    expect(applied.map((m) => m.name)[0]).toBe('017_bridge_never_approves.sql');

    expect((await c.query('select company_id, app_key, matrix_id, kind, acts_for, added_by, added_at from neos.chat_allowlist order by matrix_id')).rows).toEqual(before);
    expect((await c.query('select count(*)::int n from neos.chat_allowlist where may_approve')).rows[0].n).toBe(0);
    const audit = (await c.query("select actor, app_key, outcome, detail->>'matrix_id' as mx from neos.audit where action = 'chat.bridge_approve_revoked' order by 4")).rows;
    expect(audit).toEqual([
      { actor: 'migration:017', app_key: 'ledger', outcome: 'revoked', mx: '@agent2:hs' },
      { actor: 'migration:017', app_key: 'ledger', outcome: 'revoked', mx: '@agent:hs' },
    ]);
    const con = (await c.query("select convalidated from pg_constraint where conname = 'chat_allowlist_bridge_never_approves'")).rows[0];
    expect(con).toEqual({ convalidated: true });
    await expect(c.query("update neos.chat_allowlist set may_approve = true where matrix_id = '@agent:hs'")).rejects.toThrow(/chat_allowlist_bridge_never_approves/);
  });
});

describe('the admin API', () => {
  it('PUT /api/chat/allowlist with may_approve:true is 400 bridge_cannot_approve; false or absent is a plain entry', async () => {
    p = new Platform({ dbUrl: roleUrl(db.adminUrl, 'neos_app'), keys: await generateSigningKeys(), dbPoolSize: 3 });
    const co = (await p.createCompany('Beta')).id;
    const admin = await p.createUser(co, { name: 'Anil', email: 'a@x', role: 'admin' });
    await p.installApp(co, 'ledger');
    const put = async (body: Record<string, unknown>) => {
      const res = await chatClientRoutes(p, () => []).request('/api/chat/allowlist', { method: 'PUT', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    };
    const refused = await put({ app: 'ledger', matrix_id: '@agent:hs', kind: 'bridge', acts_for: admin.id, may_approve: true });
    expect(refused).toMatchObject({ status: 400, body: { error: { code: 'bridge_cannot_approve' } } });
    expect((await c.query('select count(*)::int n from neos.chat_allowlist where company_id = $1', [co])).rows[0].n).toBe(0);
    expect((await put({ app: 'ledger', matrix_id: '@agent:hs', kind: 'bridge', acts_for: admin.id, may_approve: false })).status).toBe(200);
    const ok = await put({ app: 'ledger', matrix_id: '@agent:hs', kind: 'bridge', acts_for: admin.id });
    expect(ok.status).toBe(200);
    expect(ok.body.may_approve).toBeUndefined();
  });
});
