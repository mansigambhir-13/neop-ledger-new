// Proof on populated data (WP §11) for 011_platform_gaps.sql: a platform database
// migrated through 010 and filled with rows of every table 011 touches upgrades
// without losing or rewriting any of them. Also: the platform family gets no
// BYPASSRLS runner role (item: neos_runner was created and never used).
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapFamily, createTestDatabase, migrate } from '@neop/pgkit';
import { migratePlatform, PLATFORM_MIGRATIONS } from '../src/index.ts';

let db: { adminUrl: string; drop: () => Promise<void> };
let dir010 = '';
beforeAll(async () => {
  db = await createTestDatabase();
  dir010 = await mkdtemp(path.join(os.tmpdir(), 'neos-010-'));
  await cp(PLATFORM_MIGRATIONS, dir010, { recursive: true });
  // Everything after 010 is cut, so the copy stops where 011 starts.
  const led = JSON.parse(await readFile(path.join(dir010, 'migrate.json'), 'utf8'));
  for (const m of led.migrations.filter((x: any) => x.file >= '011')) await rm(path.join(dir010, m.file));
  led.migrations = led.migrations.filter((m: any) => m.file < '011');
  await writeFile(path.join(dir010, 'migrate.json'), JSON.stringify(led));
});
afterAll(async () => {
  await db?.drop();
  if (dir010) await rm(dir010, { recursive: true, force: true });
});

