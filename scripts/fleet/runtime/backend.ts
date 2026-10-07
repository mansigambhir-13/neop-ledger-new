import { createPrivateKey } from 'node:crypto';
import { LlmSessions, presenceConfigFromEnv, SchemaMismatchError, startBackend } from '@neop/template';
import type { LlmConfig } from '@neop/template';
import { appIdentity, bindHost, database, endpoint, integer, optional, RuntimeConfigError, setting } from './config.ts';
import { loadFleetApp } from './load.ts';
import { entry, runtimeLog, shutdown } from './process.ts';
import type { FleetApp } from './apps.ts';

export function readBackendConfig(app: FleetApp, env: NodeJS.ProcessEnv) {
  appIdentity(app, env);
  const providerKeys = Object.keys(env).filter(k => env[k] !== undefined && /^(?:(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE|MISTRAL|GROQ|COHERE)_API_KEY|NEOP_LLM_(?:VIRTUAL_KEY|BASE_URL))(?:_FILE)?$/.test(k));
  if (providerKeys.length) throw new RuntimeConfigError(providerKeys);
  const appDb = database(env, 'NEOP_APP_DB_URL', `${app}_app`);
  const runnerDb = database(env, 'NEOP_RUNNER_DB_URL', `${app}_runner`);
  const directDb = optional(env, 'NEOP_DIRECT_DB_URL') === undefined ? undefined : database(env, 'NEOP_DIRECT_DB_URL', `${app}_runner`);
  if (appDb.database !== runnerDb.database || (directDb && directDb.database !== runnerDb.database)) throw new RuntimeConfigError(['NEOP_APP_DB_URL', 'NEOP_RUNNER_DB_URL', 'NEOP_DIRECT_DB_URL']);
  const secret = setting(env, 'NEOP_JOB_TOKEN_SECRET');
  if (secret.split(',').some(s => s.trim().length < 32)) throw new RuntimeConfigError(['NEOP_JOB_TOKEN_SECRET']);
  const gateUrl = endpoint(env, 'NEOP_GATE_URL');
  const agentUrl = endpoint(env, 'NEOP_AGENT_URL');
  const homeserver = endpoint(env, 'NEOP_MATRIX_HOMESERVER_URL', true);
  const presenceMode = setting(env, 'NEOP_PRESENCE', 'client').toLowerCase();
  if (!['appservice', 'client'].includes(presenceMode)) throw new RuntimeConfigError(['NEOP_PRESENCE']);
  const presenceEnv: NodeJS.ProcessEnv = { ...env, NEOP_PRESENCE: presenceMode, NEOP_MATRIX_HOMESERVER_URL: homeserver };
  for (const key of ['MATRIX_REPLY_DEADLINE_MS', 'MATRIX_SYNC_TIMEOUT_MS']) {
    if (env[key] !== undefined || env[`${key}_FILE`] !== undefined) presenceEnv[key] = String(integer(env, key, 1000, 1, 300_000));
  }
  if (presenceMode === 'appservice') {
    for (const key of ['NEOP_MATRIX_HS_TOKEN', 'NEOP_MATRIX_AS_TOKEN']) setting(env, key);
    presenceEnv.APPSERVICE_PORT = String(integer(env, 'APPSERVICE_PORT', 4104, 0, 65535));
  } else if (presenceMode === 'client') {
    setting(env, 'NEOP_MATRIX_CLIENT_ACCOUNTS');
  }
  let presence;
  try { presence = presenceConfigFromEnv(presenceEnv); }
  catch { throw new RuntimeConfigError(['NEOP_PRESENCE', 'NEOP_MATRIX_CLIENT_ACCOUNTS', 'NEOP_MATRIX_HS_TOKEN', 'NEOP_MATRIX_AS_TOKEN']); }
  let llm: LlmConfig | undefined;
  const llmUrl = optional(env, 'NEOP_LLM_PROXY_URL');
  const llmKey = optional(env, 'NEOP_LLM_SIGNING_KEY');
  if (llmUrl !== undefined || llmKey !== undefined || env.NEOS_ENV === 'production') {
    try {
      llm = { proxyUrl: endpoint(env, 'NEOP_LLM_PROXY_URL', true), signingKey: JSON.parse(setting(env, 'NEOP_LLM_SIGNING_KEY')) };
      new LlmSessions(app, llm); // validate before any listener or DB connection
      createPrivateKey({ key: llm.signingKey, format: 'jwk' });
    } catch { throw new RuntimeConfigError(['NEOP_LLM_PROXY_URL', 'NEOP_LLM_SIGNING_KEY']); }
  }
  let registryJwks;
  const registry = optional(env, 'NEOP_REGISTRY_JWKS');
  if (registry) {
    try {
      registryJwks = JSON.parse(registry);
      if (!Array.isArray(registryJwks?.keys) || registryJwks.keys.some((key: any) => !key || typeof key !== 'object' || key.d)) throw new Error();
    } catch { throw new RuntimeConfigError(['NEOP_REGISTRY_JWKS']); }
  }
  const metricsToken = optional(env, 'NEOP_METRICS_TOKEN');
  if (env.NEOS_ENV === 'production' && env.NEOP_METRICS_PUBLIC === '1') throw new RuntimeConfigError(['NEOP_METRICS_PUBLIC']);
  return {
    appDbUrl: appDb.url, runnerDbUrl: runnerDb.url, directDbUrl: directDb?.url,
    jobTokenSecret: secret, gateUrl, agentUrl, presence, llm, registryJwks,
    poolSize: integer(env, 'POOL_SIZE', 5, 1, 100),
    runnerId: setting(env, 'RUNNER_ID', `${app}-${process.pid}`),
    filesPort: integer(env, 'FILES_PORT', 4101, 0, 65535),
    gatePort: integer(env, 'GATE_PORT', 4102, 0, 65535),
    filesPublicUrl: optional(env, 'NEOP_FILES_PUBLIC_URL') === undefined ? undefined : endpoint(env, 'NEOP_FILES_PUBLIC_URL', true),
    metricsToken,
  };
}

export async function runBackend(app: FleetApp): Promise<void> {
  await entry(app, 'backend', async () => {
    const { filesPort, gatePort, filesPublicUrl, metricsToken, ...cfg } = readBackendConfig(app, process.env);
    const [filesHost, gateHost, appserviceHost] = await Promise.all([
      bindHost(process.env, 'FILES_HOST'), bindHost(process.env, 'GATE_HOST'), bindHost(process.env, 'APPSERVICE_HOST'),
    ]);
    if (cfg.presence.appservice) cfg.presence.appservice.host = appserviceHost;
    if (metricsToken) process.env.NEOP_METRICS_TOKEN = metricsToken;
    const def = await loadFleetApp(app);
    if (!cfg.llm) runtimeLog(app, 'backend', 'warn', 'model_sessions_unconfigured');
    let backend;
    try {
      backend = await startBackend(def, { ...cfg, files: { publicUrl: filesPublicUrl } }, { filesPort, gatePort, filesHost, gateHost });
    } catch (error) {
      if (error instanceof SchemaMismatchError) {
        runtimeLog(app, 'backend', 'fatal', 'schema_refused', { schema: app, ...error.drift });
        process.exit(78);
      }
      throw error;
    }
    shutdown(app, 'backend', () => backend.stop());
    runtimeLog(app, 'backend', 'info', 'started', { ...backend.ports, version: def.manifest.version });
  });
}
