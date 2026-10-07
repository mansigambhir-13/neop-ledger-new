// verify-install.test · scripts/verify-install.ts, the read-only post-install check (ported from 930eb38), run
// against the real pilot: a complete install passes; each broken part is a named FAIL with a plain reason, and any
// FAIL makes the whole check fail. It never writes and never prints a secret.
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyInstall, type CheckResult } from '../../../scripts/verify-install.ts';
import { ledgerApp, LEDGER_ROOT } from '../src/index.ts';
import { bootPilot, fakeClientHomeserver, type Pilot } from './harness.ts';

let P: Pilot;
beforeAll(async () => {
  P = await bootPilot();
});
afterAll(async () => P?.close());

const by = (rs: CheckResult[]) => Object.fromEntries(rs.map((r) => [r.name, r]));
async function run(env: Record<string, string> = {}, fetchImpl?: any) {
  const lines: string[] = [];
  const r = await verifyInstall({
    app: 'ledger',
    company: P.company.id,
    def: await ledgerApp(),
    env: {
      NEOS_PLATFORM_URL: P.platformUrl,
      NEOS_DB_URL: P.adminUrl,
      NEOP_LLM_UPSTREAM_KEY: 'sk-never-printed',
      NEOP_DOOR_SECRETS_DIR: P.doorsDir,
      NEOP_FILES_URL: `http://127.0.0.1:${P.backend.ports.files}`,
      NEOP_PRESENCE: 'appservice',
      NEOS_COMPOSE_FILE: path.join(LEDGER_ROOT, '../../deploy/compose.pilot.yml'),
      ...env,
    },
    fetchImpl,
    out: (l) => lines.push(l),
  });
  return { ...r, by: by(r.results), text: lines.join('\n') };
}

