// Agent container entry: the assistant worker pool. Keyless (R1): each session
// arrives with a platform-signed, budgeted token for the LLM proxy. No database,
// no vault, no route to the platform, no provider key.
import { closeServer } from '@neop/pgkit';
import { proxyModel, startAgentWorker } from '@neop/template/agent';
import { env, log, onShutdown, requireEnv } from './env.ts';

requireEnv(['NEOP_ALLOWED_GATE']);
const w = await startAgentWorker({
  poolSize: Number(env('POOL_SIZE', '5')),
  model: proxyModel(),
  allowedGates: [env('NEOP_ALLOWED_GATE')],
  port: Number(env('PORT', '4103')),
  host: '0.0.0.0',
  onEnd: (job, reason) => log('info', 'session ended', { job, reason }),
});
log('info', 'agent pool up', { port: w.port });
// In-flight sessions are abandoned on stop; their claims lapse and the runner resumes the jobs from the book.
onShutdown(() => closeServer(w.server as any), 5_000);
