// Ledger backend container entry: L3 + gate + runner. Holds DB roles; no model.
import { startBackend } from '@neop/template';
import { ledgerApp } from '../src/index.ts';
import { bindAddress, env, loadFileEnv, log, onShutdown, requireEnv } from './env.ts';

requireEnv(['NEOP_APP_DB_URL', 'NEOP_RUNNER_DB_URL', 'NEOS_PLATFORM_URL', 'NEOP_SERVICE_SECRET', 'NEOP_JOB_TOKEN_SECRET', 'NEOP_AGENT_URL', 'NEOP_GATE_URL']);
loadFileEnv(['NEOP_METRICS_TOKEN', 'NEOS_PKG_PW_KEY_LEDGER']);
const app = await ledgerApp();
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
    log: (m, e) => log('info', m, e),
  },
  { l3Port: Number(env('L3_PORT', '4101')), gatePort: Number(env('GATE_PORT', '4102')), host: '0.0.0.0', l3Host: await bindAddress('L3_HOST'), gateHost: await bindAddress('GATE_HOST') },
);
log('info', 'ledger backend up', { l3: b.ports.l3, gate: b.ports.gate, version: app.manifest.version });
onShutdown(() => b.stop());
