import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readFrontendConfig, startFrontend } from '@neop/frontend';
import { appIdentity } from './config.ts';
import { entry, runtimeLog, shutdown } from './process.ts';
import type { FleetApp } from './apps.ts';

export async function runFrontend(app: FleetApp): Promise<void> {
  appIdentity(app, process.env);
  await entry(app, 'frontend', async () => {
    const manifest = JSON.parse(readFileSync(path.join(process.cwd(), 'apps', app, 'manifest.json'), 'utf8')) as { name: string };
    const cfg = readFrontendConfig(app, manifest.name, process.env);
    const frontend = await startFrontend(cfg);
    shutdown(app, 'frontend', () => frontend.close());
    runtimeLog(app, 'frontend', 'info', 'started', { port: frontend.port, basePath: cfg.basePath || '/' });
  });
}
