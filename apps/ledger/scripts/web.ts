// Web container entry: the Ledger operator console and its BFF. It reaches only the
// platform's desk API; it holds no database role, secret or key of its own.
import { serve } from '@hono/node-server';
import { closeServer } from '@neop/pgkit';
import { webApp } from '../web/server.ts';
import { env, log, onShutdown, requireEnv } from './env.ts';

requireEnv(['NEOS_PLATFORM_URL']);
const port = Number(env('PORT', '4780'));
const app = webApp({ platformUrl: env('NEOS_PLATFORM_URL'), secureCookies: env('NEOS_WEB_SECURE_COOKIES', '0') === '1' });
const server = serve({ fetch: app.fetch, port, hostname: env('HOST', '0.0.0.0') });
log('info', 'ledger console up', { port, platform: env('NEOS_PLATFORM_URL') });
onShutdown(() => closeServer(server as any), 5_000);
