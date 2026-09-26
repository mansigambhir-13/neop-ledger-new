// Web container entry: the NEOS desk (platform-owned) and its BFF. It reaches only the
// platform's desk API; it holds no database role, secret or key of its own. Every
// installed app's screens are drawn from its blocks by the desk's one renderer.
import { startWeb } from '@neop/platform';
import { env, log, onShutdown, requireEnv } from '../apps/ledger/scripts/env.ts';

requireEnv(['NEOS_PLATFORM_URL']);
const w = await startWeb({ platformUrl: env('NEOS_PLATFORM_URL'), secureCookies: env('NEOS_WEB_SECURE_COOKIES', '0') === '1', port: Number(env('PORT', '4780')), host: env('HOST', '0.0.0.0') });
log('info', 'NEOS desk up', { port: w.port, platform: env('NEOS_PLATFORM_URL') });
onShutdown(w.stop, 5_000);
