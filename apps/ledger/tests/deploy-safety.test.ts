// Exercise the real deployment shell entrypoints with a recording Docker stub.
// No database, provider, or Docker daemon is touched by these failure-path tests.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { LEDGER_ROOT } from '../src/index.ts';

const ROOT = path.resolve(LEDGER_ROOT, '../..');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'neop-deploy-guard-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  const secrets = path.join(dir, 'secrets');
  mkdirSync(bin); mkdirSync(secrets);
  const log = path.join(dir, 'docker.log');
  writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
printf '%s\\n' "$*" >> "$DEPLOY_COMMAND_LOG"
case "$*" in
  *"ps --services --status running"*) if [ "\${DEPLOY_BACKUP_RUNNING:-0}" = 1 ]; then echo backup; fi ;;
  *"ps -a -q postgres"*) printf '%s' "\${DEPLOY_EXISTING_DB:-}"; exit "\${DEPLOY_INSPECTION_EXIT:-0}" ;;
  "volume ls -q "*) printf '%s' "\${DEPLOY_EXISTING_VOLUME:-}" ;;
  *"exec -T backup "*) echo backup-attempted; exit "\${DEPLOY_BACKUP_EXIT:-0}" ;;
  *) exit "\${DEPLOY_OTHER_EXIT:-1}" ;;
esac
`, { mode: 0o700 });
  writeFileSync(path.join(bin, 'pnpm'), '#!/bin/bash\nexit 1\n', { mode: 0o700 });
  for (const name of ['llm', 'ledger-token', 'neuralchat-token']) writeFileSync(path.join(dir, name), 'test-input\n');
  const config = path.join(dir, 'production.env');
  const values = {
    NEOS_PROJECT: 'neop-deploy-guard', NEOS_SECRETS_DIR: secrets,
    COMPANY_NAME: 'Acceptance', COMPANY_TZ: 'UTC', ADMIN_NAME: 'Test', ADMIN_EMAIL: 'test@example.test',
    LLM_KEY_FILE: path.join(dir, 'llm'), NEOP_FILES_PUBLIC_URL: 'https://files.example.test',
    MATRIX_HOMESERVER_URL: 'https://matrix.example.test', LEDGER_MXID: '@ledger:example.test',
    LEDGER_MATRIX_TOKEN_FILE: path.join(dir, 'ledger-token'), NEURALCHAT_MXID: '@neuralchat:example.test',
    NEURALCHAT_MATRIX_TOKEN_FILE: path.join(dir, 'neuralchat-token'),
  };
  writeFileSync(config, Object.entries(values).map(([k,v]) => k + '=' + quote(v)).join('\n') + '\n');
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, DEPLOY_COMMAND_LOG: log,
    NEOP_PRESENCE: 'client', NEOS_NEURALCHAT_MATRIX: 'client', BRIDGE_MAY_APPROVE: '', NEOS_COMPOSE_EXTRA: '' };
  return { dir, secrets, config, env, log };
}

function deploy(options: { state?: unknown; vars?: NodeJS.ProcessEnv } = {}) {
  const f = fixture();
  if (options.state !== undefined) writeFileSync(path.join(f.secrets, 'deploy-state.json'), JSON.stringify(options.state));
  const r = spawnSync('bash', ['scripts/deploy.sh', f.config], { cwd: ROOT, env: { ...f.env, ...options.vars }, encoding: 'utf8' });
  return { ...r, commands: readFileSync(f.log, 'utf8'), output: r.stdout + r.stderr };
}

describe('deployment refuses to upgrade without a recovery backup', () => {
  it('stopped backup service stops before generating secrets, building or migrating', () => {
    const r = deploy({ state: { company_id: 'existing-company' } });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('the backup service is not running');
    expect(r.commands).not.toMatch(/gen-secrets|build|run --rm migrate/);
  });

  it('failed backup aborts before any deployment mutation', () => {
    const r = deploy({ state: { company_id: 'existing-company' }, vars: { DEPLOY_BACKUP_RUNNING: '1', DEPLOY_BACKUP_EXIT: '1' } });
    expect(r.output).toContain('pre-upgrade backup failed');
    expect(r.commands).toContain('exec -T backup tsx scripts/backup.ts nightly');
    expect(r.commands).not.toMatch(/gen-secrets|build|run --rm migrate/);
  });

  it.each([
    { DEPLOY_EXISTING_DB: 'stopped-postgres-container' },
    { DEPLOY_EXISTING_VOLUME: 'surviving-pgdata-volume' },
  ])('missing deploy state cannot turn an existing database into a first install: %j', (vars) => {
    const r = deploy({ vars });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('existing database found without deploy-state.json');
    expect(r.commands).not.toMatch(/gen-secrets|build|run --rm migrate/);
  });

  it('an inspection failure is not mistaken for an empty host', () => {
    const r = deploy({ vars: { DEPLOY_INSPECTION_EXIT: '1' } });
    expect(r.output).toContain('could not inspect the existing database container');
    expect(r.commands).not.toContain('gen-secrets');
  });

  it('a first install may reach secret generation only after checking containers and volumes', () => {
    const r = deploy();
    expect(r.output).toContain('first install: nothing to back up');
    expect(r.output).toContain('could not generate secrets'); // The stub deliberately stops here.
    expect(r.commands.indexOf('ps -a -q postgres')).toBeLessThan(r.commands.indexOf('gen-secrets'));
    expect(r.commands.indexOf('volume ls')).toBeLessThan(r.commands.indexOf('gen-secrets'));
  });

  it('a successful upgrade backup precedes secret generation', () => {
    const r = deploy({ state: { company_id: 'existing-company' }, vars: { DEPLOY_BACKUP_RUNNING: '1' } });
    expect(r.output).toContain('could not generate secrets'); // No real deployment.
    expect(r.commands.indexOf('exec -T backup')).toBeLessThan(r.commands.indexOf('gen-secrets'));
  });
});

describe('Matrix setup for the supported appservice topology', () => {
  it('defaults to disjoint appservices and honours the configured secret directory', () => {
    const f = fixture();
    const env: NodeJS.ProcessEnv = { ...f.env, NEOS_SECRETS_DIR: f.secrets, DEPLOY_OTHER_EXIT: '0' };
    delete env.NEOP_PRESENCE;
    const r = spawnSync('bash', ['scripts/matrix-setup.sh', 'deploy/compose.pilot.yml', 'neop-setup-test', 'matrix.example.test'], {
      cwd: ROOT, env, encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    const platform = parse(readFileSync(path.join(f.secrets, 'appservice.yaml'), 'utf8'));
    const ledger = parse(readFileSync(path.join(f.secrets, 'appservice.ledger.yaml'), 'utf8'));
    expect(platform.namespaces.users).toEqual([{ exclusive: true, regex: '@neuralchat_.*' }]);
    expect(ledger.namespaces.users).toEqual([{ exclusive: true, regex: '@neop_ledger_.*' }]);
    expect(platform.as_token).not.toBe(ledger.as_token);
    expect(platform.hs_token).not.toBe(ledger.hs_token);
  });
});
