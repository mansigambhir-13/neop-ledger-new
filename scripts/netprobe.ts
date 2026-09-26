// Run INSIDE a container: try each connection and compare with what the network policy says.
//   tsx scripts/netprobe.ts open:ledger-backend:4102 closed:postgres:5432 closed:1.1.1.1:443 \
//                           proxy-open:https://api.anthropic.com proxy-refused:https://example.com
// open/closed     a raw TCP connect (no proxy): can this container reach host:port at all?
// proxy-open      an HTTPS request the way the service makes it (fetch, honouring HTTP(S)_PROXY with
//                 NODE_USE_ENV_PROXY=1) gets an HTTP answer from the far end, through the egress proxy.
// proxy-refused   the same request is refused (the egress proxy's allow-list, or no route at all).
// Exit 1 if any connection is possible that must not be (or impossible that must be).
import net from 'node:net';

const probe = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(2500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });

/** Any HTTP status from the far end counts as reachable; a refused CONNECT or no route does not. */
const viaFetch = async (url: string): Promise<{ ok: boolean; detail: string }> => {
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) });
    return { ok: true, detail: `HTTP ${r.status}` };
  } catch (e) {
    const c = (e as { cause?: { message?: string; code?: string } }).cause;
    return { ok: false, detail: `refused (${[c?.code, c?.message ?? (e as Error).message].filter(Boolean).join(': ')})` };
  }
};

if (process.argv.slice(2).some((s) => s.startsWith('proxy-')) && process.env.NODE_USE_ENV_PROXY !== '1') {
  console.log('note: NODE_USE_ENV_PROXY is not set here; fetch goes direct');
}
let bad = 0;
for (const spec of process.argv.slice(2)) {
  const i = spec.indexOf(':');
  const want = spec.slice(0, i);
  const target = spec.slice(i + 1);
  let reachable: boolean;
  let detail: string;
  if (want === 'proxy-open' || want === 'proxy-refused') {
    ({ ok: reachable, detail } = await viaFetch(target));
  } else if (want === 'open' || want === 'closed') {
    const [host = '', port = ''] = target.split(':');
    reachable = await probe(host, Number(port));
    detail = reachable ? 'reachable' : 'unreachable';
  } else {
    console.log(`FAIL unknown probe ${spec}`);
    bad++;
    continue;
  }
  const ok = (want === 'open' || want === 'proxy-open') === reachable;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${want.padEnd(13)} ${target} → ${detail}`);
}
process.exit(bad ? 1 : 0);
