// boot-schema.test · WP §11 step 8: at boot the backend reads <schema>.schema_migrations and compares
// it with the migration set this build ships (template t### + app ###). Pending, unknown or edited
// migrations → it refuses to start, naming them; the container entry exits 78 (EX_CONFIG).
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, roleUrl, SchemaMismatchError } from '@neop/pgkit';
import { migrateApp, startBackend, type NeopBackend } from '@neop/template';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { ledgerApp } from '../src/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let admin: pg.Client;
let app: Awaited<ReturnType<typeof ledgerApp>>;
let saved: { name: string; checksum: string }[];

const cfg = () => ({
  appDbUrl: roleUrl(db.adminUrl, 'ledger_app'),
  runnerDbUrl: roleUrl(db.adminUrl, 'ledger_runner'),
  jobTokenSecret: 'y'.repeat(40),
  agentUrl: 'http://127.0.0.1:9',
  poolSize: 1,
  runnerId: 'boot-test',
  presence: { mode: 'appservice' as const, homeserverUrl: 'http://127.0.0.1:9', appservice: { hsToken: 'hs', asToken: 'as' } },
});

beforeAll(async () => {
  db = await createTestDatabase();
  app = await ledgerApp();
  await migrateApp(db.adminUrl, app);
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  saved = (await admin.query('select name, checksum from ledger.schema_migrations')).rows;
});
afterAll(async () => {
  await admin?.end();
  await db?.drop();
});
beforeEach(async () => {
  // Every case starts from the schema in step with the build.
  await admin.query('delete from ledger.schema_migrations');
  for (const r of saved) await admin.query('insert into ledger.schema_migrations (name, checksum) values ($1, $2)', [r.name, r.checksum]);
});

async function refusal(): Promise<SchemaMismatchError> {
  let b: NeopBackend | null = null;
  try {
    b = await startBackend(app, cfg(), { runner: false });
  } catch (e) {
    expect(e).toBeInstanceOf(SchemaMismatchError);
    return e as SchemaMismatchError;
  } finally {
    await b?.stop();
  }
  throw new Error('the backend started on a schema out of step');
}

it('starts when the schema is exactly the shipped set', async () => {
  const b = await startBackend(app, cfg(), { runner: false });
  const r = await fetch(`http://127.0.0.1:${b.ports.files}/ready`);
  expect(r.status).toBe(200);
  await b.stop();
});

it('refuses on a pending migration and names it', async () => {
  const last = saved.map((s) => s.name).filter((n) => /^\d{3}_/.test(n)).sort().at(-1)!;
  await admin.query('delete from ledger.schema_migrations where name = $1', [last]);
  const e = await refusal();
  expect(e.drift.pending).toEqual([last]);
  expect(e.message).toContain(`pending (not applied): ${last}`);
});

it('refuses when a migration that ran was edited afterwards (checksum differs)', async () => {
  await admin.query("update ledger.schema_migrations set checksum = repeat('0', 64) where name = '002_ledger.sql'");
  const e = await refusal();
  expect(e.drift).toEqual({ pending: [], unknown: [], changed: ['002_ledger.sql'] });
  expect(e.message).toMatch(/changed \(checksum differs from what ran\): 002_ledger\.sql/);
});

it('refuses when the database ran a migration this build does not ship; package migrations are not the app’s', async () => {
  await admin.query("insert into ledger.schema_migrations (name, checksum) values ('099_from_a_newer_build.sql', 'x'), ('nep-gst@1.0.0/001.sql', 'y')");
  const e = await refusal();
  expect(e.drift).toEqual({ pending: [], unknown: ['099_from_a_newer_build.sql'], changed: [] });
});

it('the backend container entry logs the drift and exits 78 (EX_CONFIG)', async () => {
  await admin.query("delete from ledger.schema_migrations where name = 't002_trace_and_acks.sql'");
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const c = cfg();
    execFile(
      path.join(root, 'node_modules/.bin/tsx'),
      ['apps/ledger/scripts/backend.ts'],
      {
        cwd: root,
        timeout: 45_000,
        env: {
          ...process.env,
          NEOS_ENV: 'test',
          NEOP_APP_DB_URL: c.appDbUrl,
          NEOP_RUNNER_DB_URL: c.runnerDbUrl,
          NEOP_JOB_TOKEN_SECRET: c.jobTokenSecret,
          NEOP_AGENT_URL: c.agentUrl,
          NEOP_GATE_URL: 'http://127.0.0.1:9',
          FILES_PORT: '0',
          GATE_PORT: '0',
          NEOP_PRESENCE: 'appservice',
          NEOP_MATRIX_HOMESERVER_URL: 'http://127.0.0.1:9',
          NEOP_MATRIX_HS_TOKEN: 'hs',
          NEOP_MATRIX_AS_TOKEN: 'as',
        },
      },
      (err, _out, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? null) : 0, stderr }),
    );
  });
  expect(code).toBe(78);
  const line = JSON.parse(stderr.trim().split('\n').find((l) => l.includes('refusing to start'))!);
  expect(line.level).toBe('fatal');
  expect(line.pending).toEqual(['t002_trace_and_acks.sql']);
}, 60_000);
