// The Ledger operator console and its BFF. The browser talks only to this server:
// it holds the person's desk token in an httpOnly cookie (page script never sees it) and
// forwards /api/* to the platform with it. It has no database role, no vault, no
// route to the app backend and no model: everything it shows comes through the
// platform gateway as the signed-in person, and every change goes through the desk.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const COOKIE = 'neos_desk';
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
// Only the person-facing desk API; /internal and /.well-known are never forwarded.
const FORWARD = /^\/api\/(me|users|ask|registry|registry\/catalog|registry\/installs|vault|desk|tasks|dead-letters|grants|acl|audit)$|^\/api\/(apps|conversations|desk|tasks|switchboards|vault|dead-letters|grants|usage)\//;

export interface WebOptions {
  platformUrl: string;
  /** Set Secure on the cookie (behind TLS). */
  secureCookies?: boolean;
  fetch?: typeof fetch;
}

function asset(name: string): { body: string; type: string } {
  return { body: readFileSync(path.join(PUBLIC, name), 'utf8'), type: TYPES[path.extname(name)] ?? 'application/octet-stream' };
}

export function webApp(opts: WebOptions): Hono {
  const f = opts.fetch ?? fetch;
  const base = opts.platformUrl.replace(/\/$/, '');
  // Read once in production; re-read per request in development so edits show on reload.
  const names = ['index.html', 'login.html', 'app.js', 'app.css', 'login.js'];
  const cached = new Map(names.map((n) => [n, asset(n)]));
  const files = { get: (n: string) => (process.env.NEOS_ENV === 'production' ? cached.get(n) : asset(n)) };
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  });

  const send = (c: Context, name: string) => {
    const a = files.get(name)!;
    c.header('Content-Type', a.type);
    c.header('Cache-Control', name.endsWith('.html') ? 'no-store' : 'no-cache');
    return c.body(a.body);
  };
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/app.js', (c) => send(c, 'app.js'));
  app.get('/app.css', (c) => send(c, 'app.css'));
  app.get('/login.js', (c) => send(c, 'login.js'));
  app.get('/login', (c) => send(c, 'login.html'));
  app.get('/', (c) => (getCookie(c, COOKIE) ? send(c, 'index.html') : c.redirect('/login')));

  // Sign in with a desk token (issued by an admin or `scripts/ops.ts create-user`). It is checked
  // against the platform before the cookie is set, and never returned to the page.
  app.post('/auth/login', async (c) => {
    if (c.req.header('x-neos-web') !== '1') return c.json({ error: { code: 'forbidden', message: 'missing request header' } }, 403);
    const b = await c.req.json().catch(() => ({}));
    const token = typeof b.token === 'string' ? b.token.trim() : '';
    if (!token || token.length > 200) return c.json({ error: { code: 'bad_request', message: 'paste your desk token' } }, 400);
    const me = await f(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
    if (!me) return c.json({ error: { code: 'unavailable', message: 'the platform is not reachable' } }, 502);
    if (me.status !== 200) return c.json({ error: { code: 'unauthenticated', message: 'that token does not sign anyone in' } }, 401);
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Strict', secure: !!opts.secureCookies, path: '/', maxAge: 12 * 3600 });
    return c.json({ ok: true, me: await me.json() });
  });
  app.post('/auth/logout', (c) => {
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.all('/api/*', async (c) => {
    const url = new URL(c.req.url);
    if (!FORWARD.test(url.pathname)) return c.json({ error: { code: 'not_found', message: 'no such route' } }, 404);
    const token = getCookie(c, COOKIE);
    if (!token) return c.json({ error: { code: 'unauthenticated', message: 'sign in required' } }, 401);
    // CSRF: SameSite=Strict already keeps other sites' requests cookie-less; a custom header
    // (which a cross-site form cannot set) is required on every change as well.
    if (c.req.method !== 'GET' && c.req.header('x-neos-web') !== '1') return c.json({ error: { code: 'forbidden', message: 'missing request header' } }, 403);
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const ct = c.req.header('content-type');
    if (ct) headers['content-type'] = ct;
    const last = c.req.header('last-event-id');
    if (last) headers['last-event-id'] = last;
    const res = await f(base + url.pathname + url.search, {
      method: c.req.method,
      headers,
      body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.arrayBuffer(),
    }).catch(() => null);
    if (!res) return c.json({ error: { code: 'unavailable', message: 'the platform is not reachable' } }, 502);
    const out = new Headers();
    // The platform no longer accepts this token: drop the session.
    if (res.status === 401) out.append('set-cookie', `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`);
    for (const h of ['content-type', 'cache-control']) {
      const v = res.headers.get(h);
      if (v) out.set(h, v);
    }
    // Streams (SSE) pass straight through; when the browser goes away, the upstream closes too.
    const reader = res.body?.getReader();
    const body = reader
      ? new ReadableStream<Uint8Array>({
          async pull(ctrl) {
            try {
              const { done, value } = await reader.read();
              if (done) ctrl.close();
              else ctrl.enqueue(value);
            } catch {
              ctrl.close();
            }
          },
          cancel: () => reader.cancel().catch(() => {}),
        })
      : null;
    return new Response(body, { status: res.status, headers: out });
  });

  return app;
}
