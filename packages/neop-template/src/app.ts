import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { bootstrapFamily, closeServer, migrate, templateFiles, type AppliedMigration } from '@neop/pgkit';
import { Core } from './core.ts';
import { Gate } from './gate/gate.ts';
import { gateApp } from './gate/server.ts';
import { l3App } from './l3/server.ts';
import { Runner } from './runner/runner.ts';
import { DEFAULT_TIMINGS, type AppDefinition, type NeopConfig } from './types.ts';

export const TEMPLATE_MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
/** Template infrastructure tables: not business rows, exempt from the tenant lint. */
export const TEMPLATE_INFRA_TABLES = ['seen_tokens', 'outbox_acked'];

/**
 * The platform's migration runner calls this with an admin connection; the
 * app backend never runs DDL at runtime (it holds only its app/runner roles).
 */
export async function migrateApp(adminUrl: string, app: AppDefinition, log?: (m: string) => void): Promise<AppliedMigration[]> {
  const schema = app.manifest.app;
  await bootstrapFamily(adminUrl, schema);
  return migrate({
    adminUrl,
    schema,
    sources: { dir: app.migrationsDir, prepend: await templateFiles(TEMPLATE_MIGRATIONS) },
    lintExempt: TEMPLATE_INFRA_TABLES,
    log,
  });
}

export interface NeopBackend {
  core: Core;
  gate: Gate;
  runner: Runner;
  /** Bound ports once listening. */
  ports: { l3: number; gate: number };
  stop(): Promise<void>;
}

function listen(app: { fetch: (r: Request) => Response | Promise<Response> }, port: number, host: string): Promise<{ server: ServerType; port: number }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => resolve({ server, port: info.port }));
  });
}

/** Start one app backend: L3 (gateway-facing), the gate endpoint (agent-facing) and the runner. */
export async function startBackend(
  app: AppDefinition,
  cfg: Omit<NeopConfig, 'timings'> & { timings?: Partial<NeopConfig['timings']> },
  opts: { l3Port?: number; gatePort?: number; host?: string; runner?: boolean } = {},
): Promise<NeopBackend> {
  const full: NeopConfig = { ...cfg, timings: { ...DEFAULT_TIMINGS, ...(cfg.timings ?? {}) } };
  const host = opts.host ?? '127.0.0.1';
  const core = new Core(app, full);
  const gate = new Gate(core);
  const runner = new Runner(core);
  const l3 = await listen(l3App(core), opts.l3Port ?? 0, host);
  const g = await listen(
    gateApp(core, gate, (claims, reason) => runner.onSessionEnd(claims, reason)),
    opts.gatePort ?? 0,
    host,
  );
  if (!full.gateUrl) (full as { gateUrl?: string }).gateUrl = `http://${host}:${g.port}`;
  if (opts.runner !== false) await runner.start();
  return {
    core,
    gate,
    runner,
    ports: { l3: l3.port, gate: g.port },
    async stop() {
      await runner.stop();
      await Promise.all([closeServer(l3.server as any), closeServer(g.server as any)]);
      await core.close();
    },
  };
}
