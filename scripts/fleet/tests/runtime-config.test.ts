import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateLlmSigningKey } from '@neop/template';
import { CATALOG_APPS } from '../runtime/apps.ts';
import { readBackendConfig } from '../runtime/backend.ts';
import { forbiddenAgentSettings, readAgentConfig, RuntimeConfigError, setting } from '../runtime/config.ts';
import { loadFleetApp } from '../runtime/load.ts';

const SYNTHETIC_DB_PASSWORD = 'synthetic-private';
const SYNTHETIC_URL_PASSWORD = 'synthetic-private';
const backendEnv = (app = 'pay'): NodeJS.ProcessEnv => ({
  NEOS_ENV: 'test',
  NEOP_APP_DB_URL: `postgres://preview@localhost:5433/private_test`.replace('preview', `${app}_app`),
  NEOP_RUNNER_DB_URL: `postgres://preview@localhost:5433/private_test`.replace('preview', `${app}_runner`),
  NEOP_JOB_TOKEN_SECRET: 'synthetic-runtime-test-only-'.repeat(3),
  NEOP_AGENT_URL: 'http://127.0.0.1:4103', NEOP_GATE_URL: 'http://127.0.0.1:4102',
  NEOP_PRESENCE: 'appservice', NEOP_MATRIX_HOMESERVER_URL: 'http://127.0.0.1:8108',
  NEOP_MATRIX_HS_TOKEN: 'synthetic-fake-hs-only', NEOP_MATRIX_AS_TOKEN: 'synthetic-fake-as-only',
});
const agentEnv = (): NodeJS.ProcessEnv => ({ NEOP_ALLOWED_GATE: 'http://127.0.0.1:4102' });
const temporary: string[] = [];
afterEach(async () => { for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('fleet standalone configuration', () => {
  it.each(CATALOG_APPS)('%s uses its own loader, roles and fixed entrypoint identity', async app => {
    const cfg = readBackendConfig(app, backendEnv(app));
    expect(new URL(cfg.appDbUrl).username).toBe(`${app}_app`);
    expect(new URL(cfg.runnerDbUrl).username).toBe(`${app}_runner`);
    expect((await loadFleetApp(app)).manifest.app).toBe(app);
    expect(readAgentConfig(app, agentEnv()).app).toBe(app);
    expect(() => readBackendConfig(app, { ...backendEnv(app), NEOP_APP: 'ledger' })).toThrow(RuntimeConfigError);
  });

  it.each(['marketing', '../ledger', 'constructor', 'PAY', ''])('refuses unlisted dynamic app selection %j', async app => {
    await expect(loadFleetApp(app)).rejects.toThrow(RuntimeConfigError);
    expect(() => readAgentConfig(app, agentEnv())).toThrow(RuntimeConfigError);
  });

  it.each(['NaN', 'Infinity', '-1', '1.5', '1e2', '0', '101'])('refuses invalid pool size %j', value => {
    expect(() => readAgentConfig('pay', { ...agentEnv(), POOL_SIZE: value })).toThrow(RuntimeConfigError);
    expect(() => readBackendConfig('pay', { ...backendEnv(), POOL_SIZE: value })).toThrow(RuntimeConfigError);
  });

  it.each(['-1', '65536', '1.2', ''])('refuses malformed listener ports %j', value => {
    expect(() => readAgentConfig('pay', { ...agentEnv(), PORT: value })).toThrow(RuntimeConfigError);
    for (const name of ['FILES_PORT', 'GATE_PORT', 'APPSERVICE_PORT']) expect(() => readBackendConfig('pay', { ...backendEnv(), [name]: value })).toThrow(RuntimeConfigError);
  });

  it.each([`https://user:${SYNTHETIC_URL_PASSWORD}@local/`, 'http://local/?token=private', 'file:///tmp/model', 'http://local/#private', 'http://local/subpath'])('refuses credential-bearing or ambiguous gate URL %j', url => {
    expect(() => readAgentConfig('pay', { ...agentEnv(), NEOP_ALLOWED_GATE: url })).toThrow(RuntimeConfigError);
  });

  it('refuses admin, another app, a mismatched database and a wrong direct role', () => {
    for (const patch of [
      { NEOP_APP_DB_URL: `postgres://neos_admin:${SYNTHETIC_DB_PASSWORD}@localhost/private_test` },
      { NEOP_APP_DB_URL: `postgres://buy_app:${SYNTHETIC_DB_PASSWORD}@localhost/private_test` },
      { NEOP_RUNNER_DB_URL: `postgres://pay_runner:${SYNTHETIC_DB_PASSWORD}@localhost/other_db` },
      { NEOP_DIRECT_DB_URL: `postgres://pay_app:${SYNTHETIC_DB_PASSWORD}@localhost/private_test` },
    ]) expect(() => readBackendConfig('pay', { ...backendEnv(), ...patch })).toThrow(RuntimeConfigError);
  });

  it('allows the runner direct link to use another host for PgBouncer bypass', () => {
    const cfg = readBackendConfig('grant', { ...backendEnv('grant'), NEOP_DIRECT_DB_URL: 'postgres://grant_runner@postgres-direct/private_test' });
    expect(cfg.directDbUrl).toContain('postgres-direct');
  });

  it('refuses pg query-string identity/session overrides while preserving TLS options', () => {
    for (const query of ['user=neos_admin', 'host=other-cluster', 'port=6543', 'options=-c%20role%3Dneos_admin', 'password=override', 'database=other']) {
      expect(() => readBackendConfig('pay', { ...backendEnv(), NEOP_APP_DB_URL: backendEnv().NEOP_APP_DB_URL + '?' + query })).toThrow(RuntimeConfigError);
    }
    expect(readBackendConfig('pay', { ...backendEnv(), NEOP_APP_DB_URL: backendEnv().NEOP_APP_DB_URL + '?sslmode=verify-full&application_name=fleet' }).appDbUrl).toContain('sslmode=verify-full');
  });

  it.each(['NEOP_APP_DB_URL', 'NEOP_RUNNER_DB_URL_FILE', 'NEOP_JOB_TOKEN_SECRET', 'NEOP_DOOR_SECRETS_DIR', 'NEOP_MATRIX_CLIENT_ACCOUNTS', 'NEOS_ADMIN_URL', 'NEOS_PW_PAY_APP', 'PGHOST', 'PGPASSFILE', 'DATABASE_URL', 'OPENAI_API_KEY', 'AWS_ACCESS_KEY_ID', 'NEOP_LLM_SIGNING_KEY_FILE', 'NEOP_LLM_VIRTUAL_KEY'])('assistant refuses injected backend/provider setting %s without echoing its value', key => {
    const env = { ...agentEnv(), [key]: 'private-value-must-not-appear' };
    expect(forbiddenAgentSettings(env)).toContain(key);
    try { readAgentConfig('pay', env); throw new Error('unexpected success'); }
    catch (error) { expect(error).toBeInstanceOf(RuntimeConfigError); expect(String(error)).not.toContain('private-value-must-not-appear'); }
  });

  it('only supplies non-secret model metadata to the keyless model factory', () => {
    const cfg = readAgentConfig('pay', { ...agentEnv(), NEOP_LLM_MODEL: 'fixture-model', NEOP_LLM_API: 'anthropic-messages', HOME: '/tmp/fixture' });
    expect(cfg.modelEnv).toEqual({ NEOP_LLM_MODEL: 'fixture-model', NEOP_LLM_API: 'anthropic-messages' });
    expect(() => readBackendConfig('pay', { ...backendEnv(), ANTHROPIC_API_KEY: 'synthetic-private' })).toThrow(RuntimeConfigError);
  });

  it('requires a complete runner model configuration in production and never falls back to a provider key', async () => {
    const env = { ...backendEnv(), NEOS_ENV: 'production' };
    expect(() => readBackendConfig('pay', env)).toThrow(RuntimeConfigError);
    expect(() => readBackendConfig('pay', { ...env, NEOP_LLM_PROXY_URL: 'http://proxy:4200' })).toThrow(RuntimeConfigError);
    const { privateJwk } = await generateLlmSigningKey('runtime-fixture');
    const configured = { ...env, NEOP_LLM_PROXY_URL: 'http://proxy:4200/v1', NEOP_LLM_SIGNING_KEY: JSON.stringify(privateJwk) };
    expect(readBackendConfig('pay', configured).llm?.signingKey.kid).toBe('runtime-fixture');
    expect(() => readBackendConfig('pay', { ...configured, NEOP_METRICS_PUBLIC: '1' })).toThrow(RuntimeConfigError);
    expect(() => readBackendConfig('pay', { ...configured, NEOP_LLM_SIGNING_KEY: 'synthetic-invalid-private-json' })).toThrow(RuntimeConfigError);
  });

  it('reads backend-mounted files, refuses conflicts and hides unreadable paths', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-runtime-config-')); temporary.push(dir);
    const file = path.join(dir, 'fixture-secret'); await writeFile(file, ' fixture-value\n', { mode: 0o600 });
    expect(setting({ TEST_FILE: file }, 'TEST')).toBe('fixture-value');
    expect(() => setting({ TEST: 'inline', TEST_FILE: file }, 'TEST')).toThrow(RuntimeConfigError);
    try { setting({ TEST_FILE: '/private/never-echo-this-path' }, 'TEST'); }
    catch (error) { expect(String(error)).toBe('RuntimeConfigError: Invalid or missing configuration: TEST_FILE'); }
  });

  it('refuses missing Matrix, short token keys and private registry keys', () => {
    for (const patch of [{ NEOP_MATRIX_HOMESERVER_URL: '' }, { NEOP_PRESENCE: 'off' }, { NEOP_JOB_TOKEN_SECRET: 'synthetic-short' }, { NEOP_REGISTRY_JWKS: '{"keys":[{"d":"private"}]}' }]) {
      expect(() => readBackendConfig('pay', { ...backendEnv(), ...patch })).toThrow(RuntimeConfigError);
    }
  });

  it('normalizes Matrix mode before validating its port and refuses malformed signing material at startup', () => {
    expect(() => readBackendConfig('pay', { ...backendEnv(), NEOP_PRESENCE: ' APPSERVICE ', APPSERVICE_PORT: '-1' })).toThrow(RuntimeConfigError);
    expect(readBackendConfig('pay', { ...backendEnv(), NEOP_PRESENCE: ' APPSERVICE ' }).presence.mode).toBe('appservice');
    expect(() => readBackendConfig('pay', { ...backendEnv(), NEOP_LLM_PROXY_URL: 'http://proxy:4200', NEOP_LLM_SIGNING_KEY: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', kid: 'fixture', x: 'invalid', d: 'invalid' }) })).toThrow(RuntimeConfigError);
  });
});
