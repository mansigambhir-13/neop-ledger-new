import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FRONTEND_KEY_HEADER, frontendDocument, readFrontendConfig, startFrontend } from '@neop/frontend';

const KEY = 'synthetic-frontend-key-1234567890abcdef';

export function templateFrontendConformance(app: string, name: string): void {
  let upstream: Server;
  let upstreamPort = 0;
  let frontend: Awaited<ReturnType<typeof startFrontend>>;
  const seen: { cookie?: string; frontendKey?: string }[] = [];

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      seen.push({ cookie: req.headers.cookie, frontendKey: req.headers[FRONTEND_KEY_HEADER] as string | undefined });
      if (req.url === '/api/health') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      if (req.url === `/apps/${app}/blocks`) return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"blocks":{}}');
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"code":"not_found","message":"not found"}}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    upstreamPort = typeof address === 'object' && address ? address.port : 0;
    frontend = await startFrontend({ app, name, platformUrl: `http://127.0.0.1:${upstreamPort}`, key: KEY, basePath: `/apps/${app}`, host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => {
    await frontend?.close();
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
  });

  describe(`${app}: standalone frontend`, () => {
    it('requires the platform proxy key and serves the app at its base path without a second login', async () => {
      const root = `http://127.0.0.1:${frontend.port}/apps/${app}/`;
      expect((await fetch(root)).status).toBe(401);
      expect((await fetch(root, { headers: { [FRONTEND_KEY_HEADER]: 'wrong' } })).status).toBe(401);
      const response = await fetch(root, { headers: { [FRONTEND_KEY_HEADER]: KEY } });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(name);
      expect(html).toContain('No records yet');
      expect(html).toContain('Unknown');
      expect(html).toContain('Unable to load');
      expect((await fetch(`http://127.0.0.1:${frontend.port}/live`)).status).toBe(200);
    });

    it('proxies the existing authenticated platform API, preserving the user session and stripping its own key', async () => {
      const response = await fetch(`http://127.0.0.1:${frontend.port}/apps/${app}/api/apps/${app}/blocks`, { headers: { [FRONTEND_KEY_HEADER]: KEY, cookie: 'neos_session=synthetic-session' } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ blocks: {} });
      expect(seen.at(-1)).toEqual({ cookie: 'neos_session=synthetic-session', frontendKey: undefined });
      expect((await fetch(`http://127.0.0.1:${frontend.port}/apps/${app}/ready`, { headers: { [FRONTEND_KEY_HEADER]: KEY } })).status).toBe(200);
    });

    it('fails closed on production credentials and unsafe base paths', () => {
      expect(() => readFrontendConfig(app, name, { NEOS_ENV: 'production', NEOP_APP: app, NEOS_PLATFORM_URL: 'http://platform:4000' })).toThrow('NEOP_FRONTEND_KEY');
      expect(() => readFrontendConfig(app, name, { NEOS_ENV: 'production', NEOP_APP: app, NEOS_PLATFORM_URL: 'http://platform:4000', NEOP_FRONTEND_KEY: KEY, NEOP_FRONTEND_BASE_PATH: '/../escape' })).toThrow('NEOP_FRONTEND_BASE_PATH');
      expect(frontendDocument({ app, name, basePath: `/apps/${app}` })).not.toContain('<script src="/');
    });
  });
}
