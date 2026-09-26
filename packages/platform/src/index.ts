import { closeServer } from '@neop/pgkit';
import { serve, type ServerType } from '@hono/node-server';
import { ChatBridge, type RoomTransport } from './bridge/bridge.ts';
import { matrixAppservice, MatrixTransport, type MatrixConfig } from './bridge/matrix.ts';
import { llmProxyApp, pricesFromEnv, type Price } from './llm/proxy.ts';
import { Platform, type PlatformOptions } from './platform.ts';
import { platformApp } from './server.ts';

export * from './platform.ts';
export * from './gateway.ts';
export * from './keys.ts';
export * from './migrate.ts';
export { platformApp } from './server.ts';
export { pickApp } from './neuralchat.ts';
export * from './bridge/bridge.ts';
export * from './bridge/matrix.ts';
export * from './llm/proxy.ts';
export * from './vault.ts';
export * from './registry.ts';

export async function startPlatform(
  opts: PlatformOptions & {
    port?: number;
    host?: string;
    workers?: boolean;
    /** Chat bridge: a Matrix appservice, or any RoomTransport (tests). */
    chat?: { matrix: MatrixConfig } | { transport: RoomTransport; serverName: string };
    bridgeSendEveryMs?: number;
    /** Run the LLM proxy in this process, mounted at /llm. */
    llm?: { upstream: { baseUrl: string; apiKey: string }; prices?: Record<string, Price> };
  },
): Promise<{ platform: Platform; bridge: ChatBridge | null; port: number; url: string; stop: () => Promise<void> }> {
  const platform = new Platform(opts);
  await platform.ensureRegistry();
  const host = opts.host ?? '127.0.0.1';
  let bridge: ChatBridge | null = null;
  const app = platformApp(platform);
  if (opts.chat) {
    const transport = 'matrix' in opts.chat ? new MatrixTransport(opts.chat.matrix) : opts.chat.transport;
    const serverName = 'matrix' in opts.chat ? opts.chat.matrix.serverName : opts.chat.serverName;
    bridge = new ChatBridge(platform, transport, { serverName, sendEveryMs: opts.bridgeSendEveryMs, log: opts.log ? (m, e) => opts.log!(m, { e: String(e) }) : undefined });
    if ('matrix' in opts.chat) app.route('/', matrixAppservice(bridge, opts.chat.matrix));
  }
  if (opts.llm) {
    app.route('/llm', llmProxyApp({ db: platform.db, jwks: () => platform.gateway.jwks(), upstream: opts.llm.upstream, prices: opts.llm.prices ?? pricesFromEnv(), log: opts.log ? (m, e) => opts.log!(m, { e: String(e) }) : undefined }));
  }
  const { server, port } = await new Promise<{ server: ServerType; port: number }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port ?? 0, hostname: host }, (info) => resolve({ server, port: info.port }));
  });
  if (opts.llm) platform.llmProxyUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/llm`;
  if (opts.workers !== false) {
    platform.start();
    bridge?.start();
  }
  return {
    platform,
    bridge,
    port,
    url: `http://${host}:${port}`,
    stop: async () => {
      bridge?.stop();
      await closeServer(server as any);
      await platform.stop();
    },
  };
}
