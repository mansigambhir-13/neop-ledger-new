// Marketing backend container entry: L3 + gate + runner. Holds DB roles; no model.
import { startBackend } from '@neop/template';
import { marketingApp } from '../src/index.ts';
import { env } from '../../ledger/scripts/env.ts';

const app = await marketingApp();
const b = await startBackend(
  app,
  {
    appDbUrl: env('NEOP_APP_DB_URL'),
    runnerDbUrl: env('NEOP_RUNNER_DB_URL'),
    platformUrl: env('NEOS_PLATFORM_URL'),
    serviceSecret: env('NEOP_SERVICE_SECRET'),
    jobTokenSecret: env('NEOP_JOB_TOKEN_SECRET'),
    agentUrl: env('NEOP_AGENT_URL'),
    gateUrl: env('NEOP_GATE_URL'),
    poolSize: Number(env('POOL_SIZE', '5')),
    runnerId: env('RUNNER_ID', `runner-${process.pid}`),
    log: (m, e) => console.log(m, e ?? ''),
  },
  { l3Port: Number(env('L3_PORT', '4101')), gatePort: Number(env('GATE_PORT', '4102')), host: '0.0.0.0' },
);
console.log(`marketing backend: L3 :${b.ports.l3} · gate :${b.ports.gate}`);
