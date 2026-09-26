// Run INSIDE a container: try each connection and compare with what the network policy says.
//   tsx scripts/netprobe.ts open:ledger-backend:4102 closed:postgres:5432 closed:1.1.1.1:443
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

let bad = 0;
for (const spec of process.argv.slice(2)) {
  const [want = '', host = '', port = ''] = spec.split(':');
  const open = await probe(host, Number(port));
  const ok = (want === 'open') === open;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${want.padEnd(6)} ${host}:${port} → ${open ? 'reachable' : 'unreachable'}`);
}
process.exit(bad ? 1 : 0);
