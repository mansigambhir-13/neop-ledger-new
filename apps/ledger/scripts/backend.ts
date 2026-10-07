// Ledger backend container entry: files/ops + gate + runner + Matrix presence. Holds DB roles; no model.
import { presenceConfigFromEnv, SchemaMismatchError, startBackend } from '@neop/template';
import { ledgerApp } from '../src/index.ts';
import { bindAddress, env, loadFileEnv, log, onShutdown, requireEnv } from './env.ts';

requireEnv(['NEOP_APP_DB_URL', 'NEOP_RUNNER_DB_URL', 'NEOP_JOB_TOKEN_SECRET', 'NEOP_AGENT_URL', 'NEOP_GATE_URL']);
loadFileEnv(['NEOP_METRICS_TOKEN', 'NEOS_PKG_PW_KEY_LEDGER']);
// Door credentials: read per call from NEOP_DOOR_SECRETS_DIR (default /run/secrets/doors, mounted read-only here only).
// LLM sessions: the runner mints them with this app's signing key; the LLM proxy trusts the public half (v3, S8).
const llm = process.env.NEOP_LLM_PROXY_URL
  ? { proxyUrl: env('NEOP_LLM_PROXY_URL'), signingKey: JSON.parse(env('NEOP_LLM_SIGNING_KEY')) }
  : undefined;
if (!llm) log('warn', 'NEOP_LLM_PROXY_URL is not set: assistant sessions get no model token');
// v3 S9: Matrix is the only road. Invalid or missing road-specific settings fail closed here.
const presence = presenceConfigFromEnv(process.env);
log('info', 'NEOP presence on', { mode: presence.mode, homeserver: presence.homeserverUrl });
const app = await ledgerApp();
// WP §11 step 8: a schema out of step with this build's migrations is a configuration error (EX_CONFIG).
const b = await startBackend(
  app,
  {
    appDbUrl: env('NEOP_APP_DB_URL'),
    runnerDbUrl: env('NEOP_RUNNER_DB_URL'),
    // LISTEN and the execution lock bypass PgBouncer (S8).
    directDbUrl: process.env.NEOP_DIRECT_DB_URL || process.env.NEOP_DIRECT_DB_URL_FILE ? env('NEOP_DIRECT_DB_URL') : undefined,
    jobTokenSecret: env('NEOP_JOB_TOKEN_SECRET'),
    agentUrl: env('NEOP_AGENT_URL'),
    gateUrl: env('NEOP_GATE_URL'),
    poolSize: Number(env('POOL_SIZE', '5')),
    runnerId: env('RUNNER_ID', `runner-${process.pid}`),
    // v3 S7: packages are in the image (src/packages, packages.lock.json); NEOP_REGISTRY_JWKS pins the registry's keys.
    registryJwks: process.env.NEOP_REGISTRY_JWKS || process.env.NEOP_REGISTRY_JWKS_FILE ? JSON.parse(env('NEOP_REGISTRY_JWKS')) : undefined,
    llm,
    presence,
    files: { publicUrl: process.env.NEOP_FILES_PUBLIC_URL },
    log: (m, e) => log('info', m, e),
  },
  { filesPort: Number(env('FILES_PORT', '4101')), gatePort: Number(env('GATE_PORT', '4102')), host: '0.0.0.0', filesHost: await bindAddress('FILES_HOST'), gateHost: await bindAddress('GATE_HOST') },
).catch((e: unknown) => {
  if (e instanceof SchemaMismatchError) {
    log('fatal', 'schema is not in step with this build; refusing to start', { schema: e.schema, ...e.drift, detail: e.message });
    process.exit(78); // EX_CONFIG
  }
  throw e;
});
log('info', 'ledger backend up', { files: b.ports.files, gate: b.ports.gate, appservice: b.ports.appservice ?? null, version: app.manifest.version });

// Metrics for the scraper on the telemetry network only. The files/ops listener owns /metrics;
// this narrow relay avoids joining the backend's browser-facing network to telemetry.
let metricsServer: import('node:http').Server | null = null;
if (process.env.METRICS_HOST) {
  const { createServer } = await import('node:http');
  const metrics = `http://${process.env.FILES_HOST || '127.0.0.1'}:${b.ports.files}/metrics`;
  const host = await bindAddress('METRICS_HOST');
  const port = Number(env('METRICS_PORT', '9464'));
  metricsServer = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') return void res.writeHead(404).end('not found');
    fetch(metrics, { headers: { authorization: String(req.headers.authorization ?? '') }, signal: AbortSignal.timeout(10_000) })
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
