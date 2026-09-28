// migration-018-019.test · proof on populated data (WP §11) for 018_desk_union_views.sql and 019_registry_schema.sql:
// a platform database migrated through 017 and filled with apps, tasks, approvals and registry rows upgrades
// without losing or rewriting any of them; the desk views, the registry views and tasks.borrowed_ability are in
// place (real app schemas feeding the views: apps/ledger/tests/desk-views.test.ts).
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFamily, createTestDatabase, migrate } from '@neop/pgkit';
import { migratePlatform, PLATFORM_MIGRATIONS } from '../src/index.ts';

let db: { adminUrl: string; drop: () => Promise<void> };
let dir017 = '';
let c: pg.Client;
beforeAll(async () => {
  db = await createTestDatabase();
  dir017 = await mkdtemp(path.join(os.tmpdir(), 'neos-017-'));
  await cp(PLATFORM_MIGRATIONS, dir017, { recursive: true });
  const led = JSON.parse(await readFile(path.join(dir017, 'migrate.json'), 'utf8'));
  for (const m of led.migrations.filter((x: { file: string }) => x.file >= '018')) await rm(path.join(dir017, m.file));
  led.migrations = led.migrations.filter((m: { file: string }) => m.file < '018');
  await writeFile(path.join(dir017, 'migrate.json'), JSON.stringify(led));
  c = new pg.Client({ connectionString: db.adminUrl });
  await c.connect();
});
afterAll(async () => {
  await c?.end();
  await db?.drop();
  if (dir017) await rm(dir017, { recursive: true, force: true });
});

const manifest = {
  app: 'ledger',
  name: 'Ledger',
  abilities: [{ key: 'ledger.expense.record', version: '1.0.0', kind: 'write', floor: 'ask_first', title: 'Record an expense', description: 'd', doors: ['email'] }],
  doors: [{ key: 'email', scopes: ['send'] }],
  uses: [],
};

describe('018 and 019 on a populated platform database', () => {
  it('018 and 019 apply forward on a populated platform database (every row kept; views, functions and the new column in place)', async () => {
    await bootstrapFamily(db.adminUrl, 'neos', { runner: false });
    const first = await migrate({ adminUrl: db.adminUrl, schema: 'neos', sources: { dir: dir017 }, tenantLint: false });
    expect(first.at(-1)!.name).toBe('017_bridge_never_approves.sql');
    const co = (await c.query("insert into neos.companies (name, slug) values ('Acme', 'acme') returning id")).rows[0].id;
    const u = (await c.query("insert into neos.users (company_id, name, email, role, token_hash) values ($1, 'P', 'p@x', 'admin', 'h') returning id", [co])).rows[0].id;
    await c.query("insert into neos.apps (key, l3_url, manifest, contract_version, service_secret_hash) values ('ledger', 'http://l3', $1, '1', 'h')", [JSON.stringify(manifest)]);
    await c.query("insert into neos.apps (key, l3_url, manifest, contract_version, service_secret_hash, status) values ('neuralchat', 'platform:internal', '{}', '1', 'h', 'platform')");
    const job = '11111111-1111-1111-1111-111111111111';
    for (let i = 0; i < 30; i++) {
      const task = (await c.query("insert into neos.tasks (company_id, app_key, requester, ask, status) values ($1, 'ledger', $2, $3, 'COMPLETED') returning id", [co, `user:${u}`, `ask ${i}`])).rows[0].id;
      await c.query(
        `insert into neos.approvals (company_id, app_key, proposal_id, job_id, task_id, ability_key, ability_version, args, card, fingerprint, expires_at, status, decision, proof)
         values ($1, 'ledger', gen_random_uuid(), $2, $3, 'ledger.expense.record', '1.0.0', '{}', '{}', 'sha256:x', now() + interval '1 day', $4, $5, $6)`,
        [co, job, task, i % 2 ? 'PENDING' : 'EXECUTED', i % 2 ? null : 'yes', i % 2 ? null : '{"outcome":"DONE"}'],
      );
    }
    await c.query(`insert into neos.registry_artifacts (hash, bytes, size) values ('sha256:a', '\\x00', 1)`);
    await c.query(`insert into neos.registry_entries (key, version, kind, published_by, artifact_hash, content_hash, platform_sig, status, offers) values ('nep-gst', '1.0.0', 'package', 'user:x', 'sha256:a', 'sha256:c', 'sig', 'published', '[{"key":"gst.prepare"}]')`);
    const snap = async () =>
      (
        await c.query(`select (select md5(string_agg(t::text, ',' order by id)) from (select id, company_id, app_key, requester, ask, status, created_at from neos.tasks) t) tasks,
                              (select md5(string_agg(a::text, ',' order by id)) from neos.approvals a) approvals,
                              (select md5(string_agg(e::text, ',' order by key)) from neos.registry_entries e) entries,
                              (select md5(string_agg(x::text, ',' order by key)) from neos.apps x) apps`)
      ).rows[0];
    const before = await snap();

    const applied = await migratePlatform(db.adminUrl);
    expect(applied.map((m) => m.name)).toEqual(['018_desk_union_views.sql', '019_registry_schema.sql', '020_approvals_frozen.sql', '021_open_questions.sql', '022_registry_pins.sql']); // 020 (S2), 021 (S3), 022 (S7) follow; their own proofs are migration-020.test.ts, migration-021.test.ts, registry-v3.test.ts
    expect(await snap()).toEqual(before);
    expect((await c.query('select count(*)::int n from neos.tasks where borrowed_ability is not null')).rows[0].n).toBe(0);

    // The desk views exist and cover the registered app (its schema is absent here: no rows, no error).
    expect((await c.query("select pg_get_viewdef('neos.v_pending_approvals'::regclass) d")).rows[0].d).toContain("desk_pending('ledger'::text)");
    expect((await c.query("select pg_get_viewdef('neos.v_pending_approvals'::regclass) d")).rows[0].d).not.toContain('neuralchat');
    expect((await c.query('select count(*)::int n from neos.v_pending_approvals')).rows[0].n).toBe(0);
    // The registry views read the populated rows.
    expect((await c.query('select app, ability, kind, doors from neos_registry.abilities')).rows).toEqual([{ app: 'ledger', ability: 'ledger.expense.record', kind: 'write', doors: ['email'] }]);
    expect((await c.query('select app, door, floor from neos_registry.doors')).rows).toEqual([{ app: 'ledger', door: 'email', floor: 'on' }]);
    expect((await c.query('select key, version from neos_registry.packages')).rows).toEqual([{ key: 'nep-gst', version: '1.0.0' }]);
    // A re-run is a no-op.
    expect(await migratePlatform(db.adminUrl)).toEqual([]);
  });
});
