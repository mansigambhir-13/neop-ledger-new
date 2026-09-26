// The package sandbox (S6, D5): one Deno process per package version, started
// with no --allow-* flags, so it has no network, no filesystem, no environment
// and no subprocesses — enforced by the runtime, not promised by the code. The
// handler source arrives over stdin and is imported as a data: URL. Every
// capability the package has is a request back to the host over JSON-lines RPC.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export function denoPath(): string {
  if (process.env.NEOP_DENO_PATH) return process.env.NEOP_DENO_PATH;
  const pkg = createRequire(import.meta.url).resolve('deno/package.json');
  const bin = path.join(path.dirname(pkg), process.platform === 'win32' ? 'deno.exe' : 'deno');
  if (!existsSync(bin)) throw new Error('deno binary not found; set NEOP_DENO_PATH');
  return bin;
}

// Runs inside Deno. Reads JSON lines; first line loads the handlers.
const BOOTSTRAP = `
const enc = new TextEncoder();
const out = (m) => Deno.stdout.write(enc.encode(JSON.stringify(m) + "\\n"));
let mod = null;
let seq = 0;
const pending = new Map();
function ctxFor(callId, base) {
  const ask = (op, params) => new Promise((resolve, reject) => {
    const id = "c" + (++seq);
    pending.set(id, { resolve, reject });
    out({ type: "ctx", id, call: callId, op, params });
  });
  const doors = new Proxy({}, { get: (_, door) => ({
    send: (record) => ask("doors.send", { door, record }),
    lookup: () => ask("doors.lookup", { door }),
  }) });
  return {
    ...base,
    book: { step: (summary) => ask("book.step", { summary }), fact: (subject, value, source) => ask("book.fact", { subject, value, source }) },
    tables: {
      select: (table, where = {}, limit = 100) => ask("tables.select", { table, where, limit }),
      insert: (table, row) => ask("tables.insert", { table, row }),
      update: (table, where, set) => ask("tables.update", { table, where, set }),
    },
    doors,
  };
}
async function handle(m) {
  if (m.type === "load") {
    mod = await import("data:text/javascript;base64," + m.code);
    return out({ type: "loaded" });
  }
  if (m.type === "ctx_result") {
    const p = pending.get(m.id); pending.delete(m.id);
    if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
    return;
  }
  if (m.type === "call") {
    try {
      const a = mod?.abilities?.[m.ability];
      const fn = a?.[m.method];
      if (typeof fn !== "function") throw new Error("no handler " + m.ability + "." + m.method);
      const result = await fn(m.args, ctxFor(m.id, m.ctx));
      out({ type: "result", id: m.id, result: result ?? null });
    } catch (e) {
      out({ type: "result", id: m.id, error: String(e?.message ?? e), definite: !!e?.definite });
    }
  }
}
let buf = "";
const dec = new TextDecoder();
for await (const chunk of Deno.stdin.readable) {
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
}
`;

export type CtxHandler = (op: string, params: any) => Promise<unknown>;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  onCtx: CtxHandler;
}

export class SandboxError extends Error {
  readonly definite: boolean;
  constructor(message: string, definite: boolean) {
    super(message);
    this.definite = definite;
  }
}

export class Sandbox {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private calls = 0;
  readonly name: string;
  private readonly code: string;
  private readonly callTimeoutMs: number;
  private readonly memoryMb: number;
  stderr = '';

  constructor(opts: { name: string; handlersSource: string; callTimeoutMs?: number; memoryMb?: number }) {
    this.name = opts.name;
    this.code = Buffer.from(opts.handlersSource, 'utf8').toString('base64');
    this.callTimeoutMs = opts.callTimeoutMs ?? Number(process.env.NEOP_SANDBOX_TIMEOUT_MS ?? 10_000);
    this.memoryMb = opts.memoryMb ?? 256;
  }

  private start(): Promise<void> {
    const boot = 'data:application/javascript;base64,' + Buffer.from(BOOTSTRAP).toString('base64');
    // No --allow-* flag: every permission is denied. --no-prompt makes denial final.
    const p = spawn(denoPath(), ['run', '--no-prompt', '--no-config', '--no-lock', `--v8-flags=--max-old-space-size=${this.memoryMb}`, boot], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', DENO_NO_UPDATE_CHECK: '1', DENO_DIR: process.env.NEOP_DENO_DIR ?? path.join(process.cwd(), 'var', 'deno') },
    });
    this.proc = p;
    let buf = '';
    let loaded: (() => void) | null = null;
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.type === 'loaded') loaded?.();
        else if (m.type === 'result') this.settle(m);
        else if (m.type === 'ctx') void this.serveCtx(m);
      }
    });
    p.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString('utf8')).slice(-4000);
    });
    p.on('exit', () => {
      this.proc = null;
      this.ready = null;
      for (const [id, pend] of this.pending) {
        clearTimeout(pend.timer);
        pend.reject(new SandboxError(`sandbox ${this.name} exited`, false));
        this.pending.delete(id);
      }
    });
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`sandbox ${this.name} did not start: ${this.stderr}`)), 15_000);
      loaded = () => {
        clearTimeout(t);
        resolve();
      };
      p.stdin.write(JSON.stringify({ type: 'load', code: this.code }) + '\n');
    });
  }

  private settle(m: { id: string; result?: unknown; error?: string; definite?: boolean }): void {
    const pend = this.pending.get(m.id);
    if (!pend) return;
    this.pending.delete(m.id);
    clearTimeout(pend.timer);
    if (m.error !== undefined) pend.reject(new SandboxError(m.error, !!m.definite));
    else pend.resolve(m.result);
  }

  private async serveCtx(m: { id: string; call: string; op: string; params: any }): Promise<void> {
    const pend = this.pending.get(m.call);
    let reply: Record<string, unknown>;
    try {
      if (!pend) throw new Error('no such call');
      reply = { type: 'ctx_result', id: m.id, result: (await pend.onCtx(m.op, m.params)) ?? null };
    } catch (e) {
      reply = { type: 'ctx_result', id: m.id, error: (e as Error).message };
    }
    this.proc?.stdin.write(JSON.stringify(reply) + '\n');
  }

  /** Call one handler method. Over the time limit the sandbox is killed and the call fails. */
  async call(ability: string, method: 'run' | 'execute' | 'readBack', args: unknown, ctx: Record<string, unknown>, onCtx: CtxHandler): Promise<unknown> {
    if (!this.ready) this.ready = this.start();
    await this.ready;
    if (++this.calls % 1000 === 0) this.restart(); // no long-lived state between calls
    // Unguessable: package code cannot address another in-flight call's ctx (H5).
    const id = `h${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SandboxError(`${ability}.${method} exceeded ${this.callTimeoutMs} ms; sandbox restarted`, false));
        this.restart();
      }, this.callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, onCtx });
      this.proc!.stdin.write(JSON.stringify({ type: 'call', id, ability, method, args, ctx }) + '\n');
    });
  }

  restart(): void {
    this.proc?.kill('SIGKILL');
    this.proc = null;
    this.ready = null;
  }

  stop(): void {
    this.restart();
  }
}
