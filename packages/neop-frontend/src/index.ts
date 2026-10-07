import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

export const FRONTEND_KEY_HEADER = 'x-neop-frontend-key';

export interface FrontendConfig {
  app: string;
  name: string;
  platformUrl: string;
  key: string;
  basePath: string;
  host: string;
  port: number;
}

export class FrontendConfigError extends Error {
  readonly settings: string[];
  constructor(settings: string[]) {
    super(`Invalid or missing frontend configuration: ${settings.join(', ')}`);
    this.settings = settings;
    this.name = 'FrontendConfigError';
  }
}

export function basePathOf(value: string | undefined): string {
  if (!value || value === '/') return '';
  if (!/^\/[a-z0-9][a-z0-9/_-]*$/i.test(value) || value.endsWith('/') || value.includes('//') || value.split('/').includes('..')) throw new FrontendConfigError(['NEOP_FRONTEND_BASE_PATH']);
  return value;
}

function endpoint(value: string | undefined): string {
  try {
    const url = new URL(value ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/$/, '');
  } catch { throw new FrontendConfigError(['NEOS_PLATFORM_URL']); }
}

function integer(value: string | undefined, fallback: number): number {
  const raw = value ?? String(fallback);
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new FrontendConfigError(['PORT']);
  return parsed;
}

export function readFrontendConfig(app: string, name: string, env: NodeJS.ProcessEnv): FrontendConfig {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(app) || (env.NEOP_APP && env.NEOP_APP !== app)) throw new FrontendConfigError(['NEOP_APP']);
  if (env.NEOP_FRONTEND_KEY !== undefined && env.NEOP_FRONTEND_KEY_FILE !== undefined) throw new FrontendConfigError(['NEOP_FRONTEND_KEY', 'NEOP_FRONTEND_KEY_FILE']);
  let key = env.NEOP_FRONTEND_KEY?.trim() ?? '';
  try { if (env.NEOP_FRONTEND_KEY_FILE) key = readFileSync(env.NEOP_FRONTEND_KEY_FILE, 'utf8').trim(); }
  catch { throw new FrontendConfigError(['NEOP_FRONTEND_KEY_FILE']); }
  if (env.NEOS_ENV === 'production' && key.length < 32) throw new FrontendConfigError(['NEOP_FRONTEND_KEY']);
  const host = env.HOST?.trim() || '127.0.0.1';
  if (!isIP(host) && !/^[a-z0-9.-]+$/i.test(host)) throw new FrontendConfigError(['HOST']);
  return { app, name, platformUrl: endpoint(env.NEOS_PLATFORM_URL), key, basePath: basePathOf(env.NEOP_FRONTEND_BASE_PATH), host, port: integer(env.PORT, 4105) };
}

