// Platform container entry: gateway, task store, desk, approvals, outbox consumer, chat bridge, registry.
import { chatClientConfigFromEnv, loadOrCreateSigningKeys, neuralChatConfigFromEnv, startPlatform } from '@neop/platform';
import { env, loadFileEnv, log, onShutdown, requireEnv } from './env.ts';

requireEnv(['NEOS_DB_URL', 'NEOS_VAULT_KEYS']);
loadFileEnv(['NEOS_METRICS_TOKEN']);
const keys = await loadOrCreateSigningKeys(process.env.NEOS_GATEWAY_KEY_PATH ?? 'var/gateway-key.json');
// MATRIX_MODE=client: one ordinary account per company-app install, /sync in this process; else the appservice.
const client = chatClientConfigFromEnv(process.env);
const matrix = !client && process.env.MATRIX_HOMESERVER_URL
  ? { homeserverUrl: env('MATRIX_HOMESERVER_URL'), serverName: env('MATRIX_SERVER_NAME'), hsToken: env('MATRIX_HS_TOKEN'), asToken: env('MATRIX_AS_TOKEN') }
  : null;
const p = await startPlatform({
  dbUrl: env('NEOS_DB_URL'),
  // Every ask is several short queries; size to the burst the platform must absorb (PgBouncer multiplexes).
  dbPoolSize: Number(env('NEOS_DB_POOL_SIZE', '20')),
  keys,
  port: Number(env('PORT', '4000')),
  host: '0.0.0.0',
  chat: client ? { client } : matrix ? { matrix } : undefined,
  // v3 S5: NeuralChat's own Matrix identity per company (NEOS_NEURALCHAT_MATRIX=appservice|client; default off).
  neuralchat: neuralChatConfigFromEnv(process.env) ?? undefined,
  registryKeys: await loadOrCreateSigningKeys(process.env.NEOS_REGISTRY_KEY_PATH ?? 'var/registry-key.json'),
  vaultKeys: JSON.parse(env('NEOS_VAULT_KEYS')),
  log: (m, e) => log('info', m, e),
});
await p.platform.rekeyVault();
if (process.env.NEOS_LLM_PROXY_URL) p.platform.llmProxyUrl = process.env.NEOS_LLM_PROXY_URL;
log('info', 'platform up', { url: p.url, matrix: client ? 'client' : matrix ? 'appservice' : false, neuralchat_matrix: p.platform.neuralchat?.cfg.road ?? false, llm_proxy: p.platform.llmProxyUrl });
onShutdown(() => p.stop());
