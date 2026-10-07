import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect, type Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FleetApp } from '../runtime/apps.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** One failed close must not prevent removal of other owned fixture resources. */
export async function closeFixtures(actions: (() => Promise<unknown> | undefined)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const close of actions) { try { await close(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, 'fixture cleanup failed');
}

export async function eventually<T>(read: () => Promise<T | null | false | undefined>, label: string, timeout = 25_000): Promise<T> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read();
    if (value !== null && value !== undefined && value !== false) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out: ${label}`);
}

/** A fixture-only TCP address, kept stable across child restarts. No application or authorization logic. */
export async function loopbackRelay() {
  let target = 0;
  const sockets = new Set<Socket>();
  const server = createServer(incoming => {
    sockets.add(incoming); incoming.once('close', () => sockets.delete(incoming));
    incoming.on('error', () => incoming.destroy());
    if (!target) { incoming.destroy(); return; }
    const outgoing = connect({ host: '127.0.0.1', port: target });
    sockets.add(outgoing); outgoing.once('close', () => sockets.delete(outgoing));
    outgoing.on('error', () => { incoming.destroy(); outgoing.destroy(); });
    incoming.once('close', () => outgoing.destroy());
    outgoing.once('close', () => incoming.destroy());
    incoming.pipe(outgoing); outgoing.pipe(incoming);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    target(port: number) { for (const socket of sockets) socket.destroy(); target = port; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

export class RuntimeProcesses {
  private children = new Set<ChildProcess>();

  launch(app: FleetApp, side: 'agent' | 'backend', config: NodeJS.ProcessEnv) {
    // The parent's tokens/provider/database environment never reach a worker.
    const env = { PATH: process.env.PATH, NODE_NO_WARNINGS: '1', NEOS_ENV: 'production', ...config };
    const child = spawn(process.execPath, ['--import', 'tsx', `apps/${app}/scripts/${side}.ts`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.add(child);
    let stdout = '', stderr = '', spawnFailed = false;
    child.stdout!.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-100_000); });
    child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-100_000); });
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('error', () => { spawnFailed = true; this.children.delete(child); resolve({ code: null, signal: null }); });
      child.once('exit', (code, signal) => { this.children.delete(child); resolve({ code, signal }); });
    });
    const lines = () => stdout.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    return {
      pid: child.pid,
      started: () => eventually(async () => {
        const ready = lines().find(line => line.event === 'started');
        if (ready) return ready;
        if (spawnFailed || child.exitCode !== null || child.signalCode !== null) throw new Error(`${app} ${side} exited before ready`);
        return null;
      }, `${app} ${side} startup`),
      lines,
      logs: () => stdout + stderr,
      async stop(signal: NodeJS.Signals = 'SIGTERM') {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        const deadline = setTimeout(() => child.kill('SIGKILL'), 12_000);
        try { return await ended; } finally { clearTimeout(deadline); }
      },
    };
  }

  async close() {
    await Promise.all([...this.children].map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once('exit', () => resolve()); child.kill('SIGKILL');
    })));
  }
}
