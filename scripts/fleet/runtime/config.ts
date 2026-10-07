import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isFleetApp, type FleetApp } from './apps.ts';

/** Configuration diagnostics contain setting names only, never supplied values or file paths. */
export class RuntimeConfigError extends Error {
  readonly settings: string[];
  constructor(settings: string[]) {
    super(`Invalid or missing configuration: ${settings.join(', ')}`);
    this.settings = settings;
    this.name = 'RuntimeConfigError';
  }
}

export function setting(env: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const value = env[name];
  const file = env[`${name}_FILE`];
  if (value !== undefined && file !== undefined) throw new RuntimeConfigError([name, `${name}_FILE`]);
  let result: string | undefined;
  try { result = file !== undefined ? readFileSync(file, 'utf8').trim() : value ?? fallback; }
  catch { throw new RuntimeConfigError([`${name}_FILE`]); }
  if (result === undefined || !result.trim()) throw new RuntimeConfigError([name]);
  return result.trim();
}

export function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name] !== undefined || env[`${name}_FILE`] !== undefined ? setting(env, name) : undefined;
}

export function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = setting(env, name, String(fallback));
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new RuntimeConfigError([name]);
  return value;
}

export function endpoint(env: NodeJS.ProcessEnv, name: string, allowPath = false): string {
  const raw = setting(env, name);
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (!allowPath && url.pathname !== '/')) throw new Error();
    return url.toString().replace(/\/$/, '');
  } catch { throw new RuntimeConfigError([name]); }
}

export async function bindHost(env: NodeJS.ProcessEnv, name: string): Promise<string> {
  const value = setting(env, name, '127.0.0.1');
  if (isIP(value)) return value;
  try { return (await lookup(value, { family: 4 })).address; }
  catch { throw new RuntimeConfigError([name]); }
}

export function appIdentity(app: string, env: NodeJS.ProcessEnv): asserts app is FleetApp {
  if (!isFleetApp(app) || (env.NEOP_APP !== undefined && env.NEOP_APP !== app)) throw new RuntimeConfigError(['NEOP_APP']);
}

export function database(env: NodeJS.ProcessEnv, name: string, role: string): { url: string; database: string } {
  const raw = setting(env, name);
  try {
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || decodeURIComponent(url.username) !== role || !url.hostname || url.pathname.length < 2 || url.hash) throw new Error();
    // The pinned pg parser lets query parameters override URL user/host/port.
    // Only transport/observability options may supplement this reviewed identity.
    const allowed = new Set(['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'ssl', 'sslnegotiation', 'uselibpqcompat', 'application_name', 'fallback_application_name', 'connect_timeout']);
    if ([...url.searchParams.keys()].some(key => !allowed.has(key))) throw new Error();
    return { url: raw, database: decodeURIComponent(url.pathname) };
  } catch { throw new RuntimeConfigError([name]); }
}

// The worker takes short-lived model/job credentials in a session request only.
// This check detects accidental secret injection; it does not replace container/network isolation.
export function forbiddenAgentSettings(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter(name => env[name] !== undefined && (
    /SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY|ACCESS_KEY|_FILE$/i.test(name) ||
    /^(?:DATABASE_URL|DB_URL|PG[A-Z_]+|NEOS_(?:ADMIN|PW|PKG|REGISTRY)|NEOP_(?:APP_DB|RUNNER_DB|DIRECT_DB|DOOR|MATRIX|REGISTRY|LLM_(?:SIGNING|BASE_URL|VIRTUAL_KEY|PROXY_URL)))/.test(name)
  )).sort();
}

export function readAgentConfig(app: string, env: NodeJS.ProcessEnv) {
  appIdentity(app, env);
  const forbidden = forbiddenAgentSettings(env);
  if (forbidden.length) throw new RuntimeConfigError(forbidden);
  const allowedGate = endpoint(env, 'NEOP_ALLOWED_GATE');
  const poolSize = integer(env, 'POOL_SIZE', 5, 1, 100);
  const port = integer(env, 'PORT', 4103, 0, 65535);
  // Only non-secret model metadata is passed into the model factory.
  const modelEnv: NodeJS.ProcessEnv = {};
  for (const key of ['NEOP_LLM_MODEL', 'NEOP_LLM_API', 'NEOP_LLM_PROVIDER', 'NEOP_LLM_COST_IN', 'NEOP_LLM_COST_OUT']) {
    if (env[key] !== undefined) modelEnv[key] = env[key];
  }
  return { app, allowedGate, poolSize, port, modelEnv };
}
