// Ledger backend container entry: L3 + gate + runner. Holds DB roles; no model.
import { SchemaMismatchError, startBackend } from '@neop/template';
import { ledgerApp } from '../src/index.ts';
import { bindAddress, env, loadFileEnv, log, onShutdown, requireEnv } from './env.ts';

requireEnv(['NEOP_APP_DB_URL', 'NEOP_RUNNER_DB_URL', 'NEOS_PLATFORM_URL', 'NEOP_SERVICE_SECRET', 'NEOP_JOB_TOKEN_SECRET', 'NEOP_AGENT_URL', 'NEOP_GATE_URL']);
loadFileEnv(['NEOP_METRICS_TOKEN', 'NEOS_PKG_PW_KEY_LEDGER']);
// Door credentials: read per call from NEOP_DOOR_SECRETS_DIR (default /run/secrets/doors, mounted read-only here only).
// LLM sessions: the runner mints them with this app's signing key; the LLM proxy trusts the public half (v3, S8).
const llm = process.env.NEOP_LLM_PROXY_URL
  ? { proxyUrl: env('NEOP_LLM_PROXY_URL'), signingKey: JSON.parse(env('NEOP_LLM_SIGNING_KEY')) }
  : undefined;
if (!llm) log('warn', 'NEOP_LLM_PROXY_URL is not set: assistant sessions get no model token');
const app = await ledgerApp();
// WP §11 step 8: a schema out of step with this build's migrations is a configuration error (EX_CONFIG).
const b = await startBackend(
  app,
  {
    appDbUrl: env('NEOP_APP_DB_URL'),
    runnerDbUrl: env('NEOP_RUNNER_DB_URL'),
    // LISTEN and the execution lock bypass PgBouncer (S8).
    directDbUrl: process.env.NEOP_DIRECT_DB_URL || process.env.NEOP_DIRECT_DB_URL_FILE ? env('NEOP_DIRECT_DB_URL') : undefined,
    platformUrl: env('NEOS_PLATFORM_URL'),
    serviceSecret: env('NEOP_SERVICE_SECRET'),
    jobTokenSecret: env('NEOP_JOB_TOKEN_SECRET'),
    agentUrl: env('NEOP_AGENT_URL'),
    gateUrl: env('NEOP_GATE_URL'),
    poolSize: Number(env('POOL_SIZE', '5')),
    runnerId: env('RUNNER_ID', `runner-${process.pid}`),
    packageCacheDir: env('NEOP_PACKAGE_CACHE_DIR', '/var/lib/neop/packages'),
    llm,
    // Today's NEOS platform gateway (docs/pilot-ledger-integration.md): on only with its public key and a customer map.
    neosV1: process.env.NEOS_V1_PUBLIC_KEY || process.env.NEOS_V1_PUBLIC_KEY_FILE
      ? { publicKeyPem: env('NEOS_V1_PUBLIC_KEY'), customers: JSON.parse(env('NEOS_V1_CUSTOMERS')) as Record<string, string> }
      : undefined,
    log: (m, e) => log('info', m, e),
  },
  { l3Port: Number(env('L3_PORT', '4101')), gatePort: Number(env('GATE_PORT', '4102')), host: '0.0.0.0', l3Host: await bindAddress('L3_HOST'), gateHost: await bindAddress('GATE_HOST') },
).catch((e: unknown) => {
  if (e instanceof SchemaMismatchError) {
    log('fatal', 'schema is not in step with this build; refusing to start', { schema: e.schema, ...e.drift, detail: e.message });
    process.exit(78); // EX_CONFIG
  }
  throw e;
});
log('info', 'ledger backend up', { l3: b.ports.l3, gate: b.ports.gate, version: app.manifest.version });

// Metrics for the scraper on the telemetry network only (METRICS_HOST, e.g. the `ledger-metrics`
// alias). L3 itself stays reachable only from the gateway's network; this listener answers one
// path, relays /l3/metrics (same bearer token check) and nothing else.
let metricsServer: import('node:http').Server | null = null;
if (process.env.METRICS_HOST) {
  const { createServer } = await import('node:http');
  const l3 = `http://${process.env.L3_HOST || '127.0.0.1'}:${b.ports.l3}/l3/metrics`;
  const host = await bindAddress('METRICS_HOST');
  const port = Number(env('METRICS_PORT', '9464'));
  metricsServer = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') return void res.writeHead(404).end('not found');
    fetch(l3, { headers: { authorization: String(req.headers.authorization ?? '') }, signal: AbortSignal.timeout(10_000) })
      .then(async (r) => void res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'text/plain' }).end(await r.text()))
      .catch(() => void res.writeHead(502).end('metrics unavailable'));
  });
  await new Promise<void>((resolve) => metricsServer!.listen(port, host, resolve));
  log('info', 'metrics listener up', { host, port });
}
onShutdown(async () => {
  metricsServer?.close();
  await b.stop();
});
