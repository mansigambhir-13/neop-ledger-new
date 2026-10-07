// Disposable local wire-protocol fixture. Never part of an assistant image.
import { createServer } from 'node:http';
const role = process.env.ROLE ?? 'sentinel';
const events = [];
const bodyOf = async request => {
  let text = ''; for await (const chunk of request) { text += chunk; if (text.length > 2_500_000) throw new Error('fixture body too large'); }
  return text ? JSON.parse(text) : {};
};
const server = createServer(async (request, response) => {
  const reply = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  try {
    if (request.url === '/live') return reply(200, { ok: true, role });
    if (request.url === '/evidence') return reply(200, { role, events });
    if (role === 'gate' && request.url?.startsWith('/gate/')) {
      if (request.headers.authorization !== 'Bearer fixture-job-session') return reply(403, { error: 'fixture authorization refused' });
      const body = await bodyOf(request);
      events.push({ path: request.url, ...(request.url === '/gate/call' ? { tool: body.tool } : {}), ...(request.url === '/gate/session.end' ? { reason: body.reason } : {}) });
      if (request.url === '/gate/call' && body.tool !== 'job.finish') return reply(403, { status: 'refused', reason: 'fixture has no business effects' });
      return reply(200, { status: 'ok' });
    }
    if (role === 'model' && request.method === 'POST' && request.url === '/v1/messages') {
      if (request.headers['x-api-key'] !== 'fixture-model-session') return reply(401, { error: 'fixture model token refused' });
      const body = await bodyOf(request); events.push({ path: request.url, model: body.model, streamed: body.stream === true });
      const stream = [
        { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_fixture', name: 'job__finish', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ outcome: 'done', summary: 'Local artifact fixture completed; no business action.' }) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      return response.end(stream.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    }
    return reply(404, { error: 'fixture endpoint unavailable' });
  } catch { reply(400, { error: 'invalid fixture request' }); }
});
server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
