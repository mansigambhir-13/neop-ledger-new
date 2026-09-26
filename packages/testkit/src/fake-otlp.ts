// A fake OpenTelemetry collector: accepts OTLP/JSON on /v1/traces and keeps the spans.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { closeServer } from '@neop/pgkit';

export interface CollectedSpan {
  service: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes: Record<string, unknown>;
  status: number;
}

export async function fakeCollector(): Promise<{ url: string; spans: CollectedSpan[]; close(): Promise<void> }> {
  const spans: CollectedSpan[] = [];
  const app = new Hono();
  app.post('/v1/traces', async (c) => {
    const b = await c.req.json();
    for (const rs of b.resourceSpans ?? []) {
      const service = rs.resource?.attributes?.find((a: any) => a.key === 'service.name')?.value?.stringValue ?? '?';
      for (const ss of rs.scopeSpans ?? [])
        for (const s of ss.spans ?? [])
          spans.push({
            service,
            traceId: s.traceId,
            spanId: s.spanId,
            parentSpanId: s.parentSpanId,
            name: s.name,
            attributes: Object.fromEntries((s.attributes ?? []).map((a: any) => [a.key, Object.values(a.value)[0]])),
            status: s.status?.code ?? 0,
          });
    }
    return c.json({});
  });
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve({ server, port: info.port }));
  });
  return { url: `http://127.0.0.1:${port}`, spans, close: () => closeServer(server as any) };
}
