// LLM proxy container entry (R1): holds the provider key; verifies platform-signed
// session tokens against the platform JWKS; meters and caps spend in Postgres.
import { serve } from '@hono/node-server';
import { createPool } from '@neop/pgkit';
import { llmProxyApp, pricesFromEnv } from '@neop/platform';
import { env } from './env.ts';

const app = llmProxyApp({
  db: createPool(env('NEOS_DB_URL'), 10),
  jwks: `${env('NEOS_PLATFORM_URL')}/.well-known/jwks.json`,
  upstream: {
    baseUrl: env('NEOP_LLM_UPSTREAM_URL', 'https://api.anthropic.com'),
    apiKey: env('NEOP_LLM_UPSTREAM_KEY'),
    // OpenRouter: NEOP_LLM_UPSTREAM_URL=https://openrouter.ai/api, _AUTH=bearer, _MODEL_PREFIX=anthropic/
    auth: env('NEOP_LLM_UPSTREAM_AUTH', 'x-api-key') === 'bearer' ? 'bearer' : 'x-api-key',
    modelPrefix: env('NEOP_LLM_UPSTREAM_MODEL_PREFIX', ''),
  },
  prices: pricesFromEnv(),
  log: (m, e) => console.log(m, e ?? ''),
});
const port = Number(env('PORT', '4200'));
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => console.log(`llm proxy on :${port}`));
