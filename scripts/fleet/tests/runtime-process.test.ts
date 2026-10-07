import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTestDatabase, roleUrl, sqlIdent } from '@neop/pgkit';
import { migrateApp } from '@neop/template';
import { fakeHomeserver, MATRIX, type FakeHomeserver } from '@neop/testkit';
import { FLEET_APPS, type FleetApp } from '../runtime/apps.ts';
import { loadFleetApp } from '../runtime/load.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const children = new Set<ChildProcess>();
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let admin: ReturnType<typeof createPool>;
let hs: FakeHomeserver;

// Never forward the test runner's credentials or environment to a worker.
const cleanEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, NEOS_ENV: 'test', NODE_NO_WARNINGS: '1' });
function launch(app: FleetApp, side: 'agent' | 'backend', env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', 'tsx', `apps/${app}/scripts/${side}.ts`], { cwd: ROOT, env: { ...cleanEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let out = '', err = '';
  child.stdout!.on('data', chunk => { out += String(chunk); });
  child.stderr!.on('data', chunk => { err += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => { children.delete(child); resolve(code); });
  });
  const lines = () => out.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const started = async (): Promise<any> => {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const ready = lines().find(line => line.event === 'started');
      if (ready) return ready;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`runtime exited before ready: ${err}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('runtime startup timed out');
  };
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 12_000);
    try { return await exited; } finally { clearTimeout(timeout); }
  };
  const completed = async () => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 25_000);
    try { return { code: await exited, stdout: out, stderr: err }; } finally { clearTimeout(timeout); }
  };
  return { child, started, stop, completed, lines, stderr: () => err };
}

function backendEnv(app: FleetApp): NodeJS.ProcessEnv {
  return {
    NEOP_APP_DB_URL: roleUrl(db.adminUrl, `${app}_app`), NEOP_RUNNER_DB_URL: roleUrl(db.adminUrl, `${app}_runner`),
    NEOP_JOB_TOKEN_SECRET: 'synthetic-standalone-fixture-only-'.repeat(3),
    NEOP_GATE_URL: 'http://127.0.0.1:9', NEOP_AGENT_URL: 'http://127.0.0.1:9',
    FILES_HOST: '127.0.0.1', GATE_HOST: '127.0.0.1', APPSERVICE_HOST: '127.0.0.1',
    FILES_PORT: '0', GATE_PORT: '0', APPSERVICE_PORT: '0', POOL_SIZE: '1',
    NEOP_PRESENCE: 'appservice', NEOP_MATRIX_HOMESERVER_URL: hs.url,
    NEOP_MATRIX_AS_TOKEN: MATRIX.asToken, NEOP_MATRIX_HS_TOKEN: MATRIX.hsToken,
  };
}

beforeAll(async () => {
  db = await createTestDatabase('fleet_runtime');
  admin = createPool(db.adminUrl, 1);
  hs = await fakeHomeserver(() => 'http://127.0.0.1:9');
  for (const app of FLEET_APPS) await migrateApp(db.adminUrl, await loadFleetApp(app));
});
afterAll(async () => {
  for (const child of children) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
  await hs?.close(); await admin?.end(); await db?.drop();
});

describe.each(FLEET_APPS)('%s standalone processes', app => {
  it('boots its real backend, serves health, refuses unauthenticated ingress and terminates cleanly', async () => {
    const runtime = launch(app, 'backend', backendEnv(app));
    try {
      const ready = await runtime.started();
      expect(ready).toMatchObject({ app, side: 'backend', version: (await loadFleetApp(app)).manifest.version });
      expect((await fetch(`http://127.0.0.1:${ready.files}/live`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${ready.files}/ready`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${ready.files}/metrics`)).status).toBe(404);
      const ingress = await fetch(`http://127.0.0.1:${ready.appservice}/_matrix/app/v1/transactions/fixture`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"events":[]}' });
      expect([401, 403]).toContain(ingress.status);
      const connections = await admin.query('select distinct usename from pg_stat_activity where datname = current_database() and usename = any($1)', [[`${app}_app`, `${app}_runner`]]);
      expect(connections.rows.map(row => row.usename).sort()).toEqual([`${app}_app`, `${app}_runner`].sort());
      expect((await admin.query(`select count(*)::int as n from ${sqlIdent(app)}.jobs`)).rows[0].n).toBe(0);
      expect(hs.sent).toEqual([]); expect(hs.typed).toEqual([]);
    } finally { expect(await runtime.stop()).toBe(0); }
  });

  it('runs a keyless worker, rejects another gate or missing model session, and stops cleanly', async () => {
    const runtime = launch(app, 'agent', { NEOP_ALLOWED_GATE: 'http://127.0.0.1:9', PORT: '0', HOST: '127.0.0.1', POOL_SIZE: '1' });
    try {
      const ready = await runtime.started(); expect(ready.app).toBe(app);
      const base = `http://127.0.0.1:${ready.port}`;
      expect(await (await fetch(`${base}/live`)).json()).toEqual({ ok: true, active: 0, pool: 1 });
      const request = async (gate: string) => fetch(`${base}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bundle: { job: { id: 'fixture-job' } }, token: 'not-a-real-token', gate_url: gate }) });
      expect((await request('http://other-backend:4102')).status).toBe(403);
      const noModel = await request('http://127.0.0.1:9'); expect(noModel.status).toBe(400);
      expect((await noModel.json()).error).toMatch(/no LLM session token/);
      expect((await (await fetch(`${base}/live`)).json()).active).toBe(0);
    } finally { expect(await runtime.stop()).toBe(0); }
  });

  it('refuses a changed migration with EX_CONFIG before listening', async () => {
    const table = `${sqlIdent(app)}.schema_migrations`;
    const migration = (await admin.query(`select name, checksum from ${table} order by name limit 1`)).rows[0];
    await admin.query(`update ${table} set checksum = repeat('0', 64) where name = $1`, [migration.name]);
    try {
      const runtime = launch(app, 'backend', backendEnv(app));
      const result = await runtime.completed(); expect(result.code).toBe(78);
      expect(runtime.lines().some(line => line.event === 'started')).toBe(false);
      const error = JSON.parse(result.stderr.trim());
      expect(error).toMatchObject({ app, event: 'schema_refused', changed: [migration.name] });
      expect(result.stderr).not.toContain(backendEnv(app).NEOP_JOB_TOKEN_SECRET);
    } finally { await admin.query(`update ${table} set checksum = $1 where name = $2`, [migration.checksum, migration.name]); }
  });
});

it('refuses leaked backend secrets in the agent without logging their values or reading secret files', async () => {
  const runtime = launch('pay', 'agent', { NEOP_ALLOWED_GATE: 'http://127.0.0.1:9', NEOP_APP_DB_URL_FILE: '/private/never-read-this-fixture' });
  const result = await runtime.completed(); expect(result.code).toBe(78);
  expect(JSON.parse(result.stderr.trim())).toMatchObject({ event: 'configuration_refused', settings: ['NEOP_APP_DB_URL_FILE'] });
  expect(result.stderr).not.toContain('/private/never-read-this-fixture');
});

it('ships dedicated fixed-app wrappers without importing a backend into an agent entry', async () => {
  for (const app of FLEET_APPS) {
    const agent = await readFile(path.join(ROOT, `apps/${app}/scripts/agent.ts`), 'utf8');
    expect(agent).toContain(`runAgent('${app}')`); expect(agent).not.toMatch(/backend|src\/index|@neop\/pgkit/);
    const backend = await readFile(path.join(ROOT, `apps/${app}/scripts/backend.ts`), 'utf8');
    expect(backend).toContain(`runBackend('${app}')`);
  }
});
