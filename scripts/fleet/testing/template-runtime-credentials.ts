import { readFileSync } from 'node:fs';
import path from 'node:path';
import { generateLlmSigningKey } from '../../../packages/neop-template/src/index.ts';
import { readFrontendConfig } from '../../../packages/neop-frontend/src/index.ts';
import { readBackendConfig } from '../runtime/backend.ts';
import { forbiddenAgentSettings, readAgentConfig } from '../runtime/config.ts';
import type { FleetApp } from '../runtime/apps.ts';

const FRONTEND_KEY = 'synthetic-frontend-key-1234567890abcdef';

export async function templateRuntimeCredentialProblems(root: string, app: FleetApp): Promise<string[]> {
  const problems: string[] = [];
  const SYNTHETIC_DB_PASSWORD = 'synthetic-db-password';
  const { privateJwk } = await generateLlmSigningKey(`llm-${app}`);
  const backend: NodeJS.ProcessEnv = {
    NEOS_ENV: 'production', NEOP_APP: app,
    NEOP_APP_DB_URL: `postgres://${app}_app:${SYNTHETIC_DB_PASSWORD}@postgres/neos`,
    NEOP_RUNNER_DB_URL: `postgres://${app}_runner:${SYNTHETIC_DB_PASSWORD}@postgres/neos`,
    NEOP_DIRECT_DB_URL: `postgres://${app}_runner:${SYNTHETIC_DB_PASSWORD}@postgres-direct/neos`,
    NEOP_JOB_TOKEN_SECRET: 'synthetic-job-token-secret-1234567890abcdef',
    NEOP_AGENT_URL: 'http://agent:4103', NEOP_GATE_URL: 'http://gate:4102',
    NEOP_PRESENCE: 'appservice', NEOP_MATRIX_HOMESERVER_URL: 'https://matrix.example.test',
    NEOP_MATRIX_HS_TOKEN: 'synthetic-matrix-hs-token', NEOP_MATRIX_AS_TOKEN: 'synthetic-matrix-as-token',
    NEOP_LLM_PROXY_URL: 'http://llm-proxy:4200/v1', NEOP_LLM_SIGNING_KEY: JSON.stringify(privateJwk),
  };
  try {
    const cfg = readBackendConfig(app, backend);
    if (new URL(cfg.appDbUrl).username !== `${app}_app` || new URL(cfg.runnerDbUrl).username !== `${app}_runner`) problems.push(`${app} backend database roles are not app-scoped`);
    if (!cfg.llm || cfg.llm.signingKey.kid !== `llm-${app}`) problems.push(`${app} backend lacks app-bound short-lived model signing`);
  } catch (error) { problems.push(`${app} production backend credentials are invalid: ${(error as Error).message}`); }
  for (const provider of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NEOP_LLM_VIRTUAL_KEY']) {
    try { readBackendConfig(app, { ...backend, [provider]: 'synthetic-provider-key' }); problems.push(`${app} backend accepted ${provider}`); } catch { /* expected */ }
  }
  const agent = { NEOP_APP: app, NEOP_ALLOWED_GATE: 'http://gate:4102', NEOP_LLM_PROVIDER: 'proxy' };
  try {
    const cfg = readAgentConfig(app, agent);
    if (Object.keys(cfg.modelEnv).some((key) => /KEY|TOKEN|SECRET|PASSWORD|URL/.test(key))) problems.push(`${app} agent model metadata contains a credential or endpoint`);
  } catch (error) { problems.push(`${app} keyless agent configuration is invalid: ${(error as Error).message}`); }
  for (const secret of ['DATABASE_URL', 'NEOP_APP_DB_URL', 'NEOP_MATRIX_CLIENT_ACCOUNTS', 'NEOP_LLM_SIGNING_KEY', 'OPENROUTER_API_KEY', 'NEOP_FRONTEND_KEY']) {
    if (!forbiddenAgentSettings({ ...agent, [secret]: 'synthetic-secret' }).includes(secret)) problems.push(`${app} agent did not reject ${secret}`);
  }
  try { readFrontendConfig(app, app, { NEOS_ENV: 'production', NEOP_APP: app, NEOS_PLATFORM_URL: 'http://platform:4000', NEOP_FRONTEND_KEY: FRONTEND_KEY }); }
  catch (error) { problems.push(`${app} frontend proxy credential is invalid: ${(error as Error).message}`); }
  const compose = readFileSync(path.join(root, 'scripts/fleet/deploy/compose.ts'), 'utf8');
  if (!compose.includes("secrets: ['frontend_key']") || !compose.includes("NEOP_FRONTEND_KEY_FILE: '/run/secrets/frontend_key'")) problems.push(`${app} frontend key is not a file-mounted frontend-only secret`);
  return [...new Set(problems)].sort();
}
