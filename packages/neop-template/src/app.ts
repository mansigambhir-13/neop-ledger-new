import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { assertSchemaInStep, bootstrapFamily, closeServer, migrate, templateFiles, type AppliedMigration, type MigrationSource } from '@neop/pgkit';
import { Core } from './core.ts';
import { LOCK_FILE, readLock } from './packages/lock.ts';
import { applyPackageGrants } from './packages/migrate.ts';
import { Gate } from './gate/gate.ts';
import { gateApp } from './gate/server.ts';
import { neosV1App } from './l3/neos-v1.ts';
import { l3App } from './l3/server.ts';
import { documentsL3 } from './l3/documents.ts';
import { registerDocumentLinkKey } from './doors/documents/files.ts';
import { Runner } from './runner/runner.ts';
import { Presence } from './presence/index.ts';
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
  const applied = await migrate({
    adminUrl,
    schema,
    sources: await appMigrationSources(app),
    lintExempt: TEMPLATE_INFRA_TABLES,
    log,
  });
  // v3 §10: installed packages' roles, and their DML on exactly their tables (the migrator cannot make roles).
  if (app.packages) {
    const roles = await applyPackageGrants(adminUrl, schema, await readLock(path.join(app.packages.root, LOCK_FILE)));
    if (roles.length) log?.(`[${schema}] package roles: ${roles.join(', ')}`);
  }
  return applied;
}

/** The app's shipped migration set: the template stream (001_standard, t002 …) then the app's own (002 …). */
export async function appMigrationSources(app: AppDefinition): Promise<MigrationSource> {
  return { dir: app.migrationsDir, prepend: await templateFiles(TEMPLATE_MIGRATIONS) };
}

export interface NeopBackend {
  core: Core;
  gate: Gate;
  runner: Runner;
  /** The NEOP on Matrix itself (NEOP_PRESENCE=appservice|client; v3 S4); null when off. */
  presence: Presence | null;
  /** Bound ports once listening (appservice: the /_matrix/app/v1 listener, when that road is on). */
  ports: { l3: number; gate: number; appservice?: number };
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
  opts: { l3Port?: number; gatePort?: number; host?: string; l3Host?: string; gateHost?: string; runner?: boolean } = {},
): Promise<NeopBackend> {
  const full: NeopConfig = { ...cfg, timings: { ...DEFAULT_TIMINGS, ...(cfg.timings ?? {}) } };
  // WP §11 step 8: before anything listens, the schema must be exactly the set this build ships —
  // nothing pending, nothing unknown, nothing edited after it ran. Otherwise refuse (SchemaMismatchError).
  await assertSchemaInStep(full.directDbUrl ?? full.runnerDbUrl, app.manifest.app, await appMigrationSources(app));
  const host = opts.host ?? '127.0.0.1';
  const core = new Core(app, full);
  const gate = new Gate(core);
  const runner = new Runner(core);
  // L3 and the gate can each bind to one network only, so the gateway alone reaches L3 and the agent alone the gate.
  const l3Routes = l3App(core);
  // Today's NEOS platform calls /capabilities/<id> on the same listener (only when configured).
  if (full.neosV1) l3Routes.route('/', neosV1App(core, full.neosV1));
  // Kept source documents (WP §11): download links are signed and checked by this backend alone.
  const linkSecret = Array.isArray(full.jobTokenSecret) ? full.jobTokenSecret[0]! : full.jobTokenSecret.split(',')[0]!;
  registerDocumentLinkKey(app.manifest.app, linkSecret);
  l3Routes.route('/', documentsL3(core));
  const l3 = await listen(l3Routes, opts.l3Port ?? 0, opts.l3Host ?? host);
  const g = await listen(
    gateApp(core, gate, (claims, reason) => runner.onSessionEnd(claims, reason)),
    opts.gatePort ?? 0,
    opts.gateHost ?? host,
  );
  if (!full.gateUrl) (full as { gateUrl?: string }).gateUrl = `http://${host}:${g.port}`;
  if (opts.runner !== false) await runner.start();
  // v3 S4: the NEOP's own presence in Matrix — the ear (runner/inbound.ts) and the mouth (runner/mirror.ts).
  let presence: Presence | null = null;
  if (full.presence && full.presence.mode !== 'off' && opts.runner !== false) {
    presence = new Presence(core, full.presence);
    await presence.start({ host });
  }
  return {
    core,
    gate,
    runner,
    presence,
    ports: { l3: l3.port, gate: g.port, ...(presence?.port ? { appservice: presence.port } : {}) },
    async stop() {
      await presence?.stop();
      await runner.stop();
      await Promise.all([closeServer(l3.server as any), closeServer(g.server as any)]);
      await core.close();
    },
  };
}
