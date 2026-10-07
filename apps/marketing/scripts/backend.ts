// Marketing backend container entry: files/ops + gate + runner + Matrix presence. Holds DB roles; no model.
import { presenceConfigFromEnv, startBackend } from '@neop/template';
import { marketingApp } from '../src/index.ts';
import { env } from '../../ledger/scripts/env.ts';

const app = await marketingApp();
const b = await startBackend(
  app,
  {
    appDbUrl: env('NEOP_APP_DB_URL'),
    runnerDbUrl: env('NEOP_RUNNER_DB_URL'),
    jobTokenSecret: env('NEOP_JOB_TOKEN_SECRET'),
    agentUrl: env('NEOP_AGENT_URL'),
    gateUrl: env('NEOP_GATE_URL'),
    poolSize: Number(env('POOL_SIZE', '5')),
    runnerId: env('RUNNER_ID', `runner-${process.pid}`),
    presence: presenceConfigFromEnv(process.env),
    files: { publicUrl: process.env.NEOP_FILES_PUBLIC_URL },
    log: (m, e) => console.log(m, e ?? ''),
  },
  { filesPort: Number(env('FILES_PORT', '4101')), gatePort: Number(env('GATE_PORT', '4102')), host: '0.0.0.0' },
);
console.log(`marketing backend: files :${b.ports.files} · gate :${b.ports.gate} · Matrix ${b.presence?.cfg.mode}`);
