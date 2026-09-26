// Platform container entry: gateway, task store, desk, approvals, outbox consumer, chat bridge, registry.
import { loadOrCreateSigningKeys, startPlatform } from '@neop/platform';
import { env, loadFileEnv, log, onShutdown, requireEnv } from './env.ts';

requireEnv(['NEOS_DB_URL', 'NEOS_VAULT_KEYS']);
loadFileEnv(['NEOS_METRICS_TOKEN']);
const keys = await loadOrCreateSigningKeys(process.env.NEOS_GATEWAY_KEY_PATH ?? 'var/gateway-key.json');
const matrix = process.env.MATRIX_HOMESERVER_URL
  ? { homeserverUrl: env('MATRIX_HOMESERVER_URL'), serverName: env('MATRIX_SERVER_NAME'), hsToken: env('MATRIX_HS_TOKEN'), asToken: env('MATRIX_AS_TOKEN') }
  : null;
const p = await startPlatform({
  dbUrl: env('NEOS_DB_URL'),
  keys,
  port: Number(env('PORT', '4000')),
  host: '0.0.0.0',
  chat: matrix ? { matrix } : undefined,
  registryKeys: await loadOrCreateSigningKeys(process.env.NEOS_REGISTRY_KEY_PATH ?? 'var/registry-key.json'),
  vaultKeys: JSON.parse(env('NEOS_VAULT_KEYS')),
  log: (m, e) => log('info', m, e),
});
await p.platform.rekeyVault();
if (process.env.NEOS_LLM_PROXY_URL) p.platform.llmProxyUrl = process.env.NEOS_LLM_PROXY_URL;
log('info', 'platform up', { url: p.url, matrix: !!matrix, llm_proxy: p.platform.llmProxyUrl });
onShutdown(() => p.stop());
