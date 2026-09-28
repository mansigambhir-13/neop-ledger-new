import { closeServer } from '@neop/pgkit';
import { serve, type ServerType } from '@hono/node-server';
import { ChatBridge, type RoomTransport } from './bridge/bridge.ts';
import { matrixAppservice, MatrixTransport, type MatrixConfig } from './bridge/matrix.ts';
import { startChatClients, type ChatClient, type ChatClientsConfig } from './bridge/client-sync.ts';
import { chatClientRoutes } from './bridge/routes.ts';
import { llmProxyApp, pricesFromEnv, type Price, type ProxyConfig } from './llm/proxy.ts';
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
export * from './bridge/client-sync.ts';
export { chatClientRoutes } from './bridge/routes.ts';
export * from './llm/proxy.ts';
export * from './vault.ts';
export * from './registry.ts';
export * from './conformance.ts';
export * from './bridge-policy.ts';
export { modelRoute, readChoice, routeRequest, validateChoice, ROUTER_PRINCIPAL, type RouteDecision, type RouteMethod } from './neuralchat.ts';

export async function startPlatform(
  opts: PlatformOptions & {
    port?: number;
    host?: string;
    workers?: boolean;
    /** Chat bridge: a Matrix appservice, or any RoomTransport (tests). */
    chat?: { matrix: MatrixConfig } | { transport: RoomTransport; serverName: string } | { client: ChatClientsConfig };
    bridgeSendEveryMs?: number;
    /** Run the LLM proxy in this process, mounted at /llm. */
    llm?: { upstream: ProxyConfig['upstream']; prices?: Record<string, Price> };
  },
): Promise<{ platform: Platform; bridge: ChatBridge | null; chatClients: ChatClient[]; port: number; url: string; stop: () => Promise<void> }> {
  const platform = new Platform(opts);
  await platform.ensureRegistry();
  const host = opts.host ?? '127.0.0.1';
  let bridge: ChatBridge | null = null;
  const app = platformApp(platform);
  let chatClients: ChatClient[] = [];
  if (opts.chat && !('client' in opts.chat)) {
    const transport = 'matrix' in opts.chat ? new MatrixTransport(opts.chat.matrix) : opts.chat.transport;
    const serverName = 'matrix' in opts.chat ? opts.chat.matrix.serverName : opts.chat.serverName;
    bridge = new ChatBridge(platform, transport, { serverName, sendEveryMs: opts.bridgeSendEveryMs, log: opts.log ? (m, e) => opts.log!(m, { e: String(e) }) : undefined });
    if ('matrix' in opts.chat) app.route('/', matrixAppservice(bridge, opts.chat.matrix));
    // Admins bind an app's room for their company and link people's chat identities (Phase 3).
    const chatBridge = bridge;
    const admin = async (c: any) => {
      const u = await platform.authUser(c.req.header('authorization'));
      if (!u) return { error: c.json({ error: { code: 'unauthenticated', message: 'sign in required' } }, 401) };
      if (u.role !== 'admin') return { error: c.json({ error: { code: 'denied', message: 'admins only' } }, 403) };
      return { u };
    };
    app.post('/api/chat/rooms', async (c) => {
      const a = await admin(c);
      if (a.error) return a.error;
      const b = await c.req.json().catch(() => ({}));
      if (typeof b.app !== 'string' || typeof b.room_id !== 'string' || !/^![^:]+:.+$/.test(b.room_id)) return c.json({ error: { code: 'bad_request', message: 'app and a room id like !abc:server' } }, 400);
      try {
        await platform.assertInstalled(b.app, a.u!.company_id);
        const bot = await chatBridge.createAppRoom(a.u!.company_id, b.app, b.room_id);
        await platform.gateway.audit({ company_id: a.u!.company_id, actor: `user:${a.u!.id}`, app_key: b.app, action: 'chat.room_bound', outcome: b.room_id });
        return c.json({ room_id: b.room_id, bot });
      } catch (e: any) {
        return c.json({ error: { code: e.code ?? 'chat_error', message: String(e.message ?? e) } }, e.status ?? 502);
      }
    });
    app.put('/api/users/:id/chat', async (c) => {
      const a = await admin(c);
      if (a.error) return a.error;
      const b = await c.req.json().catch(() => ({}));
      if (typeof b.matrix_user_id !== 'string' || !/^@[^:]+:.+$/.test(b.matrix_user_id)) return c.json({ error: { code: 'bad_request', message: 'a chat id like @priya:server' } }, 400);
      const same = await platform.db.query('select 1 from neos.users where id = $1 and company_id = $2', [c.req.param('id'), a.u!.company_id]);
      if (!same.rowCount) return c.json({ error: { code: 'not_found', message: 'no such person in your company' } }, 404);
      await chatBridge.linkUser(c.req.param('id'), b.matrix_user_id);
      await platform.gateway.audit({ company_id: a.u!.company_id, actor: `user:${a.u!.id}`, action: 'chat.user_linked', outcome: b.matrix_user_id });
      return c.json({ ok: true });
    });
  }
  // The Matrix client road (MATRIX_MODE=client) and its allowlist admin API (bridge/routes.ts).
  app.route('/', chatClientRoutes(platform, () => chatClients, { linkUsers: !bridge }));
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
    if (opts.chat && 'client' in opts.chat) chatClients = await startChatClients(platform, { log: opts.log, ...opts.chat.client });
  }
  return {
    platform,
    bridge,
    get chatClients() {
      return chatClients;
    },
    port,
    url: `http://${host}:${port}`,
    stop: async () => {
      bridge?.stop();
      for (const c of chatClients) await c.stop();
      await closeServer(server as any);
      await platform.stop();
    },
  };
}
export { startWeb, webApp, type WebOptions } from './web/server.ts';
