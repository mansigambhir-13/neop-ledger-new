// A fake Anthropic Messages API that speaks the real SSE wire format (text and
// tool_use blocks, usage in message_start / message_delta), driven by a brain
// that sees the request. Lets pi's real Anthropic client run end to end.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { closeServer } from '@neop/pgkit';

export interface UpstreamView {
  system: string;
  messages: any[];
  tools: string[];
  /** Tool results so far, as text. */
  results: { tool: string; text: string; isError: boolean }[];
  job: string;
}
export type UpstreamBrain = (v: UpstreamView) => { tool: string; args: unknown } | { text: string };

export interface FakeUpstream {
  url: string;
  apiKey: string;
  calls: { apiKey: string | undefined; model: string; max_tokens: number }[];
  setBrain(b: UpstreamBrain): void;
  usage: { input: number; output: number };
  close(): Promise<void>;
}

export async function fakeAnthropic(opts: { apiKey?: string; usage?: { input: number; output: number } } = {}): Promise<FakeUpstream> {
  const apiKey = opts.apiKey ?? 'sk-ant-real-provider-key';
  const calls: FakeUpstream['calls'] = [];
  let brain: UpstreamBrain = () => ({ text: 'ok' });
  const usage = opts.usage ?? { input: 1200, output: 80 };
  const app = new Hono();
  app.post('/v1/messages', async (c) => {
    calls.push({ apiKey: c.req.header('x-api-key'), model: '', max_tokens: 0 });
    if (c.req.header('x-api-key') !== apiKey) return c.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
    const body = await c.req.json();
    calls[calls.length - 1] = { apiKey: c.req.header('x-api-key'), model: body.model, max_tokens: body.max_tokens };
    const toolNames = new Map<string, string>();
    const results: UpstreamView['results'] = [];
    for (const m of body.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type === 'tool_use') toolNames.set(b.id, b.name);
        if (b.type === 'tool_result') {
          const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x: any) => x.text ?? '').join('');
          results.push({ tool: toolNames.get(b.tool_use_id) ?? '?', text, isError: !!b.is_error });
        }
      }
    }
    const first = body.messages[0];
    const job = typeof first?.content === 'string' ? first.content : (first?.content ?? []).map((x: any) => x.text ?? '').join('');
    const system = Array.isArray(body.system) ? body.system.map((s: any) => s.text).join('') : (body.system ?? '');
    const out = brain({ system, messages: body.messages, tools: (body.tools ?? []).map((t: any) => t.name), results, job });
    const id = `msg_${calls.length}`;
    const events: any[] = [
      { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: usage.input, output_tokens: 1 } } },
    ];
    if ('tool' in out) {
      const tid = `toolu_${calls.length}`;
      events.push(
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: tid, name: out.tool, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(out.args) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: usage.output } },
      );
    } else {
      events.push(
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: out.text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output } },
      );
    }
    events.push({ type: 'message_stop' });
    const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    if (!body.stream) {
      return c.json({ id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: 'end_turn', usage: { input_tokens: usage.input, output_tokens: usage.output } });
    }
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
  });
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve({ server, port: info.port }));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    apiKey,
    calls,
    usage,
    setBrain: (b) => {
      brain = b;
    },
    close: () => closeServer(server as any),
  };
}
