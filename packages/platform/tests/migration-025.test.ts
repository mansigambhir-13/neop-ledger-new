// migration-025.test · destructive S9 cutover proof on populated data. The contraction must refuse while an answer
// still lives only in the retired approvals table; once drained, it copies every retired table byte-for-byte into a
// private archive before dropping it. Kept platform rows remain untouched and a repeat is a no-op.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@neop/pgkit';
import { migratePlatform } from '../src/index.ts';

const retired = [
  'gateway_ledger',
  'gateway_keys',
  'acl',
  'approvals',
  'switchboards',
  'grants',
  'questions',
  'activity',
  'vault_secrets',
  'rooms',
  'room_events',
  'room_messages',
  'chat_accounts',
  'chat_dms',
  'chat_client_events',
  'outbox_cursors',
  'outbox_dead_letters',
  'app_notifications',
  'registry_installs',
  'package_migrations',
] as const;

let db: { adminUrl: string; drop: () => Promise<void> };
let c: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  await migratePlatform(db.adminUrl, undefined, { through: '023' });
  c = new pg.Client({ connectionString: db.adminUrl });
  await c.connect();
});

afterAll(async () => {
  await c?.end();
  await db?.drop();
});

const manifest = {
  app: 'ledger',
  name: 'Ledger',
  version: '1.0.0',
  contract_version: '1',
  abilities: [{ key: 'ledger.report.pnl', version: '1.0.0', kind: 'read', floor: 'on', title: 'P&L', description: 'd', doors: [] }],
  doors: [],
  uses: [],
};

async function digest(schema: string, table: string): Promise<{ n: number; hash: string | null }> {
  return (
    await c.query(
      `select count(*)::int n,
              md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text, '[]')) hash
         from ${schema}.${table} t`,
    )
  ).rows[0];
}

describe('025 on a populated platform database', () => {
  it('refuses an undrained answer, then archives every retired table exactly and contracts the live schema', async () => {
    const co = (await c.query("insert into neos.companies (name, slug) values ('Cutover Co', 'cutover') returning id")).rows[0].id;
    const user = (
      await c.query("insert into neos.users (company_id, name, email, role, token_hash) values ($1, 'Priya', 'p@cutover.test', 'admin', 'h') returning id", [co])
    ).rows[0].id;
    await c.query(
      "insert into neos.apps (key, l3_url, manifest, contract_version, service_secret_hash) values ('ledger', 'http://retired-ledger-l3:4101', $1, '1', 'h')",
      [JSON.stringify(manifest)],
    );
    const task = (
      await c.query("insert into neos.tasks (company_id, app_key, requester, ask, status, road) values ($1, 'ledger', $2, 'cut over', 'WAITING', 'matrix') returning id", [co, `user:${user}`])
    ).rows[0].id;
    await c.query(
      `insert into neos.approvals
         (company_id, app_key, proposal_id, job_id, task_id, ability_key, ability_version, args, card, fingerprint,
          expires_at, status, decision, decided_by, decided_at, fingerprint_seen)
       values ($1, 'ledger', gen_random_uuid(), gen_random_uuid(), $2, 'ledger.journal.post', '1.0.0', '{}',
               '{"what":"post"}', 'sha256:cutover', now() + interval '1 day', 'RECORDED', 'yes', $3, now(), 'sha256:cutover')`,
      [co, task, user],
    );
    await c.query("insert into neos.gateway_ledger (caller, target_app, idem_key, endpoint, request_hash, request_id, status, response) values ('platform', 'ledger', 'cutover-1', '/l3/tasks.open', 'abc', gen_random_uuid(), 200, '{\"ok\":true}')");
    await c.query("insert into neos.gateway_keys (kid, state, activated_at) values ('old-key', 'active', now())");
    await c.query("insert into neos.vault_secrets (company_id, app_key, door, secret) values ($1, 'ledger', 'email', '{\"sealed\":true}')", [co]);
    await c.query("insert into neos.switchboards (company_id, app_key, version, settings, updated_by) values ($1, 'ledger', 1, '{\"ledger.report.pnl\":\"on\"}', $2)", [co, user]);
    await c.query("insert into neos.grants (company_id, app_key, ability_key, expires_at, created_by) values ($1, 'ledger', 'ledger.journal.post', now() + interval '1 day', $2)", [co, user]);

    await expect(migratePlatform(db.adminUrl, undefined, { through: '025' })).rejects.toThrow(/answered on the old desk were never handed to their app/);
    expect((await c.query("select to_regnamespace('neos_s9_archive') is null as absent")).rows[0].absent).toBe(true);
    expect((await c.query("select to_regclass('neos.approvals') is not null as present")).rows[0].present).toBe(true);
    expect((await c.query("select count(*)::int n from neos.schema_migrations where name = '025_gateway_gone.sql'")).rows[0].n).toBe(0);

    // The S2 drain has handed the answer to the app. Its legacy row is now evidence only and may be archived.
    await c.query("update neos.approvals set status = 'EXECUTED', proof = '{\"outcome\":\"DONE\"}' where status = 'RECORDED'");
    const before = new Map<string, { n: number; hash: string | null }>();
    for (const table of retired) before.set(table, await digest('neos', table));
    const l3 = await digest('neos', 'apps');
    const kept = (
      await c.query("select (select count(*)::int from neos.companies) companies, (select count(*)::int from neos.users) users, (select count(*)::int from neos.tasks) tasks, (select count(*)::int from neos.installs) installs")
    ).rows[0];

    const applied = await migratePlatform(db.adminUrl, undefined, { through: '025' });
    // The earlier safe 024 expand committed before 025 deliberately refused the first attempt.
    expect(applied.map((m) => m.name)).toEqual(['025_gateway_gone.sql']);
    for (const table of retired) {
      expect((await c.query('select to_regclass($1) is null as gone', [`neos.${table}`])).rows[0].gone, table).toBe(true);
      expect(await digest('neos_s9_archive', table), table).toEqual(before.get(table));
    }
    expect((await c.query("select count(*)::int n from information_schema.columns where table_schema = 'neos' and table_name = 'apps' and column_name = 'l3_url'")).rows[0].n).toBe(0);
    expect((await c.query("select key, l3_url from neos_s9_archive.apps_l3_url")).rows).toEqual([{ key: 'ledger', l3_url: 'http://retired-ledger-l3:4101' }]);
    // The apps row itself stays live; only its retired address was copied and dropped.
    expect((await digest('neos', 'apps')).n).toBe(l3.n);
    expect(
      (await c.query("select (select count(*)::int from neos.companies) companies, (select count(*)::int from neos.users) users, (select count(*)::int from neos.tasks) tasks, (select count(*)::int from neos.installs) installs")).rows[0],
    ).toEqual(kept);
    expect((await c.query("select has_schema_privilege('neos_app', 'neos_s9_archive', 'USAGE') app, has_schema_privilege('neos_desk', 'neos_s9_archive', 'USAGE') desk")).rows[0]).toEqual({ app: false, desk: false });
    expect((await c.query("select to_regclass('neos.v_operations') is not null as ok")).rows[0].ok).toBe(true);
    expect(await migratePlatform(db.adminUrl, undefined, { through: '025' })).toEqual([]);
  });
});