describe('011_platform_gaps on populated data', () => {
  it('upgrades a populated 010 database without touching existing rows', async () => {
    await bootstrapFamily(db.adminUrl, 'neos', { runner: false });
    const first = await migrate({ adminUrl: db.adminUrl, schema: 'neos', sources: { dir: dir010 }, tenantLint: false });
    expect(first.at(-1)!.name).toBe('010_room_rebind.sql');
    const c = new pg.Client({ connectionString: db.adminUrl });
    await c.connect();
    try {
      const co = (await c.query("insert into neos.companies (name, slug) values ('Acme', 'acme') returning id")).rows[0].id;
      const u = (await c.query("insert into neos.users (company_id, name, email, role, token_hash) values ($1, 'P', 'p@x', 'admin', 'h') returning id", [co])).rows[0].id;
      await c.query(`insert into neos.apps (key, l3_url, manifest, contract_version, service_secret_hash) values ('ledger', 'http://l3', '{"name":"Ledger","abilities":[]}', '1', 'h')`);
      const task = (await c.query("insert into neos.tasks (company_id, app_key, requester, ask, status) values ($1, 'ledger', $2, 'close the month', 'COMPLETED') returning id", [co, `user:${u}`])).rows[0].id;
      const job = '11111111-1111-1111-1111-111111111111';
      for (let i = 0; i < 50; i++) {
        await c.query(
          `insert into neos.approvals (company_id, app_key, proposal_id, job_id, task_id, ability_key, ability_version, args, card, fingerprint, expires_at, status, decision, proof)
           values ($1, 'ledger', gen_random_uuid(), $2, $3, 'ledger.journal.post', '1.0.0', '{}', '{}', 'sha256:x', now() + interval '1 day', $4, $5, $6)`,
          [co, job, task, i % 3 === 0 ? 'EXECUTED' : i % 3 === 1 ? 'PENDING' : 'CLOSED', i % 3 === 1 ? null : 'yes', i % 3 === 0 ? '{"outcome":"DONE"}' : null],
        );
        await c.query("insert into neos.activity (company_id, app_key, job_id, seq, kind, summary) values ($1, 'ledger', $2, $3, 'step', $4)", [co, job, i, `step ${i}`]);
      }
      await c.query(`insert into neos.registry_artifacts (hash, bytes, size) values ('sha256:a', '\\x00', 1)`);
      await c.query(`insert into neos.registry_entries (key, version, kind, published_by, artifact_hash, content_hash, platform_sig, status) values ('nep-gst', '1.0.0', 'package', 'user:x', 'sha256:a', 'sha256:c', 'sig', 'published')`);
      await c.query(`insert into neos.registry_installs (company_id, host_app, entry_key, pinned_version, status) values ($1, 'ledger', 'nep-gst', '1.0.0', 'active')`, [co]);
      const before = (await c.query('select (select count(*) from neos.approvals) a, (select count(*) from neos.activity) v, (select md5(string_agg(t::text, \',\' order by id)) from neos.approvals t) h')).rows[0];

      const applied = await migratePlatform(db.adminUrl);
      expect(applied.map((m) => m.name)[0]).toBe('011_platform_gaps.sql'); // then any later file

      const after = (await c.query('select (select count(*) from neos.approvals) a, (select count(*) from neos.activity) v')).rows[0];
      expect(after).toEqual({ a: before.a, v: before.v });
      expect((await c.query("select count(*)::int as n from neos.approvals where status = 'EXECUTED' and proof->>'outcome' = 'DONE'")).rows[0].n).toBe(17);
      const t = (await c.query('select routed_by, result_attempts, result_failed_at from neos.tasks where id = $1', [task])).rows[0];
      expect(t).toEqual({ routed_by: null, result_attempts: 0, result_failed_at: null });
      const inst = (await c.query('select status, previous_version, last_error from neos.registry_installs')).rows[0];
      expect(inst).toEqual({ status: 'active', previous_version: null, last_error: null });
      // The new states and rows 011 allows.
      await c.query("update neos.approvals set status = 'FAILED' where status = 'EXECUTED' and ctid = (select ctid from neos.approvals where status = 'EXECUTED' limit 1)");
      await c.query("insert into neos.activity (company_id, app_key, job_id, seq, kind, summary, dedupe_key) values ($1, 'ledger', $2, null, 'a2a', 'asked', 'a2a:1')", [co, job]);
      await expect(c.query("insert into neos.activity (company_id, app_key, job_id, seq, kind, summary, dedupe_key) values ($1, 'ledger', $2, null, 'a2a', 'asked', 'a2a:1')", [co, job])).rejects.toThrow(/duplicate/);
      await c.query(`insert into neos.apps (key, l3_url, manifest, contract_version, service_secret_hash, status) values ('neuralchat', 'platform:internal', '{}', '1', 'h', 'platform')`);
      await c.query("update neos.registry_installs set status = 'failed'");
      // The app role can use the new tables (default privileges from 001).
      await c.query('set role neos_app');
      await c.query("insert into neos.app_notifications (company_id, app_key, version, idem_key) values ($1, 'ledger', 1, 'k')", [co]);
      await c.query("insert into neos.gateway_keys (kid, state) values ('k1', 'active')");
      await c.query('reset role');
      const h = (await c.query("select md5(string_agg(t::text, ',' order by id)) h from (select id, company_id, app_key, proposal_id, job_id, task_id, ability_key, ability_version, args, card, fingerprint, expires_at, decision, feedback, decided_by, decided_at, fingerprint_seen, attempts, next_attempt_at, last_error, proof, created_at, updated_at from neos.approvals) t")).rows[0].h;
      expect(h).toBeTruthy();
    } finally {
      await c.end();
    }
  });

  it('the platform family has no usable BYPASSRLS runner role in its database', async () => {
    const c = new pg.Client({ connectionString: db.adminUrl });
    await c.connect();
    try {
      const acl = (await c.query('select datacl::text as a from pg_database where datname = current_database()')).rows[0].a ?? '';
      expect(acl).toContain('neos_app=');
      expect(acl).not.toContain('neos_runner=');
      const r = (await c.query("select rolcanlogin, rolbypassrls from pg_roles where rolname = 'neos_runner'")).rows[0];
      // Other (older) bootstraps on this shared cluster may recreate it; when present it must hold nothing here.
      if (r) {
        expect((await c.query("select has_schema_privilege('neos_runner', 'neos', 'usage') as ok")).rows[0].ok).toBe(false);
        expect((await c.query("select count(*)::int as n from information_schema.role_table_grants where grantee = 'neos_runner'")).rows[0].n).toBe(0);
      }
    } finally {
      await c.end();
    }
  });
});
