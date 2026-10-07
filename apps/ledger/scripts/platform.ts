// Platform container entry: companies, Conversations, NeuralChat's Matrix tool, desk and registry.
import { loadOrCreateSigningKeys, neuralChatConfigFromEnv, startPlatform } from '@neop/platform';
import { env, loadFileEnv, log, onShutdown, requireEnv } from './env.ts';

requireEnv(['NEOS_DB_URL', 'NEOS_NEURALCHAT_MATRIX', 'MATRIX_HOMESERVER_URL']);
loadFileEnv(['NEOS_METRICS_TOKEN', 'MATRIX_HS_TOKEN', 'MATRIX_AS_TOKEN']);
const keys = await loadOrCreateSigningKeys(process.env.NEOS_SIGNING_KEY_PATH ?? 'var/platform-signing-key.json');
const p = await startPlatform({
  dbUrl: env('NEOS_DB_URL'),
  // Every ask is several short queries; size to the burst the platform must absorb (PgBouncer multiplexes).
  dbPoolSize: Number(env('NEOS_DB_POOL_SIZE', '20')),
  keys,
  port: Number(env('PORT', '4000')),
  host: '0.0.0.0',
  // v3 S9: NeuralChat's own Matrix identity is mandatory; there is no fallback road.
  neuralchat: neuralChatConfigFromEnv(process.env),
  registryKeys: await loadOrCreateSigningKeys(process.env.NEOS_REGISTRY_KEY_PATH ?? 'var/registry-key.json'),
  log: (m, e) => log('info', m, e),
});
if (process.env.NEOS_LLM_PROXY_URL) p.platform.llmProxyUrl = process.env.NEOS_LLM_PROXY_URL;
log('info', 'platform up', { url: p.url, neuralchat_matrix: p.platform.neuralchat?.cfg.road, llm_proxy: p.platform.llmProxyUrl });
onShutdown(() => p.stop());
