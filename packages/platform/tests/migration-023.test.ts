// migration-023.test · proof on populated data (WP §11) for the 023–024 V3 expand set: a database migrated through
// 022 and filled with tasks in every status (with attachments, results, room tasks) upgrades with every row kept as it
// was and every existing task on the gateway road; the Matrix road's columns and tables are in place, the retired L3
// address is optional while the destructive 025 contraction is withheld, and the platform's role may use the new
// shape. (NeuralChat posting typed tasks end to end: apps/ledger/tests/neuralchat-matrix.test.ts.)
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFamily, createPool, createTestDatabase, migrate, roleUrl } from '@neop/pgkit';
import { migratePlatform, PLATFORM_MIGRATIONS } from '../src/index.ts';

let db: { adminUrl: string; drop: () => Promise<void> };
let dir022 = '';
let c: pg.Client;
beforeAll(async () => {
  db = await createTestDatabase();
  dir022 = await mkdtemp(path.join(os.tmpdir(), 'neos-022-'));
  await cp(PLATFORM_MIGRATIONS, dir022, { recursive: true });
  const led = JSON.parse(await readFile(path.join(dir022, 'migrate.json'), 'utf8'));
  for (const m of led.migrations.filter((x: { file: string }) => x.file >= '023')) await rm(path.join(dir022, m.file));
  led.migrations = led.migrations.filter((m: { file: string }) => m.file < '023');
  await writeFile(path.join(dir022, 'migrate.json'), JSON.stringify(led));
  c = new pg.Client({ connectionString: db.adminUrl });
  await c.connect();
});
afterAll(async () => {
  await c?.end();
  await db?.drop();
  if (dir022) await rm(dir022, { recursive: true, force: true });
});

const manifest = { app: 'ledger', name: 'Ledger', abilities: [], doors: [], uses: [] };

describe('023 on a populated platform database', () => {
  it('023–024 apply forward on a populated platform database (rows kept; Matrix shape present; V3 apps need no L3 address)', async () => {
    await bootstrapFamily(db.adminUrl, 'neos', { runner: false });
    const first = await migrate({ adminUrl: db.adminUrl, schema: 'neos', sources: { dir: dir022 }, tenantLint: false });
    expect(first.at(-1)!.name).toBe('022_registry_pins.sql');
    const co = (await c.query("insert into neos.companies (name, slug) values ('Acme', 'acme') returning id")).rows[0].id;
    const u = (await c.query("insert into neos.users (company_id, name, email, role, token_hash) values ($1, 'P', 'p@x', 'admin', 'h') returning id", [co])).rows[0].id;
    await c.query("insert into neos.apps (key, l3_url, manifest, contract_version, service_secret_hash) values ('ledger', 'http://l3', $1, '1', 'h')", [JSON.stringify(manifest)]);
    const statuses = ['OPEN', 'ACKNOWLEDGED', 'WAITING', 'NEEDS_INPUT', 'COMPLETED', 'FAILED', 'CANCELLED'];
    for (let i = 0; i < 21; i++) {
      await c.query(
        `insert into neos.tasks (company_id, app_key, requester, ask, status, origin, attachments, result)
         values ($1, 'ledger', $2, $3, $4, $5, $6, $7)`,
        [co, `user:${u}`, `ask ${i}`, statuses[i % statuses.length], i % 3 === 0 ? 'room' : 'app', i % 5 === 0 ? JSON.stringify([{ filename: 'a.csv', content_base64: 'YQ==' }]) : null, i % 7 === 4 ? JSON.stringify({ outcome: 'done', summary: 'ok' }) : null],
      );
    }
    const snap = async () => (await c.query('select md5(string_agg(t::text, \',\' order by id)) t, count(*)::int n from (select id, company_id, app_key, requester, ask, status, origin, attachments, result, job_id, created_at from neos.tasks) t')).rows[0];
    const before = await snap();

    const applied = await migratePlatform(db.adminUrl, undefined, { through: '024' });
    expect(applied.map((m) => m.name)).toEqual(['023_neuralchat_matrix.sql', '024_s9_expand.sql']);
    expect(await snap()).toEqual(before); // every task as it was
    expect(before.n).toBe(21);
    // Existing legacy addresses are not rewritten; new V3 principals/apps can omit an address before 024 drops it.
    expect((await c.query("select l3_url from neos.apps where key = 'ledger'")).rows[0].l3_url).toBe('http://l3');
    await c.query(
      "insert into neos.apps (key, manifest, contract_version, service_secret_hash, status) values ('neuralchat', '{}', '1', 'h', 'platform')",
    );
    expect((await c.query("select l3_url from neos.apps where key = 'neuralchat'")).rows[0].l3_url).toBeNull();
    // Every task that existed is on the gateway road; nothing is marked delivered in Matrix.
    expect((await c.query("select road, count(*)::int n, count(matrix_event_id)::int m, count(delivered_at)::int d from neos.tasks group by road")).rows).toEqual([{ road: 'gateway', n: 21, m: 0, d: 0 }]);
    await expect(c.query("update neos.tasks set road = 'bus' where true")).rejects.toMatchObject({ code: '23514' });
    // The conversation may now hold the app's step notes read from the thread.
    expect((await c.query("select pg_get_constraintdef(oid) d from pg_constraint where conname = 'conversation_messages_kind_check'")).rows[0].d).toContain("'step'::text");

    // The platform's own role reads and writes the new tables (default privileges of schema neos).
    const app = createPool(roleUrl(db.adminUrl, 'neos_app'), 2);
    try {
      const t = (await app.query("update neos.tasks set road = 'matrix', matrix_room = '!r:acme', matrix_account = '@neuralchat_acme:acme', matrix_txn = 'nc-task-x' where ask = 'ask 1' returning id")).rows[0].id;
      await app.query("insert into neos.neuralchat_events (event_id, company_id, task_id, room_id, sender, type, outcome) values ('$e1', $1, $2, '!r:acme', '@neop_ledger_acme:acme', 'neos.neop.note', 'note:ack')", [co, t]);
      await expect(app.query("insert into neos.neuralchat_events (event_id, room_id, sender, type) values ('$e1', '!r', '@x:y', 'neos.neop.note')")).rejects.toMatchObject({ code: '23505' }); // once per event id
      await app.query("insert into neos.neuralchat_rooms (company_id, app_key, account, peer, room_id) values ($1, 'ledger', '@neuralchat_acme:acme', '@ledger:acme', '!dm:acme')", [co]);
      await app.query("insert into neos.neuralchat_accounts (account, company_id, next_batch) values ('@neuralchat_acme:acme', $1, 's1')", [co]);
      expect((await app.query("select count(*)::int n from neos.tasks where road = 'matrix'")).rows[0].n).toBe(1);
    } finally {
      await app.end();
    }
    // A re-run is a no-op.
    expect(await migratePlatform(db.adminUrl, undefined, { through: '024' })).toEqual([]);
  });
});