describe('verify-install (read-only, against a running deployment)', () => {
  it('a complete install passes every check it can make; the table never shows a secret', async () => {
    await P.setDoorSecret('email', { provider: 'resend', api_key: 'sk-door-never-printed', from: 'books@acme.example' });
    const r = await run();
    for (const name of [
      'build: ledger is an app of this build',
      'platform: reachable',
      'database: platform link connects (read-only)',
      `platform: ledger is installed for ${P.company.id}`,
      'database: roles ledger_migrator, ledger_app, ledger_runner',
      'database: grants (app and runner use, never create)',
      "database: schema in step with this build's migrations",
      'switchboard: every line within its floor',
      'llm proxy: provider key present (not read)',
      'backend: files/ops /ready',
      'doors: a credential file for every connected door (not read)',
      'deploy: the door secret store reaches the backend only (no agent, no web mount)',
    ]) expect(r.by[name]?.status, `${name}: ${r.by[name]?.detail}`).toBe('PASS');
    expect(['PASS', 'WARN']).toContain(r.by['platform: ledger is registered, active and attested']!.status);
    expect(r.by["matrix: the app's own account token valid (whoami, NEOP_PRESENCE=client)"]!.status).toBe('SKIP');
    expect(r.by['matrix: NeuralChat client token valid (whoami)']!.status).toBe('SKIP');
    expect(r.text).toMatch(/^STATUS\s+CHECK\s+DETAIL/);
    expect(r.text).not.toContain('sk-never-printed');
    expect(r.text).not.toContain('sk-door-never-printed');
    expect(r.text).not.toContain(P.adminUrl);
  });

  it('a switchboard line looser than its floor, a missing key and an unreachable platform are named FAILs; the run fails', async () => {
    // A write whose floor is ask_first, recorded as "on" behind everyone's back: in the app's own switchboard, with
    // its triggers switched off by a superuser's hand (the API and the tighten-only trigger would both refuse it).
    const m = (await ledgerApp()).manifest;
    const write = m.abilities.find((a) => a.kind === 'write' && a.floor === 'ask_first')!;
    const dba = new pg.Client({ connectionString: P.adminUrl });
    await dba.connect();
    const behindTheBack = async (sql: string) => {
      await dba.query('begin');
      await dba.query('set local session_replication_role = replica');
      await dba.query(sql, [P.company.id, write.key]);
      await dba.query('commit');
    };
    await behindTheBack("insert into ledger.switchboard (company_id, line, kind, floor, setting, version) values ($1, $2, 'write', 'ask_first', 'on', 999)");
    try {
      const r = await run({ NEOP_LLM_UPSTREAM_KEY: '', NEOS_COMPOSE_FILE: '', NEOS_PLATFORM_URL: 'http://127.0.0.1:1' });
      expect(r.ok).toBe(false);
      expect(r.by['switchboard: every line within its floor']).toMatchObject({ status: 'FAIL' });
      expect(r.by['switchboard: every line within its floor']!.detail).toContain(`${write.key} is on, looser than its floor ask_first`);
      expect(r.by['llm proxy: provider key present (not read)']).toMatchObject({ status: 'FAIL' });
      expect(r.by['platform: reachable']).toMatchObject({ status: 'FAIL' });
      expect(r.text).toMatch(/\d+ check\(s\) FAILED/);
    } finally {
      await behindTheBack('delete from ledger.switchboard where company_id = $1 and line = $2');
      await dba.end();
    }
  });

  it('doors (v3 §12): a missing or open credential file is a warning, a door switched off needs none, an agent that mounts the store fails', async () => {
    const name = 'doors: a credential file for every connected door (not read)';
    await P.removeDoorSecret('email');
    expect((await run()).by[name]).toMatchObject({ status: 'WARN', detail: expect.stringMatching(/no credential yet for email/) });
    await P.api('PUT', '/api/switchboards/ledger', { settings: { 'door:email': 'off' } });
    expect((await run()).by[name]).toMatchObject({ status: 'PASS', detail: expect.stringMatching(/switched off: email/) });
    await P.api('PUT', '/api/switchboards/ledger', { settings: { 'door:email': 'on' } });
    const f = await P.setDoorSecret('email', { provider: 'dev-mailbox', dir: P.mailDir }, { app: 'ledger' });
    await chmod(f, 0o644);
    expect((await run()).by[name]).toMatchObject({ status: 'WARN', detail: expect.stringMatching(/readable by group or others/) });
    await chmod(f, 0o600);
    expect((await run()).by[name]).toMatchObject({ status: 'PASS', detail: 'email (own)' });
    expect((await run({ NEOP_DOOR_SECRETS_DIR: '/nonexistent/doors' })).by[name]!.status).toBe('FAIL');

    const dep = 'deploy: the door secret store reaches the backend only (no agent, no web mount)';
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neos-compose-'));
    try {
      const good = await readFile(path.join(LEDGER_ROOT, '../../deploy/compose.pilot.yml'), 'utf8');
      const leaky = good.replace('command: ["tsx", "apps/ledger/scripts/agent.ts"]', 'command: ["tsx", "apps/ledger/scripts/agent.ts"]\n    volumes: ["./secrets/doors:/run/secrets/doors:ro"]');
      expect(leaky).not.toBe(good);
      await writeFile(path.join(dir, 'leaky.yml'), leaky);
      const r = await run({ NEOS_COMPOSE_FILE: path.join(dir, 'leaky.yml') });
      expect(r.by[dep]).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/ledger-agent can see the door secret store/) });
      expect(r.ok).toBe(false);
      expect((await run({ NEOS_COMPOSE_FILE: '' })).by[dep]!.status).toBe('SKIP');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    await P.removeDoorSecret('email', { app: 'ledger' });
    await P.setDoorSecret('email', { provider: 'dev-mailbox', dir: P.mailDir });
  });

  it('NEOP_PRESENCE=client: the app token is checked with whoami — its own account passes, another’s fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neos-verify-'));
    try {
      await writeFile(path.join(dir, 'tok'), 'tok-ledger\n');
      const accounts = JSON.stringify([{ account: '@ledger:hs.test', company: P.company.id, app: 'ledger', token_file: path.join(dir, 'tok') }]);
      const env = { NEOP_PRESENCE: 'client', NEOP_MATRIX_HOMESERVER_URL: 'http://hs.test', NEOP_MATRIX_CLIENT_ACCOUNTS: accounts };
      const good = fakeClientHomeserver({ me: '@ledger:hs.test', token: 'tok-ledger' });
      const passthrough = (hs: any) => (url: string, init: any) => (url.startsWith('http://hs.test') ? hs.fetchImpl(url, init) : fetch(url, init));
      const check = "matrix: the app's own account token valid (whoami, NEOP_PRESENCE=client)";
      expect((await run(env, passthrough(good))).by[check]).toMatchObject({ status: 'PASS', detail: '@ledger:hs.test' });
      const other = fakeClientHomeserver({ me: '@ledger:hs.test', token: 'tok-ledger', whoamiAs: '@someone_else:hs.test' });
      expect((await run(env, passthrough(other))).by[check]!.detail).toContain('belongs to @someone_else:hs.test');
      const expired = fakeClientHomeserver({ me: '@ledger:hs.test', token: 'tok-ledger' });
      expired.expireToken();
      const r = await run(env, passthrough(expired));
      expect(r.by[check]).toMatchObject({ status: 'FAIL' });
      expect(r.text).not.toContain('tok-ledger');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
