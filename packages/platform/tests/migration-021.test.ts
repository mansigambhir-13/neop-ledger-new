// migration-021.test · proof on populated data (WP §11) for 021_open_questions.sql (v3 S3): a platform database migrated
// through 020 and filled with tasks, questions (the projection) and the DMs a question was shown in upgrades with every
// row kept as it was, and the desk's question views in place: neos.v_questions / neos.v_open_questions, built from every
// registered app's input waits by neos.refresh_desk_questions(), readable by neos_desk only (the platform's role only
// through SET LOCAL ROLE). (Real app schemas feeding the views, and answers through <app>.answer_wait():
// apps/ledger/tests/desk-functions.test.ts.)
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFamily, createPool, createTestDatabase, migrate, roleUrl, tx } from '@neop/pgkit';
import { migratePlatform, PLATFORM_MIGRATIONS } from '../src/index.ts';

let db: { adminUrl: string; drop: () => Promise<void> };
let dir020 = '';
let c: pg.Client;
beforeAll(async () => {
  db = await createTestDatabase();
  dir020 = await mkdtemp(path.join(os.tmpdir(), 'neos-020-'));
  await cp(PLATFORM_MIGRATIONS, dir020, { recursive: true });
  const led = JSON.parse(await readFile(path.join(dir020, 'migrate.json'), 'utf8'));
  for (const m of led.migrations.filter((x: { file: string }) => x.file >= '021')) await rm(path.join(dir020, m.file));
  led.migrations = led.migrations.filter((m: { file: string }) => m.file < '021');
  await writeFile(path.join(dir020, 'migrate.json'), JSON.stringify(led));
  c = new pg.Client({ connectionString: db.adminUrl });
  await c.connect();
});
afterAll(async () => {
  await c?.end();
  await db?.drop();
  if (dir020) await rm(dir020, { recursive: true, force: true });
});

const manifest = { app: 'ledger', name: 'Ledger', abilities: [], doors: [], uses: [] };

describe('021 on a populated platform database', () => {
  it("021 applies forward on a populated platform database (questions and tasks kept; the question views in place, reading the apps' waits)", async () => {
    await bootstrapFamily(db.adminUrl, 'neos', { runner: false });
    const first = await migrate({ adminUrl: db.adminUrl, schema: 'neos', sources: { dir: dir020 }, tenantLint: false });
    expect(first.at(-1)!.name).toBe('020_approvals_frozen.sql');
    const co = (await c.query("insert into neos.companies (name, slug) values ('Acme', 'acme') returning id")).rows[0].id;
    const u = (await c.query("insert into neos.users (company_id, name, email, role, token_hash) values ($1, 'P', 'p@x', 'admin', 'h') returning id", [co])).rows[0].id;
    await c.query("insert into neos.apps (key, l3_url, manifest, contract_version, service_secret_hash) values ('ledger', 'http://l3', $1, '1', 'h')", [JSON.stringify(manifest)]);
    await c.query("insert into neos.chat_accounts (account, company_id, app_key) values ('@ledger:acme', $1, 'ledger')", [co]);
    const statuses = ['OPEN', 'ANSWERED', 'EXPIRED', 'STALE'];
    for (let i = 0; i < 12; i++) {
      const task = (await c.query("insert into neos.tasks (company_id, app_key, requester, ask, status) values ($1, 'ledger', $2, $3, 'NEEDS_INPUT') returning id", [co, `user:${u}`, `ask ${i}`])).rows[0].id;
      const st = statuses[i % 4]!;
      const q = (
        await c.query(
          `insert into neos.questions (company_id, app_key, task_id, root_task_id, job_id, wait_id, text, why, fields, due_at, asked_of, status, answers, answered_by, answered_via)
           values ($1, 'ledger', $2, $2, gen_random_uuid(), gen_random_uuid(), $3, 'why', '[{"key":"answer","label":"a","type":"text","required":true}]', now() + interval '1 day', $4, $5, $6, $7, $8) returning id`,
          [co, task, `question ${i}`, u, st, st === 'ANSWERED' ? '{"answer":"x"}' : null, st === 'ANSWERED' ? `user:${u}` : null, st === 'ANSWERED' ? 'desk' : null],
        )
      ).rows[0].id;
      await c.query("insert into neos.chat_client_events (event_id, account, room_id, direction, sender, task_id, question_id, outcome) values ($1, '@ledger:acme', '!dm:acme', 'outbound', '@ledger:acme', $2, $3, 'question')", [`$q${i}`, task, q]);
    }
    const snap = async () =>
      (
        await c.query(
          `select (select md5(string_agg(q::text, ',' order by id)) from neos.questions q) q, (select md5(string_agg(t::text, ',' order by id)) from neos.tasks t) t,
                  (select md5(string_agg(e::text, ',' order by event_id)) from neos.chat_client_events e) e, (select count(*)::int from neos.questions) n`,
        )
      ).rows[0];
    const before = await snap();

    const applied = await migratePlatform(db.adminUrl);
    expect(applied.map((m) => m.name)).toEqual(['021_open_questions.sql', '022_registry_pins.sql']); // 022 (S7) follows; its own proof is in registry-v3.test.ts
    expect(await snap()).toEqual(before); // every question, task and shown-in-DM row as it was
    expect(before.n).toBe(12);

    // The views: one branch per registered app, owned by the admin's refresher (no catalog dependency on app tables).
    for (const v of ['v_questions', 'v_open_questions']) expect((await c.query(`select pg_get_viewdef('neos.${v}'::regclass) d`)).rows[0].d).toContain("desk_questions('ledger'::text)");
    const deps = (
      await c.query(
        `select distinct n.nspname from pg_depend d join pg_rewrite r on r.oid = d.objid join pg_class v on v.oid = r.ev_class join pg_class t on t.oid = d.refobjid
           join pg_namespace n on n.oid = t.relnamespace where v.relname in ('v_questions', 'v_open_questions') and t.oid <> v.oid`,
      )
    ).rows;
    expect(deps).toEqual([]);
    // Only the desk reads them; the platform's pool role only as the desk, for one transaction.
    const app = createPool(roleUrl(db.adminUrl, 'neos_app'), 2);
    try {
      await expect(app.query('select 1 from neos.v_open_questions')).rejects.toMatchObject({ code: '42501' });
      const n = await tx(app, async (x) => {
        await x.query('set local role neos_desk');
        return (await x.query('select (select count(*)::int from neos.v_open_questions) + (select count(*)::int from neos.v_questions) n')).rows[0].n;
      });
      expect(n).toBe(0); // no ledger schema on this database: no rows (and no error)
      // The desk reads nothing of the platform's own tables, the old projection included.
      await expect(
        tx(app, async (x) => {
          await x.query('set local role neos_desk');
          await x.query('select 1 from neos.questions');
        }),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.end();
    }
    // A re-run is a no-op.
    expect(await migratePlatform(db.adminUrl)).toEqual([]);
  });
});