const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function frontendDocument(config: Pick<FrontendConfig, 'app' | 'name' | 'basePath'>): string {
  const app = JSON.stringify(config.app).replace(/</g, '\\u003c');
  const base = JSON.stringify(config.basePath).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(config.name)}</title><style>
  :root{color-scheme:light dark;font:16px system-ui,sans-serif}body{margin:0;background:#f5f5f3;color:#171714}main{max-width:1100px;margin:auto;padding:32px}header{display:flex;justify-content:space-between;align-items:center}.muted{color:#65655e}.panel{background:white;border:1px solid #ddd;border-radius:12px;padding:20px;margin:16px 0}pre{white-space:pre-wrap;overflow:auto}.error{color:#9d1c1c}@media(prefers-color-scheme:dark){body{background:#151513;color:#eee}.panel{background:#20201d;border-color:#444}.muted{color:#aaa}.error{color:#ff9a9a}}
  </style></head><body><main><header><div><h1>${esc(config.name)}</h1><p class="muted">Company data, with source provenance</p></div><a href="${config.basePath || ''}/">Refresh</a></header><section id="source-status" class="panel" aria-live="polite">Checking sources…</section><section id="screens"></section></main><script>
  const APP=${app},BASE=${base};
  const api=async(path,init={})=>{const r=await fetch(BASE+'/api'+path,{...init,headers:{'content-type':'application/json',...(init.headers||{})}});const body=await r.json().catch(()=>({error:{message:'Invalid response'}}));if(!r.ok)throw Error(body.error?.message||('HTTP '+r.status));return body};
  const sources=v=>{const out=new Set();const walk=x=>{if(Array.isArray(x))x.forEach(walk);else if(x&&typeof x==='object'){if(typeof x.ability==='string')out.add(x.ability);Object.values(x).forEach(walk)}};walk(v);return [...out]};
  const state=(out)=>out?.empty===true?'No records yet':out==null?'Unknown':JSON.stringify(out,null,2);
  (async()=>{try{const b=await api('/apps/'+encodeURIComponent(APP)+'/blocks');const blocks=b.blocks||{};const abilities=sources(blocks);document.querySelector('#source-status').textContent=abilities.length?abilities.length+' reviewed data source'+(abilities.length===1?'':'s'):'No data source is required for this screen';const host=document.querySelector('#screens');for(const ability of abilities){const el=document.createElement('article');el.className='panel';el.innerHTML='<h2></h2><pre>Loading…</pre>';el.querySelector('h2').textContent=ability;host.append(el);try{const r=await api('/apps/'+encodeURIComponent(APP)+'/read/'+encodeURIComponent(ability),{method:'POST',body:'{}'});el.querySelector('pre').textContent=state(r.result)}catch(e){el.querySelector('pre').className='error';el.querySelector('pre').textContent='Unable to load: '+e.message}}if(!abilities.length)host.innerHTML='<article class="panel">No screens are configured.</article>'}catch(e){document.querySelector('#source-status').className='panel error';document.querySelector('#source-status').textContent='Unable to load: '+e.message}})();
  </script></body></html>`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(JSON.stringify(body));
}

function presented(req: IncomingMessage): string {
  const value = req.headers[FRONTEND_KEY_HEADER];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export async function startFrontend(config: FrontendConfig): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const document = frontendDocument(config);
  const server = createServer(async (req, res) => {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://frontend.local'); }
    catch { return json(res, 400, { error: { code: 'bad_request', message: 'bad url' } }); }
    if (url.pathname === '/live' || url.pathname === `${config.basePath}/live`) return json(res, 200, { ok: true });
    const remote = req.socket.remoteAddress ?? '';
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
    if ((config.key && presented(req) !== config.key) || (!config.key && !loopback)) return json(res, 401, { error: { code: 'unauthenticated', message: `${FRONTEND_KEY_HEADER} is required` } });
    if (url.pathname === '/ready' || url.pathname === `${config.basePath}/ready`) {
      const ready = await fetch(`${config.platformUrl}/api/health`, { signal: AbortSignal.timeout(2_000) }).catch(() => null);
      return json(res, ready?.ok ? 200 : 503, { ok: !!ready?.ok });
    }
    const apiPrefix = `${config.basePath}/api`;
    if (url.pathname === apiPrefix || url.pathname.startsWith(`${apiPrefix}/`)) {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (value !== undefined && !['host', 'content-length', FRONTEND_KEY_HEADER].includes(name.toLowerCase())) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const upstream = await fetch(`${config.platformUrl}${url.pathname.slice(apiPrefix.length)}${url.search}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks), redirect: 'manual' }).catch(() => null);
      if (!upstream) return json(res, 502, { error: { code: 'upstream_unavailable', message: 'platform unavailable' } });
      const responseHeaders: Record<string, string> = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
      for (const name of ['content-type', 'set-cookie', 'location']) { const value = upstream.headers.get(name); if (value) responseHeaders[name] = value; }
      res.writeHead(upstream.status, responseHeaders).end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    if (url.pathname === config.basePath || url.pathname === `${config.basePath}/`) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' }).end(document);
      return;
    }
    json(res, 404, { error: { code: 'not_found', message: 'not found' } });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => resolve()); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  return { server, port, close: () => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
