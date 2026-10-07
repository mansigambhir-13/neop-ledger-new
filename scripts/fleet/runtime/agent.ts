// No app definitions, DB package, backend import or secret-file resolution here.
import type { Server } from 'node:http';
import { proxyModel, startAgentWorker } from '@neop/template/agent';
import { bindHost, readAgentConfig } from './config.ts';
import { entry, runtimeLog, shutdown } from './process.ts';
import type { FleetApp } from './apps.ts';

export async function runAgent(app: FleetApp): Promise<void> {
  await entry(app, 'agent', async () => {
    const cfg = readAgentConfig(app, process.env);
    const host = await bindHost(process.env, 'HOST');
    const worker = await startAgentWorker({
      poolSize: cfg.poolSize,
      port: cfg.port,
      host,
      allowedGates: [cfg.allowedGate],
      model: proxyModel(cfg.modelEnv),
      onEnd: (job, reason) => runtimeLog(app, 'agent', 'info', 'session_ended', { job, reason }),
    });
    shutdown(app, 'agent', async () => {
      const server = worker.server as Server;
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }, 5_000);
    runtimeLog(app, 'agent', 'info', 'started', { port: worker.port, poolSize: cfg.poolSize });
  });
}
