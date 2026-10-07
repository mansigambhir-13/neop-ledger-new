import { RuntimeConfigError } from './config.ts';

type LogFields = Record<string, unknown>;
// Runtime errors and credentials are deliberately not serialized. Log only reviewed fields.
export function runtimeLog(app: string, side: string, level: string, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ at: new Date().toISOString(), app, side, level, event, ...fields }) + '\n';
  (level === 'fatal' ? process.stderr : process.stdout).write(line);
}

export function shutdown(app: string, side: string, stop: () => Promise<void>, deadlineMs = 10_000): void {
  let stopping = false;
  const handler = (signal: string) => {
    if (stopping) return;
    stopping = true;
    runtimeLog(app, side, 'info', 'stopping', { signal });
    const timer = setTimeout(() => {
      runtimeLog(app, side, 'fatal', 'shutdown_deadline');
      process.exit(1);
    }, deadlineMs);
    timer.unref();
    void stop().then(() => process.exit(0), () => {
      runtimeLog(app, side, 'fatal', 'shutdown_failed');
      process.exit(1);
    });
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}

export async function entry(app: string, side: string, start: () => Promise<void>): Promise<void> {
  process.on('unhandledRejection', () => {
    runtimeLog(app, side, 'fatal', 'unhandled_rejection');
    process.exit(1);
  });
  process.on('uncaughtException', () => {
    runtimeLog(app, side, 'fatal', 'uncaught_exception');
    process.exit(1);
  });
  try { await start(); }
  catch (error) {
    if (error instanceof RuntimeConfigError) {
      runtimeLog(app, side, 'fatal', 'configuration_refused', { settings: error.settings });
      process.exit(78);
    }
    runtimeLog(app, side, 'fatal', 'startup_failed');
    process.exit(1);
  }
}
