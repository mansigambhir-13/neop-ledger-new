// Minimal W3C Trace Context + OTLP/JSON exporter (R13). One trace follows a
// person's ask through gateway → L3 → runner → assistant → gate → door. No
// dependencies: spans are batched and POSTed to OTEL_EXPORTER_OTLP_ENDPOINT
// (/v1/traces) when set; otherwise they are dropped.

import { randomBytes } from 'node:crypto';

export interface TraceCtx {
  traceId: string;
  spanId: string;
}

export function parseTraceparent(h: string | null | undefined): TraceCtx | null {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(h ?? '');
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return null;
  return { traceId: m[1]!, spanId: m[2]! };
}

export function traceparent(ctx: TraceCtx): string {
  return `00-${ctx.traceId}-${ctx.spanId}-01`;
}

const hex = (n: number) => randomBytes(n).toString('hex');

export interface Span extends TraceCtx {
  name: string;
  parentSpanId: string | null;
  start: bigint;
  attrs: Record<string, string | number | boolean>;
  set(k: string, v: string | number | boolean | null | undefined): Span;
  end(status?: 'ok' | 'error', message?: string): void;
  header(): string;
}

interface Finished {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  start: bigint;
  end: bigint;
  attrs: Record<string, string | number | boolean>;
  status: 'ok' | 'error';
  message?: string;
}

export class Tracer {
  readonly service: string;
  private readonly endpoint: string | null;
  private buffer: Finished[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(service: string, endpoint: string | null = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null) {
    this.service = service;
    this.endpoint = endpoint;
  }

  /** Start a span as a child of `parent` (a context or a traceparent header), or a new trace. */
  start(name: string, parent?: TraceCtx | string | null, attrs: Record<string, string | number | boolean> = {}): Span {
    const p = typeof parent === 'string' ? parseTraceparent(parent) : (parent ?? null);
    const tracer = this;
    const span: Span = {
      name,
      traceId: p?.traceId ?? hex(16),
      spanId: hex(8),
      parentSpanId: p?.spanId ?? null,
      start: process.hrtime.bigint(),
      attrs: { ...attrs },
      set(k, v) {
        if (v !== null && v !== undefined) this.attrs[k] = v;
        return this;
      },
      end(status = 'ok', message) {
        tracer.finish({ traceId: this.traceId, spanId: this.spanId, parentSpanId: this.parentSpanId, name: this.name, start: this.start, end: process.hrtime.bigint(), attrs: this.attrs, status, message });
      },
      header() {
        return traceparent(this);
      },
    };
    return span;
  }

  /** Wrap an async function in a span; errors mark the span and rethrow. */
  async span<T>(name: string, parent: TraceCtx | string | null | undefined, fn: (s: Span) => Promise<T>, attrs: Record<string, string | number | boolean> = {}): Promise<T> {
    const s = this.start(name, parent, attrs);
    try {
      const out = await fn(s);
      s.end('ok');
      return out;
    } catch (e) {
      s.end('error', String((e as Error)?.message ?? e));
      throw e;
    }
  }

  private finish(f: Finished): void {
    if (!this.endpoint) return;
    this.buffer.push(f);
    if (this.buffer.length >= 100) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), 500);
  }

  // hrtime is monotonic; convert to wall-clock nanoseconds once per process.
  private static readonly offset = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.endpoint || !this.buffer.length) return;
    const spans = this.buffer.splice(0);
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: this.service } }] },
          scopeSpans: [
            {
              scope: { name: 'neop' },
              spans: spans.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                name: s.name,
                kind: 1,
                startTimeUnixNano: String(s.start + Tracer.offset),
                endTimeUnixNano: String(s.end + Tracer.offset),
                attributes: Object.entries(s.attrs).map(([key, v]) =>
                  typeof v === 'number' ? { key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } } : typeof v === 'boolean' ? { key, value: { boolValue: v } } : { key, value: { stringValue: v } },
                ),
                status: s.status === 'error' ? { code: 2, message: s.message ?? '' } : { code: 1 },
              })),
            },
          ],
        },
      ],
    };
    await fetch(`${this.endpoint.replace(/\/$/, '')}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  }
}
