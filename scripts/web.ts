// Web container entry: the NEOS desk — a TEST HARNESS standing in for the NEOS app
// (neos-app-platform), so a NEOP can be exercised end to end: ask, cards, switchboard,
// blocks. It is not a product UI and refuses NEOS_ENV=production. It reaches only the
// platform's desk API and holds no database role, secret or key of its own.
import { startWeb } from '@neop/platform';
import { env, log, onShutdown, requireEnv } from '../apps/ledger/scripts/env.ts';

requireEnv(['NEOS_PLATFORM_URL']);
const w = await startWeb({ platformUrl: env('NEOS_PLATFORM_URL'), secureCookies: env('NEOS_WEB_SECURE_COOKIES', '0') === '1', port: Number(env('PORT', '4780')), host: env('HOST', '0.0.0.0') });
log('info', 'NEOS desk (test harness) up', { port: w.port, platform: env('NEOS_PLATFORM_URL') });
onShutdown(w.stop, 5_000);
