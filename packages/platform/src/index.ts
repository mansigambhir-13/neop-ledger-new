import { closeServer } from '@neop/pgkit';
import { serve, type ServerType } from '@hono/node-server';
import { chatRoutes } from './chat-routes.ts';
import { llmProxyApp, pricesFromEnv, type Price, type ProxyConfig } from './llm/proxy.ts';
import { Platform, type PlatformOptions } from './platform.ts';
import { platformApp } from './server.ts';
import { NeuralChatMatrix, neuralChatRoutes, type NeuralChatMatrixConfig, type NeuralChatOptions } from './neuralchat-matrix.ts';
import { ROUTER_PRINCIPAL } from './neuralchat.ts';

export * from './platform.ts';
export * from './keys.ts';
export * from './migrate.ts';
export { platformApp } from './server.ts';
export { chatRoutes } from './chat-routes.ts';
export { roomText } from './format.ts';
export { pickApp } from './neuralchat.ts';
export * from './llm/proxy.ts';
export * from './registry.ts';
export * from './boards.ts';
export * from './conformance.ts';
export * from './neuralchat-matrix.ts';
export { modelRoute, readChoice, routeRequest, validateChoice, ROUTER_PRINCIPAL, type RouteDecision, type RouteMethod } from './neuralchat.ts';

/**
 * The NEOS platform in one process (WP v3 §1): companies, people, Conversations, NeuralChat and its Matrix tool, the
 * desk API and the registry — and, when asked, the LLM proxy. It has no route into any app and no app has one into it
 * (v3 S9): NeuralChat reaches an app only as a typed Matrix event; the desk reads and writes an app only on the
 * database (neos_desk). `neuralchat` is NeuralChat's Matrix road (its own identity per company); without it the
 * platform hands nothing to any app.
 */
export async function startPlatform(
  opts: PlatformOptions & {
    port?: number;
    host?: string;
    workers?: boolean;
    /** Run the LLM proxy in this process, mounted at /llm. */
    llm?: { upstream: ProxyConfig['upstream']; prices?: Record<string, Price>; runnerKeys?: ProxyConfig['runnerKeys'] };
    /** v3 S5: NeuralChat's Matrix tool — its own identity per company (appservice @neuralchat_<co>, or client accounts). */
    neuralchat?: NeuralChatMatrixConfig & Partial<NeuralChatOptions>;
  },
): Promise<{ platform: Platform; port: number; url: string; stop: () => Promise<void> }> {
  const platform = new Platform(opts);
  await platform.ensureRegistry();
  const host = opts.host ?? '127.0.0.1';
  const app = platformApp(platform);
  if (opts.neuralchat) {
    platform.neuralchat = new NeuralChatMatrix(platform, opts.neuralchat, {
      log: opts.log ? (m, e) => opts.log!(`[platform] ${m}`, e) : undefined,
      ackWaitMs: opts.neuralchat.ackWaitMs,
      deliveryWindowMs: opts.neuralchat.deliveryWindowMs ?? opts.timings?.taskDeliveryWindowMs,
      askWaitMs: opts.neuralchat.askWaitMs,
    });
    // On the appservice road the homeserver pushes NeuralChat's events here (@neuralchat_.* is its namespace).
    app.route('/', neuralChatRoutes(platform.neuralchat));
  }
  // Who may talk to each app in Matrix at a company, and each app's own Matrix name and rooms (written through).
  app.route('/', chatRoutes(platform));
  if (opts.llm) {
    // The proxy verifies each runner's session tokens with that runner's public key, and NeuralChat's routing tokens with
    // the platform's own (principal `neuralchat`; in the same process nothing is published).
    const given = opts.llm.runnerKeys;
    const runnerKeys = () => ({ ...(typeof given === 'function' ? given() : (given ?? {})), [ROUTER_PRINCIPAL]: [platform.opts.keys.active.publicJwk] });
    app.route('/llm', llmProxyApp({ db: platform.db, runnerKeys, upstream: opts.llm.upstream, prices: opts.llm.prices ?? pricesFromEnv(), log: opts.log ? (m, e) => opts.log!(m, { e: String(e) }) : undefined }));
  }
  const { server, port } = await new Promise<{ server: ServerType; port: number }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port ?? 0, hostname: host }, (info) => resolve({ server, port: info.port }));
  });
  if (opts.llm) platform.llmProxyUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/llm`;
  if (opts.workers !== false) {
    platform.start();
    await platform.neuralchat?.start();
  }
  return {
    platform,
    port,
    url: `http://${host}:${port}`,
    stop: async () => {
      await closeServer(server as any);
      await platform.stop();
    },
  };
}
export { startWeb, webApp, type WebOptions } from './web/server.ts';
