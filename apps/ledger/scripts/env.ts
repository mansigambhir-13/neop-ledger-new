import { readFileSync } from 'node:fs';

/** Read NAME, or the contents of the file named by NAME_FILE (container secrets). */
export function env(name: string, fallback?: string): string {
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing ${name} (or ${name}_FILE)`);
  return v;
}

/** For settings library code reads straight from process.env: resolve NAME_FILE into NAME once at boot. */
export function loadFileEnv(names: string[]): void {
  for (const n of names) if (process.env[`${n}_FILE`] && process.env[n] === undefined) process.env[n] = env(n);
}

/** Fail fast at boot with every missing setting named, not the first one found at runtime. */
export function requireEnv(names: string[]): void {
  const missing = names.filter((n) => process.env[n] === undefined && process.env[`${n}_FILE`] === undefined);
  if (missing.length) {
    log('fatal', 'missing configuration', { missing: missing.map((n) => `${n} (or ${n}_FILE)`) });
    process.exit(78); // EX_CONFIG
  }
}

const service = process.env.NEOS_SERVICE_NAME ?? process.argv[1]?.split('/').pop()?.replace(/\.ts$/, '') ?? 'neop';

/** One JSON line per event: what log shippers expect. Never log secrets. */
export function log(level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', msg: string, extra?: unknown): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service, msg, ...(extra && typeof extra === 'object' ? redact(extra as Record<string, unknown>) : extra !== undefined ? { detail: String(extra) } : {}) });
  (level === 'error' || level === 'fatal' ? process.stderr : process.stdout).write(line + '\n');
}

function redact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = /secret|token|password|api_key|key$/i.test(k) ? '[redacted]' : v;
  return out;
}

/** SIGTERM/SIGINT: stop taking work, finish or abandon in-flight work within the deadline, exit. */
export function onShutdown(stop: () => Promise<void>, deadlineMs = 10_000): void {
  let stopping = false;
  const handler = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log('info', 'shutting down', { signal: sig });
    const t = setTimeout(() => {
      log('warn', 'shutdown deadline passed; exiting');
      process.exit(1);
    }, deadlineMs);
    t.unref();
    stop()
      .then(() => process.exit(0))
      .catch((e) => {
        log('error', 'shutdown failed', { e: String(e) });
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('unhandledRejection', (e) => log('error', 'unhandled rejection', { e: String(e) }));
}
